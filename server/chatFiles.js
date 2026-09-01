/**
 * One file per conversation, on disk, next to data.json.
 *
 * data.json stays the source of truth — it's what the app reads on boot and
 * what every request mutates. But a single blob is a poor archive: you can't
 * grep one chat out of it, diff it, or hand it to someone. So every
 * conversation is also mirrored into `<data dir>/chats/` as a pair:
 *
 *   chats/2026-08-31-a-question-about-mice-mfk2p3h1.json   full fidelity
 *   chats/2026-08-31-a-question-about-mice-mfk2p3h1.md     readable
 *
 * The mirror is written whenever a conversation changes and deleted with it,
 * so the directory always matches the store. Nothing reads it back except
 * the importer, which means a bad file there can never corrupt the app.
 */
import fs from "node:fs";
import path from "node:path";

import { db, dataDir } from "./storage.js";

export const chatsDir = path.join(dataDir, "chats");

const ISO_DAY = (ms) => new Date(ms || Date.now()).toISOString().slice(0, 10);

/** A filename that sorts by date, reads like the chat, and can't escape. */
export function fileStem(convo) {
  const slug = String(convo.title || "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return [ISO_DAY(convo.createdAt), slug || "chat", convo.id].join("-");
}

const stamp = (ms) => (ms ? new Date(ms).toISOString() : null);

/** The archive shape: the stored conversation, minus internal plumbing. */
export function conversationJson(convo) {
  return {
    id: convo.id,
    title: convo.title,
    source: convo.source || "aientic",
    createdAt: stamp(convo.createdAt),
    updatedAt: stamp(convo.updatedAt),
    messages: convo.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content || "",
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      createdAt: stamp(m.createdAt),
    })),
  };
}

const SPEAKER = { user: "User", assistant: "Assistant", system: "System" };

/** The same conversation as Markdown, front matter first. */
export function conversationMarkdown(convo) {
  const head = [
    "---",
    `title: ${JSON.stringify(convo.title || "Untitled chat")}`,
    `id: ${convo.id}`,
    `source: ${convo.source || "aientic"}`,
    `created: ${stamp(convo.createdAt)}`,
    `updated: ${stamp(convo.updatedAt)}`,
    `messages: ${convo.messages.length}`,
    "---",
    "",
    `# ${convo.title || "Untitled chat"}`,
  ];

  const body = convo.messages.map((m) => {
    const parts = [`## ${SPEAKER[m.role] || m.role}`];
    if (m.reasoning)
      parts.push(
        "> _Reasoning_\n" +
          m.reasoning.split("\n").map((line) => "> " + line).join("\n")
      );
    if (m.content) parts.push(m.content);
    for (const a of m.attachments || [])
      parts.push(`*Attachment: ${a.name}*` + (a.text ? `\n\n${a.text}` : ""));
    if (m.images?.length) parts.push(`*(${m.images.length} image(s))*`);
    return parts.join("\n\n");
  });

  return [head.join("\n"), ...body].join("\n\n") + "\n";
}

/**
 * Mirror one conversation. Renames are handled by clearing the old pair
 * first: the id is in every stem, so a retitled chat leaves no stale twin.
 */
export function writeConversationFiles(convo) {
  try {
    fs.mkdirSync(chatsDir, { recursive: true });
    const stem = fileStem(convo);
    removeConversationFiles(convo.id, stem);
    fs.writeFileSync(
      path.join(chatsDir, stem + ".json"),
      JSON.stringify(conversationJson(convo), null, 2)
    );
    fs.writeFileSync(path.join(chatsDir, stem + ".md"), conversationMarkdown(convo));
  } catch (err) {
    // The mirror is a convenience; losing it must never fail a request.
    console.error(`[chats] could not write ${convo.id}:`, err.message);
  }
}

/** Drop every file belonging to an id, except the stem being written now. */
export function removeConversationFiles(id, keepStem = null) {
  let names;
  try {
    names = fs.readdirSync(chatsDir);
  } catch {
    return;
  }
  for (const name of names) {
    const stem = name.replace(/\.(json|md)$/, "");
    if (stem === name) continue;
    if (!stem.endsWith("-" + id) && stem !== id) continue;
    if (keepStem && stem === keepStem) continue;
    try {
      fs.unlinkSync(path.join(chatsDir, name));
    } catch {}
  }
}

/** Rebuild the whole directory — run at boot, so an old store catches up. */
export function syncAllConversations() {
  for (const convo of db.conversations) writeConversationFiles(convo);
}

/**
 * Debounced mirroring, for the paths that write often.
 *
 * A streaming answer touches its conversation on every chunk; the store
 * already collapses that into one write, and so does this.
 */
const dirty = new Set();
let timer = null;

export function touchConversation(convo) {
  if (!convo) return;
  dirty.add(convo.id);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushConversationFiles();
  }, 1000);
}

export function flushConversationFiles() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const id of dirty) {
    const convo = db.conversations.find((c) => c.id === id);
    if (convo) writeConversationFiles(convo);
    else removeConversationFiles(id);
  }
  dirty.clear();
}

process.on("exit", flushConversationFiles);
