import { IconSparkles } from "./Icons.jsx";

/**
 * The skill picker, as it appears when you type a slash.
 *
 * The button beside the composer already opens this same list, and this
 * doesn't replace it — a menu you have to know about isn't discoverable, and
 * a menu you have to reach for isn't fast. Typing is how you're already
 * addressing the model, so `/` is the shortcut for people who know what they
 * want, and the button stays for people who want to look.
 *
 * Presentation only: the shell owns which skills match, which one is
 * highlighted, and what picking one does, because the keyboard that drives
 * this menu is the composer's own.
 */
export default function SlashMenu({ skills, active, attached, onPick, onHover }) {
  if (!skills.length) return null;

  return (
    <div
      role="listbox"
      aria-label="Skills"
      className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-[min(360px,calc(100vw-2rem))]
                 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--raised)]
                 p-1 shadow-[var(--shadow-modal)] animate-scale-in"
    >
      {skills.map((skill, at) => (
        <button
          key={skill.id}
          type="button"
          role="option"
          aria-selected={at === active}
          // onMouseDown, not onClick: the composer has focus and a click
          // would blur it first, which on a phone closes the keyboard.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(skill);
          }}
          onMouseEnter={() => onHover(at)}
          className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left
                      ${at === active ? "bg-[var(--hover)]" : ""}`}
        >
          <IconSparkles className="mt-0.5 h-[15px] w-[15px] shrink-0 text-[var(--muted)]" />
          <span className="min-w-0">
            <span className="block truncate text-[length:var(--fs-sm2)] text-[var(--text)]">
              {skill.name}
              {attached.includes(skill.id) && (
                <span className="ui-label ml-2 text-[length:var(--fs-xs)] text-[var(--faint)]">
                  On
                </span>
              )}
            </span>
            {skill.description && (
              <span className="block truncate text-[length:var(--fs-xs)] text-[var(--muted)]">
                {skill.description}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
