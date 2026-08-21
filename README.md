# Aientic

A chat front end for llama-server — or any OpenAI-compatible server — with
accounts, server-side history, and admin-owned model and sampler settings.

It began as a single-file React shell that kept everything in `localStorage`.
That worked until the second device: history was scoped to one browser, and
model settings were whatever each person happened to have set. Aientic moves
all of that behind a small Express API, so a conversation started on a laptop
is there on a phone, and a sampler change applies to everyone at once.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. The first screen creates the admin account —
there is no self-service signup, and no default password to forget to change.

Then, as that admin:

1. **Admin → Endpoints.** Put in your server's base URL (`http://192.168.1.50:8080`)
   and press **Add all models from this server**. Every preset the server
   reports becomes a model in the picker. Re-run it later to pick up new ones;
   it never duplicates what's already listed.
2. **Sampler.** Per model: temperature, top_p, top_k, min_p, repeat_penalty and
   a system prompt. These are enforced server-side for every user of that model.
3. **Admin → Users.** Add accounts. Admins can manage endpoints, sampler
   settings and other accounts; users just chat.

`npm run dev` runs Vite on 5173 and the API on 3001, with `/api` proxied. Both
listen on all interfaces, so other devices on your network can reach the dev
server directly.

## Production

```bash
npm run build   # emits dist/
npm start       # Express serves the API and dist/ on one port
```

Or with Docker:

```bash
docker compose up -d --build
```

Compose mounts a named volume at `/data` and serves on port 8080. Set
`AIENTIC_SECRET` to something of your own before exposing it anywhere — see
"How it stores things" below for what it's actually used for.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `AIENTIC_DATA_DIR` | `server/data` | Where `data.json` lives |
| `AIENTIC_PORT` | `3001` | API port (wins over `PORT`) |
| `AIENTIC_API_ORIGIN` | `http://127.0.0.1:3001` | Dev proxy target for Vite |
| `AIENTIC_SECRET` | a generated key, kept in `secret.key` | Encrypts upstream API keys at rest |
| `AIENTIC_TLS_CERT`, `AIENTIC_TLS_KEY` | unset (plain HTTP) | PEM cert/key paths — set both to serve HTTPS directly |

## How it stores things

One JSON file, `data.json`, held in memory and written back atomically —
users, sessions, endpoints, upstream keys, sampler settings, conversations. A
`.bak` copy is kept alongside it. For a handful of accounts on a LAN this is
plenty, and being able to `cat` the database is worth more than the write
throughput a real database would buy. If it ever outgrows that, `storage.js` is
the only file that has to change.

Upstream API keys are the one field in there that's a real credential rather
than app state, so they're the one thing encrypted at rest (AES-256-GCM) —
everything else stays plain JSON. `AIENTIC_SECRET` supplies the encryption
key; left unset, one is generated on first run and kept in `secret.key`
next to `data.json`, so encryption is on with zero configuration. Either way
they're never sent to the browser — the model picker only ever sees a label
and a note.

## Security posture

This is built for a trusted network: a LAN, or a tailnet. `/api/auth/login`
is rate-limited (10 attempts per IP per 5 minutes) and sampler values are
bounds-checked, both on by default. HTTPS is opt-in — set `AIENTIC_TLS_CERT`
and `AIENTIC_TLS_KEY` to PEM files and the server terminates TLS itself; the
session cookie's `Secure` flag follows automatically (it also picks this up
correctly if you terminate TLS at a reverse proxy in front instead, via
`X-Forwarded-Proto`). CSRF protection is still intentionally skipped: cookies
are `sameSite=lax` and nothing here performs a state-changing `GET`, so the
usual CSRF vector doesn't apply. Passwords are bcrypt hashes and sessions are
random tokens in `httpOnly` cookies, so a shared box is fine.

For a quick self-signed cert to test HTTPS locally:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
AIENTIC_TLS_CERT=cert.pem AIENTIC_TLS_KEY=key.pem npm start
```

Browsers will still warn on a self-signed cert — for anything past local
testing, use a real one (Let's Encrypt, or your tailnet's own).

### A trusted cert without a public domain

If the deployment is LAN-only — no public DNS pointing at it — a self-signed
cert means a warning on every device, forever. [mkcert](https://github.com/FiloSottile/mkcert)
is the better fit for that case: it makes you a local CA once, and every cert
it signs after that is trusted by any device that's imported the CA's public
half. One trust step per device, not per cert.

```bash
mkcert -install                    # trusts the local CA on THIS machine
mkcert -cert-file cert.pem -key-file key.pem 192.168.1.50   # or a hostname
```

`-install` only affects the machine you run it on. For every other device
that'll browse to this deployment, copy `$(mkcert -CAROOT)/rootCA.pem` to
it and trust it there instead — no need to re-run `mkcert` itself, and
`-install` is exactly the step to skip on those, since it modifies that
device's own trust store and only needs doing once per device, not once per
cert.

In compose, mount the cert directory in and point the two TLS variables at
it:

```yaml
services:
  aientic:
    image: ghcr.io/400hoops/aientic-app:latest
    volumes:
      - ~/data/aientic:/data:Z
      - ~/certs/aientic:/certs:ro,Z
    environment:
      - AIENTIC_SECRET=${AIENTIC_SECRET}
      - AIENTIC_TLS_CERT=/certs/cert.pem
      - AIENTIC_TLS_KEY=/certs/key.pem
    restart: always
```

The paths after `AIENTIC_TLS_CERT`/`AIENTIC_TLS_KEY` are as the *container*
sees them, not the host — with the volume line above, a host file at
`~/certs/aientic/cert.pem` is what `/certs/cert.pem` refers to inside the
container. Keep `rootCA-key.pem` (the CA's private half) off of any directory
that gets mounted into a running container; nothing here ever needs to read
it, only `-cert-file`/`-key-file` do at generation time.

## Fonts

The UI is **Google Sans** and the wordmark is **Playfair Display**, both from
Google Fonts. Swapping either is a one-line
change to `--font-sans` / `--font-serif` in `src/index.css` plus the link tag
in `index.html`. Both fonts need outbound access to fonts.googleapis.com on
first load; on an air-gapped box, self-host the woff2 files in `public/` and
add `@font-face` blocks instead.

## Layout

```
index.html  vite.config.js  package.json  Dockerfile  docker-compose.yml
public/     favicon
src/        React app
  Admin/    AdminShell.jsx, AdminPage.jsx
  AienticChatShell.jsx  the conversation view
  Sidebar.jsx  LoginPage.jsx  SamplerPage.jsx
  Markdown.jsx  MessageActions.jsx  ModelPicker.jsx  Select.jsx
  api.js  theme.js  cookies.js  format.js  Icons.jsx  Wordmark.jsx
server/     Express API
  index.js       routes
  auth.js        accounts, sessions, bcrypt
  storage.js     the JSON store
  upstream.js    talking to OpenAI-compatible servers
  generation.js  SSE streaming, reasoning extraction
  data/          data.json (gitignored)
```
