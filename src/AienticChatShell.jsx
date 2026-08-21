import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api.js";
import { isPhone } from "./isPhone.js";
import Markdown from "./Markdown.jsx";
import MessageActions from "./MessageActions.jsx";
import ModelPicker from "./ModelPicker.jsx";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronRight,
  IconPanel,
  IconStop,
} from "./Icons.jsx";

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
          className={`-ml-[5px] h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        Reasoning
      </button>

      {open && (
        <div
          className="mt-2 whitespace-pre-wrap border-l-2 border-[var(--border-strong)] pl-3.5
                        text-[length:var(--fs-meta)] leading-[1.7] text-[var(--muted)]"
        >
          {text}
        </div>
      )}
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
  onConversationDeleted,
  sidebarOpen,
  onShowSidebar,
}) {
  const [conversation, setConversation] = useState(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, text }
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [atBottom, setAtBottom] = useState(true);

  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  // Whether new tokens still pull the view down. It has to be a ref: setState
  // lands a render later, and at a few dozen tokens a second the auto-scroll
  // would fire once more with the stale value and yank the view back to the
  // bottom — which is what made scrolling up mid-answer impossible.
  const followRef = useRef(true);
  const taRef = useRef(null);
  const idRef = useRef(conversationId);
  // The conversation this component is already streaming itself. Creating a
  // chat makes it the active one, which re-runs the loader below — and that
  // loader would attach a *second* reader to the same run, so every token
  // landed twice ("HereHere's"). One reader per generation.
  const ownStreamRef = useRef(null);
  // Which conversation the state below actually holds, as opposed to which
  // one is selected. They differ for exactly one render after a switch.
  const shownIdRef = useRef(null);
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
  // True for exactly the render(s) between navigating to an existing
  // conversation (by id, e.g. a deep link or a refresh) and its fetch
  // resolving. Without this, that gap looked identical to a genuinely new,
  // empty chat — "New chat" title, the empty-state prompt, "No model" — and
  // then visibly swapped to the real thing a moment later.
  //
  // A fresh /new load on first boot has the same shape of problem even with
  // no conversation to fetch: the model list itself is still in flight, so
  // the composer would show "No model" / "No models configured yet." for a
  // moment before the real list lands. !modelsLoaded covers that gap the
  // same way.
  const isLoadingConversation =
    (!!conversationId && conversation?.id !== conversationId) ||
    (!conversationId && !modelsLoaded);
  const activeModel = useMemo(
    () => models.find((m) => m.id === modelId) || models[0] || null,
    [models, modelId],
  );

  /* ---------- load ------------------------------------------------------- */

  // Declared before the loader so it is already up to date when that runs.
  useEffect(() => {
    shownIdRef.current = conversation?.id ?? null;
  }, [conversation?.id]);

  useEffect(() => {
    idRef.current = conversationId;
    setError(null);
    setEditing(null);

    if (!conversationId) {
      setConversation(null);
      return;
    }

    // We're already reading this run's stream and already showing it, so our
    // state is newer than anything the server would hand back.
    if (
      ownStreamRef.current === conversationId &&
      shownIdRef.current === conversationId
    )
      return;

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
    el.scrollTo({ top: el.scrollHeight, behavior });
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
  const scrollCleanupRef = useRef(null);
  const setScrollRef = useCallback((el) => {
    scrollRef.current = el;
    scrollCleanupRef.current?.();
    scrollCleanupRef.current = null;
    if (!el) return;

    const breakAway = () => {
      followRef.current = false;
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
    scrollToBottom(firstSettle ? "auto" : "smooth");
  }, [messages.length, conversation?.id, scrollToBottom]);

  const tail = messages[messages.length - 1];
  useEffect(() => {
    if (!streaming || !followRef.current) return;
    const el = scrollRef.current;
    // Assigning scrollTop, not scrollTo({behavior:"auto"}): a smooth scroll
    // still in flight from the button would otherwise keep overriding this.
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail?.content, tail?.reasoning, streaming]);

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

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !activeModel) return;

    setInput("");
    let convoId = conversation?.id;

    // The conversation is created on the first message, so empty shells never
    // pile up in the sidebar.
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
        return;
      }
    }

    // The header's title used to be guessed here client-side, mirroring
    // the server's rename-on-first-message logic — but a guess computed
    // independently of the server can race with a stale refetch and lose.
    // The stream's own "start" event now carries the server's authoritative
    // title instead (see streamHandlers), which arrives moments after this
    // and can't be wrong, so there's nothing to compute here any more.
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
                createdAt: Date.now(),
              },
            ],
          }
        : prev,
    );

    await run(convoId, { content: text, endpointId: activeModel.id });
  }, [activeModel, conversation, input, onConversationCreated, run, streaming]);

  const regenerate = useCallback(async () => {
    if (!conversation || streaming || !activeModel) return;
    setConversation((prev) => ({
      ...prev,
      messages: prev.messages.filter(
        (m, i) => !(m.role === "assistant" && i === prev.messages.length - 1),
      ),
    }));
    await run(conversation.id, {
      regenerate: true,
      endpointId: activeModel.id,
    });
  }, [activeModel, conversation, run, streaming]);

  /* ---------- message actions -------------------------------------------- */

  const removeMessage = async (messageId) => {
    if (!conversation) return;
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
  };

  const submitEdit = async () => {
    if (!conversation || !editing) return;
    const text = editing.text.trim();
    if (!text) return;

    const { conversation: next } = await api.editMessage(
      conversation.id,
      editing.id,
      text,
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

  // navigator.clipboard is only defined in a secure context (HTTPS or
  // localhost) — on a phone hitting this over plain HTTP on a LAN IP it's
  // undefined, so the optional chaining silently did nothing while the UI
  // still claimed success. execCommand('copy') still works on an insecure
  // origin, so it's used as the fallback there.
  const copy = async (text) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fall through to the legacy path
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  };

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
    <div className="flex min-w-0 flex-1 flex-col">
      <header style={{ transform: "translateZ(0)" }}
      className="sticky top-0 z-10 bg-[var(--bg)] flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
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
            className={`min-w-0 max-w-sm flex-1 truncate rounded px-1 -mx-1 text-[length:var(--fs-base2)]
                        text-[var(--text-soft)]
                        ${conversation ? "cursor-text hover:bg-[var(--hover)]" : ""}`}
          >
            {conversation?.title || "New chat"}
          </span>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={setScrollRef}
          onScroll={onScroll}
          // overflow-y-scroll, not -auto: the gutter has to exist before
          // content ever needs it. With -auto, the moment a reply (or an
          // opened reasoning panel) crosses the viewport height, a scrollbar
          // appears and the centred column beside it visibly steps sideways.
          // scrollbar-gutter (index.css) covers this in engines that support
          // it; keeping the track always present covers Safari, which still
          // doesn't.
          className="h-full overflow-y-scroll"
        >
          <div
            // cardClearance, not composerH: the top of composerRef is
            // transparent fade, not the input card, so reserving all of
            // composerH left a visibly larger gap than the layout actually
            // needs. cardClearance is exactly the card's own height plus the
            // safe-area gap below it — the last message sits clear of the
            // card itself, however tall the fade above it happens to be.
            // +14, not +8: the card's own box-shadow bleeds a couple of
            // pixels past its border, and 8px wasn't quite enough clearance
            // to keep that off the last line too.
            style={{ paddingBottom: cardClearance + 14 }}
            className="mx-auto flex min-h-full max-w-3xl flex-col px-6 pt-10 max-md:px-4 select-none-touch"
          >
            {messages.length === 0 && (
              // m-auto centres it in the column once the column is at least as
              // tall as the scroller.
              <div className="m-auto text-center">
                <p className="text-[length:var(--fs-lg)] text-[var(--text-soft)]">
                  What are we testing today?
                </p>
                <p className="mt-2 text-[length:var(--fs-sm2)] text-[var(--faint)]">
                  {activeModel
                    ? `${activeModel.label}${activeModel.note ? ` · ${activeModel.note}` : ""}`
                    : "No models configured yet."}
                </p>
              </div>
            )}

            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;

              if (m.role === "user") {
                const isEditing = editing?.id === m.id;
                return (
                  <div key={m.id || i} className="mb-8 flex flex-col items-end">
                    {isEditing ? (
                      <div className="w-full max-w-[85%]">
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
                            className="rounded-lg bg-[var(--text)] px-3 py-1.5 text-[var(--bg)]"
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
                          {m.content}
                        </div>
                        <MessageActions
                          timestamp={m.createdAt}
                          hidden={streaming}
                          onEdit={() =>
                            setEditing({ id: m.id, text: m.content })
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
                <div key={m.id || i} className="mb-10">
                  <Reasoning text={m.reasoning} />
                  <Markdown>{m.content}</Markdown>
                  {streaming && isLast && (
                    <span
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px]
                                   animate-pulse bg-[var(--muted)]"
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
                className="mb-8 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)]
                            px-4 py-3 text-[14px] text-[var(--danger)]"
              >
                {error}
              </div>
            )}
          </div>
        </div>

        {!atBottom && messages.length > 0 && (
          <button
            onClick={() => scrollToBottom()}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            style={{ bottom: composerH + 12 }}
            className="absolute left-1/2 z-10 -translate-x-1/2 rounded-full border
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
              className="rounded-2xl border border-[var(--border-strong)] bg-[var(--raised)] p-2.5
                          shadow-[0_1px_3px_rgba(0,0,0,0.04)]
                          focus-within:border-[var(--focus)]"
            >
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={`Message ${activeModel?.label ?? "…"}`}
                className="w-full resize-none bg-transparent px-2 py-1.5 text-[length:var(--fs-md)] leading-[1.6]
                         text-[var(--text)] placeholder:text-[var(--faint)] focus:outline-none"
              />

              <div className="flex items-center justify-between pt-1">
                <ModelPicker
                  models={models}
                  value={activeModel?.id}
                  onChange={onModelChange}
                  disabled={streaming}
                  placement="top"
                  status={modelStatus}
                  matchParent
                />

                {streaming ? (
                  <button
                    onClick={stop}
                    title="Stop generating"
                    className="rounded-lg bg-[var(--text)] p-2 text-[var(--bg)]"
                  >
                    <IconStop className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={send}
                    disabled={!input.trim() || !activeModel}
                    title="Send"
                    className="rounded-lg bg-[var(--text)] p-2 text-[var(--bg)] transition-opacity
                             hover:opacity-90 disabled:cursor-not-allowed
                             disabled:bg-[var(--border)] disabled:text-[var(--muted)]"
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
