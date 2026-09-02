/**
 * A small library of documents the model can look things up in.
 *
 * Attachments answer "read this now". This answers "you know about this" —
 * the handbook, the meeting notes, the spec you keep re-explaining. Add a
 * document once and every conversation can draw on it, without any of them
 * carrying its full text.
 *
 * Retrieval is lexical (BM25), not embeddings, and that's a deliberate
 * trade rather than a shortcut. Embeddings would need a second model
 * loaded, running, and reachable at all times — on a box that already has
 * one model competing for VRAM — plus a re-index of everything whenever
 * that model changes. BM25 needs nothing but the text, is exact about names
 * and numbers (which is what people actually search their own notes for),
 * and can explain any result it returns. What it can't do is match a
 * paraphrase with no shared words, so the retrieved passages are handed to
 * the model as *context to check*, never as an answer.
 */
import { db, save, uid } from "./storage.js";

/* ---------- chunking ----------------------------------------------------- */

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;

/**
 * Split on paragraph boundaries where possible, so a retrieved passage is a
 * thought rather than a slice of one. Overlap covers the case where the
 * sentence that answers the question straddles a break.
 */
export function chunkText(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = current.slice(Math.max(0, current.length - CHUNK_OVERLAP));
  };

  for (const paragraph of paragraphs) {
    // A paragraph longer than a chunk is cut on sentence ends instead.
    if (paragraph.length > CHUNK_CHARS) {
      flush();
      current = "";
      for (const sentence of paragraph.match(/[^.!?]+[.!?]*\s*/g) || [paragraph]) {
        if (current.length + sentence.length > CHUNK_CHARS) flush();
        current += sentence;
      }
      flush();
      current = "";
      continue;
    }
    if (current.length + paragraph.length > CHUNK_CHARS) flush();
    current += (current ? "\n\n" : "") + paragraph;
  }
  flush();
  return chunks.filter((c) => c.length > 40);
}

/* ---------- the index ---------------------------------------------------- */

// Words that appear in every document tell you nothing about which one you
// want, and they're most of the words in any question.
const STOP = new Set(
  ("a an and are as at be but by for from has have how i if in into is it its of on or that the " +
    "their then there these they this to was were what when where which who why will with you your")
    .split(" ")
);

/**
 * Enough stemming to survive English's most common endings, and no more.
 *
 * Without it "how do I descale it" misses a handbook that says "descaling",
 * which is the sort of failure that makes people stop trusting a search box
 * altogether. A full Porter stemmer would buy a few more matches and a lot
 * more surprising ones ("universe" and "university" share a stem under it);
 * this stops at the endings that are almost always the same word.
 */
const stem = (word) => {
  let root = word;
  for (const suffix of ["ingly", "edly", "ing", "ies", "ied", "es", "ed", "ly", "s"]) {
    if (root.endsWith(suffix) && root.length - suffix.length >= 4) {
      root = root.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") root += "y";
      break;
    }
  }
  // And the silent e, which is the whole reason "descale" has to find
  // "descaling": strip the ending and one word keeps an e the other lost.
  return root.length >= 5 && root.endsWith("e") ? root.slice(0, -1) : root;
};

export const tokenize = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && word.length < 40 && !STOP.has(word))
    .map(stem);

/** All of a user's chunks, flattened, with their document alongside. */
const chunksFor = (userId) => {
  const out = [];
  for (const doc of db.knowledge?.[userId] || [])
    doc.chunks.forEach((text, index) =>
      out.push({ doc, index, text, terms: tokenize(text) })
    );
  return out;
};

/**
 * BM25 over the user's own library.
 *
 * k1 and b are the standard defaults; there's no corpus here big enough to
 * justify tuning them, and a self-hosted library of a few dozen documents
 * behaves the same across the usual range.
 */
const K1 = 1.5;
const B = 0.75;

export function search(userId, query, { limit = 6, perDoc = 3 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const chunks = chunksFor(userId);
  if (!chunks.length) return [];

  const avgLength =
    chunks.reduce((total, c) => total + c.terms.length, 0) / chunks.length;

  // Document frequency, counted over chunks — the unit that gets retrieved.
  const df = new Map();
  for (const chunk of chunks) {
    for (const term of new Set(chunk.terms)) df.set(term, (df.get(term) || 0) + 1);
  }

  const scored = [];
  for (const chunk of chunks) {
    let score = 0;
    const counts = new Map();
    for (const term of chunk.terms) counts.set(term, (counts.get(term) || 0) + 1);

    for (const term of terms) {
      const f = counts.get(term);
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score +=
        idf *
        ((f * (K1 + 1)) /
          (f + K1 * (1 - B + (B * chunk.terms.length) / avgLength)));
    }
    // A title match is worth something: "the onboarding doc" is how people
    // refer to a document, not a phrase inside it.
    if (tokenize(chunk.doc.title).some((t) => terms.includes(t))) score += 1.5;
    if (score > 0) scored.push({ ...chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // Spread across documents: three passages from one file and nothing from
  // the file that actually answers the question is the classic failure.
  const taken = new Map();
  const results = [];
  for (const hit of scored) {
    const used = taken.get(hit.doc.id) || 0;
    if (used >= perDoc) continue;
    taken.set(hit.doc.id, used + 1);
    results.push(hit);
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * The passages for a question, as a block for the system turn plus the list
 * of what was used — so the answer can show its sources and a reader can go
 * and check them.
 */
export function retrieve(userId, query, options) {
  const hits = search(userId, query, options);
  if (!hits.length) return null;

  const passages = hits
    .map(
      (hit) =>
        `<passage from="${String(hit.doc.title).replace(/"/g, "'")}"` +
        (hit.doc.url ? ` url="${String(hit.doc.url).replace(/"/g, "'")}"` : "") +
        `>\n${hit.text}\n</passage>`
    )
    .join("\n\n");

  const sources = [];
  for (const hit of hits)
    if (!sources.some((s) => s.id === hit.doc.id))
      sources.push({ id: hit.doc.id, title: hit.doc.title, url: hit.doc.url });

  return { passages, sources };
}

/* ---------- the library -------------------------------------------------- */

export const MAX_DOCUMENTS = 100;
export const MAX_DOC_CHARS = 400_000;

export const library = (userId) => (db.knowledge[userId] ||= []);

export function addDocument(userId, { title, text, url, source = "text" }) {
  const docs = library(userId);
  if (docs.length >= MAX_DOCUMENTS)
    throw new Error(`That's the ${MAX_DOCUMENTS}-document limit — remove one first`);

  const body = String(text || "").slice(0, MAX_DOC_CHARS).trim();
  if (body.length < 40) throw new Error("There's not enough text in that to keep");

  const doc = {
    id: uid(),
    title: String(title || "Untitled").trim().slice(0, 200),
    ...(url ? { url } : {}),
    source,
    chars: body.length,
    chunks: chunkText(body),
    createdAt: Date.now(),
  };
  docs.push(doc);
  save();
  return doc;
}

export function removeDocument(userId, id) {
  db.knowledge[userId] = library(userId).filter((doc) => doc.id !== id);
  save();
}

/** What the client needs to list a library: everything but the text itself. */
export const summarise = (doc) => ({
  id: doc.id,
  title: doc.title,
  url: doc.url,
  source: doc.source,
  chars: doc.chars,
  chunks: doc.chunks.length,
  createdAt: doc.createdAt,
});
