/**
 * Aientic API.
 *
 * Conversations, accounts, model endpoints and sampler settings all live
 * server-side, so history follows the account rather than the browser.
 *
 * Deployment assumption: a trusted network (LAN or tailnet) — see README.
 * HTTPS is opt-in (AIENTIC_TLS_CERT/KEY); login rate limiting is on by
 * default. Reverse-proxy trust is also opt-in (AIENTIC_TRUST_PROXY), so a
 * direct client's X-Forwarded-* headers can't spoof req.ip; CSRF
 * protection is still intentionally skipped, since cookies are sameSite=lax
 * and nothing here performs a state-changing GET.
 */
import path from "node:path";
import fs from "node:fs";
import https from "node:https";
import express from "express";
import cookieParser from "cookie-parser";

import { db, save, uid, dataDir } from "./storage.js";
import {
  touchConversation,
  removeConversationFiles,
  syncAllConversations,
  conversationJson,
  conversationMarkdown,
  fileStem,
} from "./chatFiles.js";
import { parseUpload } from "./claudeImport.js";
import { readUrl } from "./readpage.js";
import {
  addDocument,
  library,
  removeDocument,
  search,
  summarise,
} from "./knowledge.js";
import {
  attachUser,
  requireAuth,
  requireAdmin,
  createUser,
  findUser,
  verifyPassword,
  startSession,
  endSession,
  publicUser,
  needsBootstrap,
  hashPassword,
  COOKIE,
} from "./auth.js";
import {
  listModels,
  normaliseBase,
  isBlockedBase,
  describeUpstreamError,
  fetchServerDefaults,
  fetchRunningModels,
} from "./upstream.js";
import {
  streamCompletion,
  attachGeneration,
  stopGeneration,
  isGenerating,
} from "./generation.js";

// AIENTIC_PORT wins over PORT: dev tooling (and some hosts) set PORT for
// their own server, and the API must not land on top of it.
const PORT = Number(process.env.AIENTIC_PORT || process.env.PORT || 3001);
const app = express();

// Off by default: with no reverse proxy in front, a *client's* X-Forwarded-*
// headers must not be honoured — trusting them let anyone on the LAN spoof
// req.ip (walking straight past the login rate limit). Behind a reverse
// proxy, set AIENTIC_TRUST_PROXY: "1" for one proxy hop, or "loopback" /
// a CIDR / a list of those.
const trustProxy = process.env.AIENTIC_TRUST_PROXY;
if (trustProxy)
  app.set(
    "trust proxy",
    /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy
  );

// 64 MB, not the default: a chat turn can carry up to four base64 photos
// (see sanitizeImages), and base64 inflates the binary by a third.
app.use(express.json({ limit: "64mb" }));
app.use(cookieParser());
app.use(attachUser);

// Defensive headers for the served frontend. script-src 'self' is safe
// because index.html carries no inline scripts (see public/theme-init.js);
// 'unsafe-inline' in style-src covers React's style="..." attributes and
// the first-paint <style> block. fonts.* is the Google Fonts stylesheet
// and its woff2 host.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
      "manifest-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; ")
  );
  next();
});

const ok = (res, body = {}) => res.json(body);
const bad = (res, code, error) => res.status(code).json({ error });

/**
 * Login attempts, per source IP. Sliding window: old attempts age out on
 * their own. A failed attempt counts against the limit; a successful one
 * clears it, so a legitimate user who mistypes a few times isn't locked out
 * of their next correct try.
 *
 * The map itself is bounded: entries are dropped the moment their window
 * empties, and if the number of tracked IPs ever hits the cap (a scanner
 * sweeping through source IPs) the table is swept — and if the cap still
 * holds, restarted clean — rather than growing without limit.
 */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_TRACKED_IPS = 50_000;
const loginAttempts = new Map(); // ip -> [timestamp, ...]

function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let attempts = (loginAttempts.get(ip) || []).filter(
    (t) => now - t < LOGIN_WINDOW_MS
  );
  if (!attempts.length) loginAttempts.delete(ip);

  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil(
      (LOGIN_WINDOW_MS - (now - attempts[0])) / 1000
    );
    res.set("Retry-After", String(retryAfter));
    return bad(res, 429, "Too many attempts. Try again in a few minutes.");
  }

  if (!loginAttempts.has(ip) && loginAttempts.size >= LOGIN_TRACKED_IPS) {
    for (const [key, list] of loginAttempts) {
      const fresh = list.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (fresh.length) loginAttempts.set(key, fresh);
      else loginAttempts.delete(key);
    }
    if (loginAttempts.size >= LOGIN_TRACKED_IPS) loginAttempts.clear();
  }

  attempts.push(now);
  loginAttempts.set(ip, attempts);
  next();
}

const clearLoginAttempts = (req) => loginAttempts.delete(req.ip);

/* ---------- input bounds ------------------------------------------------- */

/**
 * express.json already caps the whole body at 64 MB (headroom for base64
 * photos); these stop a valid, small request from still storing an
 * unreasonable string in the database.
 */
const MAX_LEN = {
  username: 64,
  label: 200,
  note: 200,
  modelParam: 200,
  baseUrl: 500,
  title: 200,
  content: 100_000,
  systemPrompt: 20_000,
  memory: 1_000,
  attachment: 200_000,       // one pasted article or dropped text file
  attachmentsTotal: 400_000, // everything attached to a single turn
  imageDataUrl: 12_000_000, // ≈9 MB of image in base64
  // A picture of a face at 256px. The browser squares and shrinks the file
  // before it's sent (see SettingsDialog), so this is a backstop against a
  // client that doesn't, not the working size.
  avatar: 400_000,
};

const tooLong = (value, max) =>
  typeof value === "string" && value.length > max;

