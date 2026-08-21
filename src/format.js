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

export function titleFrom(text) {
  const clean = String(text).trim().replace(/\s+/g, " ");
  return clean.length > 48 ? clean.slice(0, 48).trimEnd() + "…" : clean;
}

export const initial = (name) => (name || "?").trim().charAt(0).toUpperCase();
