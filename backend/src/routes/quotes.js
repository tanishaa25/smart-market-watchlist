import { Router } from "express";
import { getQuotes } from "../services/priceService.js";

export const quotesRouter = Router();

// GET /api/quotes?symbols=RELIANCE,TCS,INFY — batch live quote lookup
quotesRouter.get("/", async (req, res) => {
  const symbolsParam = req.query.symbols;
  if (!symbolsParam) {
    return res.status(400).json({ error: "Provide ?symbols=RELIANCE,TCS,..." });
  }
  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return res.status(400).json({ error: "No valid symbols provided." });
  }

  try {
    const quotes = await getQuotes(symbols);
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch quotes.", detail: err.message });
  }
});
