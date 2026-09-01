/**
 * Streaming generation.
 *
 * The browser never talks to the model server directly: it opens an SSE
 * stream against us, we open one against the upstream, and we forward tokens
 * as they land. That keeps upstream URLs and API keys server-side.
 *
 * A generation belongs to the conversation, not to the connection that
 * started it. Closing a tab or hitting refresh only unsubscribes that
 * listener — tokens keep arriving and keep being saved, and the client can
 * re-attach to a run already in progress. Only an explicit stop aborts it.
 */
import { db, save, uid } from "./storage.js";
import { touchConversation } from "./chatFiles.js";
import {
  chatUrl,
  authHeaders,
  samplerPayload,
  describeUpstreamError,
  upstreamFetch,
} from "./upstream.js";

/**
 * Models emit reasoning either as a separate `reasoning_content` delta or
 * inline inside <think> tags. This absorbs both and reports which bucket a
 * chunk belongs in.
 */
export function createReasoningSplitter() {
  let inThink = false;
  let carry = "";

  return function push(chunk) {
    const out = { reasoning: "", content: "" };
    let text = carry + chunk;
    carry = "";

    while (text) {
      const tag = inThink ? "</think>" : "<think>";
      const bucket = inThink ? "reasoning" : "content";
      const at = text.indexOf(tag);

      if (at !== -1) {
        out[bucket] += text.slice(0, at);
        text = text.slice(at + tag.length);
        inThink = !inThink;
        continue;
      }

      // No complete tag. A tag can straddle two chunks, so hold back the
      // longest suffix of this chunk that could still start one.
      let hold = 0;
      for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
        if (tag.startsWith(text.slice(text.length - n))) {
          hold = n;
          break;
        }
      }
      out[bucket] += hold ? text.slice(0, text.length - hold) : text;
      carry = hold ? text.slice(text.length - hold) : "";
      break;
    }

    return out;
  };
}

/**
 * How long to wait for the upstream to answer at all (response headers) before
 * the run gets a clear error instead of sitting in "generating" until someone
 * notices and hits Stop. A server that answers and then streams slowly for an
 * hour is fine — this only bounds the silence before the first byte, which is
 * where a hung socket or a black-holed connection shows up.
 *
 * Model *loading* and long-context prefill both happen before those headers
 * arrive, so the default is generous; AIENTIC_FIRST_RESPONSE_TIMEOUT_MS
 * overrides it (0 disables the watchdog entirely).
 */
function firstResponseTimeoutMs() {
  const raw = process.env.AIENTIC_FIRST_RESPONSE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 120_000;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  console.warn(
    `[aientic] AIENTIC_FIRST_RESPONSE_TIMEOUT_MS is not a number (got "${raw}"); using the 120 s default`
  );
  return 120_000;
}

const FIRST_RESPONSE_TIMEOUT_MS = firstResponseTimeoutMs();

/** Conversation id -> in-flight generation. */
const active = new Map();

export const isGenerating = (conversationId) => active.has(conversationId);

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const frame = (event, data) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const sseOne = (res, event, data) => {
  if (!res.writableEnded) res.write(frame(event, data));
};

/** Fan a frame out to every listener still attached to this generation. */
const sse = (gen, event, data) => {
  const payload = frame(event, data);
  for (const res of gen.subscribers) {
    if (!res.writableEnded) res.write(payload);
  }
};

/**
 * Attach a response to a generation. Dropping the connection removes the
 * listener but deliberately does NOT abort the run.
 */
function subscribe(gen, res) {
  res.set(SSE_HEADERS);
  res.flushHeaders?.();
  gen.subscribers.add(res);
  res.on("close", () => gen.subscribers.delete(res));
}

/**
 * Re-attach to a run already in progress — the refresh case. The listener
 * gets the message as it stands right now, then follows the live deltas.
 */
export function attachGeneration(conversationId, res) {
  const gen = active.get(conversationId);
  if (!gen) return false;
  subscribe(gen, res);
  sseOne(res, "sync", { message: gen.assistant });
  return true;
}

/** The only thing that actually cancels a run. */
export function stopGeneration(conversationId) {
  const gen = active.get(conversationId);
  if (!gen) return false;
  gen.controller.abort();
  return true;
}

