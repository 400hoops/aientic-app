/**
 * Reading a Claude data export.
 *
 * What the export actually is: a zip, mailed by Anthropic when you press
 * Settings → Privacy → Export data, holding `conversations.json` (plus
 * `projects.json` and `users.json`, which are not chats and are ignored).
 * An export is now mailed as several numbered zips rather than one —
 * `conversations000.zip`, `memories000.zip`, `light_metadata000.zip`,
 * `feedback000.zip` — so any of them can be dropped on the importer and each
 * is recognised by what's inside it rather than by its name.
 *
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

/**
 * The unsupported-block placeholder Claude's own export writes into `text`.
 *
 * A message whose reply came alongside a tool call has a `text` field that
 * begins with a fenced "This block is not supported on your current device
 * yet" — a note the export tool wrote for a reader, not part of what was
 * said. Imported as-is it becomes the first thing on screen in every answer
 * of a chat that used memory or search.
 */
const PLACEHOLDER =
  /```\s*\n?This block is not supported on your current device yet\.?\s*\n?```/gi;

const clean = (text) => String(text).replace(PLACEHOLDER, "").trim();

/**
 * Flatten one Claude message body into Markdown-ish text.
 *
 * Tool calls and their results are dropped rather than transcribed. They
 * used to come through as pretty-printed JSON, which meant a chat where
 * Claude wrote to its memory four times arrived as four screens of
 * `{"tool": "memory_write", ...}` with the actual sentences buried under
 * them. They also don't survive the trip in any useful sense: this app has
 * no memory tool to replay them against, so what's left is a transcript of
 * machinery from a different program. What was *said* is the text blocks.
 */
function messageText(message) {
  const blocks = Array.isArray(message.content) ? message.content : null;
  if (!blocks) return clean(message.text || "");

  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) out.push(clean(block.text));
  }

  // `text` is the whole message when there are no usable blocks (older
  // exports leave content empty on some rows).
  const joined = out.filter(Boolean).join("\n\n").trim();
  return joined || clean(message.text || "");
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

/* ---------- memories ------------------------------------------------------ */

/**
 * `memories/<account>.json` — what Claude had written down about you.
 *
 * The shape is a list of little Markdown files:
 *
 *   { memory_files: [ { path: "/topics/pets.md", content: "---\n…---\n\n- …" } ] }
 *
 * They map onto this app's own memory list almost exactly, because they're
 * the same idea: short standing facts told to the model at the start of
 * every chat. What doesn't map is the filing — paths, YAML front matter,
 * `[stated]` provenance tags — so that's dropped and the bullets underneath
 * are kept, one memory per line, which is the unit this app stores.
 */
export function convertMemories(raw) {
  const files = Array.isArray(raw?.memory_files) ? raw.memory_files : [];
  const memories = [];

  for (const file of files) {
    const body = String(file?.content || "")
      // YAML front matter: a name and a description of the file itself,
      // which is filing rather than anything you'd want said back to you.
      .replace(/^---\n[\s\S]*?\n---\n?/, "");

    for (const line of body.split("\n")) {
      const text = line
        .replace(/^\s*[-*]\s+/, "")
        // [stated], [inferred]: where Claude got it from. Useful to Claude,
        // noise in a list you're going to read and edit yourself.
        .replace(/^\[[a-z]+\]\s*/i, "")
        .trim();
      if (text && !text.startsWith("#") && text.length > 2) memories.push(text);
    }
  }
  // The same fact can be written into two files ("has a dog named Hazel" in
  // both /topics/pets.md and /people/…); the list is read by a person.
  return [...new Set(memories)];
}

/* ---------- the whole job ------------------------------------------------- */

/**
 * What an uploaded file holds.
 *
 * An export is mailed as several numbered zips these days —
 * `conversations000.zip`, `memories000.zip`, `light_metadata000.zip`,
 * `feedback000.zip` — and there is no way for someone to know which one this
 * app wants, so it takes any of them and works out what's inside. A bare
 * `conversations.json`, and a single chat in the shape this app writes to
 * `data/chats/`, are read the same way.
 */
export function parseUpload(buffer, userId) {
  if (!looksLikeZip(buffer))
    return { conversations: fromConversationsJson(buffer.toString("utf8"), userId), memories: [] };

  const files = unzip(buffer);
  const read = (file) => {
    try {
      return JSON.parse(file.data.toString("utf8").replace(/^\ufeff/, ""));
    } catch {
      return null;
    }
  };

  const chats = files.find((f) => /(^|\/)conversations\.json$/.test(f.name));
  if (chats)
    return { conversations: fromConversationsJson(chats.data.toString("utf8"), userId), memories: [] };

  const memoryFiles = files.filter((f) => /(^|\/)memories\//.test(f.name));
  if (memoryFiles.length) {
    const memories = memoryFiles.flatMap((f) => convertMemories(read(f)));
    if (memories.length) return { conversations: [], memories };
  }

  // Say which zip this is and which one to reach for, rather than the same
  // "no conversations.json" for all four.
  const what = files.some((f) => /(^|\/)users\.json$/.test(f.name))
    ? "your account details"
    : files.some((f) => /(^|\/)reflections\//.test(f.name))
      ? "the feedback you left on answers"
      : "no chats and no memories";
  throw new Error(
    `That zip holds ${what}. The chats are in the one named conversations, and what Claude remembered is in the one named memories.`
  );
}

/** A `conversations.json`, or one chat, as text. */
function fromConversationsJson(text, userId) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\ufeff/, ""));
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
