/**
 * Everything that talks to an OpenAI-compatible server (llama-server, vLLM,
 * Ollama, LM Studio, a hosted API — they all speak the same two routes).
 *
 * Base URLs are stored as the server root; the path is appended here so the
 * admin never has to remember whether to include /v1.
 */
import dns from "node:dns";

/** Trailing slashes and a pasted /v1 or /v1/chat/completions all normalise. */
export function normaliseBase(raw) {
  let url = String(raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/v1(\/chat)?(\/completions)?$/i, "");
  return url;
}

/**
 * The cloud instance-metadata service (AWS/GCP/Azure all answer there). It's
 * the classic SSRF target — pointed at by an admin-configured endpoint, the
 * app could be made to fetch it and hand the reply to an attacker — and no
 * model server ever runs on that address, so it's blocked outright.
 */
export const METADATA_IP = "169.254.169.254";

/** Fast string check on the URL itself — used where input is first entered. */
export function isBlockedBase(base) {
  try {
    return new URL(base).hostname === METADATA_IP;
  } catch {
    return false;
  }
}

/**
 * A fetch() with the blocklist applied where it actually matters: at the
 * wire. The string check above is gameable in two ways — a server can answer
 * a request with a redirect to anywhere, and a hostname can simply *resolve*
 * to the blocked address (169.254.169.254.nip.io, a rebinding domain, …). So
 * every outbound request goes through here: redirects are followed by hand,
 * and each hop is re-checked, with non-IP hostnames resolved first, so a
 * name that points at the metadata service is caught before it's reached.
 */
const BLOCK_CHECK_TTL = 60_000;
const BLOCK_CHECK_MAX = 1000;
const blockCheckCache = new Map(); // host -> { at, blocked }

async function hostIsBlocked(host) {
  if (host === METADATA_IP) return true;
  const hit = blockCheckCache.get(host);
  if (hit && Date.now() - hit.at < BLOCK_CHECK_TTL) return hit.blocked;

  let blocked = false;
  // dns.lookup on a numeric address is a no-op parse, so IP literals are
  // free; everything else is one resolver round trip, cached per minute.
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    blocked = addrs.some((a) => a.address === METADATA_IP);
  } catch {
    blocked = false; // unresolvable — the fetch itself will fail
  }
  if (blockCheckCache.size >= BLOCK_CHECK_MAX) blockCheckCache.clear();
  blockCheckCache.set(host, { at: Date.now(), blocked });
  return blocked;
}

const MAX_REDIRECTS = 5;
export async function upstreamFetch(rawUrl, opts = {}) {
  let url = String(rawUrl);
  let reqOpts = opts;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) throw new Error("too many redirects");
    const u = new URL(url);
    if (await hostIsBlocked(u.hostname))
      throw new Error(`${u.hostname} is not allowed`);

    const res = await fetch(url, { ...reqOpts, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400
      ? res.headers.get("location")
      : null;
    if (!location) return res;

    // Mirror fetch's own redirect semantics: 301/302/303 become GETs
    // without a body; 307/308 keep method and body.
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      if (reqOpts.method === "POST")
        reqOpts = { ...reqOpts, method: "GET", body: undefined };
    }
    res.body?.cancel?.().catch?.(() => {});
    url = new URL(location, url).toString();
  }
}

/**
 * Read an upstream JSON body with a hard size cap. An admin can point
 * Aientic at any OpenAI-compatible host; a multi-gigabyte /models reply
 * (bug or malice) must not be able to take the API down with it.
 */
const MAX_UPSTREAM_BODY = 2 * 1024 * 1024;
async function readCappedJson(res) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_UPSTREAM_BODY)
    throw new Error(`response too large (${declared} bytes)`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPSTREAM_BODY) {
      await reader.cancel().catch(() => {});
      throw new Error(`response too large`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text);
}

export const chatUrl = (base) => normaliseBase(base) + "/v1/chat/completions";
export const modelsUrl = (base) => normaliseBase(base) + "/v1/models";

export function authHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Ask a server what it is serving. llama-server returns its preset names
 * here, which is exactly what "add all models from this server" needs.
 */
