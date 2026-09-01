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
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronRight,
  IconPanel,
  IconPlus,
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
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// Breathing room above a question pinned to the top of the viewport.
const TOP_GAP = 24;

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
  // Depth counter, not a boolean: dragging over a child fires dragleave on
  // the parent, and a boolean would flicker the highlight off mid-drag.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  // Import progress and its result. Separate from imgError: "Imported 240
  // chats" is good news, and shouldn't be painted in the danger colour.
  const [notice, setNotice] = useState(null);
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
    (!!conversationId && conversation === null) ||
    (!conversationId && !modelsLoaded);
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
    setError(null);
    setEditing(null);

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
  }, [conversationId]);

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
    // Reaching the end again resumes following. Our own auto-scroll only runs
    // while following is already on, so this can't switch itself back on.
    if (gap < 24) followRef.current = true;
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

    const onWheel = (e) => e.deltaY < 0 && breakAway();

    // Dragging the content downwards is scrolling upwards.
    let touchY = null;
    const onTouchStart = (e) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e) => {
      const y = e.touches[0]?.clientY ?? null;
      if (touchY !== null && y !== null && y > touchY + 2) breakAway();
      if (y !== null) touchY = y;
    };

    // On window, not the scroller: an unfocusable div never sees a keydown,
    // and the composer must keep its own arrow keys.
    const up = new Set(["PageUp", "ArrowUp", "Home"]);
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || e.target?.isContentEditable)
        return;
      if (up.has(e.key)) breakAway();
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
  const settledConvoRef = useRef(null);
  useEffect(() => {
    const firstSettle = settledConvoRef.current !== conversation?.id;
    settledConvoRef.current = conversation?.id ?? null;
    if (firstSettle) {
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
        }
      } finally {
        if (ownStreamRef.current === convoId) ownStreamRef.current = null;
        setStreaming(false);
        abortRef.current = null;
        onConversationsChanged();
      }
    },
    [onConversationsChanged, streamHandlers],
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

    const isExport = (f) =>
      /\.(zip|json)$/i.test(f.name) || f.type === "application/zip";
    const exports_ = onImportChats ? files.filter(isExport) : [];
    const rest = files.filter((f) => !exports_.includes(f));

    if (rest.length) await addFiles(rest);

    for (const file of exports_) {
      setNotice(`Importing ${file.name}…`);
      try {
        const result = await onImportChats(file);
        setNotice(
          `Imported ${result.imported} chat${result.imported === 1 ? "" : "s"} from ${file.name}.`
        );
      } catch (err) {
        setNotice(null);
        setImgError(err.message);
      }
    }
  };

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return; // plain text pastes stay untouched
    e.preventDefault();
    acceptFiles(files);
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

  const send = useCallback(async () => {
    const text = input.trim();
    const attached = images;
    // Text, photos, or both — but not an empty turn.
    if ((!text && !attached.length) || streaming || !activeModel || sendingRef.current) return;
    sendingRef.current = true;
    try {
      setInput("");
      setImages([]);
      let convoId = conversation?.id;

      // The conversation is created on the first message, so empty shells
      // never pile up in the sidebar.
      if (!convoId) {
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
      setConversation((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: "local",
                  role: "user",
                  content: text,
                  // Same shape the server persists (data-URL strings), so the
                  // bubble renders identically before the refresh round-trip.
                  images: attached.map((img) => img.url),
                  createdAt: Date.now(),
                },
              ],
            }
          : prev,
      );

      await run(convoId, {
        content: text,
        endpointId: activeModel.id,
        images: attached.map((img) => img.url),
      });
    } finally {
      sendingRef.current = false;
    }
  }, [activeModel, conversation, images, input, onConversationCreated, run, streaming]);

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
      await run(conversation.id, {
        regenerate: true,
        endpointId: activeModel.id,
      });
    } finally {
      sendingRef.current = false;
    }
  }, [activeModel, conversation, run, streaming]);

  /* ---------- message actions -------------------------------------------- */

  const removeMessage = async (messageId) => {
    if (!conversation) return;
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
        {titleEditing ? (
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
      </header>

      <div className="relative min-h-0 flex-1">
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
              <div className="m-auto text-center">
                <p className="animate-fade-up text-[length:var(--fs-lg)] text-[var(--text-soft)]">
                  What are we testing today?
                </p>
                <p className="mt-2 animate-fade-up text-[length:var(--fs-sm2)] text-[var(--faint)]
                            [animation-delay:90ms]">
                  {activeModel
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
                    className="mb-8 flex animate-fade-up flex-col items-end"
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
                            className="rounded-lg bg-[var(--text)] px-3 py-1.5 text-[var(--bg)]
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
                                      bg-[var(--hover)] px-4 py-2.5 text-[length:var(--fs-md)] leading-[1.65]"
                        >
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
                <div key={i} className="mb-10 animate-fade-up">
                  <Reasoning text={m.reasoning} />
                  <Markdown>{m.content}</Markdown>
                  {/* A single blinking caret line says "still thinking";
                      the same caret trails the text once tokens land. */}
                  {streaming && isLast && (
                    <span
                      role="status"
                      aria-label="Thinking"
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px]
                                   animate-caret bg-[var(--muted)]"
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

            {error && (
              <div
                className="mb-8 animate-fade-up rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)]
                            px-4 py-3 text-[14px] text-[var(--danger)]"
              >
                {error}
              </div>
            )}

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
                       shadow-[0_2px_10px_rgba(0,0,0,0.15)] transition-colors
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
            <div
              ref={setCardRef}
              {...dragProps}
              className={`relative rounded-2xl border bg-[var(--raised)] p-2.5
                          shadow-[0_1px_3px_rgba(0,0,0,0.04)] focus-within:border-[var(--focus)]
                          ${dragging
                            ? "border-[var(--focus)] border-dashed"
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
                placeholder={`Message ${activeModel?.label ?? "…"}`}
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

              <div className="flex items-center justify-between pt-1">
                <div className="flex min-w-0 items-center gap-1">
                  <ModelPicker
                    models={models}
                    value={activeModel?.id}
                    onChange={onModelChange}
                    disabled={streaming}
                    placement="top"
                    status={modelStatus}
                    matchParent
                  />
                  {/* Shown only while a vision-capable model is active —
                      attaching photos to a text-only model would just send
                      bytes it can't see. h-7 w-7 = 28px, the same height as
                      the picker's trigger (py-1 + its 20px text line), so
                      the pair reads as one control. Opens the native picker;
                      the accept list is the first gate, addFiles re-checks
                      every file. */}
                  {activeModel?.vision && (
                    <>
                      <button
                        onClick={() => fileRef.current?.click()}
                        disabled={streaming}
                        title="Attach photos (JPEG, PNG or GIF)"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md
                                   text-[var(--muted)] transition-colors hover:bg-[var(--panel)]
                                   disabled:opacity-50"
                      >
                        <IconPlus className="h-[18px] w-[18px]" />
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/jpeg,image/png,image/gif"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          addFiles([...e.target.files]);
                          e.target.value = ""; // allow re-picking the same file
                        }}
                      />
                    </>
                  )}
                </div>

                {streaming ? (
                  <button
                    onClick={stop}
                    title="Stop generating"
                    className="rounded-lg bg-[var(--text)] p-2 text-[var(--bg)]
                               transition-transform duration-150 active:scale-95"
                  >
                    <IconStop className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={send}
                    disabled={(!input.trim() && images.length === 0) || !activeModel}
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
  );
}
