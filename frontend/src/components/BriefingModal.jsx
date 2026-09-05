import { useState } from "react";
import QuietCard from "./QuietCard.jsx";
import {
  rankByBriefingPriority,
  splitQuiet,
  findNextCatalyst,
  groupEchoes,
  capCatalystCards,
  getMaxDaysAway,
  LONG_ABSENCE_DAYS,
} from "../utils/briefing.js";

const ATTENTION_BUDGET = 5;

const BUCKET_LABEL = {
  attention: "Needs Attention",
  notable: "Notable",
};

export default function BriefingModal({ items, quotesBySymbol = {}, onDismiss, onOpenHistory }) {
  const [expanded, setExpanded] = useState(false);

  const maxDaysAway = getMaxDaysAway(items);
  const isLongAbsence = maxDaysAway > LONG_ABSENCE_DAYS;

  let flagged = rankByBriefingPriority(items);
  flagged = capCatalystCards(flagged, 2); // per-type cap: at most 2 catalyst-driven cards, closest earnings first

  const quietItems = splitQuiet(items);
  const nextCatalyst = findNextCatalyst(items);

  // Real market-data gaps disclosed honestly, not silently interpolated
  // — items currently falling back to simulated data because a real
  // source wasn't available right now.
  const dataGapSymbols = flagged.filter((i) => quotesBySymbol[i.symbol]?.source === "simulated").map((i) => i.symbol);

  // Echo grouping: collapse correlated sector moves into one card BEFORE
  // applying the attention budget, so a market-wide sector move counts
  // as one slot, not N near-duplicate cards.
  const { echoGroups, remainingIndividual } = groupEchoes(flagged);
  const budgetSlots = [
    ...echoGroups.map((g) => ({ type: "echo", data: g, priority: g.maxScore })),
    ...remainingIndividual.map((item) => ({ type: "individual", data: item, priority: item.significance.score })),
  ].sort((a, b) => b.priority - a.priority);

  const visibleSlots = expanded ? budgetSlots : budgetSlots.slice(0, ATTENTION_BUDGET);
  const hiddenCount = budgetSlots.length - visibleSlots.length;

  return (
    <div className="briefing-overlay" role="dialog" aria-modal="true">
      <div className="briefing-panel">
        <div className="briefing-header">
          <h2>Since You Were Away</h2>
          <p className="briefing-subtitle">
            {isLongAbsence
              ? `${Math.round(maxDaysAway)} days away · `
              : ""}
            {budgetSlots.length > 0
              ? `${budgetSlots.length} thing${budgetSlots.length === 1 ? "" : "s"} worth a look`
              : "Nothing needs your attention"}
          </p>
        </div>

        <div className="briefing-body">
          {dataGapSymbols.length > 0 && (
            <p className="data-gap-banner">
              ⚠ Data gap: real market prices weren't available for {dataGapSymbols.join(", ")} right now — showing
              simulated prices instead. Treat those readings as approximate.
            </p>
          )}

          {budgetSlots.length === 0 ? (
            <QuietCard quietCount={quietItems.length} totalCount={items.length} nextCatalyst={nextCatalyst} />
          ) : (
            <>
              {visibleSlots.map((slot) =>
                slot.type === "echo" ? (
                  <div key={`echo-${slot.data.sector}`} className="briefing-card briefing-echo">
                    <div className="briefing-card-top">
                      <span className="briefing-symbol">{slot.data.sector} sector</span>
                      <span className="briefing-score">{Math.round(slot.data.maxScore * 100)}</span>
                    </div>
                    <p className="briefing-explanation">
                      Your {slot.data.members.length} {slot.data.sector} stocks moved together (
                      {slot.data.avgChangePercent >= 0 ? "+" : ""}
                      {slot.data.avgChangePercent.toFixed(1)}% avg): {slot.data.members.join(", ")}
                    </p>
                  </div>
                ) : (
                  <div key={slot.data.symbol} className={`briefing-card briefing-${slot.data.significance.bucket}`}>
                    <div className="briefing-card-top">
                      <span className="briefing-symbol">{slot.data.symbol}</span>
                      <span className="briefing-bucket-label">{BUCKET_LABEL[slot.data.significance.bucket]}</span>
                      <span className="briefing-score">{Math.round(slot.data.significance.score * 100)}</span>
                    </div>
                    {slot.data.explanation && <p className="briefing-explanation">{slot.data.explanation}</p>}
                  </div>
                )
              )}

              {hiddenCount > 0 && !isLongAbsence && (
                <button type="button" className="briefing-more-btn" onClick={() => setExpanded(true)}>
                  {hiddenCount} more, quietly noted
                </button>
              )}

              {hiddenCount > 0 && isLongAbsence && (
                <p className="briefing-quiet-footer">
                  You were away {Math.round(maxDaysAway)} days. Showing the top {ATTENTION_BUDGET};{" "}
                  <button type="button" className="briefing-history-link" onClick={onOpenHistory}>
                    see History
                  </button>{" "}
                  for the rest.
                </p>
              )}

              {quietItems.length > 0 && (
                <p className="briefing-quiet-footer">
                  {quietItems.length} other{quietItems.length === 1 ? "" : "s"} moved within normal range
                  {nextCatalyst && ` · Next catalyst: ${nextCatalyst.symbol} earnings in ${nextCatalyst.days} days`}
                </p>
              )}
            </>
          )}
        </div>

        <button type="button" className="briefing-dismiss-btn" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
