import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.js";
import {
  readTheme,
  applyTheme,
  toggleTheme,
  watchSystemTheme,
} from "./theme.js";
import { readPref, writePref } from "./cookies.js";
import LoginPage from "./LoginPage.jsx";
import SettingsDialog from "./SettingsDialog.jsx";
import Sidebar from "./Sidebar.jsx";
import AienticChatShell from "./AienticChatShell.jsx";
import SamplerPage from "./SamplerPage.jsx";
import AdminPage from "./Admin/AdminPage.jsx";

/**
 * Width-only, deliberately not the shared isPhone() (touch + width): this
 * tracks whether the *layout* is in phone-drawer mode, which is Tailwind's
 * own max-md: breakpoint here (width-only, by design — a narrow window has
 * nowhere to dock a permanent sidebar regardless of touch vs. mouse). Using
 * the touch-gated isPhone() here would desync this from the CSS it exists
 * to track: on a narrow desktop window, max-md: would already be rendering
 * the drawer layout while this stayed "desktop", reopening the exact
 * stuck-drawer-with-backdrop bug the resize listener below was written for.
 */
const isNarrowViewport = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

/**
 * The URL is the only place view + activeId are read from on load or on
 * back/forward — everything else (clicking a chat, "New chat", the nav
 * links) is a plain state update that also pushes the matching path, so the
 * two never drift. /chat/:id and /new both render the chat view; the id is
 * what tells them apart.
 */
const parseRoute = (pathname) => {
  const chat = pathname.match(/^\/chat\/([^/]+)\/?$/);
  if (chat) return { view: "chat", activeId: chat[1] };
  if (pathname === "/new") return { view: "chat", activeId: null };
  // /private is a route so a reload lands back in a private chat rather
  // than a saved one — the transcript is gone either way, but the mode
  // shouldn't silently flip to the one that writes things down.
  if (pathname === "/private") return { view: "private", activeId: null };
  if (pathname === "/sampler") return { view: "sampler", activeId: null };
  if (pathname === "/admin") return { view: "admin", activeId: null };
  return { view: "chat", activeId: null };
};

const routePath = (view, activeId) => {
  if (view === "private") return "/private";
  if (view === "sampler") return "/sampler";
  if (view === "admin") return "/admin";
  return activeId ? `/chat/${activeId}` : "/new";
};

/**
 * Session, navigation and the state the sidebar shares with every page.
 */
