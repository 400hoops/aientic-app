/**
 * A stand-in for llama-server.
 *
 * The end-to-end tests are about Aientic, not about anyone's model: they
 * need an OpenAI-compatible endpoint that answers instantly, deterministically
 * and without a GPU. This is that endpoint. It reports one model, streams a
 * fixed reply token by token, and echoes what it was asked — which is how the
 * document test proves a pasted article actually reached the model.
 */
import http from "node:http";

export const RECEIVED = [];

export function startStubModel(port = 0) {
  const server = http.createServer((req, res) => {
    // A page for the link-reading test to fetch. Same server, different
    // route: the suite never touches the internet.
    if (req.url.startsWith("/article")) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<html><head><title>The kettle question</title></head>
        <body><nav>Home</nav>
        <article><h1>The kettle question</h1>
        <p>${"A paragraph about kettles and the people who own them. ".repeat(12)}</p>
        <p>${"A second paragraph, on descaling and its discontents. ".repeat(12)}</p>
        </article><footer>(c) 2026</footer></body></html>`);
    }

    if (req.url.startsWith("/v1/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      RECEIVED.push(request);

      const last = request.messages?.[request.messages.length - 1];
      const asked =
        typeof last?.content === "string"
          ? last.content
          : JSON.stringify(last?.content ?? "");
      // The reply names what it saw, so a test can assert on it.
      const reply = asked.includes("kettle")
        ? "The piece is about kettles."
        : asked.includes("<document")
          ? "I read the document."
          : "Short answer.";

      res.writeHead(200, { "content-type": "text/event-stream" });
      const words = reply.split(" ");
      let at = 0;
      const timer = setInterval(() => {
        if (at >= words.length) {
          clearInterval(timer);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        const delta = { choices: [{ delta: { content: words[at++] + " " } }] };
        res.write(`data: ${JSON.stringify(delta)}\n\n`);
      }, 5);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
