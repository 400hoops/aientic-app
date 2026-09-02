/**
 * Reading a Claude data export.
 *
 * What the export actually is: a zip, mailed by Anthropic when you press
 * Settings → Privacy → Export data, holding `conversations.json` (plus
 * `projects.json` and `users.json`, which are not chats and are ignored).
 * `conversations.json` is one array, each entry roughly:
 *
 *   { uuid, name, created_at, updated_at,
 *     chat_messages: [ { uuid, sender: "human" | "assistant",
 *                        text, content: [ {type: "text", text}, ... ],
 *                        attachments: [ {file_name, extracted_content} ],
 *                        files: [ {file_name} ], created_at } ] }
 *
 * Both shapes of message body exist in the wild — the old flat `text` and
 * the newer `content` blocks (text, thinking, tool_use, tool_result) — so
 * both are handled, and unknown block types are skipped rather than
 * guessed at. The zip is read here too: a few dozen lines of central
 * directory plus zlib beats a dependency for a file we open once.
 */
import zlib from "node:zlib";
import crypto from "node:crypto";

/* ---------- zip ----------------------------------------------------------- */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

export const looksLikeZip = (buf) =>
  buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

/** Every file in the archive, as { name, data }. */
export function unzip(buf) {
  // The end-of-central-directory record sits in the last 64KB (22 bytes,
  // plus a comment nobody writes). Scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  if (eocd === -1) throw new Error("That file is not a readable zip archive");

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (at === 0xffffffff)
    throw new Error("Zip64 archives are not supported — unzip it and upload conversations.json");

  const files = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CENTRAL) break;
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    // The local header repeats the name and carries its own extra field,
    // which is usually a different length from the central one.
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    if (name.endsWith("/")) continue;
    if (method === 0) files.push({ name, data: raw });
    else if (method === 8) files.push({ name, data: zlib.inflateRawSync(raw) });
    // Anything else (bzip2, lzma) never appears in these exports.
  }
  return files;
}

/* ---------- conversations.json ------------------------------------------- */

const uid = () =>
  Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

const time = (value, fallback) => {
  const ms = Date.parse(value ?? "");
  return Number.isNaN(ms) ? fallback : ms;
};

/** Flatten one Claude message body into Markdown-ish text. */
function messageText(message) {
  const blocks = Array.isArray(message.content) ? message.content : null;
  if (!blocks) return String(message.text || "").trim();

  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) out.push(String(block.text));
    else if (block.type === "tool_use" && block.name)
      out.push(`\`\`\`json\n${JSON.stringify(
        { tool: block.name, input: block.input ?? null },
        null,
        2
      )}\n\`\`\``);
    else if (block.type === "tool_result" && block.content)
      out.push(
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content, null, 2)
      );
  }
  // `text` is the whole message when there are no usable blocks (older
  // exports leave content empty on some rows).
  if (!out.length && message.text) out.push(String(message.text));
  return out.join("\n\n").trim();
}

/** Thinking blocks become our own `reasoning`, shown the same way. */
function messageReasoning(message) {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((b) => b && b.type === "thinking" && (b.thinking || b.text))
    .map((b) => String(b.thinking || b.text))
    .join("\n\n")
    .trim();
}

function messageAttachments(message) {
  const out = [];
  for (const a of message.attachments || [])
    out.push({
      name: String(a.file_name || "attachment"),
      text: String(a.extracted_content || "").slice(0, 100_000),
    });
  for (const f of message.files || [])
    if (f?.file_name) out.push({ name: String(f.file_name), text: "" });
  return out;
}

const ROLE = { human: "user", assistant: "assistant" };

/**
 * Turn the parsed export into conversations in our own shape.
 *
 * Titles, ordering and timestamps are preserved; ids are ours, so an
 * import twice over makes two copies rather than clobbering anything.
 * Empty conversations are dropped — the export is full of them.
 */
export function convertClaudeExport(raw, userId) {
  if (!Array.isArray(raw))
    throw new Error("conversations.json should contain a list of conversations");

  const conversations = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const created = time(entry.created_at, Date.now());
    const messages = [];

    const source = Array.isArray(entry.chat_messages) ? entry.chat_messages : [];
    for (const message of source) {
      const role = ROLE[message?.sender];
      if (!role) continue;
      const content = messageText(message);
      const attachments = messageAttachments(message);
      const reasoning = messageReasoning(message);
      if (!content && !reasoning && !attachments.length) continue;
      messages.push({
        id: uid(),
        role,
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(attachments.length ? { attachments } : {}),
        createdAt: time(message.created_at, created),
      });
    }
    if (!messages.length) continue;

    conversations.push({
      id: uid(),
      userId,
      title: String(entry.name || "").trim().slice(0, 200) || "Imported chat",
      endpointId: null,
      source: "claude",
      createdAt: created,
      updatedAt: time(entry.updated_at, messages[messages.length - 1].createdAt),
      messages,
    });
  }
  return conversations;
}

/**
 * The whole path from an uploaded file to conversations: a zip from the
 * export mail, the `conversations.json` out of it, or a single chat in the
 * shape this app writes to `data/chats/`.
 */
export function parseUpload(buffer, userId) {
  let text;
  if (looksLikeZip(buffer)) {
    const files = unzip(buffer);
    const found = files.find((f) => /(^|\/)conversations\.json$/.test(f.name));
    if (!found)
      throw new Error("No conversations.json inside that zip — is it the Claude export?");
    text = found.data.toString("utf8");
  } else {
    text = buffer.toString("utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error("That file isn't valid JSON");
  }

  // A single object can be one Claude conversation, one of our own exported
  // chats, or the export wrapped in a key.
  if (!Array.isArray(parsed)) {
    if (Array.isArray(parsed.conversations)) parsed = parsed.conversations;
    else parsed = [parsed];
  }
  const claude = parsed.map((entry) =>
    entry && Array.isArray(entry.messages) && !entry.chat_messages
      ? fromOwnExport(entry)
      : entry
  );
  return convertClaudeExport(claude, userId);
}

/** Our own `data/chats/*.json`, expressed as an export entry. */
function fromOwnExport(entry) {
  return {
    name: entry.title,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    chat_messages: (entry.messages || []).map((m) => ({
      sender: m.role === "assistant" ? "assistant" : "human",
      text: m.content,
      content: m.reasoning
        ? [
            { type: "thinking", thinking: m.reasoning },
            { type: "text", text: m.content || "" },
          ]
        : undefined,
      attachments: (m.attachments || []).map((a) => ({
        file_name: a.name,
        extracted_content: a.text,
      })),
      created_at: m.createdAt,
    })),
  };
}
