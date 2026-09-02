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
/** Your own username and password. Both need the current password. */
export const updateAccount = (patch) =>
  request("/account", { method: "PATCH", body: patch });

/* ---------- models ------------------------------------------------------- */

export const getModels = () => request("/models");
/** Which models are loaded in memory — drives the dot in the picker. */
export const getModelStatus = () => request("/models/status");

/* ---------- conversations ------------------------------------------------ */

export const listConversations = () => request("/conversations");
export const getConversation = (id) => request(`/conversations/${id}`);
/** Titles and message contents, with the line each hit matched on. */
export const searchConversations = (q, signal) =>
  request(`/conversations/search?q=${encodeURIComponent(q)}`, { signal });
export const createConversation = (endpointId) =>
  request("/conversations", { method: "POST", body: { endpointId } });
export const renameConversation = (id, title) =>
  request(`/conversations/${id}`, { method: "PATCH", body: { title } });
/** Pin a chat to the top of the sidebar (or unpin it). */
export const pinConversation = (id, pinned) =>
  request(`/conversations/${id}`, { method: "PATCH", body: { pinned } });
export const deleteConversation = (id) =>
  request(`/conversations/${id}`, { method: "DELETE" });
export const deleteMessage = (conversationId, messageId) =>
  request(`/conversations/${conversationId}/messages/${messageId}`, {
    method: "DELETE",
  });
/**
 * Edit a turn: new text, and the attachments it keeps. `images` is the
 * surviving subset of what the message already had — the server won't
 * accept new ones here.
 */
export const editMessage = (conversationId, messageId, content, images) =>
  request(`/conversations/${conversationId}/messages/${messageId}`, {
    method: "PATCH",
    body: { content, images, truncate: true },
  });

/**
 * A Claude data export — the zip, or the conversations.json inside it —
 * sent as raw bytes rather than JSON, so a large archive isn't inflated by
 * a third on the way up.
 */
export async function importChats(file) {
  const res = await fetch("/api/conversations/import", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(payload?.error || `Import failed (${res.status})`);
  return payload;
}

/** Download one chat as Markdown or JSON. */
export const exportChatUrl = (id, format = "md") =>
  `/api/conversations/${id}/export?format=${format}`;

/**
 * Fetch a link and get its article back, to attach to a turn. The server
 * does the fetching — see server/readpage.js for why, and for what it
 * refuses to fetch.
 */
export const readUrl = (url, signal) =>
  request("/read-url", { method: "POST", body: { url }, signal });

/* ---------- knowledge ---------------------------------------------------- */

export const listKnowledge = () => request("/knowledge");
/** Either { title, text } or { url } — a link is fetched and read server-side. */
export const addKnowledge = (document) =>
  request("/knowledge", { method: "POST", body: document });
export const removeKnowledge = (id) =>
  request(`/knowledge/${id}`, { method: "DELETE" });
/** What a question would retrieve, with no model involved. */
export const searchKnowledge = (q) =>
  request(`/knowledge/search?q=${encodeURIComponent(q)}`);

/* ---------- skills ------------------------------------------------------- */

export const listSkills = () => request("/skills");
export const addSkill = (skill) =>
  request("/skills", { method: "POST", body: skill });
export const editSkill = (id, patch) =>
  request(`/skills/${id}`, { method: "PATCH", body: patch });
export const removeSkill = (id) =>
  request(`/skills/${id}`, { method: "DELETE" });

/* ---------- memory ------------------------------------------------------- */

export const listMemories = () => request("/memories");
export const addMemory = (text) =>
  request("/memories", { method: "POST", body: { text } });
export const editMemory = (id, text) =>
  request(`/memories/${id}`, { method: "PATCH", body: { text } });
export const removeMemory = (id) =>
  request(`/memories/${id}`, { method: "DELETE" });

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
  {
    content,
    endpointId,
    regenerate = false,
    images,
    attachments,
    skillIds,
    useKnowledge,
    signal,
  },
  handlers = {},
) {
  const res = await fetch(`/api/conversations/${conversationId}/stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      endpointId,
      regenerate,
      images,
      attachments,
      skillIds,
      useKnowledge,
      // Where the user is, so {{CURRENT_WEEKDAY}} / {{CURRENT_DATETIME}} /
      // {{CURRENT_TIMEZONE}} resolve to their clock, not the server's.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
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

/**
 * A private turn: the whole exchange goes up with the request and nothing
 * comes back to a conversation id, because there isn't one. See
 * /api/private/stream — the server keeps none of it.
 */
export async function streamPrivateTurn(
  { messages, endpointId, skillIds, useKnowledge, signal },
  handlers = {},
) {
  const res = await fetch("/api/private/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      endpointId,
      skillIds,
      useKnowledge,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      message = (await res.json())?.error || message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  await readSse(res, handlers);
}

/** Explicitly cancel a run; merely disconnecting no longer stops one. */
export const stopStream = (conversationId) =>
  request(`/conversations/${conversationId}/stop`, { method: "POST" });
