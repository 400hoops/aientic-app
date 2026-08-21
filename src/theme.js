/**
 * Light/dark. Follows the OS until the user picks one explicitly here — then
 * that choice is remembered per browser and the app stops moving under them.
 */
const KEY = "aientic:theme";

const prefersDark = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: dark)").matches;

/** The explicit choice stored for this browser, or null if none was made. */
function storedTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

/** What to show right now: the stored choice, or the OS's until one exists. */
export function readTheme() {
  return storedTheme() ?? (prefersDark() ? "dark" : "light");
}

/** Flips the class and the meta tag. Doesn't touch storage — see toggleTheme
 *  and watchSystemTheme, which decide separately whether a change should
 *  stick or is just following the OS along. */
export function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
}

/** An explicit pick: persists, and from here on wins over the OS. */
export const toggleTheme = (current) => {
  const next = current === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  return next;
};

/**
 * Calls back with the OS's theme whenever it changes, so a session that
 * hasn't made an explicit choice keeps following it live (e.g. macOS
 * switching at sunset). No-ops once a choice is stored — that's what makes
 * toggling sticky rather than something the OS can undo an hour later.
 */
export function watchSystemTheme(onChange) {
  if (storedTheme() || typeof window === "undefined" || !window.matchMedia)
    return () => {};
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onQueryChange = (e) => onChange(e.matches ? "dark" : "light");
  mql.addEventListener("change", onQueryChange);
  return () => mql.removeEventListener("change", onQueryChange);
}
