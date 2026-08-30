/**
 * Small non-secret preferences — currently just the last model used.
 *
 * The session itself is an httpOnly cookie the browser can't read — that's
 * the point of it. Nothing here is trusted by the server.
 */
export function readCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export function writeCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

export const readPref = (name, fallback = null) => readCookie(name) ?? fallback;
export const writePref = (name, value) => writeCookie(name, String(value));
