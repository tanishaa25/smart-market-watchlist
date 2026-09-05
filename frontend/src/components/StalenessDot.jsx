import { useEffect, useState } from "react";
import { stalenessColor, stalenessLabel } from "../utils/staleness.js";

export default function StalenessDot({ asOf, marketOpen = true }) {
  // Forces a re-render periodically so the dot's color keeps decaying
  // over time even if no new quote arrives — otherwise it would only
  // update when a fresh price ticks in, defeating the point of showing
  // staleness in the first place.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const color = stalenessColor(asOf, Date.now(), marketOpen);
  return <span className={`staleness-dot staleness-${color}`} title={stalenessLabel(asOf, Date.now(), marketOpen)} />;
}
