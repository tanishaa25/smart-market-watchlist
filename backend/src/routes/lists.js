import { Router } from "express";
import { authenticate } from "../auth.js";
import { getListsForUser, createList, renameList, deleteList, reorderList } from "../db.js";

export const listsRouter = Router();
listsRouter.use(authenticate);

listsRouter.get("/", async (req, res) => {
  try {
    const lists = await getListsForUser(req.userId);
    res.json({ lists });
  } catch (err) {
    console.error("Failed to load lists:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

listsRouter.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "List name is required" });
    const list = await createList(req.userId, name);
    res.status(201).json({ list });
  } catch (err) {
    console.error("Failed to create list:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

listsRouter.patch("/:listId", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "List name is required" });
    await renameList(req.userId, req.params.listId, name);
    res.status(204).end();
  } catch (err) {
    console.error("Failed to rename list:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

listsRouter.delete("/:listId", async (req, res) => {
  try {
    await deleteList(req.userId, req.params.listId);
    res.status(204).end();
  } catch (err) {
    if (err.code === "LAST_LIST") {
      return res.status(400).json({ error: err.message });
    }
    console.error("Failed to delete list:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});

listsRouter.post("/:listId/reorder", async (req, res) => {
  try {
    const { direction } = req.body; // "up" | "down"
    const lists = await reorderList(req.userId, req.params.listId, direction);
    res.json({ lists });
  } catch (err) {
    console.error("Failed to reorder list:", err.message);
    res.status(503).json({ error: "Couldn't reach the database. Please try again shortly." });
  }
});
