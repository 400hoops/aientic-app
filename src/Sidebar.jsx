import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  IconDownload,
  IconGhost,
  IconLogOut,
  IconMore,
  IconPencil,
  IconPin,
  IconMoon,
  IconPanel,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShield,
  IconSun,
  IconChevronDown,
  IconTrash,
} from "./Icons.jsx";
import Wordmark from "./Wordmark.jsx";
import { groupByDate, initial } from "./format.js";

// The row "…" menu's own size, needed before it exists: the trigger works
// out where to put it, and a menu near the bottom of the screen flips above
// the button rather than off it.
const MENU_WIDTH = 176;
const MENU_HEIGHT = 186;

/**
 * The matched words, in bold, inside the server's snippet. Split rather
 * than replaced: the text is user content and never becomes markup.
 */
function highlight(text, query) {
  const q = query.trim();
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <b key={i} className="font-medium text-[var(--text)]">{part}</b>
    ) : (
      part
    )
  );
}

/**
 * Navigation, chat history and the account footer.
 *
 * The nav is deliberately two items: the two ways to start a conversation.
 * Everything that configures the app — importing history, the sampler,
 * admin — lives behind the account menu at the bottom, where you go once
 * rather than every day.
 *
 * On phones it slides over the conversation instead of pushing it — see the
 * overlay in App.
 */
