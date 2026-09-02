/**
 * Finding the artifacts in an answer.
 *
 * An artifact is a piece of work rather than a piece of conversation: a page,
 * a drawing, a script, a document you're going to keep. Chat interfaces
 * normally render those inline, which means a 200-line HTML file arrives as
 * 200 lines of scrollback and the conversation around it is pushed off the
 * screen. Here they collapse to a card and open in their own panel.
 *
 * There is no tool call to tell us one has been produced — the models this
 * app talks to are completion endpoints, and asking them to emit a special
 * marker only works until it doesn't. So detection is a reader's judgement
 * applied to what came back: a fenced block that is a *whole* thing rather
 * than a fragment being discussed.
 *
 * Shared by the server (which lists them across every conversation) and the
 * browser (which renders them), so that a card and a list entry can never
 * disagree about what counts.
 */

/** ```lang\n…\n``` — every fenced block in a message, with its position. */
export function fencedBlocks(markdown) {
  const blocks = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})[ \t]*([\w+-]*)[ \t]*\n([\s\S]*?)\n?\1\2[ \t]*$/gm;
  let match;
  while ((match = fence.exec(String(markdown || "")))) {
    blocks.push({
      lang: (match[3] || "").toLowerCase(),
      code: match[4],
      index: match.index,
      raw: match[0],
    });
  }
  return blocks;
}

const HTML_START = /^\s*(<!doctype\s+html|<html[\s>])/i;
const SVG_START = /^\s*<svg[\s>]/i;

/**
 * What kind of thing a block is, or null if it's a fragment.
 *
 * The line thresholds are the whole judgement call. Too low and every
 * three-line example becomes a card you have to click to read, which is
 * worse than the inline block it replaced; too high and the thing you asked
 * to be written lands in the transcript anyway. Twenty lines is about where
 * a code block stops being something you read in passing.
 */
export function artifactKind({ lang, code }) {
  const lines = code.split("\n").length;
  if (SVG_START.test(code) || lang === "svg") return "svg";
  if (HTML_START.test(code) || lang === "html" || lang === "htm") return "html";
  if ((lang === "md" || lang === "markdown") && lines >= 15) return "markdown";
  if (lang && lines >= 20) return "code";
  return null;
}

const firstMatch = (text, ...patterns) => {
  for (const pattern of patterns) {
    const found = text.match(pattern)?.[1]?.trim();
    if (found) return found.replace(/\s+/g, " ").slice(0, 80);
  }
  return null;
};

/** A name for it, taken from the thing itself wherever possible. */
export function artifactTitle(kind, code, lang) {
  if (kind === "html")
    return (
      firstMatch(code, /<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
      "Page"
    );
  if (kind === "svg") return firstMatch(code, /<title[^>]*>([\s\S]*?)<\/title>/i) || "Drawing";
  if (kind === "markdown") return firstMatch(code, /^#\s+(.+)$/m) || "Document";

  // Code: a leading comment names it more often than not, and a function or
  // class declaration does the rest.
  return (
    firstMatch(
      code,
      /^\s*(?:\/\/|#|--)\s*(.+)$/m,
      /(?:function|class|def|const)\s+([A-Za-z_$][\w$]*)/
    ) || `${lang || "Code"} snippet`
  );
}

/**
 * Every artifact in one message, in the order they appear.
 *
 * `id` is derived from the message and the position rather than stored: an
 * artifact isn't a record, it's a view of a message that already exists, so
 * it can't drift out of sync with the answer it came from and it doesn't
 * survive that answer being deleted.
 */
export function artifactsIn(message) {
  if (!message || message.role !== "assistant") return [];
  return fencedBlocks(message.content)
    .map((block, at) => {
      const kind = artifactKind(block);
      if (!kind) return null;
      return {
        id: `${message.id}-${at}`,
        messageId: message.id,
        at,
        kind,
        lang: block.lang || (kind === "html" ? "html" : kind === "svg" ? "svg" : ""),
        title: artifactTitle(kind, block.code, block.lang),
        code: block.code,
        lines: block.code.split("\n").length,
        createdAt: message.createdAt,
      };
    })
    .filter(Boolean);
}

/** Everything an artifact needs in a list, minus the body of it. */
export const artifactSummary = (artifact) => ({
  id: artifact.id,
  messageId: artifact.messageId,
  // Which block of that message, so a list entry can point at one of two
  // artifacts in the same answer.
  at: artifact.at,
  kind: artifact.kind,
  lang: artifact.lang,
  title: artifact.title,
  lines: artifact.lines,
  createdAt: artifact.createdAt,
});

/** The file an artifact downloads as. */
export function artifactFilename(artifact) {
  const slug =
    String(artifact.title || "artifact")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "artifact";
  const extensions = {
    html: "html",
    svg: "svg",
    markdown: "md",
    javascript: "js",
    typescript: "ts",
    python: "py",
    bash: "sh",
    shell: "sh",
    json: "json",
    css: "css",
  };
  return `${slug}.${extensions[artifact.kind] || extensions[artifact.lang] || artifact.lang || "txt"}`;
}
