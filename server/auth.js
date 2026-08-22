/**
 * Accounts and sessions.
 *
 * Passwords are bcrypt hashes. A session is a random token in an httpOnly
 * cookie, mapped server-side to a user id. No JWTs, nothing to expire on the
 * client, and revoking a session is a delete.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db, save, uid } from "./storage.js";

export const COOKIE = "aientic_session";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

// The `Secure` attribute is a setting, not a constant, because the real
// deployment shapes need different answers:
//
//   off  — no flag. Works everywhere, including plain HTTP and HTTPS with
//          a cert the browser doesn't trust. The default, so a fresh
//          deployment works no matter how it's reached.
//   auto — set exactly when the connection is TLS (req.secure, which
//          honours AIENTIC_TRUST_PROXY). Correct once every client device
//          actually trusts the cert (public CA, or a root CA installed on
//          each device).
//   on   — always set. Use when the app is guaranteed to only ever be
//          reached over HTTPS.
//
// Why it can't just be always-on: browsers (Chrome in particular) will not
// store or send a Secure cookie on an origin whose certificate failed
// validation — self-signed, or missing a SAN for the IP it's served from —
// which silently makes login impossible. The flag is only a win where the
// chain actually validates.
const SECURE_COOKIES = (
  process.env.AIENTIC_SECURE_COOKIES || "off"
).toLowerCase();
if (!["off", "auto", "on"].includes(SECURE_COOKIES)) {
  console.error(
    `[aientic] AIENTIC_SECURE_COOKIES must be "off", "auto" or "on" (got "${process.env.AIENTIC_SECURE_COOKIES}")`
  );
  process.exit(1);
}
const secureFor = (req) =>
  SECURE_COOKIES === "on" || (SECURE_COOKIES === "auto" && req.secure);
const cookieOptions = (req) => ({
  httpOnly: true,
  secure: secureFor(req),
  sameSite: "lax",
  maxAge: SESSION_TTL,
  path: "/",
});

export const hashPassword = (plain) => bcrypt.hashSync(plain, 12);

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}

export const findUser = (username) =>
  db.users.find(
    (u) => u.username.toLowerCase() === String(username || "").toLowerCase()
  );

export function createUser({ username, password, role = "user" }) {
  const user = {
    id: uid(),
    username: username.trim(),
    passwordHash: hashPassword(password),
    role: role === "admin" ? "admin" : "user",
    createdAt: Date.now(),
  };
  db.users.push(user);
  save();
  return user;
}

export function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = { userId: user.id, createdAt: Date.now() };
  save();
  res.cookie(COOKIE, token, cookieOptions(req));
  return token;
}

export function endSession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token && db.sessions[token]) {
    delete db.sessions[token];
    save();
  }
  // Mirror the secure flag so a cookie set with it can be cleared by the
  // browser on the same origin (matters in "on" mode).
  res.clearCookie(COOKIE, { path: "/", secure: secureFor(req) });
}

/** Drops expired sessions and resolves the current one. */
export function currentUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const session = db.sessions[token];
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    delete db.sessions[token];
    save();
    return null;
  }
  return db.users.find((u) => u.id === session.userId) || null;
}

export function attachUser(req, _res, next) {
  req.user = currentUser(req);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not signed in" });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not signed in" });
  if (req.user.role !== "admin")
    return res.status(403).json({ error: "Admins only" });
  next();
}

export const verifyPassword = (user, plain) =>
  // Compare against a throwaway hash when the user doesn't exist, so an
  // unknown username takes the same time as a known one — response latency
  // shouldn't reveal which usernames exist.
  bcrypt.compareSync(String(plain), user ? user.passwordHash : DUMMY_HASH);

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 12);

/** Drops sessions past their TTL so data.json doesn't hoard them forever
 *  (an expired token is only collected when that session is next used,
 *  which never happens on its own). */
export function pruneExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of Object.entries(db.sessions)) {
    if (now - session.createdAt > SESSION_TTL) {
      delete db.sessions[token];
      changed = true;
    }
  }
  if (changed) save();
}
pruneExpiredSessions();

/** True until the first account exists — drives the setup screen. */
export const needsBootstrap = () => db.users.length === 0;
