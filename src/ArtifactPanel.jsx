import { useEffect, useMemo, useState } from "react";

import { IconCheck, IconCopy, IconDownload, IconX } from "./Icons.jsx";
import { artifactFilename, artifactTitle } from "../shared/artifacts.js";
import { copyText } from "./clipboard.js";

/**
 * Rendering something a model wrote, without letting it near this app.
 *
 * srcdoc into a sandboxed iframe, and deliberately *without*
 * allow-same-origin. That one missing token is the whole security boundary:
 * with it, the frame's document shares this page's origin, and a page the
 * model produced — from text that may have come from a web page it was asked
 * to read, or a document someone else uploaded — could read the session
 * cookie, call the API as you, and rewrite the app around it. Without it the
 * frame is an opaque origin: its scripts run, it can draw, and it can reach
 * nothing of ours.
 *
 * allow-scripts is kept, because a page that can't run its own script isn't
 * a preview of the page that was written. allow-scripts plus allow-same-origin
 * together would let the frame remove its own sandbox attribute, which is
 * exactly why the pair is never used.
 */
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

const previewable = (kind) => kind === "html" || kind === "svg";

export default function ArtifactPanel({ artifact, onClose }) {
  const [tab, setTab] = useState("preview");
  const [copied, setCopied] = useState(false);

  const canPreview = previewable(artifact?.kind);
  useEffect(() => {
    setTab(previewable(artifact?.kind) ? "preview" : "code");
  }, [artifact?.kind, artifact?.code]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = useMemo(
    () => artifact && artifactTitle(artifact.kind, artifact.code, artifact.lang),
    [artifact]
  );

  if (!artifact) return null;

  const copy = async () => {
    if (await copyText(artifact.code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  const download = () => {
    // A blob and a click, because there's no file on a server to link to —
    // an artifact only ever exists as text inside a message.
    const blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifactFilename({ ...artifact, title });
    link.click();
    URL.revokeObjectURL(url);
  };

  const tabButton = (name, label) => (
    <button
      onClick={() => setTab(name)}
      className={`rounded-md px-2.5 py-1 text-[length:var(--fs-xs)]
                  ${tab === name
                    ? "bg-[var(--active)] text-[var(--text)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)]"}`}
    >
      {label}
    </button>
  );

  const action = (label, Glyph, onClick) => (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
    >
      <Glyph className="h-[17px] w-[17px]" />
    </button>
  );

  return (
    <aside
      className="flex h-full w-[440px] shrink-0 flex-col border-l border-[var(--border)]
                 bg-[var(--panel)] max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:w-full
                 animate-fade-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--fs-sm2)] text-[var(--text)]">{title}</p>
          <p className="ui-label text-[length:var(--fs-xs)] text-[var(--muted)]">
            {artifact.lang || artifact.kind}
          </p>
        </div>
        {action(copied ? "Copied" : "Copy", copied ? IconCheck : IconCopy, copy)}
        {action("Download", IconDownload, download)}
        {action("Close", IconX, onClose)}
      </header>

      {canPreview && (
        <div className="flex shrink-0 gap-1 border-b border-[var(--border)] px-3 py-2">
          {tabButton("preview", "Preview")}
          {tabButton("code", "Code")}
        </div>
      )}

      {tab === "preview" && canPreview ? (
        <iframe
          // Keyed on the code so a new version replaces the document rather
          // than trying to patch a frame that isn't ours to reach into.
          key={artifact.code.length + artifact.kind}
          title={title}
          sandbox={SANDBOX}
          srcDoc={artifact.code}
          // Referrers and top-level navigation are the two things a preview
          // has no business doing on the reader's behalf.
          referrerPolicy="no-referrer"
          className="min-h-0 flex-1 bg-white"
        />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto bg-[var(--panel-2)] px-3.5 py-3">
          <code className="font-mono text-[12.5px] leading-[1.7] text-[var(--text)]">
            {artifact.code}
          </code>
        </pre>
      )}
    </aside>
  );
}
