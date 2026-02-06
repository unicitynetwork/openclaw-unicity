import { describe, it, expect } from "vitest";
import {
  resolveCoinId,
  getCoinSymbol,
  getCoinDecimals,
  getAvailableSymbols,
  toSmallestUnit,
  toHumanReadable,
  formatAmount,
  parseAmount,
} from "../src/assets.js";

describe("assets registry", () => {
  describe("resolveCoinId", () => {
    it("resolves by symbol (case insensitive)", () => {
      expect(resolveCoinId("UCT")).toBe("unicity");
      expect(resolveCoinId("uct")).toBe("unicity");
      expect(resolveCoinId("BTC")).toBe("bitcoin");
      expect(resolveCoinId("btc")).toBe("bitcoin");
    });

    it("resolves by name", () => {
      expect(resolveCoinId("unicity")).toBe("unicity");
      expect(resolveCoinId("bitcoin")).toBe("bitcoin");
      expect(resolveCoinId("solana")).toBe("solana");
      expect(resolveCoinId("ethereum")).toBe("ethereum");
    });

    it("returns null for unknown coin", () => {
      expect(resolveCoinId("FAKE")).toBeNull();
      expect(resolveCoinId("xyz")).toBeNull();
    });

    it("trims whitespace", () => {
      expect(resolveCoinId("  UCT  ")).toBe("unicity");
    });
  });

  describe("getCoinSymbol", () => {
    it("returns symbol for known coins", () => {
      expect(getCoinSymbol("unicity")).toBe("UCT");
      expect(getCoinSymbol("bitcoin")).toBe("BTC");
      expect(getCoinSymbol("unicity-usd")).toBe("USDU");
      expect(getCoinSymbol("unicity-eur")).toBe("EURU");
    });

    it("returns uppercase name for unknown coins", () => {
      expect(getCoinSymbol("unknown")).toBe("UNKNOWN");
    });
  });

  describe("getCoinDecimals", () => {
    it("returns decimals for known coins", () => {
      expect(getCoinDecimals("unicity")).toBe(18);
      expect(getCoinDecimals("bitcoin")).toBe(8);
      expect(getCoinDecimals("unicity-usd")).toBe(6);
      expect(getCoinDecimals("solana")).toBe(9);
    });

    it("returns undefined for unknown coins", () => {
      expect(getCoinDecimals("unknown")).toBeUndefined();
    });
  });

  describe("getAvailableSymbols", () => {
    it("returns all fungible coin symbols", () => {
      const symbols = getAvailableSymbols();
      expect(symbols).toContain("UCT");
      expect(symbols).toContain("BTC");
      expect(symbols).toContain("ETH");
      expect(symbols).toContain("SOL");
      expect(symbols).toContain("USDU");
      expect(symbols).toContain("EURU");
      expect(symbols).toContain("USDT");
      expect(symbols).toContain("USDC");
      expect(symbols).toContain("ALPHT");
    });

    it("does not include non-fungible assets", () => {
      const symbols = getAvailableSymbols();
      // The non-fungible "unicity" entry has no symbol, so it shouldn't appear
      expect(symbols.filter((s) => s === "unicity")).toHaveLength(0);
    });
  });

  describe("toSmallestUnit", () => {
    it("converts whole numbers", () => {
      expect(toSmallestUnit("100", 18)).toBe("100000000000000000000");
      expect(toSmallestUnit("1", 8)).toBe("100000000");
      expect(toSmallestUnit("1", 6)).toBe("1000000");
    });

    it("converts decimal numbers", () => {
      expect(toSmallestUnit("1.5", 18)).toBe("1500000000000000000");
      expect(toSmallestUnit("0.5", 8)).toBe("50000000");
      expect(toSmallestUnit("100.25", 6)).toBe("100250000");
    });

    it("handles numbers with many decimal places", () => {
      expect(toSmallestUnit("1.123456789", 8)).toBe("112345678"); // truncates
    });

    it("handles zero", () => {
      expect(toSmallestUnit("0", 18)).toBe("0");
      expect(toSmallestUnit(0, 18)).toBe("0");
    });

    it("handles number input", () => {
      expect(toSmallestUnit(100, 6)).toBe("100000000");
      expect(toSmallestUnit(1.5, 8)).toBe("150000000");
    });
  });

  describe("toHumanReadable", () => {
    it("converts smallest units to human readable", () => {
      expect(toHumanReadable("100000000000000000000", 18)).toBe("100");
      expect(toHumanReadable("100000000", 8)).toBe("1");
      expect(toHumanReadable("1000000", 6)).toBe("1");
    });

    it("handles fractional amounts", () => {
      expect(toHumanReadable("1500000000000000000", 18)).toBe("1.5");
      expect(toHumanReadable("50000000", 8)).toBe("0.5");
      expect(toHumanReadable("100250000", 6)).toBe("100.25");
    });

    it("handles zero", () => {
      expect(toHumanReadable("0", 18)).toBe("0");
    });

    it("removes trailing zeros from fractions", () => {
      expect(toHumanReadable("1000000000000000000", 18)).toBe("1");
      expect(toHumanReadable("1100000000000000000", 18)).toBe("1.1");
    });
  });

  describe("formatAmount", () => {
    it("formats amount with symbol", () => {
      expect(formatAmount("100000000000000000000", "unicity")).toBe("100 UCT");
      expect(formatAmount("100000000", "bitcoin")).toBe("1 BTC");
    });
  });

  describe("parseAmount", () => {
    it("converts human readable to smallest units for a coin", () => {
      expect(parseAmount(100, "unicity")).toBe("100000000000000000000");
      expect(parseAmount(1, "bitcoin")).toBe("100000000");
      expect(parseAmount("1.5", "unicity-usd")).toBe("1500000");
    });
  });
});