// The only image formats an upstream vision model is asked to decode —
// mirrors the client's accept list, applied to what actually arrives.
const IMAGE_RE = /^data:image\/(jpeg|png|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGES = 4;

/**
 * req.body.images → at most four jpeg/png/gif data URLs. Anything that
 * isn't a string, isn't one of the three mime types, or is oversized is
 * dropped rather than rejecting the whole turn.
 */
const sanitizeImages = (raw) =>
  !Array.isArray(raw)
    ? []
    : raw
        .filter(
          (s) =>
            typeof s === "string" &&
            IMAGE_RE.test(s) &&
            s.length <= MAX_LEN.imageDataUrl
        )
        .slice(0, MAX_IMAGES);

/**
 * Text carried alongside a turn: a pasted article, a dropped .txt or .md.
 *
 * Kept out of the message body on purpose. A 40 KB article pasted into the
 * composer buries the actual question in a wall of someone else's prose —
 * as an attachment the question stays a question, the source stays quotable
 * verbatim, and both are stored separately (see chatFiles.js, which already
 * writes attachments into the Markdown mirror because the Claude importer
 * has produced them since day one).
 */
const MAX_ATTACHMENTS = 5;

const sanitizeAttachments = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let budget = MAX_LEN.attachmentsTotal;
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== "object") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (!text.trim()) continue;
    const clipped = text.slice(0, Math.min(MAX_LEN.attachment, budget));
    if (!clipped) break;
    budget -= clipped.length;
    out.push({
      name: String(item.name || "Pasted text").slice(0, MAX_LEN.label),
      // Where it came from, when it came from somewhere: the bubble links
      // it, and the model is told, so it can say "the piece says…" rather
      // than inventing a citation.
      ...(typeof item.url === "string" && /^https?:\/\//i.test(item.url)
        ? { url: item.url.slice(0, MAX_LEN.baseUrl) }
        : {}),
      text: clipped,
    });
  }
  return out;
};

/** normaliseBase + the blocklist + a length cap, as one check. */
const baseProblem = (base) => {
  if (!base) return "Server base URL is required";
  if (base.length > MAX_LEN.baseUrl) return "Server base URL is too long";
  if (isBlockedBase(base)) return "That address is not allowed";
  return null;
};

/* ---------- sampler defaults -------------------------------------------- */

/**
 * "Default" means what the model server itself would do if we sent nothing —
 * so the numbers come from llama-server's /props, not from us. These are only
 * the last resort for a server that has no /props route (vLLM, a hosted API)
 * or that isn't answering; they are llama.cpp's own documented defaults.
 */
const FALLBACK_DEFAULTS = {
  temperature: 0.8,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  repeat_penalty: 1.1,
};

const DEFAULTS_TTL = 60_000;
const RUNNING_TTL = 4_000; // status is meant to look live
const CACHE_MAX = 500; // bounded: entries are keyed by admin-entered base URLs
const defaultsCache = new Map(); // "base::model" -> { at, defaults, source }
const runningCache = new Map(); // base URL -> { at, models, reachable }

/** Map.set with a cap on the oldest entry, so the caches can't grow without
 *  limit as endpoints come and go. */
const cachedSet = (cache, key, value) => {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
};

/**
 * Which models a server currently holds in memory, cached briefly so a UI
 * polling for status doesn't hammer it.
 *
 * models === null means the server has no concept of loading models on
 * demand (a bare llama-server serves one model, always resident), which is
 * different from "supports it, none loaded".
 */
async function runningFor(base) {
  const hit = runningCache.get(base);
  if (hit && Date.now() - hit.at < RUNNING_TTL) return hit;

  let entry;
  try {
    entry = {
      at: Date.now(),
      models: await fetchRunningModels(base, db.keys[base]),
      reachable: true,
    };
  } catch (err) {
    entry = { at: Date.now(), models: null, reachable: false, error: err.message };
  }
  cachedSet(runningCache, base, entry);
  return entry;
}

/**
 * The defaults for one endpoint, cached briefly: the sampler page asks on
 * every model switch, and a restarted server should be picked up without
 * restarting this one.
 *
 * Keyed by base *and* model, not base alone — behind llama-swap every model
 * on one base URL has its own sampler settings, so a per-base cache would
 * hand all twenty of them whichever one was looked up first.
 */
async function defaultsFor(endpoint) {
  const base = endpoint.baseUrl;
  const model = endpoint.modelParam;
  const key = `${base}::${model}`;
  const hit = defaultsCache.get(key);
  if (hit && Date.now() - hit.at < DEFAULTS_TTL) return hit;

  const running = await runningFor(base);
  // Only ask the per-model proxy about a model that's already resident:
  // asking about a cold one makes llama-swap load it, and opening a settings
  // page must never swap a model into memory as a side effect.
  const viaProxy = Array.isArray(running.models) && running.models.includes(model);

  let entry = {
    at: Date.now(),
    defaults: { ...FALLBACK_DEFAULTS },
    // "idle" is worth distinguishing from a plain failure: the numbers are
    // knowable, just not without loading the model first.
    source: !running.reachable
      ? "unreachable"
      : Array.isArray(running.models) && !viaProxy
        ? "idle"
        : "fallback",
  };

  try {
    const live = await fetchServerDefaults(
      base,
      db.keys[base],
      viaProxy ? model : null
    );
    entry = {
      at: Date.now(),
      defaults: { ...FALLBACK_DEFAULTS, ...live },
      source: "server",
    };
  } catch (err) {
    console.warn(`[sampler] no defaults for ${model} on ${base}: ${err.message}`);
  }
  cachedSet(defaultsCache, key, entry);
  return entry;
}

/** The settings a request actually runs with: admin overrides over defaults. */
async function samplerFor(endpointId) {
  const endpoint = db.endpoints.find((e) => e.id === endpointId);
  const { defaults } = endpoint
    ? await defaultsFor(endpoint)
    : { defaults: { ...FALLBACK_DEFAULTS } };
  return {
    ...defaults,
    systemPrompt: "",
    ...(db.samplers[endpointId] || {}),
  };
}

/* ---------- endpoints as the browser sees them --------------------------- */
/* Base URLs and keys never leave the server for non-admins. */

/*
 * Does this endpoint read attached images?
 *
 * llama-server / OpenAI-compatible /v1/models don't report modalities, so
 * the default is a name-based guess — every common open-weights vision
 * family (Qwen-VL, LLaVA, MiniCPM, Gemma 3, Pixtral, Phi-4 multimodal, …)
 * says so in its name. A stored boolean overrides the guess, which is how
 * the admin table's per-endpoint toggle pins either answer.
 */
const VISION_NAME_RE =
  /(vl|vision|vit|clip|llava|minicpm|gemma[-_.]?3|pixtral|moondream|multimodal|smolvlm|dots|internvl|omni|llama[-_.]?3[.\-]?2|phi[-_.]?4|olmocr|deepseek[-_.]?ocr|kimi[-_.]?vl)/i;

