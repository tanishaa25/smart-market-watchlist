import { describe, it, expect } from "vitest";
import { isValidSymbolFormat } from "../utils/symbolValidation.js";

describe("isValidSymbolFormat", () => {
  it("accepts real plain NSE tickers", () => {
    expect(isValidSymbolFormat("RELIANCE")).toBe(true);
    expect(isValidSymbolFormat("TCS")).toBe(true);
    expect(isValidSymbolFormat("HDFCBANK")).toBe(true);
  });

  it("accepts a dot-suffixed share class", () => {
    expect(isValidSymbolFormat("BRK.B")).toBe(true);
  });

  it("rejects lowercase (must already be normalized to uppercase before this check)", () => {
    expect(isValidSymbolFormat("reliance")).toBe(false);
  });

  it("rejects empty or absurdly long input", () => {
    expect(isValidSymbolFormat("")).toBe(false);
    expect(isValidSymbolFormat("A".repeat(50))).toBe(false);
  });

  it("rejects injection-style and path-traversal attempts", () => {
    expect(isValidSymbolFormat("../../etc/passwd")).toBe(false);
    expect(isValidSymbolFormat("<script>alert(1)</script>")).toBe(false);
    expect(isValidSymbolFormat("RELIANCE; DROP TABLE users")).toBe(false);
    expect(isValidSymbolFormat("RELIANCE/../TCS")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isValidSymbolFormat(null)).toBe(false);
    expect(isValidSymbolFormat(undefined)).toBe(false);
    expect(isValidSymbolFormat(12345)).toBe(false);
  });
});