/**
 * Fill the {{PLACEHOLDER}} tokens in a system prompt with real-world values
 * at the moment the turn is sent:
 *
 *   {{CURRENT_WEEKDAY}}   Saturday
 *   {{CURRENT_DATETIME}}  2026-08-23 21:45
 *   {{CURRENT_TIMEZONE}}  America/New_York
 *   {{USER_NAME}}         the signed-in user's username
 *
 * The clock is evaluated per request, in the client's timezone when it
 * reported one (otherwise the server's). Unknown tokens are left untouched,
 * so other custom placeholders in the prompt survive.
 */
export function expandSystemPrompt(template, { userName, timeZone } = {}) {
  const date = new Date();
  let tz = typeof timeZone === "string" && timeZone ? timeZone : undefined;
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      tz = undefined; // not a real IANA zone — fall back to the server's
    }
  }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: tz,
  }).format(date);

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const datetime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;

  const vars = {
    CURRENT_WEEKDAY: weekday,
    CURRENT_DATETIME: datetime,
    CURRENT_TIMEZONE: tz,
    USER_NAME: userName || "",
  };

  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) =>
    name in vars ? vars[name] : match
  );
}

export async function streamCompletion({
  res,
  conversation,
  endpoint,
  sampler,
  apiKey,
  history,
  user,
  clientTimeZone,
}) {
  const assistant = {
    id: uid(),
    role: "assistant",
    content: "",
    reasoning: "",
    createdAt: Date.now(),
    model: endpoint.label,
  };
  // A private chat hands us a conversation that isn't in the store at all
  // (see /api/private/stream). Streaming it is identical; writing it down
  // is what must not happen, here or at any checkpoint below.
  const ephemeral = !db.conversations.includes(conversation);
  const persist = () => {
    if (ephemeral) return;
    save();
    touchConversation(conversation);
  };

  conversation.messages.push(assistant);
  persist();

  const gen = {
    assistant,
    controller: new AbortController(),
    subscribers: new Set(),
  };
  active.set(conversation.id, gen);
  subscribe(gen, res);

  // The title, not just the message id: index.js has already applied the
  // rename-on-first-message before calling this, so it's authoritative here.
  // The client used to separately guess this title itself (duplicating this
  // exact logic) so its header could update immediately without waiting for
  // a full conversation refetch — but a guess computed independently can
  // race with a stale refetch and lose. Sending the real value over the same
  // connection that's already reliably delivering the stream removes the
  // guess (and the race) entirely.
  sse(gen, "start", { id: assistant.id, title: conversation.title });

  // A user turn with photos is the upstream's vision format: an array of
  // content parts (text plus one image_url per photo, base64 data URLs —
  // exactly what llama-server's CLIP models decode). Text-only turns stay
  // plain strings, which is cheaper for the common case.
  /**
   * Attached text — a pasted article, a dropped .md — goes up ahead of the
   * question, fenced and named. The fence matters: without it a model has
   * no way to tell where someone else's prose ends and the actual
   * instruction begins, and long pastes reliably end up answered as though
   * the article had asked the question.
   */
  const withAttachments = (m) => {
    if (!m.attachments?.length) return m.content || "";
    const documents = m.attachments
      .map(
        (a) =>
          `<document name="${String(a.name).replace(/"/g, "'")}">\n${a.text}\n</document>`
      )
      .join("\n\n");
    // The question last: it's what the model should still be holding when
    // it starts writing.
    return m.content ? `${documents}\n\n${m.content}` : documents;
  };

  const upstreamMessage = (m) =>
    m.role === "user" && m.images?.length
      ? {
          role: "user",
          content: [
            ...(withAttachments(m) ? [{ type: "text", text: withAttachments(m) }] : []),
            ...m.images.map((url) => ({
              type: "image_url",
              image_url: { url },
            })),
          ],
        }
      : {
          role: m.role,
          content: m.role === "user" ? withAttachments(m) : m.content,
        };

  const messages = [];
  // The admin's prompt for this model, plus whatever this user has asked to
  // be remembered — one system turn, memory last so it reads as context the
  // prompt is speaking about rather than instructions competing with it.
  const system = [];
  if (sampler?.systemPrompt?.trim())
    // {{CURRENT_*}} / {{USER_NAME}} resolve to the real clock at send time,
    // in the sender's timezone.
    system.push(
      expandSystemPrompt(sampler.systemPrompt, {
        userName: user?.username,
        timeZone: clientTimeZone,
      })
    );
  // Skills attached to this chat, plus any the user marked always-on.
  const skills = user ? db.skills?.[user.id] || [] : [];
  const attached = new Set(conversation.skillIds || []);
  for (const skill of skills)
    if (skill.always || attached.has(skill.id))
      system.push(`# ${skill.name}\n\n${skill.instructions}`);

  const memories = user ? db.memories?.[user.id] || [] : [];
  if (memories.length)
    system.push(
      "Things " +
        (user?.username || "the user") +
        " has asked you to remember:\n" +
        memories.map((m) => `- ${m.text}`).join("\n")
    );
  if (system.length)
    messages.push({ role: "system", content: system.join("\n\n") });
  for (const m of history) messages.push(upstreamMessage(m));

  const split = createReasoningSplitter();
  let persistAt = Date.now();

  // Abort if no response headers arrive in time. Never armed when disabled
  // (0); otherwise cleared the moment the upstream answers, so it can't kill
  // a slow-but-healthy stream.
  let timedOut = false;
  let connectTimer = null;
  if (FIRST_RESPONSE_TIMEOUT_MS > 0) {
    connectTimer = setTimeout(() => {
      timedOut = true;
      gen.controller.abort();
    }, FIRST_RESPONSE_TIMEOUT_MS);
  }

  try {
    const upstream = await upstreamFetch(chatUrl(endpoint.baseUrl), {
      method: "POST",
      headers: authHeaders(apiKey),
      signal: gen.controller.signal,
      body: JSON.stringify({
        model: endpoint.modelParam,
        stream: true,
        messages,
        ...samplerPayload(sampler),
      }),
    });

    // The upstream answered — the silence-before-first-byte window is over,
    // so the watchdog can no longer fire. Clearing it here (not just in
    // finally) is what keeps a healthy answer that legitimately takes longer
    // than the whole window to stream from being cut off mid-stream.
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      throw new Error(
        `${endpoint.label} returned ${upstream.status}` +
          (detail ? ` — ${detail.slice(0, 300)}` : "")
      );
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // incomplete tail stays buffered

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") break outer;

        let delta;
        try {
          delta = JSON.parse(payload).choices?.[0]?.delta;
        } catch {
          continue; // split JSON — the next chunk completes it
        }
        if (!delta) continue;

        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) {
          assistant.reasoning += thinking;
          sse(gen, "reasoning", { text: thinking });
        }

        if (delta.content) {
          const part = split(delta.content);
          if (part.reasoning) {
            assistant.reasoning += part.reasoning;
            sse(gen, "reasoning", { text: part.reasoning });
          }
          if (part.content) {
            assistant.content += part.content;
            sse(gen, "delta", { text: part.content });
          }
        }

        // Checkpoint occasionally so a crash mid-answer keeps most of it.
        if (Date.now() - persistAt > 2000) {
          persistAt = Date.now();
          persist();
        }
      }
    }

    // The timestamp under an answer is when the answer *finished*, not when
    // the placeholder was pushed — a two-minute generation stamped at its
    // start reads as older than the question it answers.
    assistant.createdAt = Date.now();
    conversation.updatedAt = Date.now();
    persist();
    sse(gen, "done", { message: assistant });
  } catch (err) {
    // Same on the way out: a stopped or failed run keeps whatever streamed,
    // so that partial answer is stamped when it stopped.
    assistant.createdAt = Date.now();
    conversation.updatedAt = Date.now();
    persist();

    if (timedOut) {
      // The connect watchdog fired, not a user Stop.
      if (!assistant.content && !assistant.reasoning) {
        conversation.messages = conversation.messages.filter(
          (m) => m.id !== assistant.id
        );
        persist();
      }
      sse(gen, "error", {
        message: `${endpoint.label} took too long to start responding (no reply within ${Math.round(FIRST_RESPONSE_TIMEOUT_MS / 1000)} s).`,
      });
    } else if (gen.controller.signal.aborted) {
      // Explicit stop — whatever streamed is already saved.
      sse(gen, "done", { message: assistant, stopped: true });
    } else {
      const message = describeUpstreamError(err, endpoint.baseUrl);
      if (!assistant.content && !assistant.reasoning) {
        conversation.messages = conversation.messages.filter(
          (m) => m.id !== assistant.id
        );
        persist();
      }
      sse(gen, "error", { message });
    }
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    active.delete(conversation.id);
    for (const subscriber of gen.subscribers) subscriber.end();
    gen.subscribers.clear();
  }
}