function endpointVision(e) {
  if (typeof e.vision === "boolean") return e.vision;
  return VISION_NAME_RE.test(`${e.modelParam} ${e.label}`);
}

const publicEndpoint = (e) => ({
  id: e.id,
  label: e.label,
  note: e.note || "",
  vision: endpointVision(e),
});

const adminEndpoint = (e) => ({
  ...publicEndpoint(e),
  baseUrl: e.baseUrl,
  modelParam: e.modelParam,
  hasKey: !!db.keys[e.baseUrl],
});

/* ---------- auth --------------------------------------------------------- */

app.get("/api/session", (req, res) =>
  ok(res, { user: publicUser(req.user), needsSetup: needsBootstrap() })
);

// Only available while no account exists — the first-run admin. Rate-limited
// like login: an attempt here costs the server a cost-12 bcrypt, so an
// unthrottled hammerer would pin a CPU core.
app.post("/api/auth/setup", loginRateLimit, (req, res) => {
  if (!needsBootstrap()) return bad(res, 409, "Already set up");
  const { username, password } = req.body || {};
  if (!username?.trim()) return bad(res, 400, "Username is required");
  if (tooLong(username, MAX_LEN.username))
    return bad(res, 400, `Username must be at most ${MAX_LEN.username} characters`);
  if (!password || password.length < 8)
    return bad(res, 400, "Passwords must be at least 8 characters");

  const user = createUser({ username, password, role: "admin" });
  clearLoginAttempts(req);
  startSession(req, res, user);
  ok(res, { user: publicUser(user) });
});

app.post("/api/auth/login", loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (tooLong(username, MAX_LEN.username))
    return bad(res, 400, "Invalid username or password");
  const user = findUser(username);
  if (!verifyPassword(user, password))
    return bad(res, 401, "Invalid username or password");
  clearLoginAttempts(req);
  startSession(req, res, user);
  ok(res, { user: publicUser(user) });
});

/**
 * Change your own username or password.
 *
 * The current password is required for either — a borrowed, unlocked
 * browser shouldn't be able to lock the owner out of their own account.
 * Admins change *other* people's credentials under Admin → Users; this is
 * only ever the signed-in account.
 */
app.patch("/api/account", requireAuth, (req, res) => {
  const { username, currentPassword, newPassword } = req.body || {};
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return bad(res, 404, "No such account");
  if (!verifyPassword(user, currentPassword))
    return bad(res, 403, "That isn't your current password");

  const name = typeof username === "string" ? username.trim() : "";
  if (name && name !== user.username) {
    if (tooLong(name, MAX_LEN.username))
      return bad(res, 400, `Username must be at most ${MAX_LEN.username} characters`);
    // findUser is case-insensitive, which is what makes this a real check.
    if (findUser(name)) return bad(res, 409, "That username is taken");
    user.username = name;
  }

  if (newPassword) {
    if (newPassword.length < 8)
      return bad(res, 400, "Passwords must be at least 8 characters");
    user.passwordHash = hashPassword(newPassword);
    // Every other session was signed in with the old password; a password
    // change is also how you get a stolen one out.
    for (const [token, session] of Object.entries(db.sessions))
      if (session.userId === user.id && token !== req.cookies?.[COOKIE])
        delete db.sessions[token];
  }

  save();
  ok(res, { user: publicUser(user) });
});

/**
 * Your own picture.
 *
 * Separate from the account route above, which asks for your password
 * before it will change anything: a password is the right gate on a
 * username or a password, and the wrong one on a photo. Losing this to
 * someone at your unlocked laptop costs you a picture.
 */
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

app.put("/api/account/avatar", requireAuth, (req, res) => {
  const { avatar } = req.body || {};
  if (typeof avatar !== "string" || !AVATAR_RE.test(avatar))
    return bad(res, 400, "That isn't a PNG, JPEG or WebP image");
  if (avatar.length > MAX_LEN.avatar)
    return bad(res, 400, "That picture is too large — try a smaller one");

  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return bad(res, 404, "No such account");
  user.avatar = avatar;
  save();
  ok(res, { user: publicUser(user) });
});

