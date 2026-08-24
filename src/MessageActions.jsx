import { useState } from "react";
import {
  IconCheck,
  IconCopy,
  IconPencil,
  IconRefresh,
  IconTrash,
} from "./Icons.jsx";
import { relativeTime } from "./format.js";

/**
 * The timestamp + icon row under each message. User turns can be edited,
 * assistant turns can be regenerated; both can be copied or deleted.
 */
export default function MessageActions({
  timestamp,
  onRegenerate,
  onEdit,
  onCopy,
  onDelete,
  hidden = false,
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await onCopy?.();
    if (ok === false) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const button = (title, Glyph, handler) => (
    <button
      key={title}
      title={title}
      onClick={handler}
      className="rounded p-1 text-[var(--faint)] transition-colors hover:text-[var(--text)]"
    >
      <Glyph className="h-[15px] w-[15px]" />
    </button>
  );

  return (
    <div
      className={`mt-2 flex items-center gap-1 text-[length:var(--fs-meta)] text-[var(--faint)] transition-opacity
                  duration-300 ease-swift
                  ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
    >
      <span className="mr-1 tabular-nums">{relativeTime(timestamp)}</span>
      {onRegenerate && button("Regenerate", IconRefresh, onRegenerate)}
      {onEdit && button("Edit", IconPencil, onEdit)}
      {onCopy && button(copied ? "Copied" : "Copy", copied ? IconCheck : IconCopy, copy)}
      {onDelete && button("Delete", IconTrash, onDelete)}
    </div>
  );
}
