import { useEffect, useRef, useState } from "react";

import {
  IconDownload,
  IconLogOut,
  IconMore,
  IconPencil,
  IconMoon,
  IconPanel,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShield,
  IconSliders,
  IconSun,
  IconChevronDown,
  IconTrash,
  IconUpload,
} from "./Icons.jsx";
import Wordmark from "./Wordmark.jsx";
import { initial } from "./format.js";

/**
 * Navigation, chat history and the account footer.
 *
 * On phones it slides over the conversation instead of pushing it — see the
 * overlay in App.
 */
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

export default function Sidebar({
  user,
  view,
  conversations,
  activeId,
  filter,
  theme,
  onFilter,
  onNewChat,
  onImport,
  onOpenSettings,
  onOpen,
  onDelete,
  onRename,
  onNavigate,
  onToggleTheme,
  onSignOut,
  onHide,
}) {
  const fileInput = useRef(null);
  // "Importing…" while the upload is in flight, then the result — a Claude
  // export can be tens of megabytes, so the button has to say something.
  const [status, setStatus] = useState(null);
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
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
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

  const chooseFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // so picking the same file twice still fires
    if (!file) return;
    setStatus({ busy: true, text: "Importing…" });
    try {
      const result = await onImport(file);
      setStatus({
        text: `Imported ${result.imported} chat${result.imported === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      setStatus({ error: true, text: err.message });
    }
  };

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
          onClick={() => fileInput.current?.click()}
          disabled={status?.busy}
          title="Import a Claude data export (the zip, or conversations.json)"
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[length:var(--fs-base)]
                     text-[var(--text-soft)] hover:bg-[var(--hover)] disabled:opacity-60"
        >
          <IconUpload className="h-[18px] w-[18px] shrink-0" />
          {status?.busy ? "Importing…" : "Import chats"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          onChange={chooseFile}
          className="hidden"
        />
        {status && !status.busy && (
          <p
            className={`px-2.5 text-[length:var(--fs-xs)] ${
              status.error ? "text-[var(--danger)]" : "text-[var(--muted)]"
            }`}
          >
            {status.text}
          </p>
        )}
        {user.role === "admin" &&
          navItem("sampler", "Sampler", IconSliders, () => onNavigate("sampler"))}
        {user.role === "admin" &&
          navItem("admin", "Admin", IconShield, () => onNavigate("admin"))}
      </nav>

      <div className="px-3 pb-1 pt-4">
        {/* Filled with --raised, matching the composer's own input field. */}
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border)]
                        bg-[var(--raised)] px-2.5 py-2 focus-within:border-[var(--border-strong)]">
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
        <div className="ui-tight px-2.5 pb-1.5 pt-3 text-[length:var(--fs-xs)] text-[var(--muted)]">
          {filter.trim() ? "Results" : "Recents"}
        </div>

        {conversations.length === 0 && (
          <p className="px-2.5 py-2 text-[length:var(--fs-sm)] text-[var(--faint)]">
            {filter ? "No matches." : "No chats yet."}
          </p>
        )}

        {conversations.map((c) => (
          // A div, not a button: the row contains its own button (delete),
          // and a button inside a button is invalid. role/tabIndex/keydown
          // give it the same keyboard behaviour a button would.
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            aria-label={c.title}
            onClick={() => onOpen(c.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(c.id);
              }
            }}
            className={`group flex animate-fade-in cursor-pointer items-start justify-between gap-1 rounded-lg
                        px-2.5 py-[7px] transition-colors outline-none
                        focus-visible:ring-2 focus-visible:ring-[var(--focus)]
              ${c.id === activeId && view === "chat"
                ? "bg-[var(--active)]"
                : "hover:bg-[var(--hover)]"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[length:var(--fs-sm2)] text-[var(--text-soft)]">
                {c.title}
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
            <div
              ref={rowMenu === c.id ? rowMenuRef : null}
              className="relative shrink-0"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRowMenu(rowMenu === c.id ? null : c.id);
                }}
                title="More"
                aria-haspopup="menu"
                aria-expanded={rowMenu === c.id}
                className={`rounded p-1 text-[var(--faint)] transition outline-none
                            hover:text-[var(--text)] focus-visible:opacity-100
                            max-md:opacity-100
                            ${rowMenu === c.id
                              ? "text-[var(--text)] opacity-100"
                              : "opacity-0 group-hover:opacity-100"}`}
              >
                <IconMore className="h-[15px] w-[15px]" />
              </button>

              {rowMenu === c.id && (
                <div
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-full z-30 mt-1 w-44 animate-scale-in rounded-xl
                             border border-[var(--border)] bg-[var(--raised)] p-1.5
                             shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
                >
                  <button
                    onClick={() => {
                      setRowMenu(null);
                      onRename(c);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                               text-[length:var(--fs-sm2)] hover:bg-[var(--hover)]"
                  >
                    <IconPencil className="h-[15px] w-[15px] shrink-0" />
                    Rename
                  </button>
                  <a
                    href={`/api/conversations/${c.id}/export?format=md`}
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
                      if (window.confirm(`Delete “${c.title}”?`)) onDelete(c.id);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                               text-[length:var(--fs-sm2)] text-[var(--danger)] hover:bg-[var(--hover)]"
                  >
                    <IconTrash className="h-[15px] w-[15px] shrink-0" />
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div ref={menuRef} className="relative border-t border-[var(--border)] px-3 py-3">
        {menuOpen && (
          // Anchored above the row it belongs to, since the row is already
          // at the bottom of the screen.
          <div
            role="menu"
            className="absolute bottom-full left-3 right-3 mb-2 animate-scale-in rounded-xl border
                       border-[var(--border)] bg-[var(--raised)] p-1.5
                       shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
          >
            {user.role === "admin" &&
              menuItem("Sampler", IconSliders, () => onNavigate("sampler"))}
            {user.role === "admin" &&
              menuItem("Admin", IconShield, () => onNavigate("admin"))}
            {user.role === "admin" && (
              <div className="my-1.5 h-px bg-[var(--border)]" />
            )}
            {menuItem("Settings", IconSettings, onOpenSettings)}
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
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--text)]
                          text-[13px] font-medium text-[var(--bg)]">
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
    </aside>
  );
}