app.delete("/api/account/avatar", requireAuth, (req, res) => {
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return bad(res, 404, "No such account");
  delete user.avatar;
  save();
  ok(res, { user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  endSession(req, res);
  ok(res);
});

/* ---------- models available to chat ------------------------------------- */

app.get("/api/models", requireAuth, (_req, res) =>
  ok(res, { models: db.endpoints.map(publicEndpoint) })
);

/**
 * Which models are loaded in memory right now, for the dot in the picker.
 *
 * One probe per distinct base URL rather than per model — twenty endpoints
 * sharing a llama-swap instance is one question, not twenty. Results are
 * cached in runningFor(), so polling this is cheap.
 *
 * status: "loaded"      resident and answering
 *         "idle"        server is up, this model isn't loaded
 *         "unreachable" server didn't answer at all
 *         "unknown"     server is up but doesn't report per-model state
 *                       (a bare llama-server, vLLM) — the honest answer,
 *                       rather than implying a load state we can't see
 */
app.get("/api/models/status", requireAuth, async (_req, res) => {
  const bases = [...new Set(db.endpoints.map((e) => e.baseUrl))];
  const byBase = new Map(
    await Promise.all(
      bases.map(async (base) => [base, await runningFor(base)])
    )
  );

  const statuses = {};
  for (const endpoint of db.endpoints) {
    const running = byBase.get(endpoint.baseUrl);
    statuses[endpoint.id] = !running?.reachable
      ? "unreachable"
      : !Array.isArray(running.models)
        ? "unknown"
        : running.models.includes(endpoint.modelParam)
          ? "loaded"
          : "idle";
  }
  ok(res, { statuses });
});

/* ---------- admin: endpoints --------------------------------------------- */

app.get("/api/admin/endpoints", requireAdmin, (_req, res) =>
  ok(res, { endpoints: db.endpoints.map(adminEndpoint) })
);

app.post("/api/admin/endpoints", requireAdmin, (req, res) => {
  const { label, note, baseUrl, modelParam, apiKey, vision } = req.body || {};
  const base = normaliseBase(baseUrl);
  const problem = baseProblem(base);
  if (problem) return bad(res, 400, problem);
  if (!label?.trim()) return bad(res, 400, "Label is required");
  if (
    tooLong(label, MAX_LEN.label) ||
    tooLong(note, MAX_LEN.note) ||
    tooLong(modelParam, MAX_LEN.modelParam)
  )
    return bad(
      res,
      400,
      `Label, note and model param must be at most ${MAX_LEN.label} characters`
    );
  if (!modelParam.trim()) return bad(res, 400, "Model param is required");

  const endpoint = {
    id: uid(),
    label: label.trim(),
    note: (note || "").trim(),
    baseUrl: base,
    modelParam: modelParam.trim(),
    createdAt: Date.now(),
  };
  // Only an explicit boolean pins it; a missing flag leaves the name-based
  // guess (endpointVision) in charge.
  if (vision === true || vision === false) endpoint.vision = !!vision;
  db.endpoints.push(endpoint);
  if (apiKey?.trim()) db.keys[base] = apiKey.trim();
  save();
  ok(res, { endpoint: adminEndpoint(endpoint) });
});

// "Preview models" — ask the server what it has, change nothing.
app.post("/api/admin/endpoints/preview", requireAdmin, async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  const base = normaliseBase(baseUrl);
  const problem = baseProblem(base);
  if (problem) return bad(res, 400, problem);
  try {
    const models = await listModels(base, apiKey?.trim() || db.keys[base]);
    ok(res, { baseUrl: base, models });
  } catch (err) {
    bad(res, 502, describeUpstreamError(err, base));
  }
});

// "Add all models from this server" — idempotent, so re-running it picks up
// new models without duplicating the ones already listed.
app.post("/api/admin/endpoints/import", requireAdmin, async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  const base = normaliseBase(baseUrl);
  const problem = baseProblem(base);
  if (problem) return bad(res, 400, problem);

  const key = apiKey?.trim() || db.keys[base];
  let models;
  try {
    models = await listModels(base, key);
  } catch (err) {
    return bad(res, 502, describeUpstreamError(err, base));
  }

  const existing = new Set(
    db.endpoints
      .filter((e) => e.baseUrl === base)
      .map((e) => e.modelParam.toLowerCase())
  );

  const added = [];
  for (const model of models) {
    if (existing.has(model.id.toLowerCase())) continue;
    const endpoint = {
      id: uid(),
      label: model.label,
      note: "",
      baseUrl: base,
      modelParam: model.id,
      vision: false,
      createdAt: Date.now(),
    };
    db.endpoints.push(endpoint);
    added.push(endpoint);
  }

  if (apiKey?.trim()) db.keys[base] = apiKey.trim();
  save();
  ok(res, {
    added: added.map(adminEndpoint),
    skipped: models.length - added.length,
    endpoints: db.endpoints.map(adminEndpoint),
  });
});

app.patch("/api/admin/endpoints/:id", requireAdmin, (req, res) => {
  const endpoint = db.endpoints.find((e) => e.id === req.params.id);
  if (!endpoint) return bad(res, 404, "Endpoint not found");
  const { vision } = req.body || {};
  if (vision !== undefined) endpoint.vision = !!vision;
  save();
  ok(res, { endpoint: adminEndpoint(endpoint) });
});

app.delete("/api/admin/endpoints/:id", requireAdmin, (req, res) => {
  const index = db.endpoints.findIndex((e) => e.id === req.params.id);
  if (index === -1) return bad(res, 404, "No such endpoint");

  const [removed] = db.endpoints.splice(index, 1);
  delete db.samplers[removed.id];
  // Drop the shared key once nothing else points at that server.
  if (!db.endpoints.some((e) => e.baseUrl === removed.baseUrl))
    delete db.keys[removed.baseUrl];
  save();
  ok(res, { endpoints: db.endpoints.map(adminEndpoint) });
});

/* ---------- admin: sampler ----------------------------------------------- */

app.get("/api/admin/sampler/:endpointId", requireAdmin, async (req, res) => {
  const endpoint = db.endpoints.find((e) => e.id === req.params.endpointId);
  if (!endpoint) return bad(res, 404, "No such endpoint");

  const { defaults, source } = await defaultsFor(endpoint);
  ok(res, {
    sampler: await samplerFor(endpoint.id),
    defaults: { ...defaults, systemPrompt: "" },
    // The page says where the numbers came from, so "reset to defaults" is
    // never a mystery about whose defaults it means.
    defaultsSource: source,
  });
});

// Generous on purpose — wide enough to cover every value anyone would
// plausibly type, narrow enough to reject the obviously-wrong (Infinity, a
// pasted timestamp) before it reaches the model server.
const SAMPLER_BOUNDS = {
  temperature: [0, 5],
  top_p: [0, 1],
  top_k: [0, 1000],
  min_p: [0, 1],
  repeat_penalty: [0, 5],
};

app.put("/api/admin/sampler/:endpointId", requireAdmin, async (req, res) => {
  const endpoint = db.endpoints.find((e) => e.id === req.params.endpointId);
  if (!endpoint) return bad(res, 404, "No such endpoint");

  const incoming = req.body || {};
  const next = { ...(await samplerFor(endpoint.id)) };
  for (const [key, [min, max]] of Object.entries(SAMPLER_BOUNDS)) {
    if (!(key in incoming)) continue;
    const value = Number(incoming[key]);
    if (!Number.isFinite(value) || value < min || value > max)
      return bad(res, 400, `${key} must be a number between ${min} and ${max}`);
    next[key] = value;
  }
  if ("systemPrompt" in incoming) {
    const prompt = String(incoming.systemPrompt || "");
    if (prompt.length > MAX_LEN.systemPrompt)
      return bad(
        res,
        400,
        `System prompt must be at most ${MAX_LEN.systemPrompt} characters`
      );
    next.systemPrompt = prompt;
  }

  db.samplers[endpoint.id] = next;
  save();
  ok(res, { sampler: next });
});

/* ---------- admin: accounts ---------------------------------------------- */

