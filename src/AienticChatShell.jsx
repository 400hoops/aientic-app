import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as api from "./api.js";
import { copyText } from "./clipboard.js";
import PreviewableImage from "./ImageLightbox.jsx";
import { isPhone } from "./isPhone.js";
import Markdown from "./Markdown.jsx";
import MessageActions from "./MessageActions.jsx";
import ModelPicker from "./ModelPicker.jsx";
import SlashMenu from "./SlashMenu.jsx";
import { forgetScroll, recallScroll, rememberScroll } from "./scrollMemory.js";
import ArtifactPanel from "./ArtifactPanel.jsx";
import { ArtifactContext } from "./ArtifactContext.js";
import { artifactsIn } from "../shared/artifacts.js";
import { importedSummary } from "./importSummary.js";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronRight,
  IconFileText,
  IconGhost,
  IconLibrary,
  IconLink,
  IconPanel,
  IconPlus,
  IconSparkles,
  IconStop,
  IconX,
} from "./Icons.jsx";

/* ---------- attachments --------------------------------------------------

 * The only photos a vision model can look at are still images, so the
 * composer accepts JPEG, PNG and GIF — read to base64 data URLs on the
 * client and carried inside the same JSON turn as the text (the server
 * re-validates and reshapes them into image_url parts for the upstream).
 */
const ATTACH_TYPES = ["image/jpeg", "image/png", "image/gif"];

/* ---------- pasted and dropped text --------------------------------------
 *
 * Paste a whole article into the composer and the question you were about
 * to ask disappears into it — you can't see the box, you can't edit the
 * end, and the model gets no signal about where the source stops. Past a
 * few hundred words a paste becomes an attachment instead: named, counted,
 * removable, and fenced when it goes upstream.
 *
 * The threshold is deliberately not "any multi-line paste" — pasting a
 * stack trace or a paragraph you want to talk about inline should stay
 * inline. It's the length at which text stops being something you typed.
 */
const PASTE_AS_DOC_CHARS = 1200;
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|log|rst|tex)$/i;
const MAX_DOC_BYTES = 400 * 1024;
const MAX_DOCS = 5;

const isTextFile = (file) =>
  TEXT_TYPES.includes(file.type) || TEXT_EXTENSIONS.test(file.name || "");

/** "1,240 words" — the useful measure of a thing you're asking about. */
const wordCount = (text) => (text.trim().match(/\S+/g) || []).length;

/**
 * A paste that is nothing but a link.
 *
 * Deliberately strict: one URL, no surrounding words. "look at
 * https://…" is a sentence with a link in it, and the person is mid-thought
 * — going off to fetch it under them would be presumptuous. A bare link
 * pasted into an empty composer is unambiguous.
 */
const BARE_URL = /^https?:\/\/[^\s]+$/i;

/** The first line worth showing as a name, or a fallback. */
const titleForPaste = (text) => {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 2);
  if (!line) return "Pasted text";
  return line.length > 48 ? line.slice(0, 48).trimEnd() + "…" : line;
};
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// Breathing room above a question pinned to the top of the viewport.
const TOP_GAP = 24;

// The id a private chat answers to. It never reaches the server — see
// /api/private/stream, which has no conversation to name — but the whole
// shell is keyed on "which conversation is this", so one constant keeps
// every path (patchLast, ownStreamRef, the scroll anchor) working as-is.
const PRIVATE_ID = "private";

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * The conversation view.
 *
 * Structurally this is the original NuxChatShell: same layout, same streaming
 * loop, same composer. What changed is where state lives — messages are read
 * from and written to the server, so the same account picks up where it left
 * off on another device.
 */

