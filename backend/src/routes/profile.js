import { Router } from "express";
import { authenticate } from "../auth.js";
import { findUserById, updateSensitivity } from "../db.js";

export const profileRouter = Router();
profileRouter.use(authenticate);

profileRouter.get("/", async (req, res) => {
  try {
    const user = await findUserById(req.userId);
    res.json({ sensitivity: user?.sensitivity ?? "balanced" });
  } catch (err) {
    console.error("Failed to load profile:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

profileRouter.patch("/", async (req, res) => {
  const { sensitivity } = req.body || {};
  if (!["calm", "balanced", "active"].includes(sensitivity)) {
    return res.status(400).json({ error: "Sensitivity must be 'calm', 'balanced', or 'active'." });
  }
  try {
    await updateSensitivity(req.userId, sensitivity);
    res.status(204).end();
  } catch (err) {
    console.error("Failed to update sensitivity:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});