app.get("/api/admin/users", requireAdmin, (_req, res) =>
  ok(res, { users: db.users.map(publicUser) })
);

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username?.trim()) return bad(res, 400, "Username is required");
  if (tooLong(username, MAX_LEN.username))
    return bad(res, 400, `Username must be at most ${MAX_LEN.username} characters`);
  if (findUser(username)) return bad(res, 409, "That username is taken");
  if (!password || password.length < 8)
    return bad(res, 400, "Passwords must be at least 8 characters");

  const user = createUser({ username, password, role });
  ok(res, { user: publicUser(user), users: db.users.map(publicUser) });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return bad(res, 404, "No such account");

  const { password, role } = req.body || {};
  if (password) {
    if (password.length < 8)
      return bad(res, 400, "Passwords must be at least 8 characters");
    user.passwordHash = hashPassword(password);
  }
  if (role === "admin" || role === "user") {
    // Don't let the last admin demote themselves out of the admin panel.
    const admins = db.users.filter((u) => u.role === "admin");
    if (user.role === "admin" && role === "user" && admins.length === 1)
      return bad(res, 400, "There has to be at least one admin");
    user.role = role;
  }
  save();
  ok(res, { user: publicUser(user), users: db.users.map(publicUser) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === req.user.id)
    return bad(res, 400, "You can't delete the account you're signed in to");

  const index = db.users.findIndex((u) => u.id === req.params.id);
  if (index === -1) return bad(res, 404, "No such account");

  const [removed] = db.users.splice(index, 1);
  for (const c of db.conversations)
    if (c.userId === removed.id) removeConversationFiles(c.id);
  db.conversations = db.conversations.filter((c) => c.userId !== removed.id);
  delete db.memories[removed.id];
  delete db.skills[removed.id];
  delete db.knowledge[removed.id];
  for (const [token, session] of Object.entries(db.sessions))
    if (session.userId === removed.id) delete db.sessions[token];
  save();
  ok(res, { users: db.users.map(publicUser) });
});

/* ---------- conversations ------------------------------------------------ */

const summary = (c) => ({
  id: c.id,
  title: c.title,
  endpointId: c.endpointId,
  skillIds: c.skillIds || [],
  useKnowledge: !!c.useKnowledge,
  pinned: !!c.pinned,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const owned = (req) => {
  const convo = db.conversations.find((c) => c.id === req.params.id);
  return convo && convo.userId === req.user.id ? convo : null;
};

const titleFrom = (text) => {
  const clean = String(text).trim().replace(/\s+/g, " ");
  return clean.length > 48 ? clean.slice(0, 48).trimEnd() + "…" : clean;
};

app.get("/api/conversations", requireAuth, (req, res) =>
  ok(res, {
    conversations: db.conversations
      .filter((c) => c.userId === req.user.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summary),
  })
);

/**
 * Search your own history — titles *and* what was actually said.
 *
 * Everything is already in memory, so this is a plain scan: a few hundred
 * conversations cost less than the round trip that carried the query. Each
 * hit comes back with the line it matched, so the sidebar can show why.
 */
// Lopsided on purpose: the sidebar is narrow and truncates the tail, so the
// match has to sit near the front of the snippet to survive the ellipsis.
const SNIPPET_BEFORE = 16;
const SNIPPET_AFTER = 120;

const snippetAround = (text, at, needle) => {
  const from = Math.max(0, at - SNIPPET_BEFORE);
  const to = Math.min(text.length, at + needle.length + SNIPPET_AFTER);
  return (
    (from > 0 ? "…" : "") +
    text.slice(from, to).replace(/\s+/g, " ").trim() +
    (to < text.length ? "…" : "")
  );
};

app.get("/api/conversations/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return ok(res, { conversations: [] });

  const results = [];
  for (const convo of db.conversations) {
    if (convo.userId !== req.user.id) continue;

    const inTitle = convo.title.toLowerCase().includes(q);
    let hit = null;
    let matches = 0;
    for (const m of convo.messages) {
      const text = m.content || "";
      const at = text.toLowerCase().indexOf(q);
      if (at === -1) continue;
      matches++;
      if (!hit)
        hit = {
          messageId: m.id,
          role: m.role,
          snippet: snippetAround(text, at, q),
        };
    }
    if (!inTitle && !hit) continue;
    results.push({ ...summary(convo), matches, ...(hit || {}) });
  }

  // Title matches first — you usually mean the chat you named — then the
  // most recently touched.
  results.sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(q);
    const bTitle = b.title.toLowerCase().includes(q);
    if (aTitle !== bTitle) return aTitle ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  ok(res, { conversations: results.slice(0, 50) });
});

app.get("/api/conversations/:id", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  ok(res, { conversation: convo, generating: isGenerating(convo.id) });
});

app.post("/api/conversations", requireAuth, (req, res) => {
  const { endpointId, title } = req.body || {};
  const convo = {
    id: uid(),
    userId: req.user.id,
    title: (typeof title === "string" && title.trim())
      ? title.trim().slice(0, MAX_LEN.title)
      : "New chat",
    endpointId: endpointId || db.endpoints[0]?.id || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    skillIds: [],
    messages: [],
  };
  db.conversations.push(convo);
  save();
  touchConversation(convo);
  ok(res, { conversation: convo });
});

app.patch("/api/conversations/:id", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  const { title, endpointId, pinned } = req.body || {};
  if (typeof title === "string" && title.trim())
    convo.title = title.trim().slice(0, MAX_LEN.title);
  // Pinning is not an edit of the conversation, so it deliberately doesn't
  // touch updatedAt below — a chat you pin shouldn't jump to the top of
  // "Recents" as though you'd just used it.
  if (typeof pinned === "boolean") convo.pinned = pinned;
  if (endpointId) {
    const endpoint = db.endpoints.find((e) => e.id === endpointId);
    if (!endpoint) return bad(res, 400, "That model is no longer configured");
    convo.endpointId = endpoint.id;
  }
  if (title !== undefined || endpointId !== undefined) convo.updatedAt = Date.now();
  save();
  touchConversation(convo);
  ok(res, { conversation: summary(convo) });
});

app.delete("/api/conversations/:id", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  db.conversations = db.conversations.filter((c) => c.id !== convo.id);
  save();
  removeConversationFiles(convo.id);
  ok(res, {});
});

