import {
  IconLogOut,
  IconMoon,
  IconPanel,
  IconPlus,
  IconSearch,
  IconShield,
  IconSliders,
  IconSun,
  IconTrash,
} from "./Icons.jsx";
import Wordmark from "./Wordmark.jsx";
import { initial } from "./format.js";

/**
 * Navigation, chat history and the account footer.
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
  onOpen,
  onDelete,
  onNavigate,
  onToggleTheme,
  onSignOut,
  onHide,
}) {
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
          Recents
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
            className={`group flex animate-fade-in cursor-pointer items-center justify-between gap-1 rounded-lg
                        px-2.5 py-[7px] transition-colors outline-none
                        focus-visible:ring-2 focus-visible:ring-[var(--focus)]
              ${c.id === activeId && view === "chat"
                ? "bg-[var(--active)]"
                : "hover:bg-[var(--hover)]"}`}
          >
            <span className="truncate text-[length:var(--fs-sm2)] text-[var(--text-soft)]">
              {c.title}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete “${c.title}”?`)) onDelete(c.id);
              }}
              title="Delete chat"
              className="shrink-0 rounded p-1 text-[var(--faint)] opacity-0 transition outline-none
                         hover:text-[var(--danger)] group-hover:opacity-100
                         focus-visible:opacity-100 focus-visible:text-[var(--danger)]
                         max-md:opacity-100"
            >
              <IconTrash className="h-[14px] w-[14px]" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2.5 border-t border-[var(--border)] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text)]
                        text-[13px] font-medium text-[var(--bg)]">
          {initial(user.username)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--fs-sm2)] leading-tight">{user.username}</div>
        </div>
        {/* Both icons stay mounted and cross-fade by opacity — conditionally
            rendering one or the other would swap the DOM node instantly,
            with nothing to animate between. */}
        <button
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          className="relative h-[30px] w-[30px] rounded-md text-[var(--muted)] hover:bg-[var(--hover)]"
        >
          {/* The two icons cross-fade AND rotate out/in around the same axis,
              so the swap reads as the dial turning rather than a fade. */}
          <IconSun
            className={`absolute inset-0 m-auto h-[17px] w-[17px] transition-[opacity,transform]
                        duration-300 ease-swift motion-reduce:transition-none
                        ${theme === "dark" ? "-rotate-90 opacity-0" : "rotate-0 opacity-100"}`}
          />
          <IconMoon
            className={`absolute inset-0 m-auto h-[17px] w-[17px] transition-[opacity,transform]
                        duration-300 ease-swift motion-reduce:transition-none
                        ${theme === "dark" ? "rotate-0 opacity-100" : "rotate-90 opacity-0"}`}
          />
        </button>
        <button
          onClick={onSignOut}
          title="Sign out"
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
        >
          <IconLogOut className="h-[17px] w-[17px]" />
        </button>
      </div>
    </aside>
  );
}
