// Strict symbol-format validation — catches obviously malformed input
// (empty, too long, containing script/injection-style characters) before
// it's ever used to construct a Firestore document ID or path. NSE
// tickers are uppercase letters, sometimes with a dot-suffix for a
// specific share class (e.g. a Berkshire-style "BRK.B" equivalent) —
// this accepts that shape without being so strict it rejects real symbols.
const SYMBOL_PATTERN = /^[A-Z]{1,20}(\.[A-Z]{1,4})?$/;

export function isValidSymbolFormat(symbol) {
  return typeof symbol === "string" && SYMBOL_PATTERN.test(symbol);
}