app.patch("/api/conversations/:id/messages/:messageId", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  const message = convo.messages.find((m) => m.id === req.params.messageId);
  if (!message) return bad(res, 404, "No such message");

  const { content, images, truncate } = req.body || {};
  // The edited turn is still a turn: text, photos, or both — never neither.
  const nextContent = typeof content === "string" ? content : message.content;
  const nextImages = images === undefined ? message.images : sanitizeImages(images);
  if (!nextContent.trim() && !nextImages?.length)
    return bad(res, 400, "Message is empty");

  if (typeof content === "string") {
    if (content.length > MAX_LEN.content)
      return bad(
        res,
        400,
        `Messages must be at most ${MAX_LEN.content} characters`
      );
    message.content = content;
  }
  // Images can only be dropped from an existing turn, never added here —
  // whatever comes back is filtered down to what the message already had.
  if (images !== undefined) {
    const kept = new Set(nextImages);
    message.images = (message.images || []).filter((url) => kept.has(url));
  }
  // Editing a user message drops everything after it, ready for a re-run.
  if (truncate) {
    const at = convo.messages.indexOf(message);
    convo.messages = convo.messages.slice(0, at + 1);
  }
  convo.updatedAt = Date.now();
  save();
  touchConversation(convo);
  ok(res, { conversation: convo });
});

app.delete("/api/conversations/:id/messages/:messageId", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");

  const at = convo.messages.findIndex((m) => m.id === req.params.messageId);
  if (at === -1) return bad(res, 404, "No such message");

  // A question and the answers it produced are one exchange: deleting the
  // question on its own used to leave a reply hanging under whatever came
  // before it, which then went back to the model as history.
  let end = at + 1;
  if (convo.messages[at].role === "user")
    while (convo.messages[end]?.role === "assistant") end++;
  convo.messages.splice(at, end - at);
  convo.updatedAt = Date.now();
  save();
  touchConversation(convo);
  ok(res, { conversation: convo });
});

/* ---------- memory -------------------------------------------------------- */

/**
 * Things the model should know about you across every chat.
 *
 * Kept deliberately dumb: a short list of lines you write yourself, added
 * to the system turn of every generation (see generation.js). Nothing here
 * is extracted from conversations automatically — what the model is told
 * about you is a list you can read in full and delete a line from.
 */
const MAX_MEMORIES = 100;
const memoriesFor = (userId) => (db.memories[userId] ||= []);

app.get("/api/memories", requireAuth, (req, res) =>
  ok(res, { memories: memoriesFor(req.user.id) })
);

app.post("/api/memories", requireAuth, (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return bad(res, 400, "Nothing to remember");
  if (text.length > MAX_LEN.memory)
    return bad(res, 400, `Memories must be at most ${MAX_LEN.memory} characters`);

  const memories = memoriesFor(req.user.id);
  if (memories.length >= MAX_MEMORIES)
    return bad(res, 400, `That's the ${MAX_MEMORIES}-memory limit — delete one first`);

  memories.push({ id: uid(), text, createdAt: Date.now() });
  save();
  ok(res, { memories });
});

app.patch("/api/memories/:id", requireAuth, (req, res) => {
  const memories = memoriesFor(req.user.id);
  const memory = memories.find((m) => m.id === req.params.id);
  if (!memory) return bad(res, 404, "No such memory");
  const text = String(req.body?.text ?? "").trim();
  if (!text) return bad(res, 400, "Nothing to remember");
  if (text.length > MAX_LEN.memory)
    return bad(res, 400, `Memories must be at most ${MAX_LEN.memory} characters`);
  memory.text = text;
  memory.updatedAt = Date.now();
  save();
  ok(res, { memories });
});

app.delete("/api/memories/:id", requireAuth, (req, res) => {
  db.memories[req.user.id] = memoriesFor(req.user.id).filter(
    (m) => m.id !== req.params.id
  );
  save();
  ok(res, { memories: db.memories[req.user.id] });
});

/* ---------- skills -------------------------------------------------------- */

/**
 * A skill is a named block of instructions you can hand a chat.
 *
 * The same idea as memory, scoped differently: memory is always on and
 * about you; a skill is about a job ("Rewrite in my email voice", "Answer
 * as a code reviewer") and applies to the conversations you attach it to.
 * One marked `always` is simply attached to every chat without asking.
 *
 * There is no tool-calling here and none is implied — a skill is prompt
 * text, and the model does with it what a system turn does.
 */
const MAX_SKILLS = 50;
const skillsFor = (userId) => (db.skills[userId] ||= []);

const skillProblem = (name, instructions) => {
  if (!name?.trim()) return "A skill needs a name";
  if (tooLong(name, MAX_LEN.label)) return "That name is too long";
  if (!instructions?.trim()) return "A skill needs instructions";
  if (tooLong(instructions, MAX_LEN.systemPrompt))
    return `Instructions must be at most ${MAX_LEN.systemPrompt} characters`;
  return null;
};

app.get("/api/skills", requireAuth, (req, res) =>
  ok(res, { skills: skillsFor(req.user.id) })
);

app.post("/api/skills", requireAuth, (req, res) => {
  const { name, description, instructions, always } = req.body || {};
  const problem = skillProblem(name, instructions);
  if (problem) return bad(res, 400, problem);

  const skills = skillsFor(req.user.id);
  if (skills.length >= MAX_SKILLS)
    return bad(res, 400, `That's the ${MAX_SKILLS}-skill limit — delete one first`);

  skills.push({
    id: uid(),
    name: name.trim(),
    description: (description || "").trim().slice(0, MAX_LEN.note),
    instructions: instructions.trim(),
    always: always === true,
    createdAt: Date.now(),
  });
  save();
  ok(res, { skills });
});

app.patch("/api/skills/:id", requireAuth, (req, res) => {
  const skills = skillsFor(req.user.id);
  const skill = skills.find((s) => s.id === req.params.id);
  if (!skill) return bad(res, 404, "No such skill");

  const { name, description, instructions, always } = req.body || {};
  const nextName = name === undefined ? skill.name : name;
  const nextInstructions =
    instructions === undefined ? skill.instructions : instructions;
  const problem = skillProblem(nextName, nextInstructions);
  if (problem) return bad(res, 400, problem);

  skill.name = nextName.trim();
  skill.instructions = nextInstructions.trim();
  if (description !== undefined)
    skill.description = String(description).trim().slice(0, MAX_LEN.note);
  if (always !== undefined) skill.always = always === true;
  skill.updatedAt = Date.now();
  save();
  ok(res, { skills });
});

app.delete("/api/skills/:id", requireAuth, (req, res) => {
  db.skills[req.user.id] = skillsFor(req.user.id).filter(
    (s) => s.id !== req.params.id
  );
  // A deleted skill can't stay attached to the chats that were using it.
  for (const convo of db.conversations)
    if (convo.userId === req.user.id && convo.skillIds?.length)
      convo.skillIds = convo.skillIds.filter((id) => id !== req.params.id);
  save();
  ok(res, { skills: db.skills[req.user.id] });
});

