import { useEffect, useState } from "react";

import { IconArtifact, IconCode, IconX } from "./Icons.jsx";
import { listArtifacts } from "./api.js";

/**
 * Everything the model has built for you, across every conversation.
 *
 * The list is derived on the server from the answers themselves rather than
 * kept as records, so there's nothing here to delete and nothing that can
 * point at a message that no longer exists: delete the answer and the entry
 * goes with it. Opening one goes to the conversation it came from — an
 * artifact without the discussion around it is half the story.
 */
export default function ArtifactsDialog({ onOpen, onClose }) {
  const [artifacts, setArtifacts] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    listArtifacts()
      .then((data) => setArtifacts(data.artifacts || []))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const when = (at) =>
    at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  return (
    <div
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4 animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Artifacts"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl
                   border border-[var(--border)] bg-[var(--raised)]
                   shadow-[var(--shadow-modal)] animate-scale-in"
      >
        <header className="flex shrink-0 items-center justify-between px-5 py-4">
          <h2 className="text-[length:var(--fs-md)]">Artifacts</h2>
          <button
            onClick={onClose}
            title="Close"
            className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            <IconX className="h-[17px] w-[17px]" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--border)] px-3 py-3">
          {error && (
            <p className="px-2 py-6 text-center text-[length:var(--fs-sm)] text-[var(--danger)]">
              {error}
            </p>
          )}

          {!error && artifacts === null && (
            <p className="px-2 py-6 text-center text-[length:var(--fs-sm)] text-[var(--muted)]">
              Looking…
            </p>
          )}

          {artifacts?.length === 0 && (
            <p className="px-2 py-6 text-center text-[length:var(--fs-sm)] text-[var(--muted)]">
              Nothing here yet. A page, a drawing or a script the model writes for
              you is kept as an artifact, and shows up here.
            </p>
          )}

          <ul className="space-y-1">
            {(artifacts || []).map((item) => {
              const Glyph = item.kind === "code" ? IconCode : IconArtifact;
              return (
                <li key={`${item.messageId}-${item.id}`}>
                  <button
                    onClick={() => onOpen(item)}
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left
                               hover:bg-[var(--hover)]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg
                                     bg-[var(--panel-2)] text-[var(--muted)]">
                      <Glyph className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--fs-sm2)] text-[var(--text)]">
                        {item.title}
                      </span>
                      <span className="ui-label block truncate text-[length:var(--fs-xs)] text-[var(--muted)]">
                        {item.conversationTitle || "Untitled chat"}
                      </span>
                    </span>
                    <span className="ui-label shrink-0 text-[length:var(--fs-xs)] text-[var(--faint)]">
                      {when(item.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
