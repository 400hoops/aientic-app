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

## Deploying with Podman

A turnkey server deployment: the public image, TLS terminated in the
container, data on the host.

### Step 1: Create Host Directories

Set up the required directories on your host machine for application data
and TLS certificates:

```bash
mkdir -p ~/data/aientic
mkdir -p ~/certs/aientic
```

### Step 2: Configure Secrets and Certificates

Generate a random secret key for the application:

```bash
openssl rand -base64 32 > ~/data/aientic/secret.key
```

Place your TLS certificates inside the certs directory:

- `~/certs/aientic/aientic-cert.pem`
- `~/certs/aientic/aientic-key.pem`

### Step 3: Create docker-compose.yml

Create a `docker-compose.yml` file in your working directory with the
following configuration:

```yaml
services:
  aientic:
    image: ghcr.io/400hoops/aientic-app:latest
    ports:
      - "8080:8080"
    volumes:
      - ~/data/aientic:/data:Z,U
      - ~/certs/aientic:/certs:ro,Z,U
    environment:
      - AIENTIC_SECRET=${AIENTIC_SECRET}
      - AIENTIC_TLS_CERT=/certs/aientic-cert.pem
      - AIENTIC_TLS_KEY=/certs/aientic-key.pem
    restart: always
```
**Note on Podman Flags:**

- `:Z` handles SELinux context labeling for shared volumes.
- `:U` automatically adjusts UID/GID mapping for rootless Podman to prevent
  container permission (EACCES) errors.

### Step 4: Configure the Host Firewall

If you are running firewalld (common on Fedora/RHEL/CentOS), open port 8080
to allow external and local network traffic:

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

(If using UFW on Ubuntu/Debian, use `sudo ufw allow 8080/tcp` instead).

### Step 5: Start the Container

Launch the application container in the background:

```bash
podman compose up -d --force-recreate aientic
```

### Accessing the Application

Open your browser and navigate to:

```
https://<your-server-ip>:8080
```

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `AIENTIC_DATA_DIR` | `server/data` | Where `data.json` lives |
| `AIENTIC_PORT` | `3001` | API port (wins over `PORT`) |
| `AIENTIC_API_ORIGIN` | `http://127.0.0.1:3001` | Dev proxy target for Vite |
| `AIENTIC_SECRET` | a generated key, kept in `secret.key` | Encrypts upstream API keys at rest |
| `AIENTIC_TLS_CERT`, `AIENTIC_TLS_KEY` | unset (plain HTTP) | PEM cert/key paths — set both to serve HTTPS directly |
| `AIENTIC_TRUST_PROXY` | unset (no proxies trusted) | Set behind a reverse proxy so `X-Forwarded-*` is honoured: `1` for one proxy hop, or `loopback` / a CIDR / a list. Off by default on purpose: without it, a direct client's `X-Forwarded-For` would let anyone spoof `req.ip` and walk past the login rate limit |

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
key; left unset, the key comes from `secret.key` next to `data.json`
(generated on first run if missing), so encryption is on with zero
configuration. The file may hold any content — a random string, base64,
whatever — and is hashed to the actual key unless it is exactly 16, 24 or
32 bytes, in which case those bytes are the key. Either way the keys are
never sent to the browser — the model picker only ever sees a label and a
note.

## Security posture

This is built for a trusted network: a LAN, or a tailnet. `/api/auth/login`
is rate-limited (10 attempts per IP per 5 minutes) and sampler values are
bounds-checked, both on by default. HTTPS is opt-in — set `AIENTIC_TLS_CERT`
and `AIENTIC_TLS_KEY` to PEM files and the server terminates TLS itself. The
session cookie deliberately carries no `Secure` flag: deployments are
commonly reached by bare IP over plain HTTP, or over HTTPS with a
self-signed / LAN-CA cert, and browsers (Chrome in particular) will not
store or send `Secure` cookies on such origins — the flag would simply lock
you out of login. `httpOnly`, `SameSite=lax` and the random 30-day token
do the work. To terminate TLS at a reverse proxy in front instead, set
`AIENTIC_TRUST_PROXY` (see the table above) so per-IP rate limiting sees
through it; direct clients' `X-Forwarded-*` headers are otherwise ignored
on purpose.

The served frontend ships with security headers: a strict-ish
`Content-Security-Policy` (`script-src 'self'`, no inline scripts, with only
`fonts.googleapis.com` / `fonts.gstatic.com` added for the Google Fonts
stylesheet), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and
`frame-ancestors 'self'`. Conversation text renders through react-markdown
with a component allow-list — no raw HTML — and the links it can emit carry
`rel="noreferrer"`.

The app fetches admin-configured model servers, which is a server-side
request forgery surface by construction: an admin can point it anywhere on
the reachable network. Two things narrow that: upstream response bodies are
capped at 2 MB before they are parsed, and the cloud instance-metadata
address (`169.254.169.254` — AWS/GCP/Azure) is rejected outright, since no
model server runs there and it is the classic SSRF payday. Pointing it at
other internal services is a deliberate trade of the trusted-admin model.

CSRF protection is still intentionally skipped: cookies are `sameSite=lax`
and nothing here performs a state-changing `GET`, so the usual CSRF vector
doesn't apply. Passwords are bcrypt hashes (cost 12) and sessions are random
tokens in `httpOnly` cookies, so a shared box is fine. A login for an unknown
username costs the same bcrypt work as one for a known one, so timing doesn't
reveal which usernames exist. Docker images run as the unprivileged `node`
user.

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
