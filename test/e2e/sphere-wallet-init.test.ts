/**
 * Live sphere-sdk checks for the wallet shape the plugin relies on: messaging-only testnet2 wallets
 * (walletApi:'none', one network literal) opened without an aggregator key, as a gateway with no apiKey opens
 * its wallet, and with one, as the CLI does when a key is configured; reload from disk, the communications surface, and the
 * nametag binding resolving back to the authenticated key (x-only transport key = chainPubkey.slice(2)).
 *
 * Needs network access to the testnet2 Nostr relay. Run: UNICITY_E2E=1 npx vitest run --config vitest.e2e.config.ts test/e2e/sphere-wallet-init.test.ts
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TokenRegistry, isSphereError, validateMnemonic, type Sphere } from "@unicitylabs/sphere-sdk";
import { TESTNET2_API_KEY, destroyAll, openTestWallet, pollUntil, randomNametag, removeDir, tempDir, toXOnly } from "./support/wallet.js";

describe("sphere-sdk wallet (messaging-only, testnet2)", () => {
  const dirs: string[] = [];
  const spheres: Sphere[] = [];

  const newDir = (label: string): string => {
    const dir = tempDir(label);
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await destroyAll(spheres.splice(0));
  });

  afterAll(() => {
    TokenRegistry.destroy();
    for (const d of dirs.splice(0)) removeDir(d);
  });

  it("creates a keyless wallet with a mnemonic, a chain key and a DIRECT:// address, and no payments", async () => {
    const res = await openTestWallet({ label: "create", dataDir: newDir("create"), payments: false });
    spheres.push(res.sphere);
    expect(res.sphere.getAggregator().getApiKey(), "opened without a key, like a gateway with no apiKey").toBeUndefined();

    expect(res.created).toBe(true);
    expect(res.generatedMnemonic).toBeDefined();
    expect(res.generatedMnemonic!.trim().split(/\s+/).length).toBeGreaterThanOrEqual(12);
    expect(validateMnemonic(res.generatedMnemonic!)).toBe(true);

    const identity = res.sphere.identity;
    expect(identity?.chainPubkey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(identity?.directAddress?.startsWith("DIRECT://")).toBe(true);

    expect(res.sphere.hasPayments).toBe(false);
    let code: string | undefined;
    try {
      void res.sphere.payments;
    } catch (err) {
      code = isSphereError(err) ? err.code : String(err);
    }
    expect(code).toBe("PAYMENTS_NOT_COMPOSED");
  });

  it("reloads the same identity from disk keyless (a gateway restart) and with an aggregator key (the CLI's composition), never with payments", async () => {
    const dataDir = newDir("reload");
    const first = await openTestWallet({ label: "reload-1", dataDir, payments: false });
    const { chainPubkey, directAddress } = first.sphere.identity!;
    await first.sphere.destroy();

    for (const [label, apiKey] of [["reload-2", undefined], ["reload-3", TESTNET2_API_KEY]] as const) {
      const next = await openTestWallet({ label, dataDir, payments: false, apiKey });
      spheres.push(next.sphere);

      expect(next.created, label).toBe(false);
      expect(next.generatedMnemonic, label).toBeUndefined();
      expect(next.sphere.identity?.chainPubkey, label).toBe(chainPubkey);
      expect(next.sphere.identity?.directAddress, label).toBe(directAddress);
      expect(next.sphere.getAggregator().getApiKey(), label).toBe(apiKey);
      expect(next.sphere.hasPayments, `${label}: walletApi:'none' composes no payments, with or without a key`).toBe(false);

      // Closed before the next open of the same data dir; a failed close fails the test, as for the first wallet.
      spheres.pop();
      await next.sphere.destroy();
    }
  });

  it("exposes sendDM and an onDirectMessage subscription that returns an unsubscribe function", async () => {
    const { sphere } = await openTestWallet({ label: "comms", dataDir: newDir("comms"), payments: false });
    spheres.push(sphere);

    expect(typeof sphere.communications.sendDM).toBe("function");
    const unsubscribe = sphere.communications.onDirectMessage(() => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
    expect(typeof sphere.registerNametag).toBe("function");
  });

  it("registers a nametag that resolves back to the wallet's own keys", async () => {
    const nametag = randomNametag("e2ei");
    const { sphere } = await openTestWallet({ label: "nametag", dataDir: newDir("nametag"), nametag, payments: false });
    spheres.push(sphere);

    expect(sphere.identity?.nametag).toBe(nametag);
    expect(sphere.hasNametag()).toBe(true);

    const chainPubkey = sphere.identity!.chainPubkey;
    const peer = await pollUntil(`resolve(@${nametag})`, () => sphere.resolve(`@${nametag}`), { timeoutMs: 45_000, intervalMs: 3_000 });
    expect(peer.chainPubkey.toLowerCase()).toBe(chainPubkey.toLowerCase());
    // The plugin's single sender identity: DMs carry the x-only transport key, money carries the chain key.
    expect(peer.transportPubkey.toLowerCase()).toBe(toXOnly(chainPubkey));
  }, 90_000);
});
