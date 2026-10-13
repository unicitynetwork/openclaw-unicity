/** Unicity plugin configuration: normalization of plugins.entries['openclaw-unicity'].config (pure, no I/O, no env). */

import { toXOnly } from "./identity.js";
import { normalizeNametag } from "./validation.js";

export const PLUGIN_ID = "openclaw-unicity";
export const CHANNEL_ID = "unicity";

export type UnicityNetwork = "testnet2" | "mainnet";

export type DmPolicy = "open" | "allowlist" | "pairing" | "disabled";

export type UnicityConfig = {
  /** Unknown values fall back to "testnet2" with a warning. */
  network: UnicityNetwork;
  /** Lowercased, no '@', valid per the SDK (invalid values are dropped with a warning). */
  nametag?: string;
  /** Lowercased nametag (no '@') or lowercase 64/66-hex public key. */
  owner?: string;
  /** Extra authoritative owner keys, normalized to x-only. */
  ownerPubkeys: string[];
  additionalRelays?: string[];
  /** Gateway API key (from API_KEY_URL). Without one the wallet runs messaging-only: no payments. */
  apiKey?: string;
  /** Override of NETWORK_DEFAULTS[network].walletApiUrl. */
  walletApiUrl?: string;
  /** Undefined when not set here (the channel config may provide it). */
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  /**
   * Extra tool names non-owner turns (stranger DMs, all group turns, transfers, payment requests) may use on top of
   * the built-in stranger allowlist. Operator escape hatch: exec/fs/message tools here hand them to strangers.
   */
  strangerToolsAllow: string[];
  /** NIP-29 group chat: true = network default relays, object = custom relays (never empty). */
  groupChat: boolean | { relays: string[] };
  /** Human-readable normalization warnings for the caller to log. */
  warnings: string[];
};

export const NETWORK_DEFAULTS: Record<UnicityNetwork, { walletApiUrl: string; allowMint: boolean }> = {
  testnet2: { walletApiUrl: "https://wallet-api.unicity.network", allowMint: true },
  mainnet: { walletApiUrl: "https://wallet-api.mainnet.unicity.network", allowMint: false },
};

/** Where operators get a gateway API key. */
export const API_KEY_URL = "https://sphere.unicity.network";
/** Config path of the API key, for messages. */
export const API_KEY_CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config.apiKey`;

/** How to enable payments on a wallet without an API key (for logs, tool results and status lines). */
export const API_KEY_HINT = `get an API key at ${API_KEY_URL} and set ${API_KEY_CONFIG_PATH} (or run 'openclaw unicity setup')`;

export const DM_POLICIES: readonly DmPolicy[] = ["open", "allowlist", "pairing", "disabled"];
const HEX_PUBKEY = /^(?:0[23])?[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isDmPolicy(v: unknown): v is DmPolicy {
  return typeof v === "string" && (DM_POLICIES as readonly string[]).includes(v);
}

/** Trimmed non-empty string entries of an array; undefined when `v` is not an array. */
export function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

/** Trimmed string, or undefined when `v` is not a string or is blank. */
export function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Owner as stored in config: lowercase nametag without '@', or lowercase 64/66-hex public key; null when empty/invalid. */
export function normalizeOwner(input: string): string | null {
  const raw = input.trim().replace(/^@/, "").trim().toLowerCase();
  if (!raw) return null;
  return HEX_PUBKEY.test(raw) ? raw : normalizeNametag(raw);
}

function resolveNetwork(v: unknown, warnings: string[]): UnicityNetwork {
  if (v === undefined || v === null || v === "") return "testnet2";
  const n = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (n === "testnet2" || n === "mainnet") return n;
  warnings.push(`unknown network ${JSON.stringify(v)}; using "testnet2"`);
  return "testnet2";
}

function resolveOwner(v: unknown, warnings: string[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    warnings.push("owner must be a nametag or public key; ignoring it");
    return undefined;
  }
  if (!v.trim().replace(/^@/, "").trim()) return undefined; // empty or a bare '@': not set
  const owner = normalizeOwner(v);
  if (!owner) warnings.push(`owner ${JSON.stringify(v)} is neither a valid nametag nor a 64/66-hex public key; ignoring it`);
  return owner ?? undefined;
}

function resolveWalletApiUrl(v: unknown, warnings: string[]): string | undefined {
  const s = optionalString(v);
  if (!s) return undefined;
  try {
    const url = new URL(s);
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
      return s.replace(/\/+$/, "");
    }
  } catch {
    // fall through to the warning
  }
  warnings.push(`walletApiUrl ${JSON.stringify(s)} must be an https:// URL (http:// only on loopback); ignoring it`);
  return undefined;
}