function Reasoning({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[length:var(--fs-meta)] text-[var(--faint)] hover:text-[var(--muted)]"
      >
        {/* The glyph is inset in its 24px box, so the row hangs ~5px left to
            put the stroke on the same edge as the message text below. */}
        <IconChevronRight
          className={`-ml-[5px] h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        Reasoning
      </button>

      {/* The panel stays mounted; the 0fr/1fr grid row animates the height.
          A conditional unmount would snap it open and closed. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-swift
                    motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        {/* min-h-0: a grid item is min-height:auto by default, which would
            stop it collapsing below the text's own height and leave a gap
            in the "closed" state. */}
        <div className="min-h-0 overflow-hidden">
          <div
            className="mt-2 whitespace-pre-wrap border-l-2 border-[var(--border-strong)] pl-3.5
                        text-[length:var(--fs-meta)] leading-[1.7] text-[var(--muted)]"
          >
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AienticChatShell({
  models,
  modelsLoaded = true,
  modelStatus = {},
  conversationId,
  modelId,
  onModelChange,
  onConversationCreated,
  onConversationRenamed,
  onConversationNotFound,
  onConversationsChanged,
  onImportChats,
  onTogglePrivate,
  highlightMessage = null,
  openArtifactAt = null,
  renamed = null,
  privateMode = false,
  onConversationDeleted,
  sidebarOpen,
  onShowSidebar,
}) {
  const [conversation, setConversation] = useState(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, text, images }
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  // Blank space held below the last turn so the question can sit at the top
  // of the viewport while its answer arrives underneath. Recomputed as the
  // answer grows, shrinking to nothing once it fills the screen on its own.
  const [tailSpace, setTailSpace] = useState(0);
  const [images, setImages] = useState([]);
  const [preview, setPreview] = useState(null); // pending: { id, url (data URL) }
  const [imgError, setImgError] = useState(null);
  // Text riding along with the turn: a pasted article, a dropped .md.
  const [docs, setDocs] = useState([]);
  // Depth counter, not a boolean: dragging over a child fires dragleave on
  // the parent, and a boolean would flicker the highlight off mid-drag.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  // Import progress and its result. Separate from imgError: "Imported 240
  // chats" is good news, and shouldn't be painted in the danger colour.
  const [notice, setNotice] = useState(null);

  /* ---------- skills -----------------------------------------------------
   *
   * A skill is a named block of instructions kept in Settings; attaching
   * one to a chat adds it to that chat's system turn, and it stays attached
   * for the follow-ups. Skills marked always-on aren't listed as choices —
   * they apply on their own and there is nothing to pick.
   */
  const [skills, setSkills] = useState([]);
  const [skillIds, setSkillIds] = useState([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillsRef = useRef(null);

  useEffect(() => {
    api
      .listSkills()
      .then((res) => setSkills(res.skills))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!skillsOpen) return;
    const onDown = (e) => {
      if (!skillsRef.current?.contains(e.target)) setSkillsOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setSkillsOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [skillsOpen]);

  /* ---------- knowledge --------------------------------------------------
   *
   * The library is per account; whether a conversation draws on it is per
   * conversation, and sticky once set. Off by default: most questions aren't
   * about your documents, and retrieval that fires on every turn puts
   * unrelated passages in front of the model for no reason.
   */
  const [knowledge, setKnowledge] = useState([]);
  const [useKnowledge, setUseKnowledge] = useState(false);

  useEffect(() => {
    api
      .listKnowledge()
      .then((res) => setKnowledge(res.documents))
      .catch(() => {});
  }, []);

  const optional = skills.filter((s) => !s.always);
  const toggleSkill = (id) =>
    setSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  /* ---------- the slash menu ---------------------------------------------
   *
   * Type `/` in an empty composer and the skills list opens, filtered as you
   * keep typing. It's the same list as the button beside the composer, and
   * it's deliberately both: a menu you have to know about isn't
   * discoverable, and a menu you have to reach for isn't fast.
   *
   * Only when the message *starts* with the slash. One mid-sentence is just
   * a slash — dates, paths and and/or all contain one, and a picker that
   * opened over those would interrupt writing rather than help it.
   *
   * Everything after it filters, spaces included, because skill names have
   * spaces in them and stopping at the first one would make half of them
   * unreachable by typing. Nothing else limits it: the menu closes as soon
   * as nothing matches, so a message that genuinely opens with a slash —
   * "/etc/hosts is missing" — loses it after a few letters and Enter goes
   * back to sending.
   */
  const slashQuery = useMemo(() => {
    const match = /^\/(.*)$/s.exec(input);
    return match ? match[1].toLowerCase() : null;
  }, [input]);

  // Escape closes it without clearing what was typed, so it stays closed
  // until the slash goes away rather than reopening on the next letter.
  const [slashDismissed, setSlashDismissed] = useState(false);
  useEffect(() => {
    if (slashQuery === null) setSlashDismissed(false);
  }, [slashQuery]);

  const slashMatches = useMemo(() => {
    if (slashQuery === null || slashDismissed) return [];
    if (!slashQuery) return optional;
    return optional.filter(
      (skill) =>
        skill.name.toLowerCase().includes(slashQuery) ||
        (skill.description || "").toLowerCase().includes(slashQuery)
    );
    // optional is rebuilt each render from skills; skills is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, slashQuery, slashDismissed]);

  const [slashAt, setSlashAt] = useState(0);
  useEffect(() => setSlashAt(0), [slashQuery]);
  const slashOpen = slashMatches.length > 0;

  /** Attach the skill and take the `/query` back out of the composer. */
  const pickSkill = useCallback((skill) => {
    setSkillIds((prev) => (prev.includes(skill.id) ? prev : [...prev, skill.id]));
    setInput("");
    taRef.current?.focus();
  }, []);
  const fileRef = useRef(null);

  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  // Whether new tokens still pull the view down. It has to be a ref: setState
  // lands a render later, and at a few dozen tokens a second the auto-scroll
  // would fire once more with the stale value and yank the view back to the
  // bottom — which is what made scrolling up mid-answer impossible.
  const followRef = useRef(true);
  // True from a send until the reader scrolls away: the view holds the
  // question at the top instead of chasing the answer's tail.
  const pinnedRef = useRef(false);
  // The last turn attempted, for the Retry on a failure notice.
  const lastRunRef = useRef(null);
  // Set when a failure discards the conversation it was in: the loader
  // effect below clears the error on every conversation change, and this
  // one is the change — the message has to outlive it.
  const keepErrorRef = useRef(false);
  const taRef = useRef(null);
  const idRef = useRef(conversationId);
  // The conversation this component is already streaming itself. Creating a
  // chat makes it the active one, which re-runs the loader below — and that
  // loader would attach a *second* reader to the same run, so every token
  // landed twice ("HereHere's"). One reader per generation.
  const ownStreamRef = useRef(null);
  // True while a send/regenerate/edit is in flight, synchronously: the
  // `streaming` state above only becomes true after a render, and a fast
  // double-submit inside that window would start two runs (on a new chat,
  // two conversations).
  const sendingRef = useRef(false);
  const composerObserverRef = useRef(null);
  // The card, not composerRef itself: composerRef also spans the transparent
  // fade above the card (pt-14) and the safe-area gap below it (pb-5), and a
  // message's last line is fine sitting in either of those — it only needs
  // to clear the opaque card. Approximating that as a fixed fraction of
  // composerRef's full height broke as soon as the card's real proportion of
  // that height shifted (a taller composer from a longer model name, a
  // device's safe-area insets) — the fraction no longer matched, and text
  // ended up behind the card instead of above it. Measuring the card
  // directly removes the approximation.
  const cardObserverRef = useRef(null);
  const [composerH, setComposerH] = useState(96);

  const messages = conversation?.messages ?? [];
  // The turn the view pins to: the most recent question asked.
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  // Blank out only when there is genuinely nothing to show yet: a deep link
  // or refresh whose conversation hasn't arrived, or a fresh /new load whose
  // model list is still in flight (otherwise the composer would flash "No
  // model" for a moment). Switching between two existing conversations
  // keeps the current one on screen until the next one lands — a blank
  // frame on every click just reads as lag.
  const isLoadingConversation =
    (!privateMode && !!conversationId && conversation === null) ||
    (!privateMode && !conversationId && !modelsLoaded);
  const activeModel = useMemo(
    () => models.find((m) => m.id === modelId) || models[0] || null,
    [models, modelId],
  );

  // Only a model marked as vision-capable can look at photos, so pending
  // attachments are dropped the moment the active model can't see them —
  // otherwise they'd be silently attached to a turn a text-only model
  // ignores.
  useEffect(() => {
    if (activeModel?.vision) return;
    setImages((imgs) => (imgs.length ? [] : imgs));
  }, [activeModel]);

  /* ---------- load ------------------------------------------------------- */

  useEffect(() => {
    idRef.current = conversationId;
    if (keepErrorRef.current) keepErrorRef.current = false;
    else setError(null);
    setEditing(null);

    if (privateMode) {
      // Nothing to fetch, and nothing to write: the transcript lives here
      // in component state until this view goes away.
      setConversation((prev) =>
        prev?.id === PRIVATE_ID
          ? prev
          : { id: PRIVATE_ID, title: "Private chat", messages: [] }
      );
      return;
    }

    if (!conversationId) {
      setConversation(null);
      return;
    }

    // We're already reading this run's stream, so our state is newer than
    // anything the server would hand back: a snapshot lags the live run by
    // up to a checkpoint, and re-applying it would briefly drop the newest
    // tokens off the screen. (The stream's own done/error settles it.)
    if (ownStreamRef.current === conversationId) return;

    let cancelled = false;
    const controller = new AbortController();

    api
      .getConversation(conversationId)
      .then(({ conversation, generating }) => {
        if (cancelled) return;
        setConversation(conversation);
        setSkillIds(conversation.skillIds || []);
        setUseKnowledge(!!conversation.useKnowledge);
        if (conversation.endpointId) onModelChange(conversation.endpointId);

        // The answer is still being written on the server — a refresh mid-run
        // lands here. Follow it from where it got to instead of leaving a
        // half-finished message on screen.
        if (!generating || ownStreamRef.current === conversationId) return;
        setStreaming(true);
        ownStreamRef.current = conversationId;
        api
          .attachStream(
            conversationId,
            { signal: controller.signal },
            streamHandlers(conversationId),
          )
          .catch((err) => {
            if (err.name !== "AbortError" && !cancelled) setError(err.message);
          })
          .finally(() => {
            if (ownStreamRef.current === conversationId)
              ownStreamRef.current = null;
            if (!cancelled) {
              setStreaming(false);
              onConversationsChanged();
            }
          });
      })
      .catch((err) => {
        if (cancelled) return;
        // A conversation id that never existed here — most commonly a stale
        // URL: a bookmark or share link from before a fresh install wiped
        // the database, or the redirect-back-after-login carrying whatever
        // path was open before signing in. Without this, isLoadingConversation
        // stays true forever (conversation never arrives, but conversationId
        // never clears either), which now renders as an indefinitely blank
        // screen — "the chat doesn't load" — instead of surfacing anywhere
        // useful. Send it back to a clean new chat rather than leaving it
        // stuck on an id that will never resolve.
        if (err.status === 404) {
          onConversationNotFound?.(conversationId);
          return;
        }
        setError(err.message);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // onModelChange is stable; re-running on it would clobber a manual switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, privateMode]);

  const scrollToBottom = useCallback((behavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    pinnedRef.current = false; // asking for the bottom means you want the bottom
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  /**
   * Put the question you just asked at the top of the viewport, and leave
   * it there: while pinned, nothing auto-scrolls. The answer grows into the
   * space below and, once it outgrows the screen, keeps going past the
   * bottom edge — reading on is a scroll you make yourself.
   */
  const pinAnchorToTop = useCallback((behavior = "auto") => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const delta =
      anchor.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      TOP_GAP;
    if (Math.abs(delta) < 1) return;
    el.scrollTo({ top: el.scrollTop + delta, behavior });
  }, []);

  // Distance from the end that still counts as "there". The button uses the
  // generous figure so it doesn't flash up on every nudge of the wheel;
  // re-arming the auto-follow uses the tight one, so scrolling up by a single
  // notch isn't immediately read as having come back.
  const distanceToEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight;

  const onScroll = useCallback((e) => {
    const el = e.currentTarget;
    const gap = distanceToEnd(el);
    setAtBottom(gap < 120);

    // Dragging the scrollbar fires neither a wheel nor a touch, so the
    // position is the last way to notice someone has moved. Our own
    // re-align puts the anchor exactly where it wants it, so a drift this
    // large can only have come from a person.
    if (pinnedRef.current && anchorRef.current) {
      const drift =
        anchorRef.current.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        TOP_GAP;
      if (Math.abs(drift) > 80) pinnedRef.current = false;
    }
    // Reaching the end again resumes following. Our own auto-scroll only runs
    // while following is already on, so this can't switch itself back on.
    if (gap < 24) followRef.current = true;

    // Remember the place, so a refresh comes back to it. Sitting at the end
    // is *forgotten* rather than stored: the end is already the default, and
    // a stored number would be wrong the moment the next answer made the
    // page taller.
    const id = idRef.current;
    if (id && restoringRef.current === null)
      gap < 24 ? forgetScroll(id) : rememberScroll(id, el.scrollTop);
  }, []);

  // Only a gesture that means "I want to look up there" stops the following.
  // A scroll event on its own can't: our own auto-scroll raises those too.
  //
  // Attached via a callback ref (setScrollRef, below on the element itself),
  // not a useRef + a [] effect: this component's very first commit can be
  // the "still loading" blank screen (isLoadingConversation), where the
  // scroller doesn't exist in the tree at all, and an effect with empty deps
  // only ever runs once — against scrollRef.current being null at that first
  // commit, forever. That silently meant no touch/wheel/key listener was
  // ever attached: native scrolling still worked, but nothing ever broke
  // `followRef` away from it, so the auto-scroll-to-bottom effect fought
  // every scroll attempt back to the bottom on the very next streamed token
  // — scrolling away during generation was effectively impossible.
  const contentRef = useRef(null);
  // The last question on screen — what the view is pinned to after a send.
  const anchorRef = useRef(null);

  const scrollCleanupRef = useRef(null);
  const setScrollRef = useCallback((el) => {
    scrollRef.current = el;
    scrollCleanupRef.current?.();
    scrollCleanupRef.current = null;
    if (!el) return;

    const breakAway = () => {
      followRef.current = false;
      pinnedRef.current = false;
    };

    // Any wheel, in either direction. It used to break away only on an
    // upward one, from when the auto-scroll's only job was sticking to the
    // bottom — scrolling *down* was where it was taking you anyway. Since
    // the question pins to the top of the screen that's no longer true:
    // scrolling down to read the answer as it arrives was being undone on
    // the next token, which is what made the page feel stuck.
    const onWheel = () => breakAway();

    let touchY = null;
    const onTouchStart = (e) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e) => {
      const y = e.touches[0]?.clientY ?? null;
      // Either direction, same reason as the wheel above.
      if (touchY !== null && y !== null && Math.abs(y - touchY) > 2) breakAway();
      if (y !== null) touchY = y;
    };

    // On window, not the scroller: an unfocusable div never sees a keydown,
    // and the composer must keep its own arrow keys.
    const scrollKeys = new Set([
      "PageUp", "ArrowUp", "Home", "PageDown", "ArrowDown", "End", " ",
    ]);
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || e.target?.isContentEditable)
        return;
      if (scrollKeys.has(e.key)) breakAway();
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    scrollCleanupRef.current = () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // A new turn always pulls the view down; tokens arriving mid-answer only do
  // so while the reader hasn't scrolled away.
  //
  // Loading a conversation for the first time (a refresh, a deep link) lands
  // here too — the messages render at the top of the scroller and this jumps
  // them to the bottom. Animating that jump made every refresh visibly
  // scroll top-to-bottom, so it only gets the "smooth" treatment for a turn
  // added to a conversation already on screen; the initial settle is instant.
  // Non-null while a remembered position is being put back; see below.
  const restoringRef = useRef(null);

  // Re-apply it on every commit until the page stops growing under it. A
  // conversation reaches its final height over several frames, and a
  // scrollTop set against a half-built page is a different place once the
  // rest arrives.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || restoringRef.current === null) return;
    const top = Math.min(restoringRef.current, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  });

  // And stop: past this point the reader owns the scroller again.
  useEffect(() => {
    if (restoringRef.current === null) return;
    const timer = setTimeout(() => {
      restoringRef.current = null;
    }, 700);
    return () => clearTimeout(timer);
  }, [conversation?.id]);

  const settledConvoRef = useRef(null);
  useEffect(() => {
    const firstSettle = settledConvoRef.current !== conversation?.id;
    settledConvoRef.current = conversation?.id ?? null;
    if (firstSettle) {
      // Where this tab left off, if it left off anywhere but the end.
      const saved = recallScroll(conversation?.id);
      if (saved !== null) {
        // Nothing is at its final height yet — fonts, images and the tail
        // spacer all still to land — so the number is re-applied for a beat
        // rather than set once and hoped for. restoringRef also holds off
        // onScroll, which would otherwise record these intermediate
        // positions over the one being restored.
        followRef.current = false;
        pinnedRef.current = false;
        restoringRef.current = saved;
        return;
      }
      // Opening a conversation lands at its end, instantly — animating that
      // made every refresh visibly scroll top-to-bottom.
      pinnedRef.current = false;
      scrollToBottom("auto");
      return;
    }
    // A turn added to a conversation already on screen: pin its question.
    followRef.current = true;
    pinnedRef.current = true;
    pinAnchorToTop("smooth");
  }, [messages.length, conversation?.id, scrollToBottom, pinAnchorToTop]);

  /**
   * Opened from a search result: put the line that matched in the middle of
   * the screen instead of dropping in at the end of the chat. The flash is
   * what makes it findable — in a wall of text, "it's on screen somewhere"
   * isn't an answer.
   */
  /* ---------- artifacts -------------------------------------------------- */

  // The one open in the side panel, or null. Held as the artifact itself
  // rather than an id: it's a view of a message, so there's nothing to look
  // up and nothing to go stale.
  const [artifact, setArtifact] = useState(null);
  const openArtifact = useCallback((next) => setArtifact(next), []);
  const closeArtifact = useCallback(() => setArtifact(null), []);

  // Close it when the conversation changes: the panel belongs to the chat it
  // was opened from, and leaving it up over a different one is the same bug
  // as a side pane that won't go away.
  useEffect(() => {
    setArtifact(null);
  }, [conversation?.id, privateMode]);

  /**
   * Opened from the Artifacts list rather than from an answer: find the
   * message it came from and open the block at that position.
   */
  useEffect(() => {
    const wanted = openArtifactAt;
    if (!wanted || conversation?.id !== wanted.conversationId) return;
    const message = messages.find((m) => m.id === wanted.messageId);
    const found = message && artifactsIn(message)[wanted.at ?? 0];
    if (found) setArtifact(found);
  }, [openArtifactAt, conversation?.id, messages]);

  const [flash, setFlash] = useState(null);
  useEffect(() => {
    const target = highlightMessage;
    if (!target || conversation?.id !== target.conversationId) return;
    if (!messages.some((m) => m.id === target.messageId)) return;

    const node = document.querySelector(
      `[data-message-id="${CSS.escape(target.messageId)}"]`
    );
    if (!node) return;
    // Breaking the follow first: this is a deliberate move away from the
    // bottom, and the settle effect would otherwise drag it straight back.
    followRef.current = false;
    pinnedRef.current = false;
    node.scrollIntoView({ block: "center", behavior: "auto" });
    setFlash(target.messageId);
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [highlightMessage, conversation?.id, messages]);

  // A rename from the sidebar, applied to the copy this component holds.
  useEffect(() => {
    if (!renamed) return;
    setConversation((prev) =>
      prev && prev.id === renamed.id ? { ...prev, title: renamed.title } : prev
    );
  }, [renamed]);

  const tail = messages[messages.length - 1];
  useEffect(() => {
    if (!streaming || !followRef.current) return;
    // Pinned: the question stays where it is and the answer fills in under
    // it. Only a re-align, in case something above it changed height.
    if (pinnedRef.current) return pinAnchorToTop("auto");
    const el = scrollRef.current;
    // Assigning scrollTop, not scrollTo({behavior:"auto"}): a smooth scroll
    // still in flight from the button would otherwise keep overriding this.
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail?.content, tail?.reasoning, streaming, pinAnchorToTop]);

  /**
   * Push the question you just asked to the top of the screen.
   *
   * The trick is entirely in the spacer: reserve enough empty height below
   * the last turn that "scrolled to the bottom" and "that question at the
   * top" are the same position. Everything else — the send, the streaming
   * follow, the scroll-to-bottom button — keeps aiming at the bottom and
   * gets this for free. As the answer grows the reserve shrinks, so a long
   * reply scrolls the question up and off exactly as it always did.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const anchor = anchorRef.current;
    if (!el || !content || !anchor) {
      setTailSpace(0);
      return;
    }
    // Measured off the live boxes, with the two things we control ourselves
    // (the padding under the list, and the spacer already in place) taken
    // back out — otherwise each pass would measure its own last answer.
    const reserved = cardClearance + 14 + tailSpace;
    const tailHeight =
      content.getBoundingClientRect().bottom -
      reserved -
      anchor.getBoundingClientRect().top;
    const room = el.clientHeight - (cardClearance + 14) - tailHeight - TOP_GAP;
    const next = Math.max(0, Math.round(room));
    if (Math.abs(next - tailSpace) > 1) setTailSpace(next);
  });

  // Applying the spacer moves the bottom; if the view was following it,
  // follow it to the new one.
  useEffect(() => {
    if (pinnedRef.current) return pinAnchorToTop("auto");
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [tailSpace, pinAnchorToTop]);

  // The composer floats over the messages; composerH positions the
  // scroll-to-bottom button above it. A callback ref, not useRef + a []
  // effect: this component's very first commit can be the "still loading"
  // blank screen (see isLoadingConversation below), with no composer in the
  // tree at all, and an effect with empty deps only ever runs once — against
  // whatever composerRef.current was at that first commit, which was null,
  // forever. A callback ref fires exactly when the node actually attaches.
  const setComposerRef = useCallback((node) => {
    composerObserverRef.current?.disconnect();
    if (!node) return;
    // offsetHeight, not contentRect: the bar's own padding is exactly the
    // part that would cover the last line of a message.
    const observer = new ResizeObserver(() => setComposerH(node.offsetHeight));
    setComposerH(node.offsetHeight);
    observer.observe(node);
    composerObserverRef.current = observer;
  }, []);

  // How much space below the messages needs to stay clear of the card:
  // the card's own height, plus the fixed 20px safe-area gap below it
  // (pb-5, on composerRef). Not composer.getBoundingClientRect().bottom -
  // card.getBoundingClientRect().top, which is what this measured at first:
  // both are viewport-relative, and ResizeObserver only fires on *size*
  // changes — when content above the composer changed height without the
  // composer or card itself resizing (a new message arriving, a
  // conversation switch), their positions shifted but no resize fired, and
  // the stale viewport-relative gap silently stopped matching reality. Using
  // the card's own offsetHeight — a size, which is exactly what
  // ResizeObserver tracks — has no such gap between what's observed and
  // what's measured.
  const CARD_BOTTOM_GAP = 20; // px, matches composerRef's pb-5
  const [cardClearance, setCardClearance] = useState(72);
  // A callback ref, not useRef + a [] effect: the card doesn't exist yet on
  // this component's very first commit — that render is the "still loading"
  // blank screen (see isLoadingConversation below), with no card in the tree
  // at all — and an effect with empty deps only ever runs once, against
  // whatever cardRef.current was at that first commit: null, forever. A
  // callback ref instead fires exactly when the node actually attaches
  // (and again if it's ever swapped for a different one), which is what
  // "run once the card exists" actually needs to mean here.
  const setCardRef = useCallback((node) => {
    cardObserverRef.current?.disconnect();
    if (!node) return;
    const measure = () => setCardClearance(node.offsetHeight + CARD_BOTTOM_GAP);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(node);
    cardObserverRef.current = observer;
  }, []);

  // cardClearance starts at a guess (72) and only becomes exact once the
  // observer above has measured the real card — a render *after* the
  // scroll-to-bottom effect near the top of this file already ran and
  // scrolled to the bottom implied by that guess. If the true clearance is
  // taller (a longer model name wrapping the composer to two lines, say),
  // that first scroll lands short by the difference, and nothing
  // re-corrects it: this is why. Gated on followRef, the same flag native
  // scroll/wheel/key input uses to opt a reader out of auto-scrolling — so
  // this only nudges the view while still following, never a position the
  // reader deliberately chose.
  useEffect(() => {
    if (followRef.current) scrollToBottom("auto");
    // Only cardClearance settling matters here; messages/conversation
    // changes are already handled by the load-scroll effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardClearance]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  }, [input]);

  /* ---------- streaming -------------------------------------------------- */

  const stopAndUnqueue = () => {
    // Whatever was waiting goes back into the composer. Draining it the
    // instant you press Stop would be the opposite of what Stop means, and
    // silently dropping it would lose what you typed.
    setQueue((prev) => {
      if (!prev.length) return prev;
      setInput((current) =>
        [...prev.map((q) => q.text).filter(Boolean), current].filter(Boolean).join("\n\n")
      );
      setImages((current) => [...prev.flatMap((q) => q.attached), ...current].slice(0, 4));
      setDocs((current) => [...prev.flatMap((q) => q.documents), ...current].slice(0, 5));
      return [];
    });
  };

  const stop = useCallback(() => {
    if (conversation) api.stopStream(conversation.id).catch(() => {});
  }, [conversation]);

  // Unmounting just disconnects — the run carries on server-side.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Scoped to the conversation the stream belongs to: a run keeps going when
  // you switch chats, and its tokens must not land in the one you switched to.
  const patchLast = (convoId, fn) =>
    setConversation((prev) => {
      if (!prev || (convoId && prev.id !== convoId)) return prev;
      const msgs = [...prev.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") return prev;
      msgs[msgs.length - 1] = fn(last);
      return { ...prev, messages: msgs };
    });

  const streamHandlers = useCallback(
    (convoId) => ({
      // title is authoritative from the server (index.js already applied
      // the rename before this fired) — not conditional on the current
      // title like the client-side guess this replaced, since that guess
      // could itself be stale and this shouldn't defer to it.
      start: ({ id, title }) => {
        patchLast(convoId, (m) => ({ ...m, id }));
        if (title) {
          setConversation((prev) =>
            prev && prev.id === convoId ? { ...prev, title } : prev,
          );
          onConversationRenamed?.(convoId, title);
        }
      },
      // Sent only on re-attach: the message as it stands right now.
      sync: ({ message }) => patchLast(convoId, () => message),
      reasoning: ({ text }) =>
        patchLast(convoId, (m) => ({
          ...m,
          reasoning: (m.reasoning || "") + text,
        })),
      delta: ({ text }) =>
        patchLast(convoId, (m) => ({ ...m, content: m.content + text })),
      done: ({ message }) => patchLast(convoId, () => message),
      error: ({ message }) => {
        setError(message);
        setConversation((prev) =>
          prev && prev.id === convoId
            ? {
                ...prev,
                messages: prev.messages.filter((m) => m.id !== "pending"),
              }
            : prev,
        );
      },
    }),
    [onConversationRenamed],
  );

  const run = useCallback(
    async (convoId, payload) => {
      lastRunRef.current = { convoId, payload };
      ownStreamRef.current = convoId;
      setStreaming(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      // Optimistic assistant bubble so the caret appears immediately.
      setConversation((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: "pending",
                  role: "assistant",
                  content: "",
                  reasoning: "",
                  createdAt: Date.now(),
                },
              ],
            }
          : prev,
      );

      try {
        if (payload.private)
          await api.streamPrivateTurn(
            { ...payload, signal: controller.signal },
            streamHandlers(convoId),
          );
        else
          await api.streamTurn(
            convoId,
            { ...payload, signal: controller.signal },
            streamHandlers(convoId),
          );
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(err.message);
          setConversation((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.filter((m) => m.id !== "pending"),
                }
              : prev,
          );
          // The chat was created for this turn and the request never
          // landed — but "never landed" isn't always true (a stream can die
          // after the server has stored the question), so ask before
          // throwing anything away. An empty row in the sidebar is litter
          // from a failure; one holding a question is the question.
          if (payload.discardIfEmpty && !payload.private) {
            const empty = await api
              .getConversation(convoId)
              .then((res) => res.conversation.messages.length === 0)
              .catch(() => false);
            if (empty) {
              keepErrorRef.current = true;
              onConversationDeleted?.(convoId);
              setConversation(null);
              lastRunRef.current = null;
              // Nothing was kept, so give the turn back to the composer
              // rather than leaving the reader to retype it.
              setInput(payload.restore?.text || "");
              setImages(payload.restore?.attached || []);
              setDocs(payload.restore?.documents || []);
            }
          }
        }
      } finally {
        if (ownStreamRef.current === convoId) ownStreamRef.current = null;
        setStreaming(false);
        abortRef.current = null;
        onConversationsChanged();
      }
    },
    [onConversationDeleted, onConversationsChanged, streamHandlers],
  );

  /* ---------- attachments ------------------------------------------------ */

  // The accept attribute only filters the dialog; the File objects are
  // re-checked here, since the picker can still surface anything (e.g. a
  // drag-and-drop-capable browser honouring only the types it knows).
  const addFiles = async (list) => {
    setImgError(null);
    const next = [];
    let problem = null;
    for (const file of list) {
      if (images.length + next.length >= MAX_ATTACHMENTS) {
        problem = `You can attach up to ${MAX_ATTACHMENTS} images.`;
        break;
      }
      if (!ATTACH_TYPES.includes(file.type)) {
        problem = "Only JPEG, PNG and GIF images can be attached.";
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problem = "Images must be at most 8 MB.";
        continue;
      }
      next.push({
        // name+size+lastModified: stable enough to key the preview, unique
        // enough that re-picking a same-named file still adds a second slot.
        id: `${file.name}-${file.size}-${file.lastModified}-${file.type}`,
        name: file.name,
        url: await fileToDataUrl(file),
      });
    }
    if (next.length) setImages((prev) => [...prev, ...next]);
    setImgError(problem);
  };

  /**
   * Files arriving by paste or drop, which can be either kind: photos for
   * the model, or a Claude data export to turn into history. The export is
   * the only non-image we accept, and it's recognised the same way the
   * server does — a .zip or a .json.
   */
  const acceptFiles = async (list) => {
    const files = [...list];
    if (!files.length) return;
    setNotice(null);

    // A .zip is always an export; a .json only counts as one if it parses
    // as a chat list, which the server decides — so a dropped .json goes to
    // the importer, and everything else that reads as text becomes an
    // attachment for this turn.
    const isExport = (f) =>
      /\.(zip|json)$/i.test(f.name) || f.type === "application/zip";
    const exports_ = onImportChats ? files.filter(isExport) : [];
    const rest = files.filter((f) => !exports_.includes(f));
    const texts = rest.filter(isTextFile);
    const pictures = rest.filter((f) => !texts.includes(f));

    if (texts.length) await addDocs(texts);
    if (pictures.length) {
      if (activeModel?.vision) await addFiles(pictures);
      else setImgError(`${activeModel?.label || "This model"} can't look at images.`);
    }

    for (const file of exports_) {
      setNotice(`Importing ${file.name}…`);
      try {
        const result = await onImportChats(file);
        setNotice(importedSummary(result));
      } catch (err) {
        setNotice(null);
        setImgError(err.message);
      }
    }
  };

  /** Read dropped/picked text files in as attachments. */
  const addDocs = async (files) => {
    const next = [];
    let problem = null;
    for (const file of files) {
      if (docs.length + next.length >= MAX_DOCS) {
        problem = `You can attach up to ${MAX_DOCS} documents.`;
        break;
      }
      if (file.size > MAX_DOC_BYTES) {
        problem = `${file.name} is larger than 400 KB.`;
        continue;
      }
      const text = await file.text();
      if (!text.trim()) continue;
      next.push({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, text });
    }
    if (next.length) setDocs((prev) => [...prev, ...next]);
    if (problem) setImgError(problem);
  };

  const removeDoc = (id) => setDocs((prev) => prev.filter((d) => d.id !== id));

  /**
   * Fetch a pasted link and attach what it says.
   *
   * The chip appears immediately, reading, and fills in with the page's own
   * title and length — or with what went wrong, which stays on screen as a
   * chip you dismiss rather than an error that replaces your turn.
   */
  const readLink = async (url) => {
    const id = `url-${Date.now()}`;
    const host = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return url;
      }
    })();

    setDocs((prev) => [...prev, { id, name: host, url, text: "", reading: true }]);
    try {
      const { page } = await api.readUrl(url);
      setDocs((prev) =>
        prev.map((d) =>
          d.id === id
            ? { id, name: page.title, url: page.url, text: page.text, truncated: page.truncated }
            : d
        )
      );
    } catch (err) {
      setDocs((prev) =>
        prev.map((d) => (d.id === id ? { ...d, reading: false, failed: err.message } : d))
      );
    }
  };

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      acceptFiles(files);
      return;
    }

    const text = (e.clipboardData?.getData("text/plain") || "").trim();

    // A link on its own gets read: the server fetches the page and the
    // article arrives as an attachment, so "what does this say?" works on
    // something the model can actually see.
    if (BARE_URL.test(text) && docs.length < MAX_DOCS) {
      e.preventDefault();
      readLink(text);
      return;
    }

    // A paste long enough to be a document becomes one, so the composer
    // stays a place you can see what you're asking.
    if (text.length < PASTE_AS_DOC_CHARS || docs.length >= MAX_DOCS) return;
    e.preventDefault();
    setDocs((prev) => [
      ...prev,
      { id: `paste-${Date.now()}`, name: titleForPaste(text), text, pasted: true },
    ]);
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    acceptFiles(e.dataTransfer?.files || []);
  };

  const dragProps = {
    onDragEnter: (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e) => {
      if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop,
  };

  const removeImage = (id) =>
    setImages((prev) => prev.filter((img) => img.id !== id));

  /**
   * Send one turn: the composer's, or one that was queued while an answer
   * was still arriving. Everything about a turn travels in the argument, so
   * a queued one goes out through the same path as a typed one rather than
   * through a second, subtly different one.
   */
  const deliver = useCallback(async ({ text, attached, documents }) => {
    if (
      (!text && !attached.length && !documents.length) ||
      streaming ||
      !activeModel ||
      sendingRef.current
    )
      return;
    sendingRef.current = true;
    try {
      let convoId = conversation?.id;
      const hadConversation = !!convoId;

      // The conversation is created on the first message, so empty shells
      // never pile up in the sidebar. A private chat has none to create.
      if (!convoId && !privateMode) {
        try {
          const { conversation: created } = await api.createConversation(
            activeModel.id,
          );
          convoId = created.id;
          idRef.current = convoId;
          // Claimed before the id goes active: onConversationCreated is what
          // triggers the loader effect, and it must already see this as ours.
          ownStreamRef.current = convoId;
          setConversation(created);
          onConversationCreated(created);
        } catch (err) {
          setError(err.message);
          setInput(text);
          setImages(attached);
          setDocs(documents);
          return;
        }
      }

      // The header's title used to be guessed here client-side, mirroring
      // the server's rename-on-first-message logic — but a guess computed
      // independently of the server can race with a stale refetch and lose.
      // The stream's own "start" event now carries the server's
      // authoritative title instead (see streamHandlers), which arrives
      // moments after this and can't be wrong, so there's nothing left to
      // compute here.
      // Same shape the server persists (data-URL strings for photos, name +
      // text for documents), so the bubble renders identically before the
      // refresh round-trip — and so the private path can send it as history.
      const turn = {
        id: "local",
        role: "user",
        content: text,
        images: attached.map((img) => img.url),
        // Only what was actually read: a link still loading, or one that
        // couldn't be fetched, is not something to hand the model.
        attachments: documents
          .filter((d) => d.text && !d.failed)
          .map((d) => ({ name: d.name, text: d.text, ...(d.url ? { url: d.url } : {}) })),
        createdAt: Date.now(),
      };

      setConversation((prev) =>
        prev ? { ...prev, messages: [...prev.messages, turn] } : prev,
      );

      const fresh = !hadConversation;
      await run(convoId, {
        content: text,
        endpointId: activeModel.id,
        images: turn.images,
        attachments: turn.attachments,
        skillIds,
        useKnowledge,
        // A first turn that never produced a message leaves an empty chat
        // in the sidebar; run() clears it up rather than stranding it, and
        // hands the text and photos back to the composer. Neither field is
        // sent to the server — streamTurn builds its body from named fields.
        discardIfEmpty: fresh,
        restore: { text, attached, documents },
        // A private turn carries the whole exchange with it: the server
        // has nothing stored to append to.
        ...(privateMode
          ? { private: true, messages: [...(conversation?.messages || []), turn] }
          : {}),
      });
    } finally {
      sendingRef.current = false;
    }
  }, [
    activeModel,
    conversation,
    onConversationCreated,
    privateMode,
    run,
    skillIds,
    streaming,
    useKnowledge,
  ]);

  /* ---------- the queue --------------------------------------------------
   *
   * A question that occurs to you while the model is still answering the
   * last one shouldn't have to wait in your head. Enter queues it, the
   * queue drains itself when the answer lands, and the composer is free
   * again immediately.
   */
  const [queue, setQueue] = useState([]);

  const compose = () => ({
    text: input.trim(),
    attached: images,
    documents: docs.filter((d) => d.text && !d.failed),
  });

  const clearComposer = () => {
    setInput("");
    setImages([]);
    setDocs([]);
  };

  const send = useCallback(() => {
    const turn = compose();
    if (!turn.text && !turn.attached.length && !turn.documents.length) return;

    if (streaming) {
      setQueue((prev) => [...prev, { ...turn, id: `q-${Date.now()}` }]);
      clearComposer();
      return;
    }
    clearComposer();
    deliver(turn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliver, docs, images, input, streaming]);

  // Drain: one turn per run, and only when a run has genuinely finished.
  useEffect(() => {
    if (streaming || !queue.length || sendingRef.current) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    deliver(next);
  }, [streaming, queue, deliver]);

  const unqueue = (id) => setQueue((prev) => prev.filter((q) => q.id !== id));

  const regenerate = useCallback(async () => {
    if (!conversation || streaming || !activeModel || sendingRef.current) return;
    sendingRef.current = true;
    try {
      setConversation((prev) => ({
        ...prev,
        messages: prev.messages.filter(
          (m, i) =>
            !(m.role === "assistant" && i === prev.messages.length - 1),
        ),
      }));
      const trimmed = conversation.messages.filter(
        (m, i) => !(m.role === "assistant" && i === conversation.messages.length - 1),
      );
      await run(conversation.id, {
        regenerate: true,
        endpointId: activeModel.id,
        ...(privateMode
          ? { private: true, messages: trimmed, skillIds, useKnowledge }
          : {}),
      });
    } finally {
      sendingRef.current = false;
    }
  }, [activeModel, conversation, privateMode, run, skillIds, streaming]);

  /**
   * Try the failed turn again.
   *
   * Which "again" depends on where it broke. If the question made it into
   * the conversation before the model server fell over — the common case,
   * since the turn is stored before the upstream is called — re-sending the
   * text would ask it twice, so this regenerates instead. If nothing was
   * stored (the request never landed, or the conversation itself couldn't
   * be created) it replays the original payload.
   */
  const retry = useCallback(async () => {
    setError(null);
    const tail = messages[messages.length - 1];
    if (tail?.role === "user") return regenerate();

    const last = lastRunRef.current;
    if (last) await run(last.convoId, last.payload);
  }, [messages, regenerate, run]);

  /* ---------- message actions -------------------------------------------- */

  const removeMessage = async (messageId) => {
    if (!conversation) return;

    // Private chats have no server copy to delete from — the transcript on
    // screen is the only one there is.
    if (privateMode) {
      setConversation((prev) => {
        if (!prev) return prev;
        const at = prev.messages.findIndex((m) => m.id === messageId);
        if (at === -1) return prev;
        let end = at + 1;
        if (prev.messages[at].role === "user")
          while (prev.messages[end]?.role === "assistant") end++;
        const messages = [...prev.messages];
        messages.splice(at, end - at);
        return { ...prev, messages };
      });
      return;
    }

    try {
      const { conversation: next } = await api.deleteMessage(
        conversation.id,
        messageId,
      );
      if (next.messages.length === 0) {
        // Nothing left to show — an empty shell in the sidebar would just be
        // clutter, so the conversation goes with its last message.
        await onConversationDeleted(conversation.id);
      } else {
        setConversation(next);
        onConversationsChanged();
      }
    } catch (err) {
      // A second click that lands before the first delete commits 404s;
      // surface it rather than letting the rejection go unhandled.
      setError(err.message);
    }
  };

  const submitEdit = async () => {
    if (!conversation || !editing) return;
    const text = editing.text.trim();
    const images = editing.images || [];
    // Same rule as a new turn: dropping every photo *and* the text would
    // leave nothing to re-answer.
    if (!text && !images.length) return;

    if (privateMode) {
      // Same edit, applied where the transcript actually lives.
      const at = conversation.messages.findIndex((m) => m.id === editing.id);
      const messages = conversation.messages.slice(0, at + 1);
      messages[at] = { ...messages[at], content: text, images };
      const next = { ...conversation, messages };
      setConversation(next);
      setEditing(null);
      await run(conversation.id, {
        regenerate: true,
        endpointId: activeModel.id,
        private: true,
        messages,
        skillIds,
        useKnowledge,
      });
      return;
    }

    const { conversation: next } = await api.editMessage(
      conversation.id,
      editing.id,
      text,
      images,
    );
    setConversation(next);
    setEditing(null);
    await run(conversation.id, {
      regenerate: true,
      endpointId: activeModel.id,
    });
  };

  const startTitleEdit = () => {
    if (!conversation) return;
    setTitleDraft(conversation.title);
    setTitleEditing(true);
  };

  const submitTitleEdit = async () => {
    const title = titleDraft.trim();
    setTitleEditing(false);
    // Empty or unchanged: nothing worth a round trip for.
    if (!title || !conversation || title === conversation.title) return;

    // Optimistic: the rename is a single string on a record the user is
    // already looking at, not worth a loading state for.
    setConversation((prev) => (prev ? { ...prev, title } : prev));
    try {
      await api.renameConversation(conversation.id, title);
      onConversationsChanged();
    } catch (err) {
      setError(err.message);
      setConversation((prev) =>
        prev ? { ...prev, title: conversation.title } : prev,
      );
    }
  };

  // copyText falls back to execCommand('copy') on an insecure origin (a
  // phone hitting this over plain HTTP on a LAN IP), where
  // navigator.clipboard is undefined.
  const copy = (text) => copyText(text);

  // On a phone, Enter just inserts a newline — there's no Shift+Enter
  // escape hatch on a software keyboard, so treating Enter as send there
  // means there's no way to write a multi-line message without it firing
  // early. The send button is always right there for actually sending.
  const onKeyDown = (e) => {
    // While the slash menu is up it owns the keys that move through it —
    // including Enter, which picks rather than sends. Nothing else is
    // intercepted, so typing to filter still just types.
    if (slashOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : slashMatches.length - 1;
        return setSlashAt((at) => (at + step) % slashMatches.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return pickSkill(slashMatches[slashAt] || slashMatches[0]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setSlashDismissed(true);
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !isPhone()) {
      e.preventDefault();
      send();
    }
  };

  /* ---------- render ----------------------------------------------------- */

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  // A conversation en route (a deep link, a refresh) but not caught up yet:
  // rather than a half-built header/composer that fills in a moment later,
  // show nothing at all until there's something real to show.
  if (isLoadingConversation) {
    return <div className="min-w-0 flex-1 bg-[var(--bg)]" />;
  }

  return (
    // The panel sits beside the conversation rather than over it: an
    // artifact is usually something you're still talking about, and a modal
    // would put the thing and the discussion of it on different screens.
    <ArtifactContext.Provider value={openArtifact}>
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 animate-fade-in flex-1 flex-col">
      {/* translateZ(0) promotes the bar to its own compositor layer. iOS
          Safari otherwise leaves it behind by a frame — smearing the border
          — while the composer's keyboard-driven resize repaints beneath it. */}
      <header
        style={{ transform: "translateZ(0)" }}
        className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3
                   border-b border-[var(--border)] bg-[var(--bg)] px-4"
      >
        {!sidebarOpen && (
          <button
            onClick={onShowSidebar}
            title="Show sidebar"
            className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            <IconPanel className="h-[18px] w-[18px] shrink-0" />
          </button>
        )}
        {privateMode ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[length:var(--fs-base2)]
                           text-[var(--text-soft)]">
            <IconGhost className="h-[17px] w-[17px] shrink-0" />
            Private chat
            <span className="truncate text-[length:var(--fs-xs)] text-[var(--muted)]">
              — not saved anywhere
            </span>
          </span>
        ) : titleEditing ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={submitTitleEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur(); // -> onBlur saves
              if (e.key === "Escape") setTitleEditing(false);
            }}
            onFocus={(e) => e.currentTarget.select()}
            // max-w-sm, not flex-1 alone: with nothing else in the header to
            // share the row with, flex-1 stretched even a short title's
            // clickable width all the way to the header's far edge.
            className="min-w-0 max-w-sm flex-1 truncate bg-transparent text-[length:var(--fs-base2)]
                       text-[var(--text-soft)] focus:outline-none"
          />
        ) : (
          <span
            // Only once a conversation — and so a real title — exists: the
            // "New chat" placeholder before the first message isn't a title
            // to rename yet, there's nothing to send a PATCH for.
            onClick={conversation ? startTitleEdit : undefined}
            title={conversation ? "Rename" : undefined}
            className={`min-w-0 max-w-sm flex-1 truncate px-1 -mx-1 text-[length:var(--fs-base2)]
                        text-[var(--text-soft)]
                        ${conversation ? "cursor-text" : ""}`}
          >
            {conversation?.title || "New chat"}
          </span>
        )}

        {/* The right of the bar was empty. It now says what is answering in
            this conversation and whether that model is loaded — the two
            facts you'd otherwise open the picker to check. */}
        {!conversation && activeModel && (
          <span className="ml-auto flex shrink-0 items-center gap-2 pr-1 max-md:hidden">
            {modelStatus[activeModel.id] === "loaded" && (
              <span
                title="Loaded in memory"
                className="h-[6px] w-[6px] rounded-full bg-[var(--ok)]"
              />
            )}
            <span className="ui-label">{activeModel.label}</span>
          </span>
        )}
        {/* Private chat: a state this conversation can be in, so it belongs
            with the conversation rather than in the sidebar's list of
            destinations. No filled background — it's a mode toggle, not a
            button that does something on press. */}
        {onTogglePrivate && !conversation && (
          <button
            onClick={onTogglePrivate}
            aria-label="Private chat"
            aria-pressed={privateMode}
            title={
              privateMode
                ? "Leave the private chat"
                : "Start a private chat — nothing is written down"
            }
            className={`shrink-0 rounded-md p-1.5 transition-colors
                        ${activeModel ? "" : "ml-auto"}
                        ${privateMode
                          ? "text-[var(--accent)]"
                          : "text-[var(--muted)] hover:text-[var(--text)]"}`}
          >
            <IconGhost className="h-[19px] w-[19px]" />
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        {/* Errors sit under the title bar at the top right, not in the
            transcript: a failure isn't part of the conversation, and one
            buried at the end of the messages scrolls away the moment the
            next answer arrives. Dismissible, and replaced rather than
            stacked — only the most recent failure is worth reading. */}
        {error && (
          <div
            role="alert"
            className="absolute right-4 top-3 z-20 flex max-w-sm animate-scale-in items-start gap-2
                       rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)]
                       px-3 py-2.5 text-[13px] text-[var(--danger)]
                       shadow-[var(--shadow-pop)] max-md:left-4 max-md:max-w-none"
          >
            <span className="min-w-0 flex-1">
              {error}
              {(messages.length > 0 || lastRunRef.current) && !streaming && (
                <button
                  onClick={retry}
                  className="ml-2 whitespace-nowrap font-medium underline underline-offset-2
                             hover:opacity-80"
                >
                  Retry
                </button>
              )}
            </span>
            <button
              onClick={() => setError(null)}
              title="Dismiss"
              className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
            >
              <IconX className="h-[14px] w-[14px]" />
            </button>
          </div>
        )}

        <div
          ref={setScrollRef}
          onScroll={onScroll}
          // overflow-y-scroll, not -auto: scrollbars are hidden outright
          // (index.css), so this reserves no gutter and draws nothing — it
          // simply keeps the scroll container's behaviour identical either
          // side of the moment a reply (or an opened reasoning panel) grows
          // past the viewport, instead of switching between two states.
          className="h-full overflow-y-scroll"
        >
          <div
            // Keyed on the conversation so switching chats remounts the list
            // and every message settles in again (each child runs its
            // animate-fade-up). Within a conversation this key is stable, so
            // appending a message only remounts the new row, never the ones
            // already on screen.
            key={conversation?.id ?? "new"}
            // cardClearance, not composerH: the top of composerRef is
            // transparent fade, not the input card, so reserving all of
            // composerH left a visibly larger gap than the layout actually
            // needs. cardClearance is exactly the card's own height plus the
            // safe-area gap below it — the last message sits clear of the
            // card itself, however tall the fade above it happens to be.
            // +14, not +8: the card's own box-shadow bleeds a couple of
            // pixels past its border, and 8px wasn't quite enough clearance
            // to keep that off the last line too.
            ref={contentRef}
            style={{ paddingBottom: cardClearance + 14 }}
            className="mx-auto flex min-h-full max-w-3xl flex-col px-6 pt-10 max-md:px-4 select-none-touch"
          >
            {messages.length === 0 && (
              // m-auto centres it in the column once the column is at least as
              // tall as the scroller.
              // m-auto centres it in the column once the column is at least as
              // tall as the scroller.
              <div className="m-auto text-center">
                <p className="animate-fade-up text-[length:var(--fs-lg)] text-[var(--text-soft)]">
                  {privateMode ? "You're in a private chat" : "What are we testing today?"}
                </p>
                <p className="mt-2 animate-fade-up text-[length:var(--fs-sm2)] text-[var(--faint)]
                            [animation-delay:90ms]">
                  {privateMode
                    ? "Nothing here is written to the server. Closing this view is the delete."
                    : activeModel
                      ? `${activeModel.label}${activeModel.note ? ` · ${activeModel.note}` : ""}`
                      : "No models configured yet."}
                </p>
              </div>
            )}

            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;

              if (m.role === "user") {
                const isAnchor = i === lastUserIndex;
                const isEditing = editing?.id === m.id;
                return (
                  // Index key, not the message id: the assistant bubble is
                  // first mounted as the optimistic "pending" row and then
                  // patched to the server's real id. Keying by id would remount
                  // it at that moment and replay the fade mid-generation; the
                  // index is stable across that swap, so it settles in once.
                  <div
                    key={i}
                    ref={isAnchor ? anchorRef : null}
                    data-message-id={m.id}
                    className={`mb-8 flex animate-fade-up flex-col items-end rounded-xl
                                transition-colors duration-500
                                ${flash === m.id ? "bg-[var(--hover)]" : ""}`}
                  >
                    {isEditing ? (
                      <div className="w-full max-w-[85%]">
                        {/* The photos on the turn, editable the only way
                            that makes sense here: click to see one full
                            size, X to drop it before re-asking. */}
                        {editing.images.length > 0 && (
                          <div className="mb-2 flex flex-wrap justify-end gap-2">
                            {editing.images.map((url, j) => (
                              <div key={`${m.id}-edit-${j}`} className="relative animate-scale-in">
                                <PreviewableImage
                                  src={url}
                                  alt={`Attached image ${j + 1}`}
                                  className="h-16 w-16 rounded-lg object-cover"
                                />
                                <button
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() =>
                                    setEditing((prev) => ({
                                      ...prev,
                                      images: prev.images.filter((u) => u !== url),
                                    }))
                                  }
                                  title="Remove image"
                                  className="absolute -right-1.5 -top-1.5 rounded-full
                                             border border-[var(--border)] bg-[var(--raised)] p-[3px]
                                             text-[var(--muted)] hover:text-[var(--text)]"
                                >
                                  <IconX className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <textarea
                          value={editing.text}
                          autoFocus
                          onChange={(e) =>
                            setEditing({ ...editing, text: e.target.value })
                          }
                          rows={3}
                          className="w-full resize-y rounded-2xl border border-[var(--border-strong)]
                                   bg-[var(--raised)] px-4 py-3 text-[length:var(--fs-md)] leading-[1.65]
                                   focus:border-[var(--focus)] focus:outline-none"
                        />
                        <div className="mt-2 flex justify-end gap-2 text-[13px]">
                          {/* onMouseDown + preventDefault, not just onClick: without
                              it, tapping either button on Android first blurs the
                              textarea (dismissing the keyboard) before the click is
                              delivered — the tap lands, but only to close the
                              keyboard, and Save/Cancel need a second tap to actually
                              register. Preventing the mousedown's default keeps focus
                              on the textarea until the click itself fires. */}
                          <button
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setEditing(null)}
                            className="rounded-lg px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
                          >
                            Cancel
                          </button>
                          <button
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={submitEdit}
                            disabled={!editing.text.trim() && !editing.images.length}
                            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[var(--accent-fg)]
                                       disabled:opacity-40"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div
                          className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md
                                      bg-[var(--hover)] px-4 py-2.5 font-sans
                                      text-[length:var(--fs-md)] leading-[1.65]"
                        >
                          {m.attachments?.length > 0 && (
                            <span className="mb-1.5 flex flex-col gap-1">
                              {m.attachments.map((doc, j) => (
                                <a
                                  key={`${m.id}-doc-${j}`}
                                  href={doc.url || undefined}
                                  target={doc.url ? "_blank" : undefined}
                                  rel={doc.url ? "noreferrer" : undefined}
                                  title={doc.url || doc.text?.slice(0, 400)}
                                  className={`flex items-center gap-1.5 rounded-md bg-[var(--panel)]
                                              px-2 py-1 text-[length:var(--fs-xs)] text-[var(--text-soft)]
                                              ${doc.url ? "hover:bg-[var(--hover)]" : ""}`}
                                >
                                  {doc.url ? (
                                    <IconLink className="h-[13px] w-[13px] shrink-0 text-[var(--muted)]" />
                                  ) : (
                                    <IconFileText className="h-[13px] w-[13px] shrink-0 text-[var(--muted)]" />
                                  )}
                                  <span className="min-w-0 flex-1 truncate">{doc.name}</span>
                                  <span className="ui-label shrink-0">
                                    {wordCount(doc.text || "").toLocaleString()} w
                                  </span>
                                </a>
                              ))}
                            </span>
                          )}
                          {m.images?.length > 0 && (
                            <span className="mb-1.5 flex flex-wrap gap-1.5">
                              {m.images.map((url, j) => (
                                <PreviewableImage
                                  key={`${m.id}-${j}`}
                                  src={url}
                                  alt={`Attached image ${j + 1}`}
                                  className="max-h-32 max-w-[220px] rounded-lg object-cover"
                                />
                              ))}
                            </span>
                          )}
                          {m.content}
                        </div>
                        <MessageActions
                          timestamp={m.createdAt}
                          hidden={streaming}
                          onEdit={() =>
                            setEditing({
                              id: m.id,
                              text: m.content,
                              images: m.images || [],
                            })
                          }
                          onCopy={() => copy(m.content)}
                          onDelete={() => removeMessage(m.id)}
                        />
                      </>
                    )}
                  </div>
                );
              }

              return (
                // See the index-key note on the user message above.
                <div
                  key={i}
                  data-message-id={m.id}
                  className={`mb-10 animate-fade-up rounded-xl transition-colors duration-500
                              ${flash === m.id ? "bg-[var(--hover)]" : ""}`}
                >
                  <Reasoning text={m.reasoning} />
                  <div className="answer">
                    <Markdown>{m.content}</Markdown>
                  </div>

                  {/* What the answer had in front of it. Shown after the
                      answer, not before: it's for checking, and checking
                      comes second. */}
                  {m.sources?.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <span className="ui-label">Sources</span>
                      {m.sources.map((source) => {
                        // An <a> without an href is a link that isn't one:
                        // it looks clickable, does nothing, and reads as a
                        // link to a screen reader. Only pages get anchors.
                        const Tag = source.url ? "a" : "span";
                        return (
                          <Tag
                            key={source.id}
                            {...(source.url
                              ? { href: source.url, target: "_blank", rel: "noreferrer" }
                              : {})}
                            className={`flex items-center gap-1 rounded-md bg-[var(--panel)] px-2 py-0.5
                                        text-[length:var(--fs-xs)] text-[var(--text-soft)]
                                        ${source.url ? "hover:bg-[var(--hover)]" : ""}`}
                          >
                            <IconLibrary className="h-[12px] w-[12px] text-[var(--muted)]" />
                            {source.title}
                          </Tag>
                        );
                      })}
                    </div>
                  )}
                  {/* A single blinking caret line says "still thinking";
                      the same caret trails the text once tokens land. */}
                  {streaming && isLast && (
                    <span
                      role="status"
                      aria-label="Thinking"
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px]
                                   animate-caret bg-[var(--accent)]"
                    />
                  )}
                  <MessageActions
                    timestamp={m.createdAt}
                    hidden={streaming && isLast}
                    onRegenerate={m === lastAssistant ? regenerate : undefined}
                    onCopy={() => copy(m.content)}
                    onDelete={() => removeMessage(m.id)}
                  />
                </div>
              );
            })}


            {/* The reserve itself. aria-hidden and inert to everything: it is
                empty layout, not content. */}
            <div aria-hidden style={{ height: tailSpace }} />
          </div>
        </div>

        {!atBottom && messages.length > 0 && (
          <button
            onClick={() => scrollToBottom()}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            style={{ bottom: composerH + 12 }}
            className="absolute left-1/2 z-10 -translate-x-1/2 animate-scale-in rounded-full border
                       border-[var(--border)] bg-[var(--raised)] p-2.5 text-[var(--muted)]
                       shadow-[var(--shadow-pop)] transition-colors
                       hover:text-[var(--text)]"
          >
            <IconArrowDown className="h-[18px] w-[18px]" />
          </button>
        )}

        {/* Floats over the conversation. The top of the bar fades out, so a
            message scrolling past disappears gradually instead of being cut
            off by a hard edge or left half-legible behind a translucent
            panel. The fade+floor is a decorative sibling, not the wrapper's
            own background: the wrapper also parents the model picker, whose
            dropdown can pop up *above* the input row (placement="top") —
            when the mask sat on the wrapper itself, that dropdown was
            composited into the same masked paint group and came out
            half-transparent with a bite taken out of it, since masking a
            parent folds in everything painted within it, including
            children that escape its box via absolute positioning. As a
            sibling that paints first (behind, via DOM order) it can't
            reach content stacked after it.

            The mask, not a gradient built from --bg: a gradient bakes the
            theme colour into the image itself, and background-image can't
            be transitioned (Safari just snaps it) — which, with the colour
            cross-fade below, made this flash to the new theme a beat before
            everything else. A mask only carries opacity, so it stays
            identical across themes and the actual colour is a plain
            background-color, which *does* transition. */}
        <div
          ref={setComposerRef}
          /* pointer-events-none on the wrapper, re-enabled on the card
             below: this box is much taller than the input it holds (pt-14
             plus the padding either side), and all of that empty, merely
             faded area used to swallow touches — so the last couple of lines
             of a reply, visible right above the composer, couldn't be
             scrolled. Now those pixels pass through to the scroller behind. */
          className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-5 pt-14 max-md:px-4"
        >
          <div
            aria-hidden="true"
            style={{
              maskImage:
                "linear-gradient(to bottom, transparent, black 35%, black)",
              WebkitMaskImage:
                "linear-gradient(to bottom, transparent, black 35%, black)",
            }}
            className="pointer-events-none absolute inset-0 bg-[var(--bg)]"
          />
          <div className="pointer-events-auto relative mx-auto max-w-3xl">
            {/* Anchored to the composer and drawn above it, so a long list
                grows upward into the transcript rather than off-screen. */}
            <SlashMenu
              skills={slashMatches}
              active={slashAt}
              attached={skillIds}
              onPick={pickSkill}
              onHover={setSlashAt}
            />
            <div
              ref={setCardRef}
              {...dragProps}
              // The outlined card this used to be: a raised surface with a
              // real edge and a hairline shadow, rounded enough to be soft
              // and not so much that it stops reading as a field. The
              // 32px-radius filled version that replaced it had no edge and
              // no weight, which is what made the whole bottom of the
              // screen go soft.
              className={`relative rounded-2xl border bg-[var(--raised)] p-2.5
                          shadow-[var(--shadow-card)] focus-within:border-[var(--focus)]
                          ${dragging
                            ? "border-dashed border-[var(--focus)]"
                            : "border-[var(--border-strong)]"}`}
            >
              {dragging && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center
                                rounded-2xl bg-[var(--raised)]/90 text-[length:var(--fs-sm)] text-[var(--text-soft)]">
                  Drop images, or a Claude export, here
                </div>
              )}
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                rows={1}
                placeholder={
                  streaming
                    ? "Queue for after this turn…"
                    : `Message ${activeModel?.label ?? "…"}`
                }
                className="w-full resize-none bg-transparent px-2 py-1.5 text-[length:var(--fs-md)] leading-[1.6]
                         text-[var(--text)] placeholder:text-[var(--faint)] focus:outline-none"
              />

              {images.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-1 pt-2">
                  {images.map((img, i) => (
                    <div key={img.id} className="relative animate-scale-in">
                      <PreviewableImage
                        src={img.url}
                        alt={img.name || `Attached image ${i + 1}`}
                        className="h-14 w-14 rounded-lg object-cover"
                      />
                      <button
                        onClick={() => removeImage(img.id)}
                        title="Remove"
                        className="absolute -right-1.5 -top-1.5 rounded-full
                                   border border-[var(--border)] bg-[var(--raised)] p-[3px]
                                   text-[var(--muted)] hover:text-[var(--text)]"
                      >
                        <IconX className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* One place, whether or not any thumbnails made it through:
                  a rejected file (wrong type, too large, over the limit)
                  can arrive alongside accepted ones or entirely alone. */}
              {imgError && (
                <p className="px-1 pt-1.5 text-[12px] text-[var(--danger)]">
                  {imgError}
                </p>
              )}

              {notice && (
                <p className="px-1 pt-1.5 text-[12px] text-[var(--muted)]">
                  {notice}
                </p>
              )}

              {/* Waiting their turn. Shown above everything else in the
                  card because they're already sent as far as the reader is
                  concerned — the composer below is the next thing after
                  these. */}
              {queue.length > 0 && (
                // Chips, not full-width rows. Each one used to stretch the
                // whole card with its remove button pinned to the far edge,
                // which left a hand's width of nothing between a six-letter
                // message and the × that deletes it — and three of them
                // stacked up read as a column of misplaced buttons. A chip
                // is as wide as what's in it, so the × stays next to the
                // thing it removes.
                <div className="flex flex-wrap items-center gap-1.5 px-1 pt-2">
                  <span className="ui-label shrink-0 text-[var(--faint)]">
                    Queued
                  </span>
                  {queue.map((item) => (
                    <span
                      key={item.id}
                      className="inline-flex max-w-full animate-scale-in items-center gap-1.5
                                 rounded-full border border-[var(--border)] bg-[var(--panel-2)]
                                 py-1 pl-2.5 pr-1.5"
                    >
                      <span className="min-w-0 truncate text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                        {item.text ||
                          `${item.documents.length + item.attached.length} attachment(s)`}
                      </span>
                      <button
                        onClick={() => unqueue(item.id)}
                        title="Remove from the queue"
                        className="shrink-0 rounded-full p-0.5 text-[var(--faint)]
                                   hover:bg-[var(--hover)] hover:text-[var(--text)]"
                      >
                        <IconX className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Documents attached to this turn. A pasted article shows
                  what it is and how long it is — the two things you need to
                  know before you send it somewhere. */}
              {docs.length > 0 && (
                <div className="flex flex-col gap-1.5 px-1 pt-2">
                  {docs.map((doc) => (
                    <div
                      key={doc.id}
                      className={`flex animate-scale-in items-center gap-2 rounded-lg border
                                  bg-[var(--panel)] px-2.5 py-1.5
                                  ${doc.failed
                                    ? "border-[var(--danger-border)]"
                                    : "border-[var(--border)]"}`}
                    >
                      {doc.url ? (
                        <IconLink className="h-[15px] w-[15px] shrink-0 text-[var(--muted)]" />
                      ) : (
                        <IconFileText className="h-[15px] w-[15px] shrink-0 text-[var(--muted)]" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm2)]">
                        {doc.name}
                      </span>
                      <span
                        className={`ui-label shrink-0 ${doc.failed ? "text-[var(--danger)]" : ""}`}
                      >
                        {doc.reading
                          ? "Reading…"
                          : doc.failed
                            ? doc.failed
                            : `${doc.pasted ? "Pasted · " : ""}${wordCount(doc.text).toLocaleString()} words`}
                      </span>
                      <button
                        onClick={() => removeDoc(doc.id)}
                        title="Remove"
                        className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:text-[var(--text)]"
                      >
                        <IconX className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Skills riding along with this chat. Kept above the controls
                  row so a long list wraps into the card rather than
                  squeezing the model picker. */}
              {skillIds.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 px-1 pt-2">
                  {skillIds.map((id) => {
                    const skill = skills.find((s) => s.id === id);
                    if (!skill) return null;
                    return (
                      <span
                        key={id}
                        className="flex animate-scale-in items-center gap-1 rounded-full border
                                   border-[var(--border)] bg-[var(--hover)] py-0.5 pl-2 pr-1
                                   text-[length:var(--fs-xs)] text-[var(--text-soft)]"
                      >
                        <IconSparkles className="h-3 w-3 shrink-0" />
                        {skill.name}
                        <button
                          onClick={() => toggleSkill(id)}
                          title={`Detach ${skill.name}`}
                          className="rounded-full p-0.5 text-[var(--muted)] hover:text-[var(--text)]"
                        >
                          <IconX className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center justify-between pt-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* First in the row, before the model picker: attaching a
                      file is what the hand reaches for, and the leading edge
                      of the bar is where it goes.

                      Shown only while a vision-capable model is active —
                      attaching photos to a text-only model would just send
                      bytes it can't see. h-7 w-7 = 28px, the same height as
                      the picker's trigger (py-1 + its 20px text line), so the
                      two line up as one control. Opens the native picker; the
                      accept list is the first gate, addFiles re-checks every
                      file. */}
                  {/* Always here: every model can read a document, even the
                      ones that can't look at a photo. The accept list is what
                      narrows, and addFiles re-checks whatever arrives. */}
                  <>
                      <button
                        onClick={() => fileRef.current?.click()}
                        disabled={streaming}
                        title={
                          activeModel?.vision
                            ? "Attach a document or photo"
                            : "Attach a document"
                        }
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md
                                   text-[var(--muted)] transition-colors hover:bg-[var(--hover)]
                                   disabled:opacity-50"
                      >
                        <IconPlus className="h-[18px] w-[18px]" />
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept={
                          activeModel?.vision
                            ? "image/jpeg,image/png,image/gif,.txt,.md,.markdown,.csv,.log,.rst"
                            : ".txt,.md,.markdown,.csv,.log,.rst,text/plain"
                        }
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          acceptFiles([...e.target.files]);
                          e.target.value = ""; // allow re-picking the same file
                        }}
                      />
                  </>

                  <ModelPicker
                    models={models}
                    value={activeModel?.id}
                    onChange={onModelChange}
                    disabled={streaming}
                    placement="top"
                    status={modelStatus}
                    matchParent
                  />
                  {/* Retrieval, on or off for this conversation. Hidden
                      when the library is empty — a switch with nothing
                      behind it is worse than no switch. */}
                  {knowledge.length > 0 && (
                    <button
                      onClick={() => setUseKnowledge((on) => !on)}
                      title={
                        useKnowledge
                          ? `Looking things up in your ${knowledge.length} document(s)`
                          : "Look things up in your documents"
                      }
                      aria-pressed={useKnowledge}
                      className={`flex h-7 items-center gap-1.5 rounded-lg px-2
                                  text-[length:var(--fs-sm)] transition-colors
                                  ${useKnowledge
                                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                                    : "text-[var(--muted)] hover:bg-[var(--hover)]"}`}
                    >
                      <IconLibrary className="h-[17px] w-[17px]" />
                    </button>
                  )}

                  {/* Skills: the user's own named instruction blocks. Hidden
                      entirely when none are defined — an empty menu is worse
                      than no button. */}
                  {optional.length > 0 && (
                    <div ref={skillsRef} className="relative">
                      <button
                        onClick={() => setSkillsOpen((open) => !open)}
                        title="Use a skill"
                        aria-haspopup="menu"
                        aria-expanded={skillsOpen}
                        className={`flex h-7 items-center gap-1.5 rounded-lg px-2
                                    text-[length:var(--fs-sm)] transition-colors
                                    ${skillIds.length || skillsOpen
                                      ? "bg-[var(--hover)] text-[var(--text)]"
                                      : "text-[var(--muted)] hover:bg-[var(--hover)]"}`}
                      >
                        <IconSparkles className="h-[17px] w-[17px]" />
                        {skillIds.length > 0 && skillIds.length}
                      </button>

                      {skillsOpen && (
                        <div
                          role="menu"
                          className="absolute bottom-full left-0 z-20 mb-2 w-64 animate-scale-in
                                     rounded-xl border border-[var(--border)] bg-[var(--raised)] p-1.5
                                     shadow-[var(--shadow-pop)]"
                        >
                          {optional.map((skill) => (
                            <button
                              key={skill.id}
                              onClick={() => toggleSkill(skill.id)}
                              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left
                                         hover:bg-[var(--hover)]"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[length:var(--fs-sm2)]">
                                  {skill.name}
                                </span>
                                {skill.description && (
                                  <span className="block truncate text-[length:var(--fs-xs)] text-[var(--muted)]">
                                    {skill.description}
                                  </span>
                                )}
                              </span>
                              {skillIds.includes(skill.id) && (
                                <IconCheck className="mt-0.5 h-[15px] w-[15px] shrink-0" />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                </div>

                {streaming ? (
                  <button
                    onClick={() => {
                      stopAndUnqueue();
                      stop();
                    }}
                    title="Stop generating"
                    className="rounded-lg bg-[var(--text)] p-2 text-[var(--bg)]
                               transition-transform duration-150 active:scale-95"
                  >
                    <IconStop className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={send}
                    disabled={
                      (!input.trim() && !images.length && !docs.length) || !activeModel
                    }
                    title="Send"
                    className="rounded-lg bg-[var(--text)] p-2 text-[var(--bg)]
                             transition-[background-color,opacity,scale] duration-150
                             active:scale-95 hover:opacity-90 disabled:cursor-not-allowed
                             disabled:bg-[var(--border)] disabled:text-[var(--muted)]
                             disabled:active:scale-100"
                  >
                    <IconArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
          </div>
        </div>
        {artifact && <ArtifactPanel artifact={artifact} onClose={closeArtifact} />}
      </div>
    </ArtifactContext.Provider>
  );
}