/* ---------- import / export ---------------------------------------------- */

/**
 * Take a Claude data export (Settings → Privacy → Export data) and turn it
 * into conversations on this account.
 *
 * The zip Anthropic mails out can be uploaded whole, or just the
 * `conversations.json` from inside it; a chat this app wrote to
 * `data/chats/` round-trips too. The body is raw bytes rather than JSON so
 * a 200 MB archive isn't base64'd on the way in.
 */
app.post(
  "/api/conversations/import",
  requireAuth,
  express.raw({ type: () => true, limit: "200mb" }),
  (req, res) => {
    // express.json (mounted globally) will have parsed the body already if
    // the upload arrived as application/json; put it back as bytes.
    const buffer = Buffer.isBuffer(req.body)
      ? req.body
      : req.body && typeof req.body === "object"
        ? Buffer.from(JSON.stringify(req.body))
        : Buffer.alloc(0);
    if (!buffer.length) return bad(res, 400, "No file was uploaded");

    let imported;
    try {
      imported = parseUpload(buffer, req.user.id);
    } catch (err) {
      return bad(res, 400, err.message);
    }
    if (!imported.length)
      return bad(res, 400, "No conversations with any messages in that file");

    // Imported chats have no endpoint of their own — reading one is fine,
    // and continuing it picks up whatever model is configured now.
    const fallback = db.endpoints[0]?.id || null;
    for (const convo of imported) {
      convo.endpointId = fallback;
      db.conversations.push(convo);
      touchConversation(convo);
    }
    save();
    ok(res, {
      imported: imported.length,
      messages: imported.reduce((n, c) => n + c.messages.length, 0),
      conversations: db.conversations
        .filter((c) => c.userId === req.user.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summary),
    });
  }
);

/** One conversation as a file — the same pair kept in `data/chats/`. */
app.get("/api/conversations/:id/export", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  const markdown = req.query.format === "md";
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileStem(convo)}.${markdown ? "md" : "json"}"`
  );
  res.type(markdown ? "text/markdown" : "application/json");
  res.send(
    markdown
      ? conversationMarkdown(convo)
      : JSON.stringify(conversationJson(convo), null, 2)
  );
});

/* ---------- knowledge ----------------------------------------------------- */

/**
 * The documents a conversation can look things up in.
 *
 * Added once, used by any chat that turns retrieval on — as opposed to an
 * attachment, which belongs to the one turn it rode in on. Retrieval itself
 * lives in knowledge.js; these routes are the library's front desk.
 */
app.get("/api/knowledge", requireAuth, (req, res) =>
  ok(res, { documents: library(req.user.id).map(summarise) })
);

app.post("/api/knowledge", requireAuth, async (req, res) => {
  const { title, text, url } = req.body || {};
  try {
    // A URL is fetched and read here, the same way a pasted link is — so a
    // page can go into the library without a round trip through the
    // composer.
    if (url && !text) {
      const page = await readUrl(url);
      return ok(res, {
        document: summarise(
          addDocument(req.user.id, {
            title: title || page.title,
            text: page.text,
            url: page.url,
            source: "link",
          })
        ),
        documents: library(req.user.id).map(summarise),
      });
    }
    const document = addDocument(req.user.id, { title, text, url, source: "text" });
    ok(res, {
      document: summarise(document),
      documents: library(req.user.id).map(summarise),
    });
  } catch (err) {
    bad(res, 400, err.message);
  }
});

app.delete("/api/knowledge/:id", requireAuth, (req, res) => {
  removeDocument(req.user.id, req.params.id);
  ok(res, { documents: library(req.user.id).map(summarise) });
});

/**
 * What a question would retrieve, without asking a model anything.
 *
 * Retrieval that can't be inspected is retrieval nobody can debug: when an
 * answer misses something you know is in there, this is how you find out
 * whether the passage was never retrieved or was retrieved and ignored.
 */
app.get("/api/knowledge/search", requireAuth, (req, res) =>
  ok(res, {
    results: search(req.user.id, String(req.query.q || "")).map((hit) => ({
      title: hit.doc.title,
      url: hit.doc.url,
      score: Math.round(hit.score * 100) / 100,
      text: hit.text.slice(0, 400),
    })),
  })
);

/* ---------- reading a link ----------------------------------------------- */

/**
 * Fetch a page and hand back its article, for attaching to a turn.
 *
 * The server does the fetching, not the browser: a page is cross-origin to
 * the app, and the reader's own network is the wrong network to fetch from
 * anyway. Every rule about *what* may be fetched lives in readpage.js — this
 * route is only the door.
 *
 * Signed-in accounts only, and one at a time per account: fetching is the
 * one thing here that makes the server talk to the open internet, and a
 * loop of tabs shouldn't be able to turn it into a crawler.
 */
const reading = new Set();

app.post("/api/read-url", requireAuth, async (req, res) => {
  if (reading.has(req.user.id))
    return bad(res, 429, "Still reading the last link — one at a time");

  reading.add(req.user.id);
  try {
    const page = await readUrl(req.body?.url);
    ok(res, { page });
  } catch (err) {
    // These messages are written to be read by the person who pasted the
    // link ("that page answered 404"), so they go straight through.
    bad(res, 400, err.name === "AbortError" ? "That page took too long" : err.message);
  } finally {
    reading.delete(req.user.id);
  }
});

/* ---------- private chats ------------------------------------------------ */

/**
 * A conversation the server never keeps.
 *
 * Everything else here is stored so history follows the account — which is
 * the whole point of the app, and exactly what you don't want for some
 * questions. A private chat lives in the browser tab: the client posts the
 * whole exchange each turn, the answer streams back, and nothing touches
 * data.json or data/chats. Closing the tab is the delete.
 *
 * Your skills and memory still apply — they're yours, and the model is
 * yours. What's missing is only the writing down.
 */
