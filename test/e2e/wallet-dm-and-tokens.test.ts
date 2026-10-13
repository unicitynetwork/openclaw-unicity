/**
 * Live testnet2 e2e for the wallet operations the plugin's tools and channel use, with two wallets
 * composed exactly like the gateway's (createWalletApiProviders, public testnet2 key, unique deviceId):
 * DMs by nametag and by x-only key, self-mint (there is no faucet), send + receive, and payment
 * requests (create -> list -> pay).
 *
 * Money rules from the SDK apply here too: a failed mint() is never re-called (its journal replays it via
 * resumeNow()), and a possibly-committed send/pay is never re-issued; both converge by waiting.
 * The shared testnet2 gateway throttles certification, so the token steps have generous timeouts.
 *
 * Run: UNICITY_E2E=1 npx vitest run --config vitest.e2e.config.ts test/e2e/wallet-dm-and-tokens.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  TokenRegistry,
  getCoinIdBySymbol,
  getTokenDecimals,
  isPossiblyCommittedSendOutcome,
  parseTokenAmount,
  toHumanReadable,
  type IncomingTransfer,
  type Sphere,
} from "@unicitylabs/sphere-sdk";
import type { PaymentRequestView } from "@unicitylabs/sphere-sdk/payments-v2";
import { DmInbox, destroyAll, openTestWallet, pollUntil, randomNametag, removeDir, tempDir, toXOnly } from "./support/wallet.js";

const DM_TIMEOUT_MS = 45_000;
const MINT_TIMEOUT_MS = 300_000;
const SETTLE_TIMEOUT_MS = 300_000;
const REQUEST_ARRIVAL_TIMEOUT_MS = 120_000;
/** Errors mint() returns before journaling; anything else converges through the journal replay. */
const MINT_PRE_JOURNAL_REFUSAL = /even-length lowercase hex|issued only by token type/;

type Party = { label: string; sphere: Sphere; dir: string; nametag: string; chainPubkey: string; xOnly: string; inbox: DmInbox };

const nonce = (): string => randomBytes(6).toString("hex");

