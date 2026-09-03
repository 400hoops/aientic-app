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
      // "LONG" buys the test a couple of seconds of streaming to act
      // during — queueing a message, pressing Stop — without any sleeps.
      // Retrieval test: echo a passage back, so "the model was handed this"
      // is something a test can see rather than infer.
      const passage = request.messages?.find(
        (m) => m.role === "system" && String(m.content).includes("<passage")
      );
      const long = /LONG/.test(asked);
      // A real answer, at a real length and a real pace. "LONG" is a couple
      // of seconds of one repeated sentence, which turned out to be far too
      // small and far too plain to show how the view behaves: no headings,
      // no code, no paragraph breaks, and over before the layout has to cope
      // with anything. Several hundred words of actual markdown, streaming
      // for fifteen-odd seconds, is what a person is looking at when they
      // say the scrolling is wrong.
      const huge = /HUGE/.test(asked);
      // An answer with nothing to wrap on: one very long token, and a URL
      // with no spaces in it. Both are ordinary in real answers (a hash, a
      // stack frame, a link) and both are what finds a missing break rule.
      const unbreakable = /UNBREAKABLE/.test(asked);
      const wall =
        "Here is the identifier:\n\n" +
        "abcdefghij".repeat(20) +
        "\n\nAnd a link: https://example.com/" +
        "a-very-long-path-segment/".repeat(10) +
        "end";
      const essay = [
        "## What's going on here",
        "",
        ...Array.from({ length: 5 }, (_, i) =>
          `This is paragraph ${i + 1} of an answer long enough to run past the ` +
          "bottom of the window several times over, which is the only condition " +
          "under which any of the scrolling behaviour actually matters. It keeps " +
          "going for a few lines so that the transcript grows by a meaningful " +
          "amount between one token and the next.\n"
        ),
        "### A code block, because answers have those",
        "",
        "```js",
        ...Array.from({ length: 12 }, (_, i) => `const line${i} = ${i} * 2;`),
        "```",
        "",
        "### And a list",
        "",
        ...Array.from({ length: 8 }, (_, i) => `- Item number ${i + 1} in the list.`),
        "",
        ...Array.from({ length: 4 }, (_, i) =>
          `A closing paragraph, number ${i + 1}, to carry the answer past the ` +
          "point where the spacer under the last question has been used up.\n"
        ),
      ].join("\n");
      // A whole HTML page, for the artifact tests: a fenced block that is a
      // finished thing rather than an example being discussed.
      const artifact = /ARTIFACT/.test(asked);
      const page =
        "Here you go.\n\n```html\n<!doctype html>\n<html>\n<head><title>Kettle timer</title></head>\n<body>\n" +
        "<h1>Kettle timer</h1>\n".repeat(1) +
        "<p>A page.</p>\n".repeat(14) +
        "</body>\n</html>\n```\n\nThat should do it.";
      const reply = unbreakable
        ? wall
        : huge
        ? essay
        : artifact
        ? page
        : passage
        ? "From your documents: " +
          (String(passage.content).match(/citric acid[^.]*\./i)?.[0] ||
            "a passage was supplied.")
        : long
        ? "A longer answer, arriving a word at a time. ".repeat(6)
        : asked.includes("kettle")
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
      }, huge ? 40 : long ? 45 : 5);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