export async function listModels(base, apiKey) {
  const res = await upstreamFetch(modelsUrl(base), {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(
      `${normaliseBase(base)} answered ${res.status} ${res.statusText}`
    );
  }
  const body = await readCappedJson(res);
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((id) => typeof id === "string" && id.length)
    .map((id) => ({ id, label: id }));
}

/**
 * Turns a fetch failure into something an admin can act on. Node reports
 * almost every connection problem as a bare "fetch failed".
 */
export function describeUpstreamError(err, base) {
  const where = normaliseBase(base);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|aborted/i.test(err.message))
    return `Can't reach ${where}. Is the model server running and reachable from here?`;
  return err.message;
}

/** Sampler settings the upstream accepts, with blanks dropped. */
export function samplerPayload(sampler = {}) {
  const out = {};
  for (const key of [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
  ]) {
    const value = sampler[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/* ---------- sampler defaults, read from the server itself ---------------- */

/**
 * The keys we let an admin override, and where llama.cpp reports each one.
 * vLLM and friends don't serve /props at all — that's what the fallback in
 * index.js is for.
 */
const DEFAULT_KEYS = [
  ["temperature", ["temperature", "temp"]],
  ["top_p", ["top_p"]],
  ["top_k", ["top_k"]],
  ["min_p", ["min_p"]],
  ["repeat_penalty", ["repeat_penalty", "repeat_penalty_last_n_penalty", "penalty_repeat"]],
];

export const propsUrl = (base) => normaliseBase(base) + "/props";

/**
 * llama-swap fronts many llama-server instances behind one port, so a plain
 * /props there describes whichever model happens to be loaded — or nothing at
 * all. Its per-model proxy is the way to reach a specific one's real settings.
 */
export const upstreamPropsUrl = (base, model) =>
  `${normaliseBase(base)}/upstream/${encodeURIComponent(model)}/props`;

/** llama-swap's list of models currently held in memory. */
export const runningUrl = (base) => normaliseBase(base) + "/running";

/**
 * Which models the server currently has loaded. llama-swap answers /running
 * with {running:[{model,state}]}; anything else (a bare llama-server, vLLM)
 * 404s, which is reported as "this server doesn't do per-model loading"
 * rather than as an error.
 *
 * Returns null when the concept doesn't apply, [] when it applies and nothing
 * is loaded — the caller needs to tell those apart.
 */
export async function fetchRunningModels(base, apiKey) {
  const res = await upstreamFetch(runningUrl(base), {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `${normaliseBase(base)} answered ${res.status} ${res.statusText} for /running`
    );
  }

  const body = await readCappedJson(res);
  const rows = Array.isArray(body?.running)
    ? body.running
    : Array.isArray(body)
      ? body
      : [];
  return rows
    .filter((r) => {
      // llama-swap reports stopping/starting models here too; only "ready"
      // means actually resident and answering.
      const state = typeof r === "string" ? "ready" : r?.state;
      return state === undefined || state === "ready";
    })
    .map((r) => (typeof r === "string" ? r : r?.model))
    .filter((m) => typeof m === "string" && m.length);
}

/**
 * llama-server publishes the sampler it was started with at /props. Older
 * builds put the values straight on default_generation_settings; newer ones
 * nest them under .params. Read both, and return only the keys we found —
 * the caller fills the rest in.
 *
 * `model` routes through llama-swap's per-model proxy. Only pass it for a
 * model already loaded: that proxy will happily *start* one to answer, and
 * silently swapping a 27B model into memory because someone opened a settings
 * page is not a thing this should ever do.
 */
export async function fetchServerDefaults(base, apiKey, model = null) {
  const url = model ? upstreamPropsUrl(base, model) : propsUrl(base);
  const res = await upstreamFetch(url, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(
      `${normaliseBase(base)} answered ${res.status} ${res.statusText} for ${
        model ? `/upstream/${model}/props` : "/props"
      }`
    );
  }

  const body = await readCappedJson(res);
  const settings = body?.default_generation_settings ?? {};
  const sources = [settings.params, settings, body?.params, body];

  const out = {};
  for (const [key, aliases] of DEFAULT_KEYS) {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const found = aliases.find(
        (alias) => typeof source[alias] === "number" && Number.isFinite(source[alias])
      );
      if (found) {
        out[key] = source[found];
        break;
      }
    }
  }
  if (!Object.keys(out).length)
    throw new Error(`${normaliseBase(base)} served /props with no sampler in it`);
  return out;
}
