/**
 * Coin metadata and amount conversion over the SDK token registry.
 * Every process-global registry call lives here, so the SDK's planned removal of the global registry is a one-file change.
 */

import {
  TokenRegistry,
  getCoinIdByName,
  getCoinIdBySymbol,
  getTokenDecimals,
  getTokenDefinition,
  getTokenName,
  getTokenSymbol,
  parseTokenAmount,
  toHumanReadable,
  type TokenDefinition,
} from "@unicitylabs/sphere-sdk";
import { quoteUntrusted } from "./text.js";

export type CoinInfo = { coinId: string; symbol: string; name: string; decimals: number; claimed: boolean };

/** Names people use for coins the registry lists under another symbol. */
const SYMBOL_ALIASES: Record<string, string> = { usdc: "USDC.e" };

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Waits for the registry's first load (Sphere.init starts it without awaiting).
 * Also true when a later refresh filled a registry whose first load failed.
 */
export async function ensureRegistryReady(timeoutMs = 10_000): Promise<boolean> {
  const loaded = await TokenRegistry.waitForReady(timeoutMs).catch(() => false);
  return loaded || TokenRegistry.getInstance().getFungibleTokens().length > 0;
}

function toCoinInfo(def: TokenDefinition | undefined): CoinInfo | null {
  if (!def || def.assetKind !== "fungible" || !def.symbol) return null;
  return {
    coinId: def.id.toLowerCase(),
    symbol: def.symbol,
    name: def.name,
    decimals: def.decimals ?? 0,
    claimed: def.issuance !== undefined,
  };
}

/** Fungible coin by symbol (case-insensitive), name, or known 64-hex coin id; "USDC" maps to "USDC.e". */
export function resolveCoin(input: string): CoinInfo | null {
  const value = input.trim();
  if (!value) return null;
  if (HEX64.test(value)) return toCoinInfo(getTokenDefinition(value.toLowerCase()));
  const alias = SYMBOL_ALIASES[value.toLowerCase()];
  const coinId = getCoinIdBySymbol(value) ?? (alias ? getCoinIdBySymbol(alias) : undefined) ?? getCoinIdByName(value);
  return coinId ? toCoinInfo(getTokenDefinition(coinId)) : null;
}

/** Display metadata for a coin id; unknown ids fall back to the registry's placeholders (hex prefix, 0 decimals). */
export function describeCoin(coinId: string): { symbol: string; decimals: number; name: string } {
  const info = toCoinInfo(getTokenDefinition(coinId));
  if (info) return { symbol: info.symbol, decimals: info.decimals, name: info.name };
  return { symbol: getTokenSymbol(coinId), decimals: getTokenDecimals(coinId), name: getTokenName(coinId) };
}

export function getAvailableSymbols(opts?: { excludeClaimed?: boolean }): string[] {
  return TokenRegistry.getInstance()
    .getFungibleTokens()
    .filter((def) => def.symbol && !(opts?.excludeClaimed && def.issuance))
    .map((def) => def.symbol as string);
}

/**
 * "1.5 UCT" from base units. decimals/symbol default from the registry; a coin the registry does not know
 * is shown in base units with its id rather than with guessed decimals.
 */
export function formatAmount(amount: string | bigint, coinId: string, decimals?: number, symbol?: string): string {
  const base = amount.toString();
  if (decimals !== undefined) return `${toHumanReadable(base, decimals)} ${symbol ?? describeCoin(coinId).symbol}`;
  const info = toCoinInfo(getTokenDefinition(coinId));
  if (!info) return `${base} base units of coin ${shownCoinId(coinId)}`;
  return `${toHumanReadable(base, info.decimals)} ${symbol ?? info.symbol}`;
}

/** An unknown coin id as text: a hex id shortened, anything else (sender-chosen) escaped and bounded. */
function shownCoinId(coinId: string): string {
  return /^[0-9a-f]+$/i.test(coinId) ? `${coinId.slice(0, 12)}…` : quoteUntrusted(coinId, 12) || '""';
}

/** Strict human -> base units (SDK parseTokenAmount); throws Error with a user-facing message on bad input. */
export function parseHumanAmount(amount: string, decimals: number): bigint {
  let value: bigint;
  try {
    value = parseTokenAmount(amount, decimals);
  } catch {
    const places = decimals === 0 ? "a whole number (this coin has no decimal places)" : `at most ${decimals} decimal places`;
    throw new Error(`Invalid amount "${amount}": use a plain decimal string such as "1.5", with ${places}.`);
  }
  if (value <= 0n) throw new Error("Amount must be greater than 0.");
  return value;
}
