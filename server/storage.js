/**
 * The whole database: one JSON file, held in memory, written back atomically.
 *
 * That is enough for this app. A handful of accounts on a trusted network
 * generate far less write traffic than a single fsync can absorb, and a file
 * you can read with `cat` is worth a lot when something goes wrong.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR =
  process.env.AIENTIC_DATA_DIR || path.join(import.meta.dirname, "data");
const FILE = path.join(DATA_DIR, "data.json");
const BACKUP = FILE + ".bak";
const SECRET_FILE = path.join(DATA_DIR, "secret.key");

const EMPTY = {
  users: [],
  sessions: {},
  endpoints: [],
  keys: {},        // upstream API keys, one per server base URL
  samplers: {},
  conversations: [],
  memories: {},     // userId -> [{ id, text, createdAt }]
  skills: {},       // userId -> [{ id, name, instructions, always }]
};

export const uid = () =>
  Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Everything else in data.json is meant to be readable with `cat` — that's
 * the whole point of this store. Upstream API keys are the one field that's
 * a real credential rather than app state, so only that field is encrypted
 * at rest (AES-256-GCM), transparently: db.keys holds plaintext in memory
 * exactly as before, and only what hits disk changes.
 *
 * AIENTIC_SECRET (documented in the README, previously unused) supplies the
 * key when set. Unset, one is generated and kept in secret.key next to
 * data.json — encryption stays on with zero configuration, at the cost of
 * the key living alongside what it protects: meaningful against someone who
 * gets the JSON file alone (a backup, a careless copy), not against anyone
 * with access to the data directory itself.
 */
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

function loadEncryptionKey() {
  const secret = process.env.AIENTIC_SECRET;
  if (secret) return sha256(secret);

  try {
    const raw = fs.readFileSync(SECRET_FILE);
    // A 16/24/32-byte file is the key itself (that's what the generator
    // below writes, and what older data was encrypted with — keep it raw or
    // existing values stop decrypting). Anything else is secret *material*
    // to be hashed into a key: text pasted by hand, or `openssl rand
    // -base64 32`, which is 44 chars plus a newline. Without the hash,
    // 45 raw bytes hit AES and the first save throws "Invalid key length".
    return [16, 24, 32].includes(raw.length) ? raw : sha256(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
  return key;
}

const encryptionKey = loadEncryptionKey();
const ENC_PREFIX = "enc:v1:";

function encryptValue(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

function decryptValue(stored) {
  if (typeof stored !== "string" || !stored.startsWith(ENC_PREFIX))
    return stored; // legacy plaintext from before encryption existed
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const merged = { ...structuredClone(EMPTY), ...parsed };
    for (const [base, value] of Object.entries(merged.keys))
      merged.keys[base] = decryptValue(value);
    return merged;
  } catch (err) {
    if (err.code !== "ENOENT") {
      // A corrupt file is worth shouting about; we keep it and start clean
      // rather than silently overwriting whatever is in there.
      console.error(`[storage] ${FILE} unreadable (${err.message})`);
      try {
        fs.renameSync(FILE, FILE + ".corrupt-" + Date.now());
      } catch {}
    }
    return structuredClone(EMPTY);
  }
}

export const db = read();

let pending = null;
let writing = false;

function flush() {
  if (writing) return;
  writing = true;
  const tmp = FILE + ".tmp";
  // Build the body inside the guard: a failure here used to escape the
  // debounced timer and crash the whole process mid-save.
  try {
    const onDisk = { ...db, keys: {} };
    for (const [base, value] of Object.entries(db.keys))
      onDisk.keys[base] = encryptValue(value);
    const body = JSON.stringify(onDisk, null, 2);
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BACKUP);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE); // rename is atomic on the same filesystem
  } catch (err) {
    console.error("[storage] write failed:", err.message);
  } finally {
    writing = false;
  }
}

/** Queue a save. Bursts during streaming collapse into one write. */
export function save() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    flush();
  }, 250);
}

/** Write immediately — used on shutdown. */
export function saveNow() {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  flush();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}
process.on("exit", saveNow);

export const dataDir = DATA_DIR;
