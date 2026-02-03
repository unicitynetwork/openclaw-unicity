/**
 * E2E tests for Uniclaw wallet functionality.
 *
 * Tests real Sphere SDK operations on testnet:
 * - Wallet creation with random nametags
 * - Faucet fund requests
 * - DM sending between nametags
 * - Token transfers with finalization
 *
 * Run manually: npm run test:e2e
 *
 * NOT for CI - requires network access to testnet relays and faucet.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import type { DirectMessage } from "@unicitylabs/sphere-sdk";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = "https://faucet.unicity.network/api/v1/faucet/request";
const TRUSTBASE_URL =
  "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json";

/** Default testnet API key (from Sphere app) */
const DEFAULT_API_KEY = "sk_06365a9c44654841a366068bcfc68986";

// Timeouts
const RELAY_SETTLE_MS = 5000;
const DM_TIMEOUT_MS = 30000;
const FAUCET_TIMEOUT_MS = 30000;
const TOKEN_RECEIVE_TIMEOUT_MS = 60000;

// =============================================================================
// Helpers
// =============================================================================

const rand = () => Math.random().toString(36).slice(2, 8);

function randomNametag(prefix: string): string {
  // Nametag must be alphanumeric only (no hyphens), 3-20 chars
  const suffix = rand().replace(/[^a-z0-9]/g, "");
  const ts = (Date.now() % 10000).toString();
  return `${prefix}${suffix}${ts}`.slice(0, 20);
}

interface TempDirs {
  base: string;
  dataDir: string;
  tokensDir: string;
}

function makeTempDirs(label: string): TempDirs {
  const base = join(tmpdir(), `uniclaw-e2e-${label}-${Date.now()}-${rand()}`);
  const dataDir = join(base, "data");
  const tokensDir = join(base, "tokens");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { base, dataDir, tokensDir };
}

async function ensureTrustbase(dataDir: string): Promise<void> {
  const trustbasePath = join(dataDir, "trustbase.json");
  if (existsSync(trustbasePath)) return;

  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: ${res.status}`);
  }
  const data = await res.text();
  writeFileSync(trustbasePath, data);
}

interface WalletContext {
  sphere: Sphere;
  dirs: TempDirs;
  nametag: string;
}

async function createWallet(label: string, nametag?: string): Promise<WalletContext> {
  const dirs = makeTempDirs(label);
  await ensureTrustbase(dirs.dataDir);

  const actualNametag = nametag ?? randomNametag(label);

  const providers = createNodeProviders({
    network: "testnet",
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    oracle: {
      trustBasePath: join(dirs.dataDir, "trustbase.json"),
      apiKey: DEFAULT_API_KEY,
    },
  });

  const result = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag: actualNametag,
  });

  return { sphere: result.sphere, dirs, nametag: actualNametag };
}

function waitForDM(sphere: Sphere, timeoutMs = DM_TIMEOUT_MS): Promise<DirectMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: DM not received within ${timeoutMs}ms`)),
      timeoutMs
    );
    sphere.communications.onDirectMessage((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

interface FaucetResponse {
  success: boolean;
  coin?: string;
  amount?: number;
  error?: string;
}

async function requestFaucet(
  nametag: string,
  coin = "unicity",
  amount = 100
): Promise<FaucetResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FAUCET_TIMEOUT_MS);

  try {
    const res = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unicityId: nametag, coin, amount }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();
    return { success: true, ...data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { success: false, error: String(err) };
  }
}

