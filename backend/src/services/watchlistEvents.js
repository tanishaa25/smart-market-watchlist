// Tiny in-memory pub-sub so the SSE stream route can react instantly when
// a user adds/removes a watchlist symbol, without re-querying Firestore
// on every price tick just to check "is this still on their list?" —
// that would mean a Firestore read per update per connected client,
// which gets expensive fast for no real benefit over just tracking it
// in memory for the life of the connection.
//
// Also carries "reviewed" events: when a user acknowledges a
// significance flag on one device, this lets any OTHER open connection
// for the same user update immediately over the existing SSE stream,
// rather than only reflecting the change on that device's next reload.

import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export function emitWatchlistChange(userId, symbol, action, extra = {}) {
  emitter.emit("change", { userId, symbol, action, ...extra });
}

export function onWatchlistChange(listener) {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}
