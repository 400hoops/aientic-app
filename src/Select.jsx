import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
      className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--ok)]"
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
      // The popover lives in a portal outside rootRef (see below), so an
      // interaction inside it must not count as "outside" either.
      if (!rootRef.current?.contains(e.target) && !popRef.current?.contains(e.target))
        setOpen(false);
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

  // The popover is portaled to <body> with fixed coordinates, because an
  // ancestor scroll/overflow container would otherwise clip it — the Users
  // table, for instance, scrolls horizontally, and a popover that grew
  // past the table's edge was cut off at the border. Positioning against
  // the viewport also makes "keep it on screen" a simple clamping problem.
  // Runs in a layout effect so the coordinates land in the same frame the
  // popover first paints (it is invisible until positioned).
  useLayoutEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const root = rootRef.current;
    if (!pop || !root) return;

    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // What CSS position:relative was previously anchoring to: this element's
    // own wrapper, or — matchParent — the nearest positioned ancestor (the
    // composer bar), spanning it the way left-0 right-0 used to.
    let anchor = root;
    if (matchParent) {
      let n = root.parentElement;
      while (n && n !== document.body) {
        if (getComputedStyle(n).position !== "static") {
          anchor = n;
          break;
        }
        n = n.parentElement;
      }
    }
    const a = anchor.getBoundingClientRect();

    // matchParent spans the anchor edge to edge, so its width is set here (a
    // fixed-position element has no containing box to span); only then can
    // the box be measured in either direction.
    //
    // Edge to edge, not inside the padding: it used to span the padding box,
    // which left the menu a centimetre narrower than the composer it opens
    // from and floating slightly inside it. Two stacked panels with almost
    // the same edge read as a misalignment rather than a nesting.
    if (matchParent) pop.style.width = `${a.width}px`;
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;

    let left, top;
    if (matchParent) {
      left = a.left;
    } else if (align === "right") {
      left = a.right - popW;
    } else {
      left = a.left;
    }
    if (placement === "bottom") {
      top = a.bottom + margin;
      // Not enough room below, but room above the anchor: flip.
      if (top + popH > vh - margin && a.top - margin - popH >= margin)
        top = a.top - margin - popH;
    } else {
      top = a.top - margin - popH;
      if (top < margin && a.bottom + margin + popH <= vh - margin)
        top = a.bottom + margin;
    }

    // Final clamp: a very small window can defeat both flip directions.
    left = Math.min(Math.max(left, margin), vw - popW - margin);
    top = Math.min(Math.max(top, margin), vh - popH - margin);

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = "visible";
  }, [open, placement, align, matchParent]);

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

      {open &&
        createPortal(
          <div
            ref={popRef}
            // Fixed, viewport-relative (the layout effect fills in left/top
            // before the first paint; hidden until then so the unpositioned
            // state is never seen). matchParent: no width here — the effect
            // spans the anchor it finds. Otherwise, a fixed pixel width,
            // capped against a narrow phone screen (the composer's model
            // picker triggers near the left edge); 24px total margin,
            // matching the composer's own side padding.
            style={
              matchParent
                ? { position: "fixed", visibility: "hidden" }
                : {
                    position: "fixed",
                    visibility: "hidden",
                    width: `min(${width}px, calc(100vw - 24px))`,
                  }
            }
            className={`z-50 overflow-hidden rounded-xl border border-[var(--border)]
                     bg-[var(--raised)] shadow-[var(--shadow-pop)]
                     animate-scale-in ${placement === "top" ? "origin-bottom" : "origin-top"}`}
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
          </div>,
          document.body
        )}
    </div>
  );
}