function balanceOf(sphere: Sphere, coinId: string): bigint {
  return sphere.payments.tokens({ coinId }).reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

/**
 * Drains `p`'s mailbox until its `coinId` balance satisfies `ok`. `resume` is the sender of a possibly-committed
 * op: its resumeNow() (the SDK retry verb, same transferId) is driven while waiting.
 */
async function waitForBalance(p: Party, coinId: string, what: string, ok: (b: bigint) => boolean, resume?: Party): Promise<bigint> {
  return pollUntil(
    what,
    async () => {
      if (resume) await resume.sphere.payments.resumeNow().catch(() => undefined);
      await p.sphere.payments.receive().catch(() => undefined);
      const b = balanceOf(p.sphere, coinId);
      return ok(b) ? b : null;
    },
    { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 5_000 },
  );
}

/** One mint() call; a journaled failure converges via resumeNow(), never via a second mint(). */
async function mintOnce(p: Party, coinId: string, amount: bigint): Promise<void> {
  const before = balanceOf(p.sphere, coinId);
  const res = await p.sphere.payments.mint(coinId, amount);
  if (!res.success) {
    if (MINT_PRE_JOURNAL_REFUSAL.test(res.error ?? "")) throw new Error(`mint refused: ${res.error}`);
    console.log(`[e2e] ${p.label}: mint not admitted directly (${res.error}); converging via journal replay`);
  }
  await pollUntil(
    `${p.label} mint of ${amount} to land`,
    async () => {
      if (!res.success) await p.sphere.payments.resumeNow().catch(() => undefined);
      return balanceOf(p.sphere, coinId) >= before + amount;
    },
    { timeoutMs: MINT_TIMEOUT_MS, intervalMs: 10_000 },
  );
}

/** Runs a money op once; true when it is possibly committed and must converge (it is never re-issued). */
async function moneyOpOnce(label: string, op: () => Promise<unknown>): Promise<boolean> {
  try {
    await op();
    return false;
  } catch (err) {
    if (!isPossiblyCommittedSendOutcome(err)) throw err;
    console.log(`[e2e] ${label} possibly committed (${String(err)}); waiting for it to converge`);
    return true;
  }
}

describe("testnet2 wallets: DMs, mint, transfers, payment requests", () => {
  let alice: Party | undefined;
  let bob: Party | undefined;
  let uct: { coinId: string; decimals: number } | undefined;
  const incomingAtBob: IncomingTransfer[] = [];
  const requestsAtAlice: PaymentRequestView[] = [];
  const offs: Array<() => void> = [];

  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`precondition failed: ${what} (see the earlier failure)`);
    return v;
  };

  async function party(label: string): Promise<Party> {
    const dir = tempDir(label);
    const nametag = randomNametag(`e2e${label[0]}`);
    try {
      const { sphere } = await openTestWallet({ label, dataDir: dir, nametag, payments: true });
      const chainPubkey = sphere.identity!.chainPubkey;
      return { label, sphere, dir, nametag, chainPubkey, xOnly: toXOnly(chainPubkey)!, inbox: new DmInbox(sphere) };
    } catch (err) {
      removeDir(dir);
      throw err;
    }
  }

  beforeAll(async () => {
    alice = await party("alice");
    bob = await party("bob");
    offs.push(bob.sphere.on("transfer:incoming", (t) => incomingAtBob.push(t)));
    offs.push(alice.sphere.on("payment_request:incoming", (r) => requestsAtAlice.push(r)));
  }, 180_000);

  afterAll(async () => {
    for (const off of offs.splice(0)) off();
    alice?.inbox.close();
    bob?.inbox.close();
    await destroyAll([alice?.sphere, bob?.sphere]);
    TokenRegistry.destroy();
    removeDir(alice?.dir);
    removeDir(bob?.dir);
  }, 60_000);

  it("both wallets are composed with payments and own their nametags", () => {
    const a = need(alice, "alice wallet");
    const b = need(bob, "bob wallet");
    for (const p of [a, b]) {
      expect(p.sphere.hasPayments).toBe(true);
      expect(p.sphere.identity?.nametag).toBe(p.nametag);
      expect(p.sphere.hasNametag()).toBe(true);
      expect(p.sphere.identity?.directAddress?.startsWith("DIRECT://")).toBe(true);
    }
  });

  it("delivers a DM by @nametag with the sender's authenticated x-only key", async () => {
    const a = need(alice, "alice wallet");
    const b = need(bob, "bob wallet");
    const text = `A->B by nametag ${nonce()}`;
    await a.sphere.communications.sendDM(`@${b.nametag}`, text);

    const msg = await b.inbox.waitFor({ from: a.xOnly, content: text }, DM_TIMEOUT_MS, "Alice's DM at Bob");
    expect(toXOnly(msg.senderPubkey)).toBe(a.xOnly);
  }, DM_TIMEOUT_MS + 15_000);

  it("replies to the authenticated sender key (round trip by x-only pubkey)", async () => {
    const a = need(alice, "alice wallet");
    const b = need(bob, "bob wallet");
    const ping = `A->B ping ${nonce()}`;
    await a.sphere.communications.sendDM(b.xOnly, ping);
    const got = await b.inbox.waitFor({ from: a.xOnly, content: ping }, DM_TIMEOUT_MS, "ping at Bob");

    const pong = `B->A pong ${nonce()}`;
    await b.sphere.communications.sendDM(toXOnly(got.senderPubkey)!, pong);
    // Alice's own ping is replayed into her subscription too; the inbox drops own messages and matches content.
    const back = await a.inbox.waitFor({ from: b.xOnly, content: pong }, DM_TIMEOUT_MS, "pong at Alice");
    expect(back.content).toBe(pong);
  }, 2 * DM_TIMEOUT_MS + 15_000);

  it("self-mints UCT on testnet2 (no faucet)", async () => {
    const a = need(alice, "alice wallet");
    expect(await TokenRegistry.waitForReady(30_000)).toBe(true);
    const coinId = getCoinIdBySymbol("UCT");
    expect(coinId, "UCT in the testnet2 registry").toMatch(/^[0-9a-f]{64}$/);
    uct = { coinId: coinId!, decimals: getTokenDecimals(coinId!) };

    const amount = parseTokenAmount("10", uct.decimals);
    await mintOnce(a, uct.coinId, amount);
    expect(balanceOf(a.sphere, uct.coinId)).toBe(amount);
    const [asset] = await a.sphere.payments.assets(uct.coinId);
    expect(asset?.totalAmount).toBe(amount.toString());
  }, MINT_TIMEOUT_MS + 60_000);

  it("sends part of a token; the recipient receives it from the sender's chain key and change returns", async () => {
    const a = need(alice, "alice wallet");
    const b = need(bob, "bob wallet");
    const coin = need(uct, "minted UCT");
    const sent = parseTokenAmount("3", coin.decimals);
    const start = balanceOf(a.sphere, coin.coinId);

    const converging = await moneyOpOnce("send", () =>
      a.sphere.payments.send({ recipient: b.chainPubkey, amount: sent.toString(), coinId: coin.coinId, memo: `e2e ${nonce()}` }),
    );

    const atBob = await waitForBalance(
      b,
      coin.coinId,
      `Bob to hold ${toHumanReadable(sent, coin.decimals)} UCT`,
      (bal) => bal >= sent,
      converging ? a : undefined,
    );
    expect(atBob).toBe(sent);
    // The receive drain stores the token before it announces it, so the balance can lead the event briefly.
    const arrival = await pollUntil("transfer:incoming at Bob", () => incomingAtBob.find((t) => t.tokens.some((tok) => tok.coinId === coin.coinId)), {
      timeoutMs: 30_000,
      intervalMs: 500,
    });
    expect(toXOnly(arrival.senderPubkey)).toBe(a.xOnly);

    const change = await waitForBalance(a, coin.coinId, "Alice's change to land", (bal) => bal === start - sent, converging ? a : undefined);
    expect(change).toBe(start - sent);
  }, 2 * SETTLE_TIMEOUT_MS + 60_000);

  it("creates a payment request, lists it at the payer and settles it with pay()", async () => {
    const a = need(alice, "alice wallet");
    const b = need(bob, "bob wallet");
    const coin = need(uct, "minted UCT");
    const amount = parseTokenAmount("1", coin.decimals);
    const memo = `e2e invoice ${nonce()}`;
    const bobBefore = balanceOf(b.sphere, coin.coinId);

    const created = await b.sphere.payments.requests.create(a.chainPubkey, { coinId: coin.coinId, amount: amount.toString(), memo });
    expect(created.error).toBeUndefined();
    expect(created.success).toBe(true);
    const requestId = created.requestId!;
    expect(requestId).toBeTruthy();

    const view = await pollUntil(
      `request ${requestId} at Alice`,
      () => a.sphere.payments.requests.list().find((r) => r.id === requestId),
      { timeoutMs: REQUEST_ARRIVAL_TIMEOUT_MS, intervalMs: 3_000 },
    );
    expect(view.requestId).toBe(requestId);
    expect(view.status).toBe("pending");
    expect(toXOnly(view.senderPubkey)).toBe(b.xOnly);
    expect(view.coinId).toBe(coin.coinId);
    expect(view.amount).toBe(amount.toString());
    expect(view.message).toBe(memo);
    expect(requestsAtAlice.some((r) => r.id === requestId), "payment_request:incoming at Alice").toBe(true);

    const converging = await moneyOpOnce("pay", () => a.sphere.payments.requests.pay(requestId));

    await waitForBalance(b, coin.coinId, "Bob to receive the requested amount", (bal) => bal === bobBefore + amount, converging ? a : undefined);
    // A deferred 'paid' respond leaves the request 'settling' until a convergence pass retries it; resumeNow() runs one.
    const settled = await pollUntil(
      `request ${requestId} to be paid`,
      async () => {
        const view = a.sphere.payments.requests.list().find((r) => r.id === requestId);
        if (view?.status === "paid") return view;
        await a.sphere.payments.resumeNow().catch(() => undefined);
        return null;
      },
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 5_000 },
    );
    expect(settled.status).toBe("paid");
  }, REQUEST_ARRIVAL_TIMEOUT_MS + 2 * SETTLE_TIMEOUT_MS + 60_000);
});
