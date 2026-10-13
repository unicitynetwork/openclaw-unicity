import { describe, expect, it } from "vitest";
import {
  API_KEY_CONFIG_PATH, API_KEY_HINT, API_KEY_URL, DM_POLICIES, effectiveApiKey, isDmPolicy, NETWORK_DEFAULTS, normalizeOwner,
  optionalString, readPluginConfig, resolveUnicityConfig, stringList,
} from "../src/config.js";

const X_ONLY = "ab".repeat(32);
const CHAIN_KEY = `03${"cd".repeat(32)}`;

describe("resolveUnicityConfig", () => {
  it("returns defaults for undefined / empty input", () => {
    for (const raw of [undefined, {}]) {
      const cfg = resolveUnicityConfig(raw);
      expect(cfg).toEqual({ network: "testnet2", ownerPubkeys: [], strangerToolsAllow: [], groupChat: true, warnings: [] });
    }
  });

  describe("network", () => {
    it("keeps testnet2 and mainnet", () => {
      expect(resolveUnicityConfig({ network: "testnet2" }).network).toBe("testnet2");
      expect(resolveUnicityConfig({ network: "mainnet" }).network).toBe("mainnet");
      expect(resolveUnicityConfig({ network: " MainNet " }).network).toBe("mainnet");
    });

    it("falls back to testnet2 with a warning for unknown values, other testnet spellings included", () => {
      for (const network of ["invalid", 42, "testnet", "dev"]) {
        const cfg = resolveUnicityConfig({ network });
        expect(cfg.network).toBe("testnet2");
        expect(cfg.warnings[0]).toMatch(/unknown network/);
      }
    });
  });

  describe("nametag", () => {
    it("normalizes to lowercase without '@'", () => {
      expect(resolveUnicityConfig({ nametag: "@My-Bot_01" }).nametag).toBe("my-bot_01");
    });

    it("drops names the SDK rejects, with a warning", () => {
      for (const nametag of ["ab", "a".repeat(21), "bad@name!", "bad name"]) {
        const cfg = resolveUnicityConfig({ nametag });
        expect(cfg.nametag).toBeUndefined();
        expect(cfg.warnings[0]).toMatch(/nametag .* is invalid/);
      }
    });

    it("drops non-strings with a warning and ignores empty strings", () => {
      expect(resolveUnicityConfig({ nametag: 123 })).toMatchObject({ warnings: ["nametag must be a string; ignoring it"] });
      expect(resolveUnicityConfig({ nametag: "" }).warnings).toEqual([]);
      expect(resolveUnicityConfig({ nametag: "  " }).warnings).toEqual([]);
    });
  });

  describe("owner", () => {
    it("accepts a nametag (lowercased, '@' stripped)", () => {
      expect(resolveUnicityConfig({ owner: "@Alice" }).owner).toBe("alice");
    });

    it("accepts 64- and 66-hex public keys, lowercased, also with a leading '@'", () => {
      expect(resolveUnicityConfig({ owner: X_ONLY.toUpperCase() }).owner).toBe(X_ONLY);
      expect(resolveUnicityConfig({ owner: CHAIN_KEY.toUpperCase() }).owner).toBe(CHAIN_KEY);
      expect(resolveUnicityConfig({ owner: `@${CHAIN_KEY}` }).owner).toBe(CHAIN_KEY);
    });

    it("drops invalid owners with a warning", () => {
      for (const owner of ["1@", "bad name", `05${"a".repeat(64)}`]) {
        const cfg = resolveUnicityConfig({ owner });
        expect(cfg.owner).toBeUndefined();
        expect(cfg.warnings[0]).toMatch(/owner .* is neither/);
      }
      expect(resolveUnicityConfig({ owner: 123 }).warnings[0]).toMatch(/owner must be/);
    });

    it("ignores empty owners silently", () => {
      for (const owner of ["", " ", "@"]) {
        const cfg = resolveUnicityConfig({ owner });
        expect(cfg.owner).toBeUndefined();
        expect(cfg.warnings).toEqual([]);
      }
    });
  });

  describe("ownerPubkeys", () => {
    it("normalizes to deduplicated x-only keys", () => {
      const cfg = resolveUnicityConfig({ ownerPubkeys: [X_ONLY, CHAIN_KEY, `02${X_ONLY}`, CHAIN_KEY.toUpperCase()] });
      expect(cfg.ownerPubkeys).toEqual([X_ONLY, "cd".repeat(32)]);
      expect(cfg.warnings).toEqual([]);
    });

    it("drops invalid entries with a warning", () => {
      const cfg = resolveUnicityConfig({ ownerPubkeys: ["alice", X_ONLY, 7] });
      expect(cfg.ownerPubkeys).toEqual([X_ONLY]);
      expect(cfg.warnings).toEqual([expect.stringContaining('"alice" is not a 64/66-hex public key')]);
    });

    it("is an empty list when absent or not an array", () => {
      expect(resolveUnicityConfig({ ownerPubkeys: "nope" }).ownerPubkeys).toEqual([]);
    });
  });

  it("parses relays, apiKey and allowFrom as trimmed string lists", () => {
    const cfg = resolveUnicityConfig({
      additionalRelays: ["wss://ok.example", 42, null, " wss://also.example ", ""],
      apiKey: "  sk_test  ",
      allowFrom: ["@alice", 1, X_ONLY],
    });
    expect(cfg.additionalRelays).toEqual(["wss://ok.example", "wss://also.example"]);
    expect(cfg.apiKey).toBe("sk_test");
    expect(cfg.allowFrom).toEqual(["@alice", X_ONLY]);
    expect(resolveUnicityConfig({ additionalRelays: "not-array" }).additionalRelays).toBeUndefined();
  });

  it("accepts https walletApiUrl (http only on loopback) and drops others with a warning", () => {
    expect(resolveUnicityConfig({ walletApiUrl: "https://wallet.example/" }).walletApiUrl).toBe("https://wallet.example");
    expect(resolveUnicityConfig({ walletApiUrl: "http://127.0.0.1:8080" }).walletApiUrl).toBe("http://127.0.0.1:8080");
    for (const walletApiUrl of ["http://wallet.example", "not a url"]) {
      const cfg = resolveUnicityConfig({ walletApiUrl });
      expect(cfg.walletApiUrl).toBeUndefined();
      expect(cfg.warnings[0]).toMatch(/walletApiUrl/);
    }
  });

  it("keeps dmPolicy undefined unless valid", () => {
    expect(resolveUnicityConfig({ dmPolicy: "pairing" }).dmPolicy).toBe("pairing");
    expect(resolveUnicityConfig({}).dmPolicy).toBeUndefined();
    const bad = resolveUnicityConfig({ dmPolicy: "everyone" });
    expect(bad.dmPolicy).toBeUndefined();
    expect(bad.warnings[0]).toMatch(/dmPolicy/);
  });

  it("resolves groupChat to a boolean or a non-empty relay list", () => {
    expect(resolveUnicityConfig({ groupChat: false }).groupChat).toBe(false);
    expect(resolveUnicityConfig({ groupChat: true }).groupChat).toBe(true);
    expect(resolveUnicityConfig({ groupChat: { relays: ["wss://g.example", 3] } }).groupChat).toEqual({ relays: ["wss://g.example"] });
    expect(resolveUnicityConfig({ groupChat: {} }).groupChat).toBe(true);
    expect(resolveUnicityConfig({ groupChat: { relays: [" "] } }).groupChat).toBe(true);
  });

  it("parses strangerToolsAllow as a deduplicated trimmed list (empty by default)", () => {
    expect(resolveUnicityConfig({ strangerToolsAllow: [" web_search ", "web_search", 3, ""] }).strangerToolsAllow).toEqual(["web_search"]);
    expect(resolveUnicityConfig({ strangerToolsAllow: "exec" }).strangerToolsAllow).toEqual([]);
  });

  it("passes no unknown keys through (SDK storage paths included)", () => {
    const cfg = resolveUnicityConfig({ trustBasePath: "/x", tokensDir: "/y", somethingElse: "z" });
    expect(Object.keys(cfg).sort()).toEqual(["groupChat", "network", "ownerPubkeys", "strangerToolsAllow", "warnings"]);
  });
});

