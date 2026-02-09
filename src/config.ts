/** Unicity plugin configuration schema and helpers. */

import { NAMETAG_REGEX } from "./validation.js";

export type UnicityNetwork = "testnet" | "mainnet" | "dev";

export type UnicityConfig = {
  network?: UnicityNetwork;
  nametag?: string;
  owner?: string;
  additionalRelays?: string[];
  /** Aggregator API key (defaults to testnet key) */
  apiKey?: string;
};

const VALID_NETWORKS = new Set<string>(["testnet", "mainnet", "dev"]);

export function resolveUnicityConfig(raw: Record<string, unknown> | undefined): UnicityConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const network = typeof cfg.network === "string" && VALID_NETWORKS.has(cfg.network)
    ? (cfg.network as UnicityNetwork)
    : "testnet";
  const rawNametag = typeof cfg.nametag === "string" ? cfg.nametag.replace(/^@/, "").trim() : undefined;
  const nametag = rawNametag && NAMETAG_REGEX.test(rawNametag) ? rawNametag : undefined;
  const rawOwner = typeof cfg.owner === "string" ? cfg.owner.replace(/^@/, "").trim() : undefined;
  const owner = rawOwner && NAMETAG_REGEX.test(rawOwner) ? rawOwner : undefined;
  const additionalRelays = Array.isArray(cfg.additionalRelays)
    ? cfg.additionalRelays.filter((r): r is string => typeof r === "string")
    : undefined;
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey : undefined;
  return { network, nametag, owner, additionalRelays, apiKey };
}

/** Environment overrides — centralized here to keep env access out of network-facing modules. */
export const TRUSTBASE_URL = process.env.UNICITY_TRUSTBASE_URL
  ?? "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json";
export const FAUCET_API_URL = process.env.UNICITY_FAUCET_URL
  ?? "https://faucet.unicity.network/api/v1/faucet/request";
