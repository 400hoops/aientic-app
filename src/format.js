/** Small display helpers shared by the chat and the admin tables. */

const pluralize = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

// Each threshold is in the unit above it (minutes < 45 hours would be wrong,
// it's minutes < 45 *minutes*), so what a step converts to and what it's
// compared against always match — the previous version divided by a step's
// size and then labelled the result with that same step's name, which is
// the unit being converted *from*, not the one just converted *to*. That
// silently displayed everything one unit too small once a message got past
// a minute old (2 hours ago read as "2 minutes ago").
export function relativeTime(ts) {
  if (!ts) return "";
  const seconds = (Date.now() - ts) / 1000;
  if (seconds < 45) return "Just now";

  const minutes = seconds / 60;
  if (minutes < 45) return pluralize(Math.round(minutes), "minute");

  const hours = minutes / 60;
  if (hours < 22) return pluralize(Math.round(hours), "hour");

  const days = hours / 24;
  if (days < 5.5) return pluralize(Math.round(days), "day");

  const weeks = days / 7;
  if (weeks < 3.5) return pluralize(Math.round(weeks), "week");

  const months = days / 30.44;
  if (months < 11) return pluralize(Math.round(months), "month");

  return pluralize(Math.round(days / 365.25), "year");
}

export const initial = (name) => (name || "?").trim().charAt(0).toUpperCase();

/**
 * A username as it's shown, rather than as it's stored.
 *
 * Accounts are typed in lower case and matched case-insensitively, but a
 * name printed back at someone is a name — "matt" in the corner of the
 * screen reads like a database row. Only the first letter is touched: the
 * rest is however they wrote it, so mcDonald and JJ survive intact.
 *
 * Display only. The stored username, the login form and the {{USER_NAME}}
 * the model is given all keep the real value.
 */
export const displayName = (name) => {
  const text = String(name || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
};

/**
 * Which slab of the history a chat belongs to.
 *
 * The sidebar is a list of everything you've ever asked, and an unbroken
 * one gives no sense of when — "yesterday" and "last spring" look the same.
 * These are the same buckets a person uses out loud.
 */
export function dateGroup(ts) {
  if (!ts) return "Older";
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const start = startOfToday.getTime();

  if (ts >= start) return "Today";
  if (ts >= start - day) return "Yesterday";
  if (ts >= start - 7 * day) return "Previous 7 days";
  if (ts >= start - 30 * day) return "Previous 30 days";
  // Inside this year the month is the useful label; before that, the year.
  const then = new Date(ts);
  if (then.getFullYear() === startOfToday.getFullYear())
    return then.toLocaleString(undefined, { month: "long" });
  return String(then.getFullYear());
}

/** The buckets above, in order, with their chats — empty ones dropped. */
export function groupByDate(conversations) {
  const groups = [];
  for (const convo of conversations) {
    const label = dateGroup(convo.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(convo);
    else groups.push({ label, items: [convo] });
  }
  return groups;
}