describe("shared parsing helpers", () => {
  it("normalizeOwner: nametag or 64/66-hex key, lowercased, '@' stripped; null otherwise", () => {
    expect(normalizeOwner(" @Alice ")).toBe("alice");
    expect(normalizeOwner(`@${CHAIN_KEY.toUpperCase()}`)).toBe(CHAIN_KEY);
    expect(normalizeOwner(X_ONLY)).toBe(X_ONLY);
    for (const bad of ["", "@", "bad name", `05${"a".repeat(64)}`]) expect(normalizeOwner(bad)).toBeNull();
  });

  it("isDmPolicy / DM_POLICIES", () => {
    expect(DM_POLICIES).toEqual(["open", "allowlist", "pairing", "disabled"]);
    for (const p of DM_POLICIES) expect(isDmPolicy(p)).toBe(true);
    for (const p of ["Open", "everyone", 1, null, undefined]) expect(isDmPolicy(p)).toBe(false);
  });

  it("stringList / optionalString trim and drop blanks", () => {
    expect(stringList([" a ", "", 1, "b"])).toEqual(["a", "b"]);
    expect(stringList("a")).toBeUndefined();
    expect(optionalString("  x ")).toBe("x");
    expect(optionalString("  ")).toBeUndefined();
    expect(optionalString(5)).toBeUndefined();
  });
});

