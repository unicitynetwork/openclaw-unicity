import { describe, it, expect, vi, beforeEach } from "vitest";
import { NAMED_KEY, UCT, USDCE, binding, ledgerEntries, makePayments, makeSphere, memFiles, pendingRow, registry, resetRegistry, resetStorage, sdkError, storageControl, text, wallet, type FakePayments, MEM_LEDGER_PATH } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/sphere.js", async () => {
  const f = await import("./payments-fixtures.js");
  return { getSphereOrNull: () => f.wallet.sphere };
});

const { sendTokensTool } = await import("../../src/tools/send-tokens.js");
const sdk = await vi.importActual<typeof import("@unicitylabs/sphere-sdk")>("@unicitylabs/sphere-sdk");

const ONE_AND_HALF_UCT = "1500000000000000000";
const MINUTE = 60_000;
let payments: FakePayments;
let sphere: ReturnType<typeof makeSphere>;

function send(params: Record<string, unknown>, signal?: AbortSignal) {
  return sendTokensTool.execute("call", { recipient: "@alice", amount: "1.5", coin: "UCT", ...params }, signal);
}

/** Moves every ledger entry `ms` into the past. */
function ageLedger(ms: number): void {
  const entries = ledgerEntries().map((e) => ({ ...e, at: e.at - ms }));
  memFiles.set(MEM_LEDGER_PATH, JSON.stringify(entries));
}

beforeEach(() => {
  resetRegistry();
  resetStorage();
  payments = makePayments();
  payments.send.mockResolvedValue({ id: "tx-1", status: "delivered", tokens: [], tokenTransfers: [], deliveryPending: false });
  sphere = makeSphere(payments);
  wallet.sphere = sphere;
});

describe("unicity_send_tokens metadata", () => {
  it("is a sequential, owner-only money tool with a string amount", () => {
    expect(sendTokensTool.name).toBe("unicity_send_tokens");
    expect(sendTokensTool.executionMode).toBe("sequential");
    expect(sendTokensTool.description).toContain("Owner only (enforced by the plugin)");
    expect(sendTokensTool.description).not.toMatch(/IsOwner|PROXY/);
    expect(sendTokensTool.description).toContain("still settling");
    expect(sendTokensTool.description).toContain("paying a payment request counts as a payment to its requester");
    const props = (sendTokensTool.parameters as { properties: Record<string, { type: string }> }).properties;
    expect(props.amount.type).toBe("string");
    expect(props.allowDuplicate.type).toBe("boolean");
  });
});

