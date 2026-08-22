// Applied before first paint so the app never flashes the wrong theme.
//
// This is a plain (non-module) script, so it runs during HTML parsing —
// well before the module bundle loads — which is what makes the no-flash
// possible. It is deliberately a separate file rather than inline: the
// server's Content-Security-Policy is script-src 'self', and this is the
// only script index.html references besides the app bundle.
try {
  var t = localStorage.getItem("aientic:theme");
  // No explicit choice yet: follow the OS, same as theme.js does once
  // React is up. Once t is set this stops mattering — a stored choice
  // always wins.
  var dark =
    t === "dark" ||
    (t !== "light" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) {
    document.documentElement.classList.add("dark");
    document
      .querySelector('meta[name="theme-color"]')
      .setAttribute("content", "#000000");
  }
} catch (e) {}
