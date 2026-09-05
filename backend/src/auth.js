// Auth utilities.
//
// Password hashing uses Node's built-in crypto.scrypt — no bcrypt
// dependency needed. Sessions use JWT (jsonwebtoken) so the server stays
// stateless; the token itself carries the user id.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const TOKEN_TTL = "7d";

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Fallback so the app still runs without extra setup, but this means
  // sessions won't survive a server restart. Fine for local dev/demo;
  // set JWT_SECRET in .env for anything more permanent.
  if (!getJwtSecret._fallback) {
    getJwtSecret._fallback = crypto.randomBytes(32).toString("hex");
    console.warn("No JWT_SECRET set — using a random one for this run. Sessions won't survive a restart. See .env.example.");
  }
  return getJwtSecret._fallback;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const attempt = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(attempt, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signToken(userId) {
  return jwt.sign({ userId }, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret()); // throws if invalid/expired
}

// Standard middleware: expects `Authorization: Bearer <token>`, falling
// back to an httpOnly cookie if no header is present. Additive, not a
// replacement — existing bearer-token clients keep working unchanged;
// this just also accepts a cookie-based session if one exists.
export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  let token = null;

  if (header && header.startsWith("Bearer ")) {
    token = header.slice(7);
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }

  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}

// EventSource (used for the real-time stream) can't set custom headers,
// so that one route accepts the token as a query param instead.
export function authenticateFromQuery(req, res, next) {
  const token = req.query.token;
  if (!token) {
    return res.status(401).json({ error: "Missing token query parameter." });
  }
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}