describe("unicity_send_tokens", () => {
  it("sends registry hex coin id and exact base units, records the intent as done", async () => {
    const result = await send({ memo: "coffee" });

    expect(payments.send).toHaveBeenCalledWith({ recipient: "@alice", amount: ONE_AND_HALF_UCT, coinId: UCT, memo: "coffee" });
    expect(text(result)).toContain("Sent 1.5 UCT to @alice. Transfer tx-1 (status: delivered).");
    expect(result.details).toMatchObject({ outcome: "sent", transferId: "tx-1", amount: ONE_AND_HALF_UCT });
    expect(result.details).not.toHaveProperty("status");
    expect(ledgerEntries()).toEqual([expect.objectContaining({ op: "send", state: "done", transferId: "tx-1" })]);
  });

  it("maps USDC to USDC.e with its own decimals", async () => {
    await send({ coin: "USDC", amount: "2.5" });
    expect(payments.send).toHaveBeenCalledWith(expect.objectContaining({ coinId: USDCE, amount: "2500000" }));
  });

  it("reports a certified send whose delivery is still pending as sent", async () => {
    payments.send.mockResolvedValue({ id: "tx-2", status: "confirmed", tokens: [], tokenTransfers: [], deliveryPending: true });
    const result = await send({});
    expect(text(result)).toContain("delivery to the recipient is still pending");
    expect(result.details).toMatchObject({ outcome: "sent", deliveryPending: true });
  });

  it("never hands the abort signal to the SDK and finishes a send that started", async () => {
    const controller = new AbortController();
    payments.send.mockImplementation(async () => {
      controller.abort();
      return { id: "tx-3", status: "delivered", tokens: [], tokenTransfers: [] };
    });
    const result = await send({}, controller.signal);
    expect(payments.send.mock.calls[0]).toHaveLength(1);
    expect(result.details).toMatchObject({ outcome: "sent", transferId: "tx-3" });
  });

  it("does not start when the call was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await send({}, controller.signal);
    expect(result.details).toMatchObject({ status: "error", code: "aborted" });
    expect(payments.send).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
  });

  describe("validation before anything is sent", () => {
    it.each([
      [{ recipient: "not valid!" }, "invalid_recipient"],
      [{ recipient: "PROXY://abc" }, "invalid_recipient"],
      [{ amount: 1.5 }, "invalid_amount"],
      [{ amount: "1e3" }, "invalid_amount"],
      [{ amount: "0" }, "invalid_amount"],
      [{ amount: "-1" }, "invalid_amount"],
      [{ amount: "1.0000000000000000001" }, "invalid_amount"],
      [{ coin: "SNAKE", amount: "1.5" }, "invalid_amount"],
      [{ coin: "FAKE" }, "unknown_coin"],
    ])("%j -> %s", async (params, code) => {
      const result = await send(params);
      expect(result.details).toMatchObject({ status: "error", code });
      expect(payments.send).not.toHaveBeenCalled();
      expect(ledgerEntries()).toEqual([]);
    });

    it("lists the available coins for an unknown coin", async () => {
      expect(text(await send({ coin: "FAKE" }))).toContain("Available coins: UCT, USDU, BTC, SNAKE, USDC.e");
    });

    it("refuses while the token registry is not loaded", async () => {
      registry.ready = false;
      expect((await send({})).details).toMatchObject({ code: "registry_not_ready" });
      expect(payments.send).not.toHaveBeenCalled();
    });

    it("explains a wallet that is not open, starting, or messaging-only", async () => {
      wallet.sphere = null;
      expect((await send({})).details).toMatchObject({ code: "wallet_not_ready" });
      wallet.sphere = makeSphere(payments, { paymentsError: sdkError("NOT_INITIALIZED") });
      expect((await send({})).details).toMatchObject({ code: "wallet_not_ready" });
      wallet.sphere = makeSphere(payments, { hasPayments: false });
      expect((await send({})).details).toMatchObject({ code: "payments_unavailable" });
      expect(payments.send).not.toHaveBeenCalled();
    });

    it("does not send when the intent cannot be recorded", async () => {
      storageControl.failWrites = true;
      expect((await send({})).details).toMatchObject({ code: "ledger_unavailable" });
      expect(payments.send).not.toHaveBeenCalled();
    });

    it("does not send when the ledger cannot be read, so an earlier possibly-committed record is never bypassed", async () => {
      storageControl.failReads = "EIO";
      expect((await send({})).details).toMatchObject({ status: "error", code: "ledger_unavailable" });
      memFiles.set(MEM_LEDGER_PATH, "{corrupt");
      storageControl.failReads = null;
      expect((await send({})).details).toMatchObject({ code: "ledger_unavailable" });
      expect(memFiles.get(MEM_LEDGER_PATH)).toBe("{corrupt");
      expect(payments.send).not.toHaveBeenCalled();
    });
  });

  describe("possibly committed outcomes (do-not-retry results)", () => {
    it.each([
      ["SEND_SYNC_PENDING"],
      ["CERTIFICATION_UNCONFIRMED"],
      ["CHECKPOINT_PERSIST_FAILED"],
      ["SPLIT_CHECKPOINT_LOST"],
      ["CHECKPOINT_TRUSTBASE_MISMATCH"],
    ])("%s returns a non-error result telling the model not to retry", async (code) => {
      payments.send.mockRejectedValue(sdkError(code, "not yet certified", { transferId: "tx-9" }));
      payments.pendingTransfers.mockResolvedValue([
        { transferId: "tx-9", kind: "open", recipient: "02aa", coinId: UCT, amount: ONE_AND_HALF_UCT, legs: { certified: 1, total: 1 }, deliveryPending: true, createdAt: 1 },
      ]);
      const result = await send({});
      expect(text(result)).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
      expect(text(result)).toContain("Transfer tx-9");
      expect(text(result)).toContain("Transfers still settling:\n- tx-9: 1.5 UCT to 02aa");
      // A SENT row missing from the history later is never offered as the sign that it failed.
      expect(text(result)).not.toMatch(/check unicity_get_transaction_history later/);
      expect(text(result)).toContain("a missing SENT row in unicity_get_transaction_history later does NOT show that it failed");
      expect(result.details).toMatchObject({ outcome: "possibly_committed", transferId: "tx-9", code });
      expect(result.details).not.toHaveProperty("status");
      expect(result.details).not.toHaveProperty("error");
      expect(ledgerEntries()[0]).toMatchObject({ state: "possibly_committed", transferId: "tx-9" });
    });

    it("recognises the SDK's own PartialSendConflictError and reports the remainder", async () => {
      payments.send.mockRejectedValue(new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "500000000000000000"));
      const result = await send({});
      expect(text(result)).toContain("PAYMENT PARTIALLY SENT — DO NOT RETRY THE FULL AMOUNT");
      expect(text(result)).toContain("0.5 UCT could not be sent");
      expect(result.details).toMatchObject({
        outcome: "possibly_committed",
        transferId: "tx-p",
        remainingAmount: "500000000000000000",
        remainderOutcome: "not_sent",
      });
    });

    it.each([
      ["no cause (re-plan budget exhausted)", undefined],
      ["a pre-spend cause", new sdk.SphereError("short", "SEND_INSUFFICIENT_BALANCE")],
    ])("says the remainder was not sent only when it provably was not: %s", async (_label, cause) => {
      payments.send.mockRejectedValueOnce(new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "500000000000000000", cause));
      const result = await send({});
      expect(text(result)).toContain("0.5 UCT could not be sent");
      expect(result.details).toMatchObject({ remainderOutcome: "not_sent" });
      // The remainder was never sent, so a new payment of it is not a duplicate.
      expect((await send({ amount: "0.5" })).details).toMatchObject({ outcome: "sent" });
    });

    it.each([
      ["SEND_SYNC_PENDING", Object.assign(new sdk.SphereError("committed", "SEND_SYNC_PENDING"), { transferId: "tx-r" })],
      ["CERTIFICATION_UNCONFIRMED", Object.assign(new sdk.SphereError("keep open", "CERTIFICATION_UNCONFIRMED"), { transferId: "tx-r" })],
      ["NOT_FOUND", Object.assign(new Error("intent not found"), { code: "NOT_FOUND" })],
    ])("never calls a remainder unsent when its own attempt may have committed (%s)", async (causeCode, cause) => {
      const older = pendingRow("tx-older", { kind: "shortfall", createdAt: Date.now() - 5 * MINUTE });
      payments.pendingTransfers.mockResolvedValue([older]);
      payments.send.mockImplementationOnce(async () => {
        payments.pendingTransfers.mockResolvedValue([
          pendingRow("tx-r", { amount: "500000000000000000", legs: { certified: 0, total: 1 } }),
          older,
          pendingRow("tx-p", { kind: "shortfall", amount: "500000000000000000", deliveryPending: false, createdAt: Date.now() }),
        ]);
        throw new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "500000000000000000", cause);
      });
      const result = await send({});
      const out = text(result);
      expect(out).toContain("PAYMENT PARTIALLY SENT — DO NOT RETRY");
      expect(out).toContain(`outcome is UNKNOWN (${causeCode}`);
      expect(out).not.toMatch(/could not be sent|could NOT be sent|send the remainder as a new payment|owed/);
      expect(out).toMatch(/Transfers still settling:\n- tx-r: 0\.5 UCT [^\n]*\n\n/);
      expect(out).toMatch(/- tx-p: 0\.5 UCT .*\(remainder attempted again, outcome unknown\)/);
      expect(out).toMatch(/- tx-older: .*\(may have been paid separately since\)/);
      expect(result.details).toMatchObject({
        outcome: "possibly_committed",
        transferId: "tx-p",
        remainingAmount: "500000000000000000",
        remainderOutcome: "unknown",
        causeCode,
      });
      expect(result.details).not.toHaveProperty("status");
      // A missing history row is never offered as the check that clears a re-send of the remainder.
      expect(out).not.toMatch(/history shows it never left/);
      expect(out).toContain("their absence does NOT show that nothing went out");
      expect(out).toContain("Only the recipient can confirm what arrived");

      // A re-send of just the remainder, under any spelling of the payee, is refused like the payment itself.
      const remainder = await send({ recipient: `02${NAMED_KEY}`, amount: "0.5" });
      expect(remainder.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "possibly_committed" } });
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("labels only the newest of the call's shortfalls as the unsent remainder", async () => {
      // One send, two partials: 1 UCT delivered (shortfall 0.5), then 0.3 delivered (shortfall 0.2), then the budget ran out.
      payments.send.mockImplementationOnce(async () => {
        payments.pendingTransfers.mockResolvedValue([
          pendingRow("tx-p", { kind: "shortfall", amount: "500000000000000000", deliveryPending: false, createdAt: Date.now() - 1000 }),
          pendingRow("tx-q", { kind: "shortfall", amount: "200000000000000000", deliveryPending: false, createdAt: Date.now() }),
        ]);
        throw new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "200000000000000000");
      });
      const out = text(await send({}));
      expect(out).toContain("0.2 UCT could not be sent");
      expect(out).toMatch(/- tx-q: 0\.2 UCT .*\(this payment's unsent remainder\)/);
      expect(out).toMatch(/- tx-p: 0\.5 UCT .*\(superseded by a later attempt of this payment\)/);
      expect(out).not.toMatch(/owed|Transfers still settling/);
    });

    it("does not present an earlier partial send's shortfall as owed or settling after the remainder was paid", async () => {
      // An earlier send left a shortfall row; the owner then paid that remainder separately, which never clears the row.
      const earlier = pendingRow("tx-old", { kind: "shortfall", amount: "500000000000000000", deliveryPending: false, createdAt: Date.now() - 10 * MINUTE });
      payments.pendingTransfers.mockResolvedValue([earlier]);
      payments.send.mockImplementationOnce(async () => {
        payments.pendingTransfers.mockResolvedValue([pendingRow("tx-9"), earlier]);
        throw sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-9" });
      });
      const out = text(await send({ recipient: "@bob", amount: "2" }));
      expect(out).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
      expect(out).toMatch(/Transfers still settling:\n- tx-9: [^\n]*\n\nPartial sends the wallet still lists/);
      expect(out).toMatch(/- tx-old: 0\.5 UCT .*\(may have been paid separately since\)/);
      expect(out).not.toMatch(/owed/);
    });

    it("never throws when the remainder cannot be recorded", async () => {
      payments.send.mockImplementationOnce(async () => {
        storageControl.failWrites = true;
        throw new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "5", new sdk.SphereError("x", "SEND_SYNC_PENDING"));
      });
      expect((await send({})).details).toMatchObject({ outcome: "possibly_committed", remainderOutcome: "unknown" });
    });

    it("recognises a root SphereError with a possibly-committed code", async () => {
      const err = new sdk.SphereError("keep open", "CERTIFICATION_UNCONFIRMED");
      err.transferId = "tx-s";
      payments.send.mockRejectedValue(err);
      expect((await send({})).details).toMatchObject({ outcome: "possibly_committed", transferId: "tx-s" });
    });

    it("treats an uncoded error as an unknown outcome, not a retryable failure", async () => {
      payments.send.mockRejectedValue(new TypeError("socket hang up"));
      const result = await send({});
      expect(result.details).toMatchObject({ outcome: "possibly_committed", code: "UNKNOWN" });
      expect(text(result)).toContain("DO NOT RETRY");
    });

    it("treats a wallet-api error after a new pending transfer appeared as possibly committed and refuses the retry", async () => {
      // sdk 0.18.1: a non-422 intent PUT failure resumes the transfer in-process (certify, deliver, apply), then
      // completing the intent the server never stored throws a bare NOT_FOUND and the backstop row stays open.
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-older")]);
      payments.send.mockImplementationOnce(async () => {
        payments.pendingTransfers.mockResolvedValue([pendingRow("tx-older"), pendingRow("tx-new", { createdAt: 0 })]);
        throw Object.assign(new Error("intent not found"), { name: "WalletApiHttpError", status: 404, code: "NOT_FOUND" });
      });
      const result = await send({});
      expect(text(result)).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
      expect(text(result)).not.toContain("NOT sent");
      expect(result.details).toMatchObject({ outcome: "possibly_committed", code: "NOT_FOUND" });
      expect(result.details).not.toHaveProperty("status");
      expect(ledgerEntries()[0]).toMatchObject({ state: "possibly_committed" });

      const retry = await send({});
      expect(retry.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "possibly_committed" } });
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("does not trust a pre-spend code when a new pending transfer appeared", async () => {
      payments.send.mockImplementationOnce(async () => {
        payments.pendingTransfers.mockResolvedValue([pendingRow("tx-new")]);
        throw sdkError("SEND_INSUFFICIENT_BALANCE");
      });
      expect((await send({})).details).toMatchObject({ outcome: "possibly_committed", code: "SEND_INSUFFICIENT_BALANCE" });
    });

    it("does not trust a pre-spend code when pending transfers could not be read before the send", async () => {
      payments.pendingTransfers.mockRejectedValueOnce(new Error("kv down"));
      payments.send.mockRejectedValueOnce(sdkError("SEND_INSUFFICIENT_BALANCE"));
      expect((await send({})).details).toMatchObject({ outcome: "possibly_committed" });
    });

    it.each(["TRANSPORT_ERROR", "VALIDATION_ERROR", "TRANSFER_CONFLICT", "AGGREGATOR_ERROR", "ENOSPC"])(
      "%s is never reported as a payment that was not sent",
      async (code) => {
        payments.send.mockRejectedValueOnce(sdkError(code));
        const result = await send({});
        expect(result.details).toMatchObject({ outcome: "possibly_committed", code });
        expect(text(result)).not.toMatch(/safe to try again|NOT sent/);
      },
    );

    it("blocks a retry of a possibly-committed payment", async () => {
      payments.send.mockRejectedValueOnce(sdkError("SEND_SYNC_PENDING", "pending", { transferId: "tx-9" }));
      await send({});
      const retry = await send({});
      expect(retry.details).toMatchObject({ status: "error", code: "duplicate" });
      expect(text(retry)).toContain("may have gone through");
      expect(text(retry)).toContain("tx-9");
      expect(payments.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("clean failures", () => {
    it("reports insufficient balance as a failure that moved nothing and allows a retry", async () => {
      payments.send.mockRejectedValueOnce(sdkError("SEND_INSUFFICIENT_BALANCE", "not enough"));
      const result = await send({});
      expect(text(result)).toBe("Payment NOT sent: insufficient UCT balance. Nothing left the wallet.");
      expect(result.details).toMatchObject({ status: "error", code: "SEND_INSUFFICIENT_BALANCE" });
      expect(ledgerEntries()[0].state).toBe("failed");

      expect((await send({})).details).toMatchObject({ outcome: "sent" });
      expect(payments.send).toHaveBeenCalledTimes(2);
    });

    it("explains that a claimed coin received by this wallet cannot be spent", async () => {
      payments.send.mockRejectedValueOnce(sdkError("SEND_INSUFFICIENT_BALANCE"));
      expect(text(await send({ coin: "USDC.e", amount: "1" }))).toContain("pending verification and cannot be spent");
    });

    it.each([
      ["INVALID_RECIPIENT", "could not be resolved"],
      ["SEND_QUEUE_FULL", "SEND_QUEUE_FULL: Send queue is full"],
      ["SEND_QUEUE_TIMEOUT", "SEND_QUEUE_TIMEOUT: Send queue timeout"],
    ])("%s", async (code, message) => {
      payments.send.mockRejectedValueOnce(sdkError(code, message.split(": ")[1]));
      const result = await send({});
      expect(text(result)).toContain(message);
      expect(result.details).toMatchObject({ status: "error", code });
      expect(ledgerEntries()[0].state).toBe("failed");
    });

    it("is not confused by transfers that were already pending before the send", async () => {
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-older")]);
      payments.send.mockRejectedValueOnce(sdkError("SEND_INSUFFICIENT_BALANCE"));
      expect((await send({})).details).toMatchObject({ status: "error", code: "SEND_INSUFFICIENT_BALANCE" });
    });
  });

  describe("duplicate guard", () => {
    it("refuses an identical payment within 15 minutes, also when written differently", async () => {
      await send({});
      const again = await send({ recipient: "ALICE", amount: "1.50" });
      expect(again.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "done", transferId: "tx-1" } });
      expect(text(again)).toContain("allowDuplicate: true");
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("lets only one of two identical concurrent calls send", async () => {
      let release: (v: unknown) => void = () => undefined;
      payments.send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const results = Promise.all([send({}), send({})]);
      await vi.waitFor(() => expect(payments.send).toHaveBeenCalledTimes(1));
      release({ id: "tx-1", status: "delivered", tokens: [], tokenTransfers: [] });
      const [first, second] = await results;
      expect(first.details).toMatchObject({ outcome: "sent" });
      expect(second.details).toMatchObject({ code: "duplicate", previous: { state: "intent" } });
      expect(text(second)).toContain("started (outcome unknown)");
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("sends a confirmed second identical payment with allowDuplicate", async () => {
      await send({});
      expect((await send({ allowDuplicate: true })).details).toMatchObject({ outcome: "sent" });
      expect(payments.send).toHaveBeenCalledTimes(2);
    });

    it("does not treat a different amount, coin or recipient as a duplicate", async () => {
      sphere.resolve.mockImplementation(async (id: string) => binding(id === "@bob" ? "bb".repeat(32) : NAMED_KEY));
      await send({});
      await send({ amount: "2" });
      await send({ coin: "BTC" });
      await send({ recipient: "@bob" });
      expect(payments.send).toHaveBeenCalledTimes(4);
    });

    it.each([
      ["66-hex chain key", `02${NAMED_KEY}`],
      ["64-hex x-only key", NAMED_KEY],
      ["upper-case chain key", `02${NAMED_KEY.toUpperCase()}`],
      ["DIRECT:// address", `DIRECT://${"0a".repeat(20)}`],
    ])("refuses a retry that names the same payee by its %s", async (_label, other) => {
      payments.send.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-9" }));
      await send({});
      const retry = await send({ recipient: other });
      expect(retry.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "possibly_committed" } });
      expect(payments.send).toHaveBeenCalledTimes(1);
      expect(payments.send.mock.calls[0][0]).toMatchObject({ recipient: "@alice" });
    });

    it.each([
      ["fails", () => sphere.resolve.mockRejectedValue(new Error("relay down"))],
      ["finds nothing", () => sphere.resolve.mockResolvedValue(null)],
    ])("refuses a send whose payee lookup %s, so an earlier send under another spelling is never missed", async (_label, breakLookup) => {
      payments.send.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-9" }));
      await send({ recipient: `02${NAMED_KEY}` });
      breakLookup();
      const retry = await send({ recipient: "@alice" });
      expect(retry.details).toMatchObject({ status: "error", code: "payee_lookup_failed" });
      expect(text(retry)).toContain("Payment NOT sent: could not look up @alice");
      expect(text(retry)).toContain("Nothing left the wallet");
      expect(text(retry)).not.toContain("allowDuplicate");
      expect(payments.send).toHaveBeenCalledTimes(1);
      expect(ledgerEntries()).toHaveLength(1);

      // The owner's explicit confirmation of a second identical payment still overrides the guard.
      expect((await send({ recipient: "@alice", allowDuplicate: true })).details).toMatchObject({ outcome: "sent" });
      expect(ledgerEntries()[1]).toMatchObject({ key: `alice|${UCT}|${ONE_AND_HALF_UCT}` });
    });

    it("needs no lookup for a 66-hex chain key", async () => {
      sphere.resolve.mockRejectedValue(new Error("relay down"));
      expect((await send({ recipient: `02${NAMED_KEY}` })).details).toMatchObject({ outcome: "sent" });
      expect(sphere.resolve).not.toHaveBeenCalled();
    });

    it("sends to the recipient as typed, not to the key it resolved to", async () => {
      await send({ recipient: "@alice" });
      expect(payments.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: "@alice" }));
      expect(ledgerEntries()[0]).toMatchObject({ key: `${NAMED_KEY}|${UCT}|${ONE_AND_HALF_UCT}`, aliases: [`alice|${UCT}|${ONE_AND_HALF_UCT}`] });
    });
  });

  describe("duplicate guard while an earlier payment is still settling", () => {
    async function possiblyCommitted(transferId?: string): Promise<void> {
      payments.send.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", transferId ? { transferId } : {}));
      expect((await send({})).details).toMatchObject({ outcome: "possibly_committed" });
    }

    it("refuses an identical payment after 15 minutes while its transfer is still pending", async () => {
      await possiblyCommitted("tx-9");
      ageLedger(20 * MINUTE);
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-9")]);
      const retry = await send({});
      expect(retry.details).toMatchObject({ status: "error", code: "duplicate", previous: { transferId: "tx-9", settling: true } });
      expect(text(retry)).toContain("transfer tx-9 is still settling and will complete automatically");

      payments.pendingTransfers.mockResolvedValue([]);
      expect((await send({})).details).toMatchObject({ outcome: "sent" });
      expect(payments.send).toHaveBeenCalledTimes(2);
    });

    it("refuses while pending transfers cannot be read", async () => {
      await possiblyCommitted("tx-9");
      ageLedger(20 * MINUTE);
      payments.pendingTransfers.mockRejectedValue(new Error("kv down"));
      expect((await send({})).details).toMatchObject({ code: "duplicate" });
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("refuses an unresolved payment with no transfer id for 24 hours", async () => {
      await possiblyCommitted();
      ageLedger(60 * MINUTE);
      expect((await send({})).details).toMatchObject({ code: "duplicate" });
      ageLedger(24 * 60 * MINUTE);
      expect((await send({})).details).toMatchObject({ outcome: "sent" });
    });

    it("refuses a completed payment whose delivery is still pending", async () => {
      payments.send.mockResolvedValueOnce({ id: "tx-d", status: "confirmed", tokens: [], tokenTransfers: [], deliveryPending: true });
      await send({});
      ageLedger(20 * MINUTE);
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-d", { kind: "open" })]);
      expect((await send({})).details).toMatchObject({ code: "duplicate", previous: { state: "done", settling: true } });
    });

    it.each([
      ["fails", () => payments.pendingTransfers.mockRejectedValue(new Error("kv down"))],
      ["hangs past 3 seconds", () => payments.pendingTransfers.mockReturnValue(new Promise(() => undefined))],
    ])("refuses a completed payment whose delivery was pending while the pending-transfer read %s", async (_label, breakRead) => {
      payments.send.mockResolvedValueOnce({ id: "tx-d", status: "confirmed", tokens: [], tokenTransfers: [], deliveryPending: true });
      await send({});
      expect(ledgerEntries()[0]).toMatchObject({ state: "done", transferId: "tx-d", deliveryPending: true });
      ageLedger(20 * MINUTE);
      breakRead();
      vi.useFakeTimers();
      try {
        const pending = send({});
        await vi.advanceTimersByTimeAsync(3_000);
        const retry = await pending;
        expect(retry.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "done", transferId: "tx-d" } });
        expect(text(retry)).toContain("its delivery to the recipient was still pending, and the wallet's pending transfers could not be read");
      } finally {
        vi.useRealTimers();
      }
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("lets a completed, delivered payment be repeated after 15 minutes even while pending transfers cannot be read", async () => {
      await send({});
      ageLedger(20 * MINUTE);
      payments.pendingTransfers.mockRejectedValue(new Error("kv down"));
      expect((await send({})).details).toMatchObject({ outcome: "sent" });
    });

    it("names a transfer to the same payee that is still settling when it refuses", async () => {
      await possiblyCommitted();
      ageLedger(60 * MINUTE);
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-z", { recipient: `03${NAMED_KEY}` }), pendingRow("tx-y", { recipient: `02${"cd".repeat(32)}` })]);
      const retry = await send({});
      expect(retry.details).toMatchObject({ code: "duplicate", settlingToRecipient: ["tx-z"] });
      expect(text(retry)).toContain("Transfer tx-z to the same recipient is still settling (a payment in progress).");
    });

    it("refuses the full amount again after a partial send without claiming the rest will arrive", async () => {
      // sdk 0.18.1 never removes a partial's shortfall row, so its transfer stays listed as pending.
      payments.send.mockImplementationOnce(async () => {
        payments.pendingTransfers.mockResolvedValue([pendingRow("tx-p", { kind: "shortfall", deliveryPending: false })]);
        throw new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "500000000000000000");
      });
      expect((await send({})).details).toMatchObject({ remainderOutcome: "not_sent" });
      ageLedger(20 * MINUTE);
      const retry = await send({});
      expect(retry.details).toMatchObject({ code: "duplicate", previous: { transferId: "tx-p", settling: true } });
      expect(text(retry)).toContain("transfer tx-p was only partly delivered; the delivered part is final");
      expect(text(retry)).not.toContain("complete automatically");
      expect(payments.send).toHaveBeenCalledTimes(1);
    });

    it("still sends with allowDuplicate", async () => {
      await possiblyCommitted("tx-9");
      ageLedger(20 * MINUTE);
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-9")]);
      expect((await send({ allowDuplicate: true })).details).toMatchObject({ outcome: "sent" });
    });
  });
});
