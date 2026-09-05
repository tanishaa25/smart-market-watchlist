import { Router } from "express";
import { authenticate } from "../auth.js";
import { updateLastBriefingOpened } from "../db.js";

export const briefingRouter = Router();
briefingRouter.use(authenticate);

// POST /api/briefing/opened — explicit dismissal of the "Since You Were
// Away" briefing modal. The ranking/quiet-state content itself is
// derived client-side from the same significance data GET /api/watchlist
// already returns (no need to recompute it server-side too) — this
// endpoint's only job is recording that the user has now seen it,
// server-side, so it's a real cross-device anchor rather than
// per-browser-tab state that resets the moment they switch devices.
briefingRouter.post("/opened", async (req, res) => {
  try {
    await updateLastBriefingOpened(req.userId, new Date().toISOString());
    res.status(204).end();
  } catch (err) {
    console.error("Failed to record briefing dismissal:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});
