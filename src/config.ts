/** Uniclaw plugin configuration schema and helpers. */

export type UnicityNetwork = "testnet" | "mainnet" | "dev";

export type UniclawConfig = {
  network?: UnicityNetwork;
  nametag?: string;
  additionalRelays?: string[];
};

const VALID_NETWORKS = new Set<string>(["testnet", "mainnet", "dev"]);

export function resolveUniclawConfig(raw: Record<string, unknown> | undefined): UniclawConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const network = typeof cfg.network === "string" && VALID_NETWORKS.has(cfg.network)
    ? (cfg.network as UnicityNetwork)
    : "testnet";
  const nametag = typeof cfg.nametag === "string" ? cfg.nametag : undefined;
  const additionalRelays = Array.isArray(cfg.additionalRelays)
    ? cfg.additionalRelays.filter((r): r is string => typeof r === "string")
    : undefined;
  return { network, nametag, additionalRelays };
}