app.post("/api/private/stream", requireAuth, async (req, res) => {
  const { messages, endpointId, timeZone, skillIds, useKnowledge } = req.body || {};
  const endpoint = db.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) return bad(res, 400, "That model is no longer configured");
  if (!Array.isArray(messages) || !messages.length)
    return bad(res, 400, "Nothing to answer");

  const history = [];
  for (const m of messages.slice(-200)) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content : "";
    if (tooLong(content, MAX_LEN.content))
      return bad(res, 400, `Messages must be at most ${MAX_LEN.content} characters`);
    const images = sanitizeImages(m?.images);
    const attached = sanitizeAttachments(m?.attachments);
    if (!content && !images.length && !attached.length) continue;
    history.push({
      id: uid(),
      role,
      content,
      images,
      ...(attached.length ? { attachments: attached } : {}),
      createdAt: Date.now(),
    });
  }
  if (!history.length) return bad(res, 400, "Nothing to answer");

  const mine = new Set(skillsFor(req.user.id).map((s) => s.id));
  // A conversation object that exists only for the length of this request:
  // it is never pushed into db.conversations, so nothing persists it and
  // the file mirror has nothing to write.
  const conversation = {
    id: "private-" + uid(),
    userId: req.user.id,
    title: "Private chat",
    endpointId: endpoint.id,
    skillIds: Array.isArray(skillIds) ? skillIds.filter((id) => mine.has(id)) : [],
    useKnowledge: useKnowledge === true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: history,
  };

  await streamCompletion({
    res,
    conversation,
    endpoint,
    sampler: await samplerFor(endpoint.id),
    apiKey: db.keys[endpoint.baseUrl],
    history,
    user: req.user,
    clientTimeZone: typeof timeZone === "string" ? timeZone : undefined,
  });
});

/* ---------- generation --------------------------------------------------- */

// Re-attach to a run already in progress — what a refreshed tab calls.
app.get("/api/conversations/:id/stream", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  if (!attachGeneration(convo.id, res)) return res.status(204).end();
});

// Stopping is now explicit: dropping the connection no longer cancels a run.
app.post("/api/conversations/:id/stop", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  ok(res, { stopped: stopGeneration(convo.id) });
});

app.post("/api/conversations/:id/stream", requireAuth, async (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");

  if (isGenerating(convo.id))
    return bad(res, 409, "That conversation is already generating");

  const { content, endpointId, regenerate, timeZone, skillIds, useKnowledge } =
    req.body || {};
  // Sticky, like skills: turn it on once and the follow-ups keep it.
  if (typeof useKnowledge === "boolean") convo.useKnowledge = useKnowledge;
  // Skills stay attached to the conversation once chosen, so a follow-up
  // question keeps the same instructions without re-picking them.
  if (Array.isArray(skillIds)) {
    const mine = new Set(skillsFor(req.user.id).map((s) => s.id));
    convo.skillIds = skillIds.filter((id) => mine.has(id)).slice(0, MAX_SKILLS);
  }
  const images = sanitizeImages(req.body?.images);
  const attachments = sanitizeAttachments(req.body?.attachments);
  // The browser's IANA timezone, so {{CURRENT_*}} tokens resolve to where
  // the user is, not where the server runs. Invalid values fall back to
  // the server's clock inside expandSystemPrompt.
  const clientTimeZone = typeof timeZone === "string" ? timeZone : undefined;
  const endpoint = db.endpoints.find(
    (e) => e.id === (endpointId || convo.endpointId)
  );
  if (!endpoint) return bad(res, 400, "That model is no longer configured");
  convo.endpointId = endpoint.id;

  if (regenerate) {
    // Re-answer the last user turn.
    while (
      convo.messages.length &&
      convo.messages[convo.messages.length - 1].role === "assistant"
    )
      convo.messages.pop();
  } else {
    const text = content?.trim();
    // A turn is valid with text, photos, attached text, or any mix — but
    // not with none of them.
    if (!text && !images.length && !attachments.length)
      return bad(res, 400, "Message is empty");
    if (text && text.length > MAX_LEN.content)
      return bad(
        res,
        400,
        `Messages must be at most ${MAX_LEN.content} characters`
      );
    convo.messages.push({
      id: uid(),
      role: "user",
      content: text || "",
      images,
      ...(attachments.length ? { attachments } : {}),
      createdAt: Date.now(),
    });
    if (convo.title === "New chat" && text) convo.title = titleFrom(text);
  }

  convo.updatedAt = Date.now();
  save();
  touchConversation(convo);

  await streamCompletion({
    res,
    conversation: convo,
    endpoint,
    sampler: await samplerFor(endpoint.id),
    apiKey: db.keys[endpoint.baseUrl],
    history: convo.messages.filter((m) => m.role !== "assistant" || m.content),
    user: req.user,
    clientTimeZone,
  });
});

/* ---------- static frontend ---------------------------------------------- */

// Last-resort handler: an unexpected throw never leaks a stack trace to
// the client, and a request that already started streaming isn't touched.
// Errors that carry their own 4xx status (express.json's invalid-JSON and
// friends) keep it; everything else is a plain 500.
app.use((err, _req, res, _next) => {
  console.error("[aientic] unhandled error:", err);
  if (res.headersSent) return;
  const status = Number(err.status) || 0;
  if (status >= 400 && status < 500) return bad(res, status, err.message);
  bad(res, 500, "Internal server error");
});

const dist = path.join(import.meta.dirname, "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.use("/api", (_req, res) => bad(res, 404, "No such route"));

// Both env vars point at PEM files. Set neither and this is exactly the
// plain-HTTP LAN server it always was; set both and the server terminates
// TLS itself. Set one without the other and refuse to start, rather than
// silently falling back to unencrypted with a half-finished cert config.
const tlsCertPath = process.env.AIENTIC_TLS_CERT;
const tlsKeyPath = process.env.AIENTIC_TLS_KEY;
if (!!tlsCertPath !== !!tlsKeyPath) {
  console.error(
    "[aientic] AIENTIC_TLS_CERT and AIENTIC_TLS_KEY must both be set to enable HTTPS"
  );
  process.exit(1);
}
const tls = tlsCertPath && {
  cert: fs.readFileSync(tlsCertPath),
  key: fs.readFileSync(tlsKeyPath),
};

const server = tls ? https.createServer(tls, app) : app;
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[aientic] listening on http${tls ? "s" : ""}://0.0.0.0:${PORT}`
  );
  console.log(`[aientic] data directory: ${dataDir}`);
  // Bring data/chats/ up to date with the store, so a directory that
  // predates this mirror (or was cleaned out) fills itself back in.
  syncAllConversations();
  if (needsBootstrap())
    console.log("[aientic] no accounts yet — open the app to create the admin");
});
