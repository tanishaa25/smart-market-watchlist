import { Router } from "express";
import { STOCK_UNIVERSE } from "../data/stockUniverse.js";

export const stocksRouter = Router();

// GET /api/stocks?query=app — browse/search the known stock universe.
// No query returns the full list (used by the "Browse all stocks" page).
stocksRouter.get("/", (req, res) => {
  const query = (req.query.query || "").trim().toLowerCase();

  if (!query) {
    return res.json({ stocks: STOCK_UNIVERSE });
  }

  const matches = STOCK_UNIVERSE.filter(
    (s) => s.symbol.toLowerCase().includes(query) || s.name.toLowerCase().includes(query)
  );
  res.json({ stocks: matches });
});