export default function App() {
  const [session, setSession] = useState(null); // null while loading
  const [theme, setTheme] = useState(readTheme);

  const initialRoute = useRef(
    typeof window !== "undefined" ? parseRoute(window.location.pathname) : { view: "chat", activeId: null }
  ).current;

  const [view, setView] = useState(initialRoute.view);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isNarrowViewport());
  const [filter, setFilter] = useState("");

  const [models, setModels] = useState([]);
  // Distinct from models.length > 0: a server with no endpoints configured
  // yet is a real, valid state to render ("No models configured yet."), but
  // is indistinguishable from "haven't asked yet" without this.
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelStatus, setModelStatus] = useState({});
  const [modelId, setModelId] = useState(() => readPref("aientic:model"));
  const [conversations, setConversations] = useState([]);
  // Search results, which carry a snippet the plain list doesn't have.
  const [matches, setMatches] = useState([]);
  // false, true, or the section to open at — "Knowledge", from the
  // sidebar's Library entry.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The last rename made from the sidebar, passed down so an open chat's
  // header follows it.
  const [renamed, setRenamed] = useState(null);
  const [activeId, setActiveId] = useState(initialRoute.activeId);

  const user = session?.user ?? null;

  /* ---------- boot ------------------------------------------------------- */

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // isNarrowViewport() only decides the *initial* sidebarOpen — resizing the window
  // afterwards (not a fresh load) didn't re-check it, so shrinking a wide
  // window left the desktop-docked sidebar's markup rendering through the
  // phone layout: an open drawer plus its backdrop overlay, stuck on top of
  // the conversation instead of tucking away like a fresh phone-width load
  // would. Only closes on crossing into phone width — widening back out
  // doesn't reopen it, since that's a real user choice to leave undisturbed.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = (e) => {
      if (e.matches) setSidebarOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Follows the OS theme live, so long as nothing has been chosen here yet —
  // watchSystemTheme itself no-ops once a choice is stored.
  const stopWatchingRef = useRef(null);
  useEffect(() => {
    stopWatchingRef.current = watchSystemTheme(setTheme);
    return () => stopWatchingRef.current?.();
  }, []);

  // An explicit pick wins over the OS from here on — stop following it, this
  // session and every one after.
  const onToggleTheme = () => {
    stopWatchingRef.current?.();
    stopWatchingRef.current = null;
    setTheme(toggleTheme(theme));
  };

  useEffect(() => {
    api
      .getSession()
      .then(setSession)
      .catch(() => setSession({ user: null, needsSetup: false }));
  }, []);

  const refreshConversations = useCallback(
    () =>
      api
        .listConversations()
        .then((res) => setConversations(res.conversations))
        .catch(() => {}),
    []
  );

  /**
   * Search runs on the server, over message text as well as titles — the
   * transcripts never all live in the browser, and the store is a scan away
   * from answering this anyway. Debounced, and each keystroke aborts the
   * request the last one left in flight.
   */
  useEffect(() => {
    const q = filter.trim();
    if (!q) {
      setMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .searchConversations(q, controller.signal)
        .then((res) => setMatches(res.conversations))
        .catch(() => {});
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter]);

  /**
   * A Claude data export, uploaded from the sidebar or dropped on the
   * composer. The server answers with the new history, so the list updates
   * without a second round trip.
   */
  const importChats = useCallback(async (file) => {
    const result = await api.importChats(file);
    setConversations(result.conversations);
    return result;
  }, []);

  const refreshModels = useCallback(
    () =>
      api
        .getModels()
        .then((res) => {
          setModels(res.models);
          // A remembered model that has since been deleted falls back to the first.
          setModelId((current) =>
            res.models.some((m) => m.id === current)
              ? current
              : res.models[0]?.id ?? null
          );
        })
        .catch(() => {})
        .finally(() => setModelsLoaded(true)),
    []
  );

  useEffect(() => {
    if (!user) return;
    refreshConversations();
    refreshModels();
  }, [user, refreshConversations, refreshModels]);

  // Poll which models are loaded in memory. Cheap: the server probes each
  // distinct base URL once and caches for a few seconds, so this is one
  // request regardless of how many models are configured.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const tick = () =>
      api
        .getModelStatus()
        .then((res) => !cancelled && setModelStatus(res.statuses || {}))
        .catch(() => {});

    tick();
    const timer = setInterval(tick, 10000);
    // A tab left open in the background shouldn't keep polling; refresh on
    // return instead, so the dot is current the moment it's looked at.
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user]);

  // Endpoints can change while the admin panel is open, and the chat view is
  // the only place that notices. Re-read the list on every return to it, so
  // the composer can't hold a model list from before an import.
  useEffect(() => {
    if (user && view === "chat") refreshModels();
  }, [user, view, refreshModels]);

  useEffect(() => {
    if (modelId) writePref("aientic:model", modelId);
  }, [modelId]);

  /* ---------- navigation ------------------------------------------------- */

  // Keeps the URL bar in sync with view/activeId for every *internal* state
  // change, without re-pushing when the change came from the URL itself
  // (the popstate handler below sets this ref before updating state).
  const fromPopstateRef = useRef(false);
  const pushRoute = (nextView, nextActiveId, { replace = false } = {}) => {
    if (typeof window === "undefined") return;
    const path = routePath(nextView, nextActiveId);
    if (path === window.location.pathname) return;
    const method = replace ? "replaceState" : "pushState";
    window.history[method](null, "", path);
  };

  // The very first render normalizes whatever path the tab was opened with
  // (e.g. bare "/") into its canonical form without adding a history entry;
  // every change after that is a real navigation and gets a pushed entry.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (fromPopstateRef.current) {
      fromPopstateRef.current = false;
      return;
    }
    pushRoute(view, activeId, { replace: !bootedRef.current });
    bootedRef.current = true;
  }, [view, activeId]);

  useEffect(() => {
    const onPopState = () => {
      const route = parseRoute(window.location.pathname);
      fromPopstateRef.current = true;
      setView(route.view);
      setActiveId(route.activeId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // /login isn't one of the authenticated views above — it's just what the
  // URL bar shows while `user` is null, regardless of what view/activeId
  // are underneath. Read through a ref rather than depending on view/
  // activeId directly, so a chat nav doesn't also re-run the auth check.
  const routeRef = useRef({ view, activeId });
  routeRef.current = { view, activeId };
  useEffect(() => {
    if (session === null) return; // still loading — don't redirect yet
    const onLogin = window.location.pathname === "/login";
    if (!user && !onLogin) {
      window.history.replaceState(null, "", "/login");
    } else if (user && onLogin) {
      const { view: v, activeId: id } = routeRef.current;
      window.history.replaceState(null, "", routePath(v, id));
    }
  }, [user, session]);

  // Admin and the sampler are admin-only everywhere they can be reached
  // from: the account menu doesn't offer them, the settings pane doesn't
  // show the sampler, and a normal account that types /admin — or returns
  // to a bookmark from when it *was* an admin — is sent back to the chat,
  // URL and all, so a refresh doesn't land there again. The server refuses
  // every /api/admin route on its own; this is the UI half of the same rule.
  const adminOnly = view === "sampler" || view === "admin";
  useEffect(() => {
    if (adminOnly && user && user.role !== "admin") setView("chat");
  }, [adminOnly, user]);

  const closeOnPhone = () => isNarrowViewport() && setSidebarOpen(false);

  // messageId is set when the row came from a search result: the chat opens
  // scrolled to the line that matched rather than at its end.
  const [highlightMessage, setHighlightMessage] = useState(null);
  const openChat = (id, messageId = null) => {
    setActiveId(id);
    setHighlightMessage(messageId ? { conversationId: id, messageId } : null);
    setView("chat");
    closeOnPhone();
  };

  const newChat = () => {
    setActiveId(null);
    setView("chat");
    closeOnPhone();
  };

  // A chat the server never stores. Leaving the view is what deletes it,
  // so the id is cleared on the way in and the shell starts empty.
  const privateChat = () => {
    setActiveId(null);
    setView("private");
    closeOnPhone();
  };

  const navigate = (next) => {
    setView(next);
    closeOnPhone();
  };

  const renameConversation = async (convo) => {
    const title = window.prompt("Rename chat", convo.title);
    if (title === null) return;
    const next = title.trim();
    if (!next || next === convo.title) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === convo.id ? { ...c, title: next } : c))
    );
    // Bumped so the open chat picks the new title up in its header — the
    // shell holds its own copy of the conversation, and the sidebar row
    // changing underneath it isn't something it can see.
    setRenamed({ id: convo.id, title: next });
    await api.renameConversation(convo.id, next).catch(() => refreshConversations());
  };

  const pinChat = async (convo, pinned) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === convo.id ? { ...c, pinned } : c))
    );
    await api.pinConversation(convo.id, pinned).catch(() => refreshConversations());
  };

  const removeConversation = async (id) => {
    await api.deleteConversation(id).catch(() => {});
    setConversations((prev) => prev.filter((c) => c.id !== id));
    // Functional, not `if (id === activeId)`: this handler is also held by
    // the chat shell, which can be running a copy from before the chat it
    // is deleting even existed — that closure's activeId is stale, and the
    // comparison silently failed, leaving the app pointed at a chat that
    // was gone.
    setActiveId((current) => (current === id ? null : current));
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setSession({ user: null, needsSetup: false });
    setConversations([]);
    setActiveId(null);
    setView("chat");
  };

  /* ---------- gates ------------------------------------------------------ */

  if (session === null) {
    return <div className="h-full bg-[var(--bg)]" />;
  }

  if (!user) {
    return (
      <LoginPage
        needsSetup={session.needsSetup}
        onSignedIn={(user) => setSession({ user, needsSetup: false })}
      />
    );
  }

  const effectiveView =
    adminOnly && user?.role !== "admin" ? "chat" : view;

  const visible = filter.trim() ? matches : conversations;

  const sidebar = (
    <Sidebar
      user={user}
      view={effectiveView}
      conversations={visible}
      activeId={activeId}
      filter={filter}
      theme={theme}
      onFilter={setFilter}
      onNewChat={newChat}
      onImport={importChats}
      onOpenSettings={() => {
        setSettingsOpen(true);
        closeOnPhone();
      }}
      // Settings is one long page; these open it at the part they name.
      onOpenSection={(section) => {
        setSettingsOpen(section);
        closeOnPhone();
      }}
      onOpen={openChat}
      onDelete={removeConversation}
      onRename={renameConversation}
      onPin={pinChat}
      onNavigate={navigate}
      onToggleTheme={onToggleTheme}
      onSignOut={signOut}
      onHide={() => setSidebarOpen(false)}
    />
  );

  const settings = settingsOpen && (
    <SettingsDialog
      user={user}
      models={models}
      modelId={modelId}
      theme={theme}
      onModelChange={setModelId}
      onToggleTheme={onToggleTheme}
      onImport={importChats}
      focus={typeof settingsOpen === "string" ? settingsOpen : null}
      onNavigate={navigate}
      onUserChanged={(next) => setSession((prev) => ({ ...prev, user: next }))}
      onClose={() => setSettingsOpen(false)}
    />
  );

  return (
    <div className="flex h-full animate-fade-in bg-[var(--bg)] text-[var(--text)] antialiased">
      {settings}
      {/* Desktop: the sidebar takes space in the row, so showing/hiding it
          has to animate that space rather than just the sidebar itself —
          the outer wrapper's width slides between 0 and 268px with the
          overflow clipped, while the sidebar inside stays a constant 268px
          so its own contents never squash or reflow mid-slide. Always
          mounted (unlike before) so there's something to animate from. */}
      <div
        className={`max-md:hidden shrink-0 overflow-hidden transition-[width]
                    duration-300 ease-drawer motion-reduce:transition-none
                    ${sidebarOpen ? "w-[268px]" : "w-0"}`}
      >
        <div className="h-full w-[268px]">{sidebar}</div>
      </div>

      {/* Phones: it slides over the conversation, at the same 268px width as
          the docked column so the nav never changes size. Both layers stay
          mounted so the transform has something to animate from. */}
      <div className="hidden max-md:block">
        <div
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
          className={`fixed inset-0 z-40 bg-[var(--scrim)] transition-opacity duration-300
                      motion-reduce:transition-none
                      ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        />
        {/* -translate-x-full moves this exactly its own width off-screen, so
            its right edge lands flush with x:0 — but shadow-xl's blur radius
            extends past the box edge and would bleed back into view even
            while "hidden". Drop the shadow itself while closed. */}
        <div
          className={`fixed inset-y-0 left-0 z-50 w-[268px] max-w-[86vw]
                      transition-transform duration-300 ease-drawer
                      motion-reduce:transition-none
                      ${sidebarOpen ? "translate-x-0 shadow-[var(--shadow-modal)]" : "-translate-x-full shadow-none"}`}
        >
          {sidebar}
        </div>
      </div>

      {(effectiveView === "chat" || effectiveView === "private") && (
        <AienticChatShell
          // Remounted when the mode flips, so a private transcript can
          // never survive into a saved chat (or the other way round).
          key={effectiveView === "private" ? "private" : "chat"}
          privateMode={effectiveView === "private"}
          models={models}
          modelsLoaded={modelsLoaded}
          modelStatus={modelStatus}
          conversationId={activeId}
          highlightMessage={highlightMessage}
          renamed={renamed}
          modelId={modelId}
          onModelChange={setModelId}
          onConversationCreated={(convo) => {
            setActiveId(convo.id);
            setConversations((prev) => [convo, ...prev]);
          }}
          // Patches the sidebar row directly, the moment the server's
          // rename-on-first-message reaches the client over the stream's
          // `start` event — the header already updates on that same event,
          // and without this the sidebar lagged behind it until the whole
          // reply finished and onConversationsChanged did a full refetch.
          onConversationRenamed={(id, title) =>
            setConversations((prev) =>
              prev.map((c) => (c.id === id ? { ...c, title } : c))
            )
          }
          onConversationsChanged={refreshConversations}
          onImportChats={importChats}
          onTogglePrivate={() =>
            effectiveView === "private" ? newChat() : privateChat()
          }
          onConversationDeleted={removeConversation}
          // A conversation id that will never resolve (a stale bookmark, a
          // link from before a fresh install) — nothing to delete on the
          // server, just clear the id so the URL falls back to a clean /new
          // instead of staying stuck on one that can never load.
          onConversationNotFound={(id) => {
            if (id === activeId) setActiveId(null);
          }}
          sidebarOpen={sidebarOpen}
          onShowSidebar={() => setSidebarOpen(true)}
        />
      )}

      {effectiveView === "sampler" && user.role === "admin" && (
        <SamplerPage
          models={models}
          modelStatus={modelStatus}
          modelId={modelId}
          onModelChange={setModelId}
          onBack={() => setView("chat")}
          sidebarOpen={sidebarOpen}
          onShowSidebar={() => setSidebarOpen(true)}
        />
      )}

      {effectiveView === "admin" && user.role === "admin" && (
        <AdminPage
          user={user}
          sidebarOpen={sidebarOpen}
          onShowSidebar={() => setSidebarOpen(true)}
          onEndpointsChanged={refreshModels}
          onBack={() => setView("chat")}
        />
      )}
    </div>
  );
}
