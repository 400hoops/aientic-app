/**
 * Where you were in a conversation, across a refresh.
 *
 * A chat is a long page and reloading it dropped you at the end of it every
 * time, which is only the right answer when the end is where you were. Read
 * back through something from last week, hit refresh, and you lost your place
 * with no way to find it again except scrolling.
 *
 * sessionStorage, not localStorage, and that's the whole design: a position
 * belongs to this tab and this sitting. Persisting it forever would mean
 * opening a chat next month at whatever line you happened to stop on, which
 * is not where anyone wants to start — the end is the right default for a
 * fresh visit, and the remembered spot is only right for the tab that was
 * just looking at it.
 */
const KEY = "aientic:scroll";

const read = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
};

/** Positions for the most recent conversations, so the entry can't grow forever. */
const KEEP = 20;

export function rememberScroll(conversationId, top) {
  if (!conversationId) return;
  try {
    const all = read();
    // Delete first, then set: object key order is insertion order, so this
    // keeps the map in least-recently-used order for the trim below.
    delete all[conversationId];
    all[conversationId] = Math.round(top);
    const keys = Object.keys(all);
    for (const stale of keys.slice(0, Math.max(0, keys.length - KEEP)))
      delete all[stale];
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private browsing, a full quota, storage switched off: losing a scroll
    // position is not worth an error anyone has to see.
  }
}

export function recallScroll(conversationId) {
  if (!conversationId) return null;
  const top = read()[conversationId];
  return typeof top === "number" && top > 0 ? top : null;
}

export function forgetScroll(conversationId) {
  if (!conversationId) return;
  try {
    const all = read();
    delete all[conversationId];
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* as above */
  }
}
