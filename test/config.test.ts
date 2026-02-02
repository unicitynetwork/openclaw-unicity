import { describe, it, expect } from "vitest";
import { resolveUniclawConfig } from "../src/config.js";

describe("resolveUniclawConfig", () => {
  it("returns defaults for undefined input", () => {
    const cfg = resolveUniclawConfig(undefined);
    expect(cfg.network).toBe("testnet");
    expect(cfg.nametag).toBeUndefined();
    expect(cfg.owner).toBeUndefined();
    expect(cfg.additionalRelays).toBeUndefined();
  });

  it("returns defaults for empty object", () => {
    const cfg = resolveUniclawConfig({});
    expect(cfg.network).toBe("testnet");
  });

  it("accepts valid network values", () => {
    expect(resolveUniclawConfig({ network: "mainnet" }).network).toBe("mainnet");
    expect(resolveUniclawConfig({ network: "dev" }).network).toBe("dev");
    expect(resolveUniclawConfig({ network: "testnet" }).network).toBe("testnet");
  });

  it("rejects invalid network, falls back to testnet", () => {
    expect(resolveUniclawConfig({ network: "invalid" }).network).toBe("testnet");
    expect(resolveUniclawConfig({ network: 42 }).network).toBe("testnet");
  });

  it("parses nametag string", () => {
    expect(resolveUniclawConfig({ nametag: "alice" }).nametag).toBe("alice");
  });

  it("ignores non-string nametag", () => {
    expect(resolveUniclawConfig({ nametag: 123 }).nametag).toBeUndefined();
  });

  it("parses additionalRelays array", () => {
    const cfg = resolveUniclawConfig({
      additionalRelays: ["wss://relay1.example.com", "wss://relay2.example.com"],
    });
    expect(cfg.additionalRelays).toEqual(["wss://relay1.example.com", "wss://relay2.example.com"]);
  });

  it("filters non-string entries from additionalRelays", () => {
    const cfg = resolveUniclawConfig({
      additionalRelays: ["wss://ok.com", 42, null, "wss://also-ok.com"],
    });
    expect(cfg.additionalRelays).toEqual(["wss://ok.com", "wss://also-ok.com"]);
  });

  it("ignores non-array additionalRelays", () => {
    expect(resolveUniclawConfig({ additionalRelays: "not-array" }).additionalRelays).toBeUndefined();
  });

  it("parses owner string and strips @ prefix", () => {
    expect(resolveUniclawConfig({ owner: "alice" }).owner).toBe("alice");
    expect(resolveUniclawConfig({ owner: "@alice" }).owner).toBe("alice");
  });

  it("ignores non-string or empty owner", () => {
    expect(resolveUniclawConfig({ owner: 123 }).owner).toBeUndefined();
    expect(resolveUniclawConfig({ owner: "" }).owner).toBeUndefined();
    expect(resolveUniclawConfig({ owner: " " }).owner).toBeUndefined();
  });
});
