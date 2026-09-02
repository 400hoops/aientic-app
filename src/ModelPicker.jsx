import Select from "./Select.jsx";
import { IconChevronDown } from "./Icons.jsx";

/**
 * The "GPT ▾" control in the composer and in the sampler header.
 * Search is always on — a llama-server with twenty presets is normal.
 */
export default function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  placement = "top",
  tone = "composer",
  status = {},
  matchParent = false,
}) {
  const options = models.map((m) => ({
    value: m.id,
    label: m.label,
    note: m.note,
    status: status[m.id],
  }));

  return (
    <Select
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      searchable
      searchPlaceholder="Search a model"
      placement={placement}
      width={356}
      matchParent={matchParent}
      emptyLabel="No models configured yet."
      renderTrigger={({ open, selected, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          // min-w-0: flex items default to min-width: auto, which refuses to
          // shrink below the label's natural width — so a long model name
          // pushed the chevron out of alignment instead of the label
          // actually truncating, despite it already having the truncate
          // class. Needs to hold at every level in the chain (here, and on
          // Select's own root div in Select.jsx) for the shrink to reach
          // the label.
          // w-full, not just min-w-0: Select's wrapping div (rootRef) is
          // position:relative, not display:flex, so this button never
          // negotiated a width with it at all — it was rendering at its own
          // natural content width regardless of how narrow the wrapper
          // actually was. min-w-0 alone only governs shrinking *within* a
          // flex parent, which this isn't one of; the button needs to
          // explicitly fill (and thus be bounded by) the wrapper before its
          // own internal flex/truncate logic has a width to work against.
          className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13.5px]
                      transition-colors disabled:opacity-50
                      ${tone === "header"
                        ? "bg-[var(--hover)] text-[var(--text)] hover:bg-[var(--active)]"
                        : "bg-[var(--raised)] text-[var(--text-soft)] hover:bg-[var(--hover)]"}`}
        >
          {/* min-w-0 here too: the span is itself a flex item of the button
              (display:flex), so it also defaults to min-width:auto — the
              chain has to hold all the way down or the last link breaks it. */}
          <span className="min-w-0 truncate">{selected?.label ?? "No model"}</span>
          <IconChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}
    />
  );
}
