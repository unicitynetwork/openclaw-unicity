/**
 * Integration tests — uses real sphere-sdk (no mocks).
 * Verifies wallet creation, identity, nametag, and communications API surface.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDirs() {
  const base = join(tmpdir(), `uniclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dataDir = join(base, "data");
  const tokensDir = join(base, "tokens");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { base, dataDir, tokensDir };
}

describe("sphere-sdk integration", () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterEach(async () => {
    for (const s of spheres) {
      try { await s.destroy(); } catch {}
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    cleanupDirs.length = 0;
  });

  it("creates a new wallet with autoGenerate and returns mnemonic", async () => {
    const { base, dataDir, tokensDir } = makeTempDirs();
    cleanupDirs.push(base);

    const providers = createNodeProviders({
      network: "testnet",
      dataDir,
      tokensDir,
    });

    const result = await Sphere.init({
      ...providers,
      autoGenerate: true,
    });

    spheres.push(result.sphere);

    expect(result.created).toBe(true);
    expect(result.generatedMnemonic).toBeDefined();
    expect(result.generatedMnemonic!.split(" ").length).toBeGreaterThanOrEqual(12);

    const identity = result.sphere.identity;
    expect(identity).toBeDefined();
    expect(identity!.chainPubkey).toBeDefined();
    expect(typeof identity!.chainPubkey).toBe("string");
    expect(identity!.chainPubkey.length).toBeGreaterThan(0);
  });

  it("loads existing wallet on second init (no new mnemonic)", async () => {
    const { base, dataDir, tokensDir } = makeTempDirs();
    cleanupDirs.push(base);

    const providers = createNodeProviders({ network: "testnet", dataDir, tokensDir });

    const first = await Sphere.init({ ...providers, autoGenerate: true });
    const firstPubkey = first.sphere.identity!.chainPubkey;
    await first.sphere.destroy();

    const providers2 = createNodeProviders({ network: "testnet", dataDir, tokensDir });
    const second = await Sphere.init({ ...providers2, autoGenerate: true });
    spheres.push(second.sphere);

    expect(second.created).toBe(false);
    expect(second.generatedMnemonic).toBeUndefined();
    expect(second.sphere.identity!.chainPubkey).toBe(firstPubkey);
  });

  it("exposes communications API with sendDM and onDirectMessage", async () => {
    const { base, dataDir, tokensDir } = makeTempDirs();
    cleanupDirs.push(base);

    const providers = createNodeProviders({ network: "testnet", dataDir, tokensDir });
    const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
    spheres.push(sphere);

    expect(sphere.communications).toBeDefined();
    expect(typeof sphere.communications.sendDM).toBe("function");
    expect(typeof sphere.communications.onDirectMessage).toBe("function");
  });

  it("onDirectMessage returns an unsubscribe function", async () => {
    const { base, dataDir, tokensDir } = makeTempDirs();
    cleanupDirs.push(base);

    const providers = createNodeProviders({ network: "testnet", dataDir, tokensDir });
    const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
    spheres.push(sphere);

    const unsub = sphere.communications.onDirectMessage(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("registerNametag is a callable method", async () => {
    const { base, dataDir, tokensDir } = makeTempDirs();
    cleanupDirs.push(base);

    const providers = createNodeProviders({ network: "testnet", dataDir, tokensDir });
    const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
    spheres.push(sphere);

    expect(typeof sphere.registerNametag).toBe("function");
  });
});
