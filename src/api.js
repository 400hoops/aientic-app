/**
 * The one place the browser talks to the server.
 *
 * Everything that used to be a localStorage read in NuxChatShell is a call in
 * here now — that swap is what makes history follow the account instead of
 * the browser.
 */

async function request(path, { method = "GET", body, signal } = {}) {
  const res = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* 204s and empty bodies */
  }

  if (!res.ok) {
    const error = new Error(payload?.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return payload || {};
}

/* ---------- session ------------------------------------------------------ */

export const getSession = () => request("/session");
export const login = (username, password) =>
  request("/auth/login", { method: "POST", body: { username, password } });
export const setupAdmin = (username, password) =>
  request("/auth/setup", { method: "POST", body: { username, password } });
export const logout = () => request("/auth/logout", { method: "POST" });

/* ---------- models ------------------------------------------------------- */

export const getModels = () => request("/models");
/** Which models are loaded in memory — drives the dot in the picker. */
export const getModelStatus = () => request("/models/status");

/* ---------- conversations ------------------------------------------------ */

export const listConversations = () => request("/conversations");
export const getConversation = (id) => request(`/conversations/${id}`);
export const createConversation = (endpointId) =>
  request("/conversations", { method: "POST", body: { endpointId } });
export const renameConversation = (id, title) =>
  request(`/conversations/${id}`, { method: "PATCH", body: { title } });
export const deleteConversation = (id) =>
  request(`/conversations/${id}`, { method: "DELETE" });
export const deleteMessage = (conversationId, messageId) =>
  request(`/conversations/${conversationId}/messages/${messageId}`, {
    method: "DELETE",
  });
export const editMessage = (conversationId, messageId, content) =>
  request(`/conversations/${conversationId}/messages/${messageId}`, {
    method: "PATCH",
    body: { content, truncate: true },
  });

/* ---------- admin -------------------------------------------------------- */

export const listEndpoints = () => request("/admin/endpoints");
export const addEndpoint = (endpoint) =>
  request("/admin/endpoints", { method: "POST", body: endpoint });
export const previewModels = (baseUrl, apiKey) =>
  request("/admin/endpoints/preview", {
    method: "POST",
    body: { baseUrl, apiKey },
  });
export const importModels = (baseUrl, apiKey) =>
  request("/admin/endpoints/import", {
    method: "POST",
    body: { baseUrl, apiKey },
  });
export const updateEndpoint = (id, patch) =>
  request(`/admin/endpoints/${id}`, { method: "PATCH", body: patch });
export const removeEndpoint = (id) =>
  request(`/admin/endpoints/${id}`, { method: "DELETE" });

export const getSampler = (endpointId) =>
  request(`/admin/sampler/${endpointId}`);
export const saveSampler = (endpointId, sampler) =>
  request(`/admin/sampler/${endpointId}`, { method: "PUT", body: sampler });

export const listUsers = () => request("/admin/users");
export const addUser = (username, password, role) =>
  request("/admin/users", {
    method: "POST",
    body: { username, password, role },
  });
export const removeUser = (id) =>
  request(`/admin/users/${id}`, { method: "DELETE" });
// General role/password update — the server applies only the keys present.
export const updateUser = (id, patch) =>
  request(`/admin/users/${id}`, { method: "PATCH", body: patch });
export const setUserPassword = (id, password) => updateUser(id, { password });

/* ---------- streaming ---------------------------------------------------- */

/**
 * POSTs a turn and reads the SSE reply.
 *
 * EventSource can't POST, so we parse the stream by hand — the same loop the
 * original client ran against llama-server, one hop further back.
 */
/** Reads an SSE body, dispatching each frame to a handler by event name. */
async function readSse(res, handlers) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop(); // incomplete frame stays buffered

    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      handlers[event]?.(payload);
    }
  }
}

export async function streamTurn(
  conversationId,
  { content, endpointId, regenerate = false, images, signal },
  handlers = {},
) {
  const res = await fetch(`/api/conversations/${conversationId}/stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, endpointId, regenerate, images }),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new Error(message);
  }

  await readSse(res, handlers);
}

/**
 * Re-attach to a generation still running on the server — the case where a
 * tab was refreshed mid-answer. Resolves false if nothing is in flight.
 */
export async function attachStream(conversationId, { signal }, handlers = {}) {
  const res = await fetch(`/api/conversations/${conversationId}/stream`, {
    credentials: "same-origin",
    signal,
  });

  if (res.status === 204 || !res.body) return false;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);

  await readSse(res, handlers);
  return true;
}

/** Explicitly cancel a run; merely disconnecting no longer stops one. */
export const stopStream = (conversationId) =>
  request(`/conversations/${conversationId}/stop`, { method: "POST" });