export function resolveUnicityConfig(raw: Record<string, unknown> | undefined): UnicityConfig {
  const cfg = raw ?? {};
  const warnings: string[] = [];

  const network = resolveNetwork(cfg.network, warnings);

  let nametag: string | undefined;
  if (typeof cfg.nametag === "string") {
    nametag = cfg.nametag.trim() ? (normalizeNametag(cfg.nametag) ?? undefined) : undefined;
    if (!nametag && cfg.nametag.trim()) {
      warnings.push(`nametag ${JSON.stringify(cfg.nametag)} is invalid (3-20 chars: a-z, 0-9, _ or -); ignoring it`);
    }
  } else if (cfg.nametag !== undefined && cfg.nametag !== null) {
    warnings.push("nametag must be a string; ignoring it");
  }

  const owner = resolveOwner(cfg.owner, warnings);

  const ownerPubkeys: string[] = [];
  for (const k of stringList(cfg.ownerPubkeys) ?? []) {
    const x = toXOnly(k);
    if (!x) warnings.push(`ownerPubkeys entry ${JSON.stringify(k)} is not a 64/66-hex public key; ignoring it`);
    else if (!ownerPubkeys.includes(x)) ownerPubkeys.push(x);
  }

  let dmPolicy: DmPolicy | undefined;
  if (isDmPolicy(cfg.dmPolicy)) {
    dmPolicy = cfg.dmPolicy;
  } else if (cfg.dmPolicy !== undefined && cfg.dmPolicy !== null) {
    warnings.push(`dmPolicy ${JSON.stringify(cfg.dmPolicy)} is not one of open|allowlist|pairing|disabled; ignoring it`);
  }

  const rawGroupChat = cfg.groupChat;
  let groupChat: UnicityConfig["groupChat"] = true;
  if (rawGroupChat === false) {
    groupChat = false;
  } else if (rawGroupChat !== null && typeof rawGroupChat === "object" && !Array.isArray(rawGroupChat)) {
    const relays = stringList((rawGroupChat as Record<string, unknown>).relays);
    groupChat = relays?.length ? { relays } : true;
  }

  const additionalRelays = stringList(cfg.additionalRelays);
  const apiKey = optionalString(cfg.apiKey);
  const walletApiUrl = resolveWalletApiUrl(cfg.walletApiUrl, warnings);
  const allowFrom = stringList(cfg.allowFrom);
  const strangerToolsAllow = [...new Set(stringList(cfg.strangerToolsAllow) ?? [])];

  return {
    network,
    ...(nametag ? { nametag } : {}),
    ...(owner ? { owner } : {}),
    ownerPubkeys,
    ...(additionalRelays ? { additionalRelays } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(walletApiUrl ? { walletApiUrl } : {}),
    ...(dmPolicy ? { dmPolicy } : {}),
    ...(allowFrom ? { allowFrom } : {}),
    strangerToolsAllow,
    groupChat,
    warnings,
  };
}

/** Extract plugins.entries['openclaw-unicity'].config from a full OpenClaw config object and resolve it. */
export function readPluginConfig(fullConfig: unknown): UnicityConfig {
  const plugins = (fullConfig as { plugins?: { entries?: Record<string, { config?: unknown } | undefined> } } | null)?.plugins;
  const raw = plugins?.entries?.[PLUGIN_ID]?.config;
  return resolveUnicityConfig(raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);
}

/** The configured API key; the plugin ships none, so undefined means messaging-only on every network. */
export function effectiveApiKey(cfg: UnicityConfig): string | undefined {
  return cfg.apiKey;
}
