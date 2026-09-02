# shared

Code both halves of the app import. Right now that's the artifact detector,
which the server uses to list artifacts across every conversation and the
browser uses to render them — one definition, so a card and a list row can
never disagree about what counts as one.

Two things to remember when adding to this directory:

- **It is not inside `src/` or `server/`, so it has to be copied into the
  Docker image explicitly** — into *both* stages. The web stage failing is
  loud and immediate; the runtime stage failing waits until the server
  starts.
- **The `package.json` here says `"type": "module"` and is load-bearing.**
  Module type is resolved from the nearest `package.json` upward, and in the
  runtime image `/app` has no `package.json` at all — so without this one,
  Node falls back to sniffing the syntax and warns while it does it.
