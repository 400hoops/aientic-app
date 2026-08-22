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

app.use(express.json({ limit: "8mb" }));
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
const defaultsCache = new Map(); // "base::model" -> { at, defaults, source }
const runningCache = new Map(); // base URL -> { at, models, reachable }

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
  runningCache.set(base, entry);
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
  defaultsCache.set(key, entry);
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

const publicEndpoint = (e) => ({
  id: e.id,
  label: e.label,
  note: e.note || "",
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

// Only available while no account exists — the first-run admin.
app.post("/api/auth/setup", (req, res) => {
  if (!needsBootstrap()) return bad(res, 409, "Already set up");
  const { username, password } = req.body || {};
  if (!username?.trim()) return bad(res, 400, "Username is required");
  if (!password || password.length < 8)
    return bad(res, 400, "Passwords must be at least 8 characters");

  const user = createUser({ username, password, role: "admin" });
  startSession(req, res, user);
  ok(res, { user: publicUser(user) });
});

app.post("/api/auth/login", loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser(username);
  if (!verifyPassword(user, password))
    return bad(res, 401, "Invalid username or password");
  clearLoginAttempts(req);
  startSession(req, res, user);
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
  const { label, note, baseUrl, modelParam, apiKey } = req.body || {};
  const base = normaliseBase(baseUrl);
  if (!base) return bad(res, 400, "Server base URL is required");
  if (isBlockedBase(base))
    return bad(res, 400, "That address is not allowed");
  if (!label?.trim()) return bad(res, 400, "Label is required");
  if (!modelParam?.trim()) return bad(res, 400, "Model param is required");

  const endpoint = {
    id: uid(),
    label: label.trim(),
    note: (note || "").trim(),
    baseUrl: base,
    modelParam: modelParam.trim(),
    createdAt: Date.now(),
  };
  db.endpoints.push(endpoint);
  if (apiKey?.trim()) db.keys[base] = apiKey.trim();
  save();
  ok(res, { endpoint: adminEndpoint(endpoint) });
});

// "Preview models" — ask the server what it has, change nothing.
app.post("/api/admin/endpoints/preview", requireAdmin, async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  const base = normaliseBase(baseUrl);
  if (!base) return bad(res, 400, "Server base URL is required");
  if (isBlockedBase(base))
    return bad(res, 400, "That address is not allowed");
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
  if (!base) return bad(res, 400, "Server base URL is required");
  if (isBlockedBase(base))
    return bad(res, 400, "That address is not allowed");

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
  if ("systemPrompt" in incoming)
    next.systemPrompt = String(incoming.systemPrompt || "");

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
  db.conversations = db.conversations.filter((c) => c.userId !== removed.id);
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
    title: title?.trim() || "New chat",
    endpointId: endpointId || db.endpoints[0]?.id || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  db.conversations.push(convo);
  save();
  ok(res, { conversation: convo });
});

app.patch("/api/conversations/:id", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  const { title, endpointId } = req.body || {};
  if (typeof title === "string" && title.trim()) convo.title = title.trim();
  if (endpointId) {
    const endpoint = db.endpoints.find((e) => e.id === endpointId);
    if (!endpoint) return bad(res, 400, "That model is no longer configured");
    convo.endpointId = endpoint.id;
  }
  convo.updatedAt = Date.now();
  save();
  ok(res, { conversation: summary(convo) });
});

app.delete("/api/conversations/:id", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  db.conversations = db.conversations.filter((c) => c.id !== convo.id);
  save();
  ok(res, {});
});

app.patch("/api/conversations/:id/messages/:messageId", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  const message = convo.messages.find((m) => m.id === req.params.messageId);
  if (!message) return bad(res, 404, "No such message");

  const { content, truncate } = req.body || {};
  if (typeof content === "string") message.content = content;
  // Editing a user message drops everything after it, ready for a re-run.
  if (truncate) {
    const at = convo.messages.indexOf(message);
    convo.messages = convo.messages.slice(0, at + 1);
  }
  convo.updatedAt = Date.now();
  save();
  ok(res, { conversation: convo });
});

app.delete("/api/conversations/:id/messages/:messageId", requireAuth, (req, res) => {
  const convo = owned(req);
  if (!convo) return bad(res, 404, "No such conversation");
  convo.messages = convo.messages.filter((m) => m.id !== req.params.messageId);
  convo.updatedAt = Date.now();
  save();
  ok(res, { conversation: convo });
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

  const { content, endpointId, regenerate } = req.body || {};
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
    if (!content?.trim()) return bad(res, 400, "Message is empty");
    convo.messages.push({
      id: uid(),
      role: "user",
      content: content.trim(),
      createdAt: Date.now(),
    });
    if (convo.title === "New chat") convo.title = titleFrom(content);
  }

  convo.updatedAt = Date.now();
  save();

  await streamCompletion({
    res,
    conversation: convo,
    endpoint,
    sampler: await samplerFor(endpoint.id),
    apiKey: db.keys[endpoint.baseUrl],
    history: convo.messages.filter((m) => m.role !== "assistant" || m.content),
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
  if (needsBootstrap())
    console.log("[aientic] no accounts yet — open the app to create the admin");
});