describe("readPluginConfig", () => {
  it("reads plugins.entries['openclaw-unicity'].config", () => {
    const cfg = readPluginConfig({ plugins: { entries: { "openclaw-unicity": { config: { nametag: "Bot", network: "mainnet" } } } } });
    expect(cfg).toMatchObject({ nametag: "bot", network: "mainnet" });
  });

  it("falls back to defaults for missing or malformed configs", () => {
    for (const full of [undefined, null, {}, { plugins: {} }, { plugins: { entries: { "openclaw-unicity": { config: [] } } } }]) {
      expect(readPluginConfig(full).network).toBe("testnet2");
    }
  });
});

describe("effectiveApiKey / NETWORK_DEFAULTS", () => {
  it("ships no API key: only a configured key is used, on every network", () => {
    expect(effectiveApiKey(resolveUnicityConfig({}))).toBeUndefined();
    expect(effectiveApiKey(resolveUnicityConfig({ network: "mainnet" }))).toBeUndefined();
    expect(effectiveApiKey(resolveUnicityConfig({ apiKey: " sk_test " }))).toBe("sk_test");
    expect(effectiveApiKey(resolveUnicityConfig({ network: "mainnet", apiKey: "sk_main" }))).toBe("sk_main");
    expect(effectiveApiKey(resolveUnicityConfig({ apiKey: "  " }))).toBeUndefined();
    for (const defaults of Object.values(NETWORK_DEFAULTS)) expect(Object.keys(defaults).sort()).toEqual(["allowMint", "walletApiUrl"]);
  });

  it("points operators to the key's source and its config path", () => {
    expect(API_KEY_URL).toBe("https://sphere.unicity.network");
    expect(API_KEY_CONFIG_PATH).toBe("plugins.entries.openclaw-unicity.config.apiKey");
    expect(API_KEY_HINT).toContain(API_KEY_URL);
    expect(API_KEY_HINT).toContain(API_KEY_CONFIG_PATH);
  });

  it("allows minting only on testnet2", () => {
    expect(NETWORK_DEFAULTS.testnet2).toMatchObject({ walletApiUrl: "https://wallet-api.unicity.network", allowMint: true });
    expect(NETWORK_DEFAULTS.mainnet).toMatchObject({ walletApiUrl: "https://wallet-api.mainnet.unicity.network", allowMint: false });
  });
});
