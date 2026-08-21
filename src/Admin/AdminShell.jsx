import { IconPanel } from "../Icons.jsx";

/** Chrome for the admin area: the tab row and the way back to chat. */
export default function AdminShell({
  tab,
  onTab,
  onBack,
  sidebarOpen,
  onShowSidebar,
  children,
}) {
  const tabButton = (key, label) => (
    <button
      onClick={() => onTab(key)}
      className={`rounded-lg px-3 py-1.5 text-[13.5px] transition-colors
        ${tab === key
          ? "bg-[var(--hover)] text-[var(--text)]"
          : "text-[var(--muted)] hover:text-[var(--text)]"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header style={{ transform: "translateZ(0)" }}
      className="sticky top-0 z-10 bg-[var(--bg)] flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] px-4">
        {!sidebarOpen && (
          <button
            onClick={onShowSidebar}
            title="Show sidebar"
            className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            <IconPanel className="h-[18px] w-[18px] shrink-0" />
          </button>
        )}
        <h1 className="mr-2 text-[14.5px] text-[var(--text-soft)]">Admin</h1>
        {tabButton("endpoints", "Endpoints")}
        {tabButton("users", "Users")}
        <button
          onClick={onBack}
          className="ml-auto text-[13.5px] text-[var(--muted)] hover:text-[var(--text)]"
        >
          Back to chat
        </button>
      </header>

      <div className="flex-1 overflow-y-scroll">
        <div className="mx-auto max-w-3xl px-6 py-10 max-md:px-4">{children}</div>
      </div>
    </div>
  );
}