export default function Sidebar({
  user,
  view,
  conversations,
  activeId,
  filter,
  theme,
  onFilter,
  onNewChat,
  onPrivateChat,
  onOpenSettings,
  onOpen,
  onDelete,
  onRename,
  onPin,
  onNavigate,
  onToggleTheme,
  onSignOut,
  onHide,
}) {
  // The account menu behind the name in the footer.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  // Which chat row has its "…" menu open, if any.
  const [rowMenu, setRowMenu] = useState(null);
  const rowMenuRef = useRef(null);

  useEffect(() => {
    if (!rowMenu) return;
    const onDown = (e) => {
      if (!rowMenuRef.current?.contains(e.target)) setRowMenu(null);
    };
    const onKey = (e) => e.key === "Escape" && setRowMenu(null);
    // Placed in viewport coordinates, so scrolling the list would leave it
    // hanging next to a different row: it closes instead.
    const onScroll = () => setRowMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [rowMenu]);

  // Click anywhere else, or press Escape, and it closes — the two ways
  // every menu on the web is dismissed.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const menuItem = (label, Glyph, onClick, extra = null) => (
    <button
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                 text-[length:var(--fs-sm2)] text-[var(--text-soft)] hover:bg-[var(--hover)]"
    >
      <Glyph className="h-[16px] w-[16px] shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {extra}
    </button>
  );

  const navItem = (key, label, Glyph, onClick) => (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[length:var(--fs-base)] transition-colors
        ${view === key
          ? "bg-[var(--active)] text-[var(--text)]"
          : "text-[var(--text-soft)] hover:bg-[var(--hover)]"}`}
    >
      <Glyph className="h-[18px] w-[18px] shrink-0" />
      {label}
    </button>
  );

  const searching = !!filter.trim();
  // Pinned chats keep their own place at the top and don't move when the
  // conversation they belong to is used — see the server, where pinning
  // deliberately leaves updatedAt alone.
  const pinned = searching ? [] : conversations.filter((c) => c.pinned);
  const recents = searching ? conversations : conversations.filter((c) => !c.pinned);

  const heading = (text) => (
    <div className="ui-label px-2.5 pb-1.5 pt-4 first:pt-1">{text}</div>
  );

  const chatRow = (c) => (
          // A div, not a button: the row contains its own button (delete),
          // and a button inside a button is invalid. role/tabIndex/keydown
          // give it the same keyboard behaviour a button would.
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            aria-label={c.title}
            onClick={() => onOpen(c.id, c.messageId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(c.id, c.messageId);
              }
            }}
            className={`group flex animate-fade-in cursor-pointer items-start justify-between gap-1 rounded-lg
                        px-2.5 py-[7px] transition-colors outline-none
                        focus-visible:ring-2 focus-visible:ring-[var(--focus)]
              ${c.id === activeId && view === "chat"
                ? "bg-[var(--accent-soft)] text-[var(--text)]"
                : "hover:bg-[var(--hover)]"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[length:var(--fs-sm2)] text-[var(--text-soft)]">
                {c.pinned && (
                  <IconPin className="h-[12px] w-[12px] shrink-0 text-[var(--muted)]" />
                )}
                <span className="truncate">{c.title}</span>
              </span>
              {/* Why this chat matched, when it wasn't the title. */}
              {c.snippet && (
                <span className="mt-0.5 block truncate text-[length:var(--fs-xs)] text-[var(--muted)]">
                  {highlight(c.snippet, filter)}
                </span>
              )}
            </span>
            {/* One "…" instead of a row of icons: the row stays quiet, and
                there's somewhere to put the next action when there is one. */}
            <div className="shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (rowMenu?.id === c.id) return setRowMenu(null);
                  const r = e.currentTarget.getBoundingClientRect();
                  // Right edges aligned, hung just under the button — in
                  // viewport coordinates, since it renders outside the
                  // scroller now. Flipped above when it wouldn't fit below.
                  const below = window.innerHeight - r.bottom > MENU_HEIGHT;
                  setRowMenu({
                    id: c.id,
                    left: Math.max(8, r.right - MENU_WIDTH),
                    top: below ? r.bottom + 4 : r.top - MENU_HEIGHT - 4,
                  });
                }}
                title="More"
                aria-haspopup="menu"
                aria-expanded={rowMenu?.id === c.id}
                className={`rounded p-1 text-[var(--faint)] transition outline-none
                            hover:text-[var(--text)] focus-visible:opacity-100
                            max-md:opacity-100
                            ${rowMenu?.id === c.id
                              ? "text-[var(--text)] opacity-100"
                              : "opacity-0 group-hover:opacity-100"}`}
              >
                <IconMore className="h-[15px] w-[15px]" />
              </button>
            </div>
          </div>
  );

  // Rendered once, in a portal: see the trigger above.
  const rowMenuFor = conversations.find((c) => c.id === rowMenu?.id);
  const rowMenuNode =
    rowMenu && rowMenuFor
      ? createPortal(
          <div
            ref={rowMenuRef}
            role="menu"
            style={{ position: "fixed", top: rowMenu.top, left: rowMenu.left, width: MENU_WIDTH }}
            className="z-50 animate-scale-in rounded-xl border border-[var(--border)]
                       bg-[var(--raised)] p-1.5 shadow-[var(--shadow-pop)]"
          >
            <button
              onClick={() => {
                setRowMenu(null);
                onPin(rowMenuFor, !rowMenuFor.pinned);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                         text-[length:var(--fs-sm2)] hover:bg-[var(--hover)]"
            >
              <IconPin className="h-[15px] w-[15px] shrink-0" />
              {rowMenuFor.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              onClick={() => {
                setRowMenu(null);
                onRename(rowMenuFor);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                         text-[length:var(--fs-sm2)] hover:bg-[var(--hover)]"
            >
              <IconPencil className="h-[15px] w-[15px] shrink-0" />
              Rename
            </button>
            <a
              href={`/api/conversations/${rowMenuFor.id}/export?format=md`}
              download
              onClick={() => setRowMenu(null)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2
                         text-[length:var(--fs-sm2)] hover:bg-[var(--hover)]"
            >
              <IconDownload className="h-[15px] w-[15px] shrink-0" />
              Download
            </a>
            <div className="my-1.5 h-px bg-[var(--border)]" />
            <button
              onClick={() => {
                setRowMenu(null);
                if (window.confirm(`Delete “${rowMenuFor.title}”?`)) onDelete(rowMenuFor.id);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                         text-[length:var(--fs-sm2)] text-[var(--danger)] hover:bg-[var(--hover)]"
            >
              <IconTrash className="h-[15px] w-[15px] shrink-0" />
              Delete
            </button>
          </div>,
          document.body
        )
      : null;

  return (
    // 268px is the desktop column; inside the phone drawer the aside fills
    // its wrapper, so no transparent gutter is left beside it.
    <aside className="flex h-full w-[268px] shrink-0 flex-col border-r border-[var(--border)]
                      bg-[var(--panel)] max-md:w-full">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <Wordmark />
        <button
          onClick={onHide}
          title="Hide sidebar"
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
        >
          <IconPanel className="h-[18px] w-[18px] shrink-0" />
        </button>
      </div>

      <nav className="space-y-1 px-2 pt-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[length:var(--fs-base)]
                     text-[var(--text-soft)] hover:bg-[var(--hover)]"
        >
          <IconPlus className="h-[18px] w-[18px] shrink-0" />
          New chat
        </button>
        <button
          onClick={onPrivateChat}
          title="A chat the server never keeps"
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[length:var(--fs-base)]
                      ${view === "private"
                        ? "bg-[var(--active)] text-[var(--text)]"
                        : "text-[var(--text-soft)] hover:bg-[var(--hover)]"}`}
        >
          <IconGhost className="h-[18px] w-[18px] shrink-0" />
          Private chat
        </button>
      </nav>

      <div className="px-3 pb-1 pt-4">
        {/* Filled with --raised, matching the composer's own input field. */}
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-strong)]
                        bg-[var(--field)] px-2.5 py-2 focus-within:border-[var(--focus)]">
          <IconSearch className="h-[15px] w-[15px] text-[var(--muted)]" />
          <input
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-[length:var(--fs-sm)] text-[var(--text)]
                       placeholder:text-[var(--muted)] focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-scroll px-2 pb-2">
        {searching ? (
          <>
            {heading("Results")}
            {conversations.map(chatRow)}
          </>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                {heading("Pinned")}
                {pinned.map(chatRow)}
              </>
            )}
            {/* Dated slabs rather than one endless list: "Today" and "March"
                are how anyone actually looks for a conversation they had. */}
            {groupByDate(recents).map((group) => (
              <div key={group.label}>
                {heading(group.label)}
                {group.items.map(chatRow)}
              </div>
            ))}
          </>
        )}

        {conversations.length === 0 && (
          <p className="px-2.5 py-2 text-[length:var(--fs-sm)] text-[var(--faint)]">
            {searching ? "No matches." : "No chats yet."}
          </p>
        )}
      </div>

      <div ref={menuRef} className="relative border-t border-[var(--border)] px-3 py-3">
        {menuOpen && (
          // Anchored above the row it belongs to, since the row is already
          // at the bottom of the screen.
          <div
            role="menu"
            className="absolute bottom-full left-3 right-3 mb-2 animate-scale-in rounded-xl border
                       border-[var(--border)] bg-[var(--raised)] p-1.5
                       shadow-[var(--shadow-pop)]"
          >
            {menuItem("Settings", IconSettings, onOpenSettings)}
            {/* Admin is the one thing here a normal account never sees:
                other people's accounts and the server's model list. The
                sampler lives inside Settings now, with the rest of what a
                signed-in person configures. */}
            {user.role === "admin" &&
              menuItem("Admin", IconShield, () => onNavigate("admin"))}
            {menuItem(
              theme === "dark" ? "Light mode" : "Dark mode",
              theme === "dark" ? IconSun : IconMoon,
              onToggleTheme
            )}
            <div className="my-1.5 h-px bg-[var(--border)]" />
            {menuItem("Sign out", IconLogOut, onSignOut)}
          </div>
        )}

        <button
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors
                      hover:bg-[var(--hover)] ${menuOpen ? "bg-[var(--hover)]" : ""}`}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
                          bg-[var(--accent)] text-[13px] font-medium text-[var(--accent-fg)]">
            {initial(user.username)}
          </div>
          <div className="min-w-0 flex-1 text-left">
            <div className="truncate text-[length:var(--fs-sm2)] leading-tight">
              {user.username}
            </div>
          </div>
          <IconChevronDown
            className={`h-[15px] w-[15px] shrink-0 text-[var(--muted)] transition-transform
                        duration-200 ${menuOpen ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {rowMenuNode}
    </aside>
  );
}
