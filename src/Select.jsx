import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown, IconSearch } from "./Icons.jsx";
import { isPhone } from "./isPhone.js";

/**
 * A popover listbox. Used for the model picker (with search) and for small
 * choices like the account role.
 *
 * Native <select> can't show a second muted line per option, and can't be
 * styled to match the rest of the app, which is why this exists.
 */
/**
 * A green dot marks a model that's loaded in memory, and that is the only
 * thing this draws. "Not loaded" is the ordinary state for most models most
 * of the time — marking each of them would put a dot on nearly every row and
 * say nothing. Silence is the signal.
 */
function StatusDot({ status }) {
  if (status !== "loaded") return null;
  return (
    <span
      title="Loaded in memory"
      aria-label="Loaded in memory"
      role="img"
      className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#4ade80]"
    />
  );
}

export default function Select({
  value,
  options,
  onChange,
  renderTrigger,
  searchable = false,
  searchPlaceholder = "Search",
  placement = "bottom",
  align = "left",
  width = 260,
  disabled = false,
  emptyLabel = "Nothing to choose from",
  // For a trigger that's only part of a wider bar (the composer's model
  // picker sits at the bar's left edge, with Send at the far right): anchors
  // the popover to that whole bar instead of just the trigger, so it's
  // centered under — and the same width as — the bar rather than the
  // trigger's own narrow position. Requires a positioned ancestor already
  // in place (the bar itself) for the popover to anchor against, since this
  // deliberately doesn't put position:relative on the trigger's own wrapper.
  matchParent = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const popRef = useRef(null);

  const selected = options.find((o) => o.value === value) || null;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    // Not on a phone: autofocusing the search field is what raises the
    // keyboard, which then shrinks the visual viewport out from under a
    // popover already positioned against the taller one — the list ends up
    // floating over the keyboard, misaligned from where it opened. The list
    // is short enough to just tap through on a touch screen; typing to
    // filter is the desktop affordance, where there's no keyboard to summon.
    if (open && searchable && !isPhone()) searchRef.current?.focus();
    if (!open) setQuery("");
  }, [open, searchable]);

  // Keep the popover inside the window. The class-based position (a fixed
  // width anchored at the trigger's edge) can run off the right of a phone
  // screen, and an "open upward" popover can run off the top. This measures
  // it once open and, only when it would be cut off and the other side has
  // room for the whole thing, nudges or flips it. Runs in a layout effect so
  // the shift happens in the same frame the popover paints.
  useLayoutEffect(() => {
    if (!open || matchParent) return;
    const pop = popRef.current;
    const root = rootRef.current;
    if (!pop || !root) return;

    const margin = 8;
    const popRect = pop.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: clamp so a trigger near an edge can't push it off-screen.
    let dx = 0;
    if (popRect.left < margin) dx = margin - popRect.left;
    else if (popRect.right > vw - margin) dx = vw - margin - popRect.right;
    if (dx) pop.style.transform = `translateX(${dx}px)`;

    // Vertical: flip to the other side of the trigger if it overflows and
    // that side has room for the full popover (otherwise leave it — a
    // half-flip on a very short screen is worse than a clipped edge).
    if (placement === "bottom") {
      if (
        popRect.bottom > vh - margin &&
        popRect.height + margin * 2 <= rootRect.top
      ) {
        // Over the trigger: 8px (the class's mt-2, now on the other side)
        // clear of its top edge.
        pop.style.top = "auto";
        pop.style.bottom = `calc(100% + ${margin}px)`;
      }
    } else if (
      popRect.top < margin &&
      popRect.height + margin * 2 <= vh - rootRect.bottom
    ) {
      pop.style.bottom = "auto";
      pop.style.top = `calc(100% + ${margin}px)`;
    }
  }, [open, placement, matchParent]);

  const visible = query.trim()
    ? options.filter((o) =>
        `${o.label} ${o.note || ""}`.toLowerCase().includes(query.toLowerCase())
      )
    : options;

  const choose = (option) => {
    onChange?.(option.value);
    setOpen(false);
  };

  return (
    // min-w-0: this is the flex item that actually sits in the composer's
    // row (ModelPicker + Send button) — without it here too, the truncation
    // fix in ModelPicker's trigger button has nothing to shrink against.
    // relative is skipped under matchParent: the popover needs to anchor to
    // the bar around this trigger, not to this element itself.
    <div ref={rootRef} className={`min-w-0 ${matchParent ? "" : "relative"}`}>
      {renderTrigger ? (
        renderTrigger({ open, selected, toggle: () => !disabled && setOpen((v) => !v) })
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-lg border
                     border-[var(--border-strong)] bg-[var(--raised)] px-3 py-2 text-[14px]
                     text-[var(--text)] hover:border-[var(--muted)] focus:outline-none
                     disabled:opacity-50"
        >
          <span className="truncate">{selected?.label ?? "Select…"}</span>
          <IconChevronDown
            className={`h-4 w-4 text-[var(--faint)] transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}

      {open && (
        <div
          ref={popRef}
          // matchParent: left-0 right-0 spans the positioned ancestor
          // exactly, so no explicit width is needed — it's already the
          // same length as the bar. Otherwise, a fixed pixel width can push
          // past the right edge of a narrow phone screen when the trigger
          // sits near the left (the composer's model picker does) — min()
          // caps it against the viewport instead of letting it overflow.
          // 24px total margin, matching the composer's own side padding.
          style={matchParent ? undefined : { width: `min(${width}px, calc(100vw - 24px))` }}
          className={`absolute z-40 overflow-hidden rounded-xl border border-[var(--border)]
                      bg-[var(--raised)] shadow-[0_12px_32px_rgba(0,0,0,0.14)]
                      ${placement === "top" ? "bottom-full mb-2" : "top-full mt-2"}
                      ${matchParent ? "left-0 right-0" : align === "right" ? "right-0" : "left-0"}`}
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
              <IconSearch className="h-[15px] w-[15px] text-[var(--faint)]" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-[13.5px] max-md:text-[16px] text-[var(--text)]
                           placeholder:text-[var(--faint)] focus:outline-none"
              />
            </div>
          )}

          <div className="max-h-[320px] overflow-y-auto py-1">
            {visible.length === 0 && (
              <p className="px-3.5 py-3 text-[13px] text-[var(--faint)]">
                {query ? "No matches." : emptyLabel}
              </p>
            )}

            {visible.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => choose(option)}
                className={`flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[14px]
                            ${option.value === value
                              ? "bg-[var(--hover)] text-[var(--text)]"
                              : "text-[var(--text-soft)] hover:bg-[var(--hover)]"}`}
              >
                <span className="truncate">{option.label}</span>
                <StatusDot status={option.status} />
                {option.note && (
                  <span className="truncate text-[12px] text-[var(--faint)]">
                    {option.note}
                  </span>
                )}
                {option.value === value && (
                  <IconCheck className="ml-auto h-4 w-4 text-[var(--muted)]" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