function waitForTokens(
  sphere: Sphere,
  minCount: number,
  timeoutMs = TOKEN_RECEIVE_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = async () => {
      const tokens = sphere.payments.getTokens();
      if (tokens.length >= minCount) {
        resolve();
        return;
      }

      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout: Expected ${minCount} tokens, got ${tokens.length}`));
        return;
      }

      setTimeout(check, 2000);
    };

    check();
  });
}

async function cleanup(ctx: WalletContext | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.sphere.destroy();
  } catch { /* ignore */ }
  try {
    rmSync(ctx.dirs.base, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// =============================================================================
// DM Tests - Each test creates fresh wallets
// =============================================================================

describe("Uniclaw E2E: DM Operations", () => {
  let alice: WalletContext | null = null;
  let bob: WalletContext | null = null;

  afterEach(async () => {
    await cleanup(alice);
    await cleanup(bob);
    alice = null;
    bob = null;
  });

  it("sends DM from Alice to Bob by nametag", async () => {
    const aliceTag = randomNametag("alice");
    const bobTag = randomNametag("bob");

    alice = await createWallet("alice", aliceTag);
    bob = await createWallet("bob", bobTag);

    expect(alice.sphere.identity?.nametag).toBe(aliceTag);
    expect(bob.sphere.identity?.nametag).toBe(bobTag);

    // Subscribe Bob first, wait for relay subscription
    const dmPromise = waitForDM(bob.sphere);
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    const text = `Hello Bob! ${Date.now()}`;
    await alice.sphere.communications.sendDM(`@${bobTag}`, text);

    const msg = await dmPromise;
    expect(msg.content).toBe(text);
    expect(msg.senderNametag).toBe(aliceTag);
  }, 45000);

  it("sends DM from Bob to Alice by nametag", async () => {
    const aliceTag = randomNametag("alice");
    const bobTag = randomNametag("bob");

    alice = await createWallet("alice", aliceTag);
    bob = await createWallet("bob", bobTag);

    // Subscribe Alice first
    const dmPromise = waitForDM(alice.sphere);
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    const text = `Hello Alice! ${Date.now()}`;
    await bob.sphere.communications.sendDM(`@${aliceTag}`, text);

    const msg = await dmPromise;
    expect(msg.content).toBe(text);
    expect(msg.senderNametag).toBe(bobTag);
  }, 45000);

  it("sends DM by pubkey (32-byte x-only)", async () => {
    alice = await createWallet("alice");
    bob = await createWallet("bob");

    // Subscribe Bob first
    const dmPromise = waitForDM(bob.sphere);
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    // Get 32-byte x-only pubkey (chainPubkey is 33-byte compressed)
    let bobPubkey = bob.sphere.identity!.chainPubkey;
    if (bobPubkey.length === 66 && (bobPubkey.startsWith("02") || bobPubkey.startsWith("03"))) {
      bobPubkey = bobPubkey.slice(2);
    }

    const text = `Direct pubkey message ${Date.now()}`;
    await alice.sphere.communications.sendDM(bobPubkey, text);

    const msg = await dmPromise;
    expect(msg.content).toBe(text);
  }, 45000);

  it("completes bidirectional DM round-trip", async () => {
    const aliceTag = randomNametag("alice");
    const bobTag = randomNametag("bob");

    alice = await createWallet("alice", aliceTag);
    bob = await createWallet("bob", bobTag);

    // Wait for relay setup
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    // Alice -> Bob
    const bobDmPromise = waitForDM(bob.sphere);
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    const msg1 = `Round-trip A->B ${Date.now()}`;
    await alice.sphere.communications.sendDM(`@${bobTag}`, msg1);

    const received1 = await bobDmPromise;
    expect(received1.content).toBe(msg1);

    // Wait for subscription state to settle before second exchange
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    // Bob -> Alice
    const aliceDmPromise = waitForDM(alice.sphere);
    await new Promise((r) => setTimeout(r, RELAY_SETTLE_MS));

    const msg2 = `Round-trip B->A ${Date.now()}`;
    await bob.sphere.communications.sendDM(`@${aliceTag}`, msg2);

    const received2 = await aliceDmPromise;
    expect(received2.content).toBe(msg2);
  }, 120000);
});

// =============================================================================
// Token Tests - Faucet and transfers
// =============================================================================

describe("Uniclaw E2E: Token Operations", () => {
  let alice: WalletContext | null = null;
  let bob: WalletContext | null = null;

  afterEach(async () => {
    await cleanup(alice);
    await cleanup(bob);
    alice = null;
    bob = null;
  });

  it("creates wallet with nametag token minted", async () => {
    alice = await createWallet("alice");

    expect(alice.sphere.identity?.nametag).toBeTruthy();
    expect(alice.sphere.identity?.chainPubkey).toBeTruthy();

    // Nametag token should have been minted (check via hasNametag)
    const hasNametag = alice.sphere.payments.hasNametag();
    expect(hasNametag).toBe(true);
  }, 60000);

  it("requests funds from faucet", async () => {
    alice = await createWallet("alice");

    const response = await requestFaucet(alice.nametag, "unicity", 100);

    console.log(`[E2E] Faucet response:`, response);
    expect(response.success).toBe(true);
  }, 45000);

  it("receives tokens after faucet request", async () => {
    alice = await createWallet("alice");

    // Request funds
    const faucetRes = await requestFaucet(alice.nametag, "unicity", 100);
    expect(faucetRes.success).toBe(true);

    // Wait for tokens to arrive
    await waitForTokens(alice.sphere, 1, TOKEN_RECEIVE_TIMEOUT_MS);

    const tokens = alice.sphere.payments.getTokens();
    expect(tokens.length).toBeGreaterThan(0);
    console.log(`[E2E] Alice received ${tokens.length} token(s)`);
  }, 90000);

  it("transfers token from Alice to Bob", async () => {
    const aliceTag = randomNametag("alice");
    const bobTag = randomNametag("bob");

    alice = await createWallet("alice", aliceTag);
    bob = await createWallet("bob", bobTag);

    // Request funds for Alice
    const faucetRes = await requestFaucet(aliceTag, "unicity", 100);
    expect(faucetRes.success).toBe(true);

    // Wait for Alice to receive tokens
    await waitForTokens(alice.sphere, 1, TOKEN_RECEIVE_TIMEOUT_MS);

    const aliceTokens = alice.sphere.payments.getTokens();
    expect(aliceTokens.length).toBeGreaterThan(0);

    // Transfer to Bob
    const tokenToSend = aliceTokens[0];
    console.log(`[E2E] Transferring token ${tokenToSend.coinId} (${tokenToSend.amount}) to @${bobTag}`);

    await alice.sphere.payments.send({
      recipient: `@${bobTag}`,
      amount: tokenToSend.amount,
      coinId: tokenToSend.coinId,
    });

    // Wait for Bob to receive
    await waitForTokens(bob.sphere, 1, TOKEN_RECEIVE_TIMEOUT_MS);

    const bobTokens = bob.sphere.payments.getTokens();
    expect(bobTokens.length).toBeGreaterThan(0);
    console.log(`[E2E] Bob received ${bobTokens.length} token(s)`);
  }, 180000);
});
