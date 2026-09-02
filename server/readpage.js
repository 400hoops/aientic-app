/**
 * Fetching a web page and getting the article out of it.
 *
 * Paste a link into the composer and the server — not the browser — goes and
 * reads it, so the page arrives as text the model can actually answer about.
 * The browser can't do this itself: it would be a cross-origin request, and
 * anything it could reach would be reachable from the reader's own network
 * rather than from where the app runs.
 *
 * Which is exactly why this file is mostly a list of things not to fetch.
 * The app is normally reached over a LAN, and its own server sits on that
 * LAN next to routers, printers, dashboards and the model host itself. A URL
 * box that will fetch anything is a request forgery machine pointed at all
 * of them, and the reply comes back on screen. So: public addresses only,
 * every redirect re-checked, DNS resolved before the connection rather than
 * trusted after it, http(s) only, a size cap and a timeout.
 */
import dns from "node:dns";

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Enough article for any model's context, and a hard stop on the rest. */
export const MAX_TEXT = 120_000;

/* ---------- where we're allowed to go ------------------------------------ */

const privateV4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the metadata service
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
};

const privateV6 = (ip) => {
  const address = ip.toLowerCase().split("%")[0];
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(address)) return true; // unique local
  // ::ffff:10.0.0.1 and friends — a v4 address wearing a v6 coat.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateV4(mapped[1]) : false;
};

export const isPrivateAddress = (ip, family) =>
  family === 6 || ip.includes(":") ? privateV6(ip) : privateV4(ip);

/**
 * Off by default, and it should stay off on anything with more than one
 * user: with it on, anyone who can sign in can make the server fetch
 * addresses on your network — the router's admin page, the printer, the
 * dashboard nobody put a password on — and read the reply back on screen.
 *
 * It exists because there's a real reason to want it: an intranet wiki or a
 * homelab dashboard you'd like summarised, on a box only you can reach.
 * That's a decision for whoever runs the server, made once, in the
 * environment — not something the app can infer.
 */
const ALLOW_PRIVATE = process.env.AIENTIC_ALLOW_PRIVATE_FETCH === "1";

/**
 * Every address a hostname resolves to must be public.
 *
 * All of them, not the first: a name that answers with one public and one
 * private address would otherwise be a coin flip, which is precisely how
 * rebinding attacks are built.
 */
async function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE) return;
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Couldn't find ${hostname}`);
  }
  for (const { address, family } of addresses)
    if (isPrivateAddress(address, family))
      throw new Error(
        `${hostname} points inside this network, so it isn't fetched`
      );
}

/* ---------- fetching ----------------------------------------------------- */

export function normaliseUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // A scheme that isn't http(s) is refused outright rather than repaired.
  // Prepending https:// to "file:///etc/passwd" turned it into a request to
  // a host called "file" — harmless by luck, wrong by construction, and the
  // sort of thing that stops being harmless the day someone adds a scheme.
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;

  const withScheme = scheme ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = ""; // never sent anyway, and noise in the attachment's name
    return url;
  } catch {
    return null;
  }
}

/**
 * GET a page, following redirects by hand so each hop is checked against the
 * rules above rather than only the address that was typed.
 */
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new Error("Too many redirects");
      await assertPublicHost(current.hostname);

      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identifying, and honest about being a reader rather than a
          // browser: sites that would rather not be read this way can say so.
          "User-Agent": "Aientic/1.0 (+link reader; like curl)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "Accept-Language": "en",
        },
      });

      const location =
        res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        res.body?.cancel?.().catch?.(() => {});
        const next = normaliseUrl(new URL(location, current).toString());
        if (!next) throw new Error("That page redirects somewhere unreadable");
        current = next;
        continue;
      }

      if (!res.ok) throw new Error(`That page answered ${res.status}`);

      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (!/text\/html|application\/xhtml|text\/plain|text\/markdown/.test(type))
        throw new Error(
          `That link is ${type.split(";")[0] || "not a page"}, which can't be read as text`
        );

      return { url: current, html: await readCapped(res), plain: type.startsWith("text/plain") };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let size = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break; // what arrived is plenty; the rest is someone else's problem
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/* ---------- turning a page into an article ------------------------------- */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—",
  ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°",
};

const decode = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

const strip = (html, tag) =>
  html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");

/**
 * The readable part of a page, as text.
 *
 * Not a full readability implementation, and it doesn't need to be: an
 * article page is a <article>, <main> or the densest block of paragraphs on
 * it, and everything that makes the rest of the page — nav, headers, footers,
 * sidebars, scripts — announces itself in the markup. What comes out keeps
 * paragraph breaks, headings and list items, because those are what let a
 * model quote a piece back accurately.
 */
export function extractArticle(html) {
  let body = html;
  for (const tag of ["script", "style", "noscript", "svg", "template", "iframe", "form"])
    body = strip(body, tag);
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  body = strip(body, "head"); // the <title> is read separately, not inline

  const region = pick(body, "article") || pick(body, "main");
  const article = region ? toText(dropChrome(region)) : "";
  // Plenty of pages put the article outside <article> or <main> — and plenty
  // of others have an <article> holding a teaser. Read both and keep the one
  // with more to say, rather than trusting the markup to be honest.
  if (article.length >= 1200) return article;
  const whole = toText(dropChrome(body));
  return whole.length > article.length ? whole : article;
}

/** Everything that isn't the piece: menus, mastheads, sidebars, footers. */
const dropChrome = (html) => {
  let out = html;
  for (const tag of ["nav", "header", "footer", "aside"]) out = strip(out, tag);
  return out;
};

/**
 * Markup to text, keeping the structure a reader would keep: paragraph
 * breaks, headings, list items. A model quoting the piece back needs those —
 * flattened to one line, an article stops having parts to refer to.
 */
const toText = (html) =>
  decode(
    html
      .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n## ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote|pre)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The innermost-to-outermost longest match for a tag, or null. */
function pick(html, tag) {
  const matches = [
    ...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi")),
  ];
  if (!matches.length) return null;
  return matches.sort((a, b) => b[1].length - a[1].length)[0][1];
}

export function pageTitle(html, url) {
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  const title = og?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const clean = decode(title || "").replace(/\s+/g, " ").trim();
  return clean || url.hostname + url.pathname;
}

/* ---------- the whole job ------------------------------------------------ */

/**
 * Read a link: fetch it, pull the article out, and hand back something that
 * can be attached to a turn.
 */
export async function readUrl(rawUrl) {
  const url = normaliseUrl(rawUrl);
  if (!url) throw new Error("That doesn't look like a web address");

  const { url: finalUrl, html, plain } = await fetchPage(url);
  const text = plain ? html.trim() : extractArticle(html);
  if (!text || text.length < 80)
    throw new Error("There's no readable text on that page");

  return {
    url: finalUrl.toString(),
    title: plain ? finalUrl.hostname + finalUrl.pathname : pageTitle(html, finalUrl),
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
  };
}
