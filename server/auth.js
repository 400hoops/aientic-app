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

// secure is decided per-request, not hardcoded: this app's default is plain
// HTTP on a LAN, where a cookie marked secure would just never be sent at
// all. req.secure is true precisely when the connection actually is
// encrypted — Node's own TLS when AIENTIC_TLS_CERT/KEY are set, or a
// reverse proxy's TLS termination via trust proxy (see index.js) — so this
// upgrades itself automatically the moment either is in place.
const cookieOptions = (req) => ({
  httpOnly: true,
  secure: req.secure,
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
  res.clearCookie(COOKIE, { path: "/" });
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
  !!user && bcrypt.compareSync(String(plain), user.passwordHash);

/** True until the first account exists — drives the setup screen. */
export const needsBootstrap = () => db.users.length === 0;
