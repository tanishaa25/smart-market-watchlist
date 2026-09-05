import { Router } from "express";
import { createUser, findUserByEmail, createAnonymousUser, upgradeAnonymousUser } from "../db.js";
import { hashPassword, verifyPassword, signToken, authenticate } from "../auth.js";
import { rateLimit } from "../utils/rateLimiter.js";

export const authRouter = Router();

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // matches the JWT's own 7-day expiry

// Sets the session as an httpOnly cookie IN ADDITION TO returning the
// token in the JSON body — additive, not a replacement. Existing
// clients using the Bearer-token flow keep working completely
// unchanged; this just also makes a cookie-based session available.
// `secure` is conditional on NODE_ENV since local HTTP dev would
// otherwise silently refuse to set/send the cookie.
function setSessionCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

authRouter.post("/register", rateLimit, async (req, res) => {
  const { email, password } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const cleanEmail = email.trim().toLowerCase();
  try {
    const { hash, salt } = hashPassword(password);
    const user = await createUser(cleanEmail, hash, salt);
    const token = signToken(user.id);
    setSessionCookie(res, token);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    if (err.code === "DUPLICATE") {
      return res.status(409).json({ error: err.message });
    }
    console.error("Registration failed:", err.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

authRouter.post("/login", rateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const cleanEmail = email.trim().toLowerCase();
  try {
    const user = await findUserByEmail(cleanEmail);
    if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      // Same message for "no such user" and "wrong password" — don't leak which one it was.
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = signToken(user.id);
    setSessionCookie(res, token);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Login failed:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /api/auth/anonymous — anonymous-first auth: creates a fully
// functional session with no email/password required at all. Called
// automatically by the frontend on first load when no existing session
// is found — never a login wall, real value before any signup.
authRouter.post("/anonymous", rateLimit, async (req, res) => {
  try {
    const user = await createAnonymousUser();
    const token = signToken(user.id);
    setSessionCookie(res, token);
    res.status(201).json({ token, user: { id: user.id, isAnonymous: true } });
  } catch (err) {
    console.error("Anonymous session creation failed:", err.message);
    res.status(500).json({ error: "Couldn't start a session. Please try again." });
  }
});

// POST /api/auth/upgrade — attaches email+password to the CURRENT
// (anonymous) session, in place, so the same watchlists/history/
// everything become accessible from another device by logging in with
// that email. Requires an existing valid session — this converts one,
// it doesn't create a new one.
authRouter.post("/upgrade", authenticate, rateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  try {
    const { hash, salt } = hashPassword(password);
    const user = await upgradeAnonymousUser(req.userId, email, hash, salt);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    if (err.code === "DUPLICATE") {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === "NOT_FOUND") {
      return res.status(401).json({ error: "Your session has expired. Please refresh and try again." });
    }
    console.error("Account upgrade failed:", err.message);
    res.status(500).json({ error: "Upgrade failed. Please try again." });
  }
});

// POST /api/auth/logout — clears the httpOnly cookie server-side. The
// existing Bearer-token flow logs out purely client-side (just drops
// the token from localStorage), which is why this endpoint wasn't
// needed before — but a cookie can't be cleared from JavaScript if it's
// httpOnly, so a real endpoint is required for that half of the flow.
authRouter.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.status(204).end();
});
