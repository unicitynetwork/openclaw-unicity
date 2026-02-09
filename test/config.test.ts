import { describe, it, expect } from "vitest";
import { resolveUnicityConfig } from "../src/config.js";

describe("resolveUnicityConfig", () => {
  it("returns defaults for undefined input", () => {
    const cfg = resolveUnicityConfig(undefined);
    expect(cfg.network).toBe("testnet");
    expect(cfg.nametag).toBeUndefined();
    expect(cfg.owner).toBeUndefined();
    expect(cfg.additionalRelays).toBeUndefined();
  });

  it("returns defaults for empty object", () => {
    const cfg = resolveUnicityConfig({});
    expect(cfg.network).toBe("testnet");
  });

  it("accepts valid network values", () => {
    expect(resolveUnicityConfig({ network: "mainnet" }).network).toBe("mainnet");
    expect(resolveUnicityConfig({ network: "dev" }).network).toBe("dev");
    expect(resolveUnicityConfig({ network: "testnet" }).network).toBe("testnet");
  });

  it("rejects invalid network, falls back to testnet", () => {
    expect(resolveUnicityConfig({ network: "invalid" }).network).toBe("testnet");
    expect(resolveUnicityConfig({ network: 42 }).network).toBe("testnet");
  });

  it("parses nametag string", () => {
    expect(resolveUnicityConfig({ nametag: "alice" }).nametag).toBe("alice");
  });

  it("ignores non-string nametag", () => {
    expect(resolveUnicityConfig({ nametag: 123 }).nametag).toBeUndefined();
  });

  it("parses additionalRelays array", () => {
    const cfg = resolveUnicityConfig({
      additionalRelays: ["wss://relay1.example.com", "wss://relay2.example.com"],
    });
    expect(cfg.additionalRelays).toEqual(["wss://relay1.example.com", "wss://relay2.example.com"]);
  });

  it("filters non-string entries from additionalRelays", () => {
    const cfg = resolveUnicityConfig({
      additionalRelays: ["wss://ok.com", 42, null, "wss://also-ok.com"],
    });
    expect(cfg.additionalRelays).toEqual(["wss://ok.com", "wss://also-ok.com"]);
  });

  it("ignores non-array additionalRelays", () => {
    expect(resolveUnicityConfig({ additionalRelays: "not-array" }).additionalRelays).toBeUndefined();
  });

  it("parses owner string and strips @ prefix", () => {
    expect(resolveUnicityConfig({ owner: "alice" }).owner).toBe("alice");
    expect(resolveUnicityConfig({ owner: "@alice" }).owner).toBe("alice");
  });

  it("ignores non-string or empty owner", () => {
    expect(resolveUnicityConfig({ owner: 123 }).owner).toBeUndefined();
    expect(resolveUnicityConfig({ owner: "" }).owner).toBeUndefined();
    expect(resolveUnicityConfig({ owner: " " }).owner).toBeUndefined();
  });

  it("strips nametag starting with a number", () => {
    expect(resolveUnicityConfig({ nametag: "1badname" }).nametag).toBeUndefined();
  });

  it("strips nametag with special characters", () => {
    expect(resolveUnicityConfig({ nametag: "bad@name!" }).nametag).toBeUndefined();
  });

  it("strips nametag exceeding 32 chars", () => {
    expect(resolveUnicityConfig({ nametag: "a".repeat(33) }).nametag).toBeUndefined();
  });

  it("accepts valid nametag formats", () => {
    expect(resolveUnicityConfig({ nametag: "mybot" }).nametag).toBe("mybot");
    expect(resolveUnicityConfig({ nametag: "My-Bot_01" }).nametag).toBe("My-Bot_01");
    expect(resolveUnicityConfig({ nametag: "a" }).nametag).toBe("a");
  });

  it("strips @ prefix from nametag before validation", () => {
    expect(resolveUnicityConfig({ nametag: "@alice" }).nametag).toBe("alice");
  });

  it("strips owner with invalid nametag format", () => {
    expect(resolveUnicityConfig({ owner: "1bad" }).owner).toBeUndefined();
    expect(resolveUnicityConfig({ owner: "bad@!" }).owner).toBeUndefined();
  });
});
