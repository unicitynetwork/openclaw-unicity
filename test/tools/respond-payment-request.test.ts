import { describe, it, expect, vi, beforeEach } from "vitest";
import { NAMED_KEY, UCT, binding, ledgerEntries, makePayments, makeSphere, memFiles, pendingRow, resetRegistry, resetStorage, sdkError, storageControl, text, wallet, type FakePayments, MEM_LEDGER_PATH } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/sphere.js", async () => (await import("./payments-fixtures.js")).sphereExports());

const { respondPaymentRequestTool } = await import("../../src/tools/respond-payment-request.js");
const { sendTokensTool } = await import("../../src/tools/send-tokens.js");
const sdk = await vi.importActual<typeof import("@unicitylabs/sphere-sdk")>("@unicitylabs/sphere-sdk");

const REQUEST_ID = "7f3c2a9e-1b4d-4c6e-9a8b-0d1e2f3a4b5c";
const SENDER = `02${"ab".repeat(32)}`;
let payments: FakePayments;
let request: Record<string, unknown>;

const respond = (params: Record<string, unknown>) =>
  respondPaymentRequestTool.execute("call", { requestId: REQUEST_ID, action: "pay", ...params });

/** Moves every ledger entry `ms` into the past. */
function ageLedger(ms: number): void {
  memFiles.set(MEM_LEDGER_PATH, JSON.stringify(ledgerEntries().map((e) => ({ ...e, at: e.at - ms }))));
}

beforeEach(() => {
  resetRegistry();
  resetStorage();
  payments = makePayments();
  request = {
    id: REQUEST_ID,
    requestId: REQUEST_ID,
    senderPubkey: SENDER,
    senderNametag: "trusted-vendor",
    amount: "2000000000000000000",
    coinId: UCT,
    message: "invoice 42",
    timestamp: 1_700_000_000_000,
    status: "pending",
  };
  payments.requests.list.mockImplementation(() => [request]);
  payments.requests.pay.mockResolvedValue({ id: "tx-pay", status: "delivered", tokens: [], tokenTransfers: [] });
  wallet.sphere = makeSphere(payments);
});

describe("unicity_respond_payment_request metadata", () => {
  it("offers pay and decline (reject alias), no accept and no memo", () => {
    expect(respondPaymentRequestTool.executionMode).toBe("sequential");
    expect(respondPaymentRequestTool.description).toContain("Owner only (enforced by the plugin)");
    expect(respondPaymentRequestTool.description).not.toContain("IsOwner");
    const schema = respondPaymentRequestTool.parameters as { properties: Record<string, { anyOf?: Array<{ const: string }> }> };
    expect(schema.properties.action.anyOf?.map((s) => s.const)).toEqual(["pay", "decline", "reject"]);
    expect(schema.properties).not.toHaveProperty("memo");
  });

  it("tells the agent that paying a request is a send to the requester, guarded like one", () => {
    expect(respondPaymentRequestTool.description).toContain("Paying a request is a send of its amount to the requester");
    expect(respondPaymentRequestTool.description).toContain(
      "never pay that request again and never send its amount to the requester with unicity_send_tokens",
    );
  });

  it("tells the agent to pay a requester named by the owner only when the listing shows that name as verified", () => {
    expect(respondPaymentRequestTool.description).toContain(
      "When the owner names a requester instead of giving a request id, pay only a pending request whose row in " +
        "unicity_list_payment_requests shows that name as verified; if none or several match, ask the owner for the request id",
    );
  });
});

describe("requester label", () => {
  /** Every nametag resolves to NAMED_KEY in the fake wallet: a request from that key claims its own name. */
  const NAMED_REQUESTER = `02${NAMED_KEY}`;
  const VERIFIED = `@trusted-vendor (verified, ${NAMED_REQUESTER})`;
  const sphere = () => wallet.sphere as ReturnType<typeof makeSphere>;

  beforeEach(() => {
    request.senderPubkey = NAMED_REQUESTER;
  });

  it("names a requester whose claim resolves to its key as verified when paying", async () => {
    expect(text(await respond({}))).toBe(`Paid request ${REQUEST_ID}: 2 UCT to ${VERIFIED}. Transfer tx-pay (status: delivered).`);
  });

  it("names it as verified when declining", async () => {
    expect(text(await respond({ action: "decline" }))).toBe(`Declined payment request ${REQUEST_ID} (2 UCT from ${VERIFIED}). This is final.`);
  });

  it("names it as verified when the payment may have gone through or was partly sent", async () => {
    payments.requests.pay.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-k" }));
    expect(text(await respond({}))).toContain(`Paying request ${REQUEST_ID} (2 UCT to ${VERIFIED}) did not finish cleanly`);
    payments.requests.pay.mockRejectedValueOnce(new sdk.PartialSendConflictError("partly sent", "tx-part", ["tok"], "400000000000000000"));
    expect(text(await respond({ allowDuplicate: true }))).toContain(`payment for request ${REQUEST_ID} to ${VERIFIED} was sent and is final`);
  });

  it("labels the claim unverified when the name resolves to another key or cannot be looked up", async () => {
    sphere().resolve.mockResolvedValue(binding("ef".repeat(32)));
    expect(text(await respond({ action: "decline" }))).toContain(`(2 UCT from ${NAMED_REQUESTER} (claims @trusted-vendor, unverified))`);
    wallet.sphere = makeSphere(payments);
    sphere().resolve.mockRejectedValue(new Error("relay down"));
    expect(text(await respond({}))).toContain(`2 UCT to ${NAMED_REQUESTER} (claims @trusted-vendor, unverified).`);
  });

  it("does not hold the payment up while a slow lookup runs, and then labels the claim unverified", async () => {
    vi.useFakeTimers();
    try {
      sphere().resolve.mockImplementation(() => new Promise(() => {}));
      const result = respond({});
      await vi.waitFor(() => expect(payments.requests.pay).toHaveBeenCalledWith(REQUEST_ID));
      // Well before the lookup times out, the payment is already recorded as done.
      await vi.waitFor(() => expect(ledgerEntries()).toEqual([expect.objectContaining({ op: "pay", state: "done", transferId: "tx-pay" })]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(text(await result)).toContain(`2 UCT to ${NAMED_REQUESTER} (claims @trusted-vendor, unverified).`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold a decline up while a slow lookup runs", async () => {
    vi.useFakeTimers();
    try {
      sphere().resolve.mockImplementation(() => new Promise(() => {}));
      const result = respond({ action: "decline" });
      await vi.waitFor(() => expect(payments.requests.decline).toHaveBeenCalledWith(REQUEST_ID));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(text(await result)).toBe(
        `Declined payment request ${REQUEST_ID} (2 UCT from ${NAMED_REQUESTER} (claims @trusted-vendor, unverified)). This is final.`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records every ledger entry of a partly sent payment before it waits for a slow lookup", async () => {
    vi.useFakeTimers();
    try {
      sphere().resolve.mockImplementation(() => new Promise(() => {}));
      const cause = Object.assign(new sdk.SphereError("committed", "SEND_SYNC_PENDING"), { transferId: "tx-r" });
      payments.requests.pay.mockRejectedValueOnce(new sdk.PartialSendConflictError("partly sent", "tx-part", ["tok"], "400000000000000000", cause));
      const result = respond({});
      // Well before the lookup times out, a send of the remainder is already guarded.
      await vi.waitFor(() =>
        expect(ledgerEntries()).toEqual([
          expect.objectContaining({ op: "pay", state: "possibly_committed", transferId: "tx-part" }),
          expect.objectContaining({ op: "send", state: "possibly_committed", transferId: "tx-r" }),
        ]),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(text(await result)).toContain(`to ${NAMED_REQUESTER} (claims @trusted-vendor, unverified) was sent and is final`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pay", () => {
  it("pays the request by its full id and labels the requester's claimed name as unverified", async () => {
    const result = await respond({});
    expect(payments.requests.pay).toHaveBeenCalledWith(REQUEST_ID);
    expect(text(result)).toBe(
      `Paid request ${REQUEST_ID}: 2 UCT to ${SENDER} (claims @trusted-vendor, unverified). Transfer tx-pay (status: delivered).`,
    );
    expect(result.details).toMatchObject({ outcome: "paid", requestId: REQUEST_ID, transferId: "tx-pay" });
    expect(ledgerEntries()[0]).toMatchObject({ op: "pay", key: REQUEST_ID, state: "done" });
  });

  it("does not resolve a truncated id", async () => {
    const result = await respond({ requestId: REQUEST_ID.slice(0, 12) });
    expect(result.details).toMatchObject({ status: "error", code: "request_not_found" });
    expect(payments.requests.pay).not.toHaveBeenCalled();
  });

  it("refuses requests that are not pending", async () => {
    request.status = "settling";
    const result = await respond({});
    expect(result.details).toMatchObject({ code: "request_not_pending", requestStatus: "settling" });
    expect(text(result)).toContain("do not pay it again");
    expect(payments.requests.pay).not.toHaveBeenCalled();
  });

  it("returns a do-not-retry result when the payment may have gone through, and blocks paying again", async () => {
    payments.requests.pay.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-k" }));
    const result = await respond({});
    expect(text(result)).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
    expect(result.details).toMatchObject({ outcome: "possibly_committed", requestId: REQUEST_ID, transferId: "tx-k" });
    expect(result.details).not.toHaveProperty("status");

    // The SDK may show the request as pending again after a restart; the ledger still refuses a second payment.
    const again = await respond({});
    expect(again.details).toMatchObject({ code: "duplicate" });
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("pays again only when the owner explicitly allows it", async () => {
    payments.requests.pay.mockRejectedValueOnce(new Error("unknown"));
    await respond({});
    expect((await respond({ allowDuplicate: true })).details).toMatchObject({ outcome: "paid" });
    expect(payments.requests.pay).toHaveBeenCalledTimes(2);
  });

  it("reports a clean failure and allows a later attempt", async () => {
    payments.requests.pay.mockRejectedValueOnce(sdkError("SEND_INSUFFICIENT_BALANCE", "not enough"));
    const result = await respond({});
    expect(result.details).toMatchObject({ status: "error", code: "SEND_INSUFFICIENT_BALANCE" });
    expect(text(result)).toContain("Nothing left the wallet");
    expect(ledgerEntries()[0].state).toBe("failed");
    expect((await respond({})).details).toMatchObject({ outcome: "paid" });
  });

  it("does not trust a pre-spend code when the SDK already holds the request as settling", async () => {
    // No new pending transfer, so isCleanMoneyFailure says clean and only the request's status decides.
    payments.requests.pay.mockImplementationOnce(async () => {
      request.status = "settling";
      throw sdkError("SEND_INSUFFICIENT_BALANCE", "not enough");
    });
    const result = await respond({});
    expect(text(result)).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
    expect(text(result)).not.toContain("Nothing left the wallet");
    expect(result.details).toMatchObject({ outcome: "possibly_committed", code: "SEND_INSUFFICIENT_BALANCE" });
    expect(ledgerEntries()[0].state).toBe("possibly_committed");

    request.status = "pending";
    expect((await respond({})).details).toMatchObject({ code: "duplicate" });
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("a non-pre-spend error from pay() is possibly committed even if the request reads as settling", async () => {
    payments.requests.pay.mockImplementationOnce(async () => {
      request.status = "settling";
      throw sdkError("STORAGE_ERROR", "kv write failed");
    });
    const result = await respond({});
    expect(text(result)).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
    expect(result.details).toMatchObject({ outcome: "possibly_committed", code: "STORAGE_ERROR" });
    expect(result.details).not.toHaveProperty("status");
    expect(ledgerEntries()[0].state).toBe("possibly_committed");

    // Even if a restart shows the request as pending again, the ledger refuses a second payment.
    request.status = "pending";
    expect((await respond({})).details).toMatchObject({ code: "duplicate" });
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("treats a wallet-api error after a new pending transfer appeared as possibly committed, although the SDK made the request payable again", async () => {
    // sdk 0.18.1: the send inside pay() resumed and delivered, then completing the never-stored intent threw NOT_FOUND;
    // pay() calls that a clean failure and reverts the request to pending.
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-new")]);
      throw Object.assign(new Error("intent not found"), { status: 404, code: "NOT_FOUND" });
    });
    const result = await respond({});
    expect(text(result)).toContain("PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY");
    expect(result.details).toMatchObject({ outcome: "possibly_committed", requestId: REQUEST_ID, code: "NOT_FOUND" });
    expect(result.details).not.toHaveProperty("status");
    expect(request.status).toBe("pending");
    expect(ledgerEntries()[0]).toMatchObject({ op: "pay", state: "possibly_committed" });

    const again = await respond({});
    expect(again.details).toMatchObject({ code: "duplicate", previous: { state: "possibly_committed" } });
    expect(text(again)).toContain("may list the request as pending again");
    expect(text(again)).toContain("unicity_get_transaction_history");
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("names the transfer to the requester that is still settling, and never offers an empty history as the check", async () => {
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-new", { recipient: SENDER.slice(2) })]);
      throw Object.assign(new Error("intent not found"), { code: "NOT_FOUND" });
    });
    await respond({});
    const again = await respond({});
    expect(again.details).toMatchObject({ code: "duplicate", settlingToRecipient: ["tx-new"] });
    expect(text(again)).toContain("Transfer tx-new to the same recipient is still settling (a payment in progress).");
    expect(text(again)).not.toMatch(/check unicity_get_transaction_history for this payment before/);
    expect(text(again)).toContain("only the requester can confirm what arrived");
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("records a paid request whose delivery is still pending", async () => {
    payments.requests.pay.mockResolvedValueOnce({ id: "tx-pay", status: "confirmed", tokens: [], tokenTransfers: [], deliveryPending: true });
    await respond({});
    expect(ledgerEntries()[0]).toMatchObject({ op: "pay", state: "done", transferId: "tx-pay", deliveryPending: true });
  });

  it("keeps refusing to pay again after an unresolved attempt however old it is (the request never expires)", async () => {
    payments.requests.pay.mockRejectedValueOnce(Object.assign(new Error("intent not found"), { code: "NOT_FOUND" }));
    await respond({});
    ageLedger(365 * 24 * 3600_000);
    expect((await respond({})).details).toMatchObject({ code: "duplicate", previous: { state: "possibly_committed" } });
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("lets a completed pay expire after 30 days", async () => {
    await respond({});
    ageLedger(31 * 24 * 3600_000);
    expect((await respond({})).details).toMatchObject({ outcome: "paid" });
  });

  it("does not trust a pre-spend code when a new pending transfer appeared during the pay", async () => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("tx-older")]);
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-older"), pendingRow("tx-new")]);
      throw sdkError("SEND_INSUFFICIENT_BALANCE");
    });
    const result = await respond({});
    expect(result.details).toMatchObject({ outcome: "possibly_committed", code: "SEND_INSUFFICIENT_BALANCE" });
    expect(request.status).toBe("pending");
    expect(ledgerEntries()[0].state).toBe("possibly_committed");
  });

  it("does not trust a pre-spend code when pending transfers could not be read before the pay", async () => {
    payments.pendingTransfers.mockRejectedValueOnce(new Error("kv down"));
    payments.requests.pay.mockRejectedValueOnce(sdkError("SEND_INSUFFICIENT_BALANCE"));
    expect((await respond({})).details).toMatchObject({ outcome: "possibly_committed" });
    expect(ledgerEntries()[0].state).toBe("possibly_committed");
  });

  it.each(["VALIDATION_ERROR", "TRANSFER_CONFLICT", "TRANSPORT_ERROR"])("%s from pay() is never reported as not sent", async (code) => {
    payments.requests.pay.mockRejectedValueOnce(sdkError(code));
    expect((await respond({})).details).toMatchObject({ outcome: "possibly_committed", code });
  });

  it.each([
    ["no cause (re-plan budget exhausted)", undefined],
    ["a pre-spend cause", new sdk.SphereError("short", "SEND_INSUFFICIENT_BALANCE")],
  ])("reports a partly paid request with the unsent remainder: %s", async (_label, cause) => {
    payments.requests.pay.mockRejectedValueOnce(
      new sdk.PartialSendConflictError("partly sent", "tx-part", ["tok"], "400000000000000000", cause),
    );
    const result = await respond({});
    expect(text(result)).toContain("PAYMENT PARTIALLY SENT — DO NOT PAY THIS REQUEST AGAIN");
    expect(text(result)).toContain("0.4 UCT could NOT be sent");
    expect(text(result)).toContain("will still mark this request as paid");
    expect(text(result)).toContain(`unicity_send_tokens to ${SENDER}`);
    expect(result.details).toMatchObject({
      outcome: "possibly_committed",
      requestId: REQUEST_ID,
      transferId: "tx-part",
      coinId: UCT,
      remainingAmount: "400000000000000000",
      remainderOutcome: "not_sent",
    });
    expect(result.details).not.toHaveProperty("status");
    expect(ledgerEntries()).toEqual([expect.objectContaining({ state: "possibly_committed", transferId: "tx-part" })]);
  });

  it("names only this payment's shortfall as its unsent remainder, never an earlier partial send's", async () => {
    // The earlier row stays listed although its remainder may have been paid separately (sdk 0.18.1 never removes it).
    const earlier = pendingRow("tx-old", { kind: "shortfall", amount: "400000000000000000", deliveryPending: false, createdAt: Date.now() - 5 * 60_000 });
    payments.pendingTransfers.mockResolvedValue([earlier]);
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.pendingTransfers.mockResolvedValue([
        earlier,
        pendingRow("tx-part", { kind: "shortfall", amount: "400000000000000000", deliveryPending: false, createdAt: Date.now() }),
      ]);
      throw new sdk.PartialSendConflictError("partly sent", "tx-part", ["tok"], "400000000000000000");
    });
    const out = text(await respond({}));
    expect(out).toContain("0.4 UCT could NOT be sent");
    expect(out).toMatch(/- tx-part: 0\.4 UCT .*\(this payment's unsent remainder\)/);
    expect(out).toMatch(/- tx-old: 0\.4 UCT .*\(may have been paid separately since\)/);
    expect(out).not.toMatch(/- tx-old: .*(owed|remainder\))/);
    expect(out).not.toContain("Transfers still settling");
  });

  it("does not present an earlier partial send's shortfall as owed when a pay may have gone through", async () => {
    const earlier = pendingRow("tx-old", { kind: "shortfall", amount: "400000000000000000", deliveryPending: false, createdAt: Date.now() - 5 * 60_000 });
    payments.pendingTransfers.mockResolvedValue([earlier]);
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-k"), earlier]);
      throw sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-k" });
    });
    const out = text(await respond({}));
    expect(out).toMatch(/Transfers still settling:\n- tx-k: [^\n]*\n\nPartial sends the wallet still lists/);
    expect(out).toMatch(/- tx-old: .*\(may have been paid separately since\)/);
    expect(out).not.toMatch(/owed/);
  });

  it.each([
    ["SEND_SYNC_PENDING", Object.assign(new sdk.SphereError("committed", "SEND_SYNC_PENDING"), { transferId: "tx-r" })],
    ["CERTIFICATION_UNCONFIRMED", Object.assign(new sdk.SphereError("keep open", "CERTIFICATION_UNCONFIRMED"), { transferId: "tx-r" })],
    ["NOT_FOUND", Object.assign(new Error("intent not found"), { code: "NOT_FOUND" })],
  ])("never calls the remainder still owed when its own attempt may have committed (%s)", async (causeCode, cause) => {
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-part", { kind: "shortfall", amount: "400000000000000000" })]);
      throw new sdk.PartialSendConflictError("partly sent", "tx-part", ["tok"], "400000000000000000", cause);
    });
    const result = await respond({});
    const out = text(result);
    expect(out).toContain("PAYMENT PARTIALLY SENT — DO NOT PAY THIS REQUEST AGAIN");
    expect(out).toContain(`outcome is UNKNOWN (${causeCode}`);
    expect(out).not.toMatch(/could NOT be sent|still owed|send it as a new payment/);
    expect(out).toMatch(/- tx-part: 0\.4 UCT .*\(remainder attempted again, outcome unknown\)/);
    expect(result.details).toMatchObject({ outcome: "possibly_committed", remainingAmount: "400000000000000000", remainderOutcome: "unknown", causeCode });
    // A missing history row is never offered as the check that clears sending the remainder.
    expect(out).not.toMatch(/history shows it never left/);
    expect(out).toContain("their absence does NOT show that nothing went out");
    expect(out).toContain("Only the requester can confirm what arrived");

    // Sending the remainder to the requester, as the owner might ask, is refused under every spelling of its key.
    const requesterKey = SENDER.slice(2);
    (wallet.sphere as ReturnType<typeof makeSphere>).resolve.mockImplementation(async (id: string) =>
      binding(id === "@trusted-vendor" ? requesterKey : id.toLowerCase()),
    );
    for (const recipient of [SENDER, requesterKey, "@trusted-vendor"]) {
      const remainder = await sendTokensTool.execute("call", { recipient, amount: "0.4", coin: "UCT" });
      expect(remainder.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "possibly_committed" } });
    }
    expect(payments.send).not.toHaveBeenCalled();
  });

  it("does not pay when the ledger cannot be read", async () => {
    storageControl.failReads = "EACCES";
    expect((await respond({})).details).toMatchObject({ status: "error", code: "ledger_unavailable" });
    expect(payments.requests.pay).not.toHaveBeenCalled();
  });

  it("lets only one of two concurrent pays of the same request reach the wallet", async () => {
    let release: (v: unknown) => void = () => undefined;
    payments.requests.pay.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const results = Promise.all([respond({}), respond({})]);
    await vi.waitFor(() => expect(payments.requests.pay).toHaveBeenCalledTimes(1));
    release({ id: "tx-pay", status: "delivered", tokens: [], tokenTransfers: [] });
    const [first, second] = await results;
    expect(first.details).toMatchObject({ outcome: "paid" });
    expect(second.details).toMatchObject({ code: "duplicate" });
    expect(payments.requests.pay).toHaveBeenCalledTimes(1);
  });

  it("treats a clean-looking error as unknown when the request can no longer be read", async () => {
    payments.requests.pay.mockImplementationOnce(async () => {
      payments.requests.list.mockImplementation(() => {
        throw sdkError("NOT_INITIALIZED");
      });
      throw sdkError("SEND_INSUFFICIENT_BALANCE");
    });
    expect((await respond({})).details).toMatchObject({ outcome: "possibly_committed" });
  });

  it("does not pay when the call was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await respondPaymentRequestTool.execute("call", { requestId: REQUEST_ID, action: "pay" }, controller.signal);
    expect(result.details).toMatchObject({ status: "error", code: "aborted" });
    expect(payments.requests.pay).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
  });

  it("never hands the abort signal to the SDK", async () => {
    await respondPaymentRequestTool.execute("call", { requestId: REQUEST_ID, action: "pay" }, new AbortController().signal);
    expect(payments.requests.pay.mock.calls[0]).toEqual([REQUEST_ID]);
  });

  it("explains a wallet whose payments are not ready", async () => {
    wallet.sphere = makeSphere(payments, { paymentsError: sdkError("NOT_INITIALIZED") });
    expect((await respond({})).details).toMatchObject({ code: "wallet_not_ready" });
  });
});

describe("a request payment and a send of its amount to the requester guard each other", () => {
  // sdk 0.18.1 Requests.payInner: pay() is a plain send({ recipient: request.senderPubkey, amount, coinId }).
  const REQUESTER_KEY = SENDER.slice(2);
  const SPELLINGS = [SENDER, REQUESTER_KEY, "@trusted-vendor"];
  const sphere = () => wallet.sphere as ReturnType<typeof makeSphere>;
  const sendToRequester = (params?: Record<string, unknown>) =>
    sendTokensTool.execute("call", { recipient: "@trusted-vendor", amount: "2", coin: "UCT", ...params });

  beforeEach(() => {
    sphere().resolve.mockImplementation(async (id: string) =>
      binding(id === "@trusted-vendor" ? REQUESTER_KEY : id === "@bob" ? "cd".repeat(32) : id.toLowerCase()),
    );
    payments.send.mockResolvedValue({ id: "tx-send", status: "delivered", tokens: [], tokenTransfers: [] });
  });

  it("refuses to send the requested amount to the requester, under any spelling, after a pay that may have gone through", async () => {
    payments.requests.pay.mockRejectedValueOnce(sdkError("TRANSFER_CONFLICT", "conflict", { transferId: "tx-k" }));
    const paid = text(await respond({}));
    expect(paid).toContain("Do NOT pay this request again, and do NOT send this amount to the requester with unicity_send_tokens.");
    expect(ledgerEntries()).toEqual([expect.objectContaining({ op: "pay", key: REQUEST_ID, sendKey: `${REQUESTER_KEY}|${UCT}|2000000000000000000` })]);
    for (const recipient of SPELLINGS) {
      const result = await sendToRequester({ recipient });
      expect(result.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "possibly_committed", transferId: "tx-k", requestId: REQUEST_ID } });
      expect(text(result)).toContain(`NOT DONE: send 2 UCT to ${recipient} would repeat the payment of request ${REQUEST_ID}`);
    }
    expect(payments.send).not.toHaveBeenCalled();
  });

  it("refuses it while a completed pay's delivery is still pending, and allows it once the transfer settled", async () => {
    payments.requests.pay.mockResolvedValueOnce({ id: "tx-pay", status: "confirmed", tokens: [], tokenTransfers: [], deliveryPending: true });
    expect(text(await respond({}))).toContain("Delivery to the requester is still pending and completes automatically — do not pay or send it again.");
    expect((await sendToRequester()).details).toMatchObject({ code: "duplicate", previous: { state: "done", transferId: "tx-pay" } });
    ageLedger(20 * 60_000);
    payments.pendingTransfers.mockResolvedValue([pendingRow("tx-pay", { recipient: SENDER })]);
    expect((await sendToRequester()).details).toMatchObject({ code: "duplicate", previous: { state: "done", settling: true } });
    payments.pendingTransfers.mockRejectedValue(new Error("kv down"));
    expect((await sendToRequester()).details).toMatchObject({ code: "duplicate", previous: { state: "done" } });
    expect(payments.send).not.toHaveBeenCalled();
    payments.pendingTransfers.mockResolvedValue([]);
    expect((await sendToRequester()).details).toMatchObject({ outcome: "sent" });
  });

  it("allows a send after a possibly-committed pay once the window passed and its transfer is no longer pending", async () => {
    payments.requests.pay.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-k" }));
    await respond({});
    ageLedger(20 * 60_000);
    payments.pendingTransfers.mockResolvedValue([pendingRow("tx-k")]);
    expect((await sendToRequester()).details).toMatchObject({ code: "duplicate", previous: { settling: true } });
    payments.pendingTransfers.mockResolvedValue([]);
    expect((await sendToRequester()).details).toMatchObject({ outcome: "sent" });
  });

  it("refuses to pay a request after a send of its amount to the requester that may have gone through", async () => {
    payments.send.mockRejectedValueOnce(sdkError("SEND_SYNC_PENDING", "pending", { transferId: "tx-9" }));
    expect((await sendToRequester()).details).toMatchObject({ outcome: "possibly_committed" });
    const result = await respond({});
    expect(result.details).toMatchObject({ status: "error", code: "duplicate", previous: { state: "possibly_committed", transferId: "tx-9" } });
    expect(text(result)).toContain(`NOT DONE: pay request ${REQUEST_ID} would repeat a send of the same coin and amount to the same payee`);
    expect(payments.requests.pay).not.toHaveBeenCalled();

    ageLedger(20 * 60_000);
    payments.pendingTransfers.mockResolvedValue([pendingRow("tx-9")]);
    expect((await respond({})).details).toMatchObject({ code: "duplicate", previous: { settling: true } });
    payments.pendingTransfers.mockResolvedValue([]);
    expect((await respond({})).details).toMatchObject({ outcome: "paid" });
  });

  it("refuses to pay another request for the same amount from the same requester right after paying one", async () => {
    await respond({});
    const second = { ...request, id: "second-request", requestId: "second-request" };
    payments.requests.list.mockImplementation(() => [request, second]);
    const result = await respond({ requestId: "second-request" });
    expect(result.details).toMatchObject({ code: "duplicate", previous: { state: "done", requestId: REQUEST_ID } });
    expect(text(result)).toContain(`NOT DONE: pay request second-request would repeat the payment of request ${REQUEST_ID}`);
    expect((await respond({ requestId: "second-request", allowDuplicate: true })).details).toMatchObject({ outcome: "paid" });
    expect(payments.requests.pay).toHaveBeenCalledTimes(2);
  });

  it("lets only one of a pay and a concurrent send of its amount to the requester reach the wallet", async () => {
    let release: (v: unknown) => void = () => undefined;
    payments.requests.pay.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const paying = respond({});
    await vi.waitFor(() => expect(payments.requests.pay).toHaveBeenCalledTimes(1));
    expect((await sendToRequester()).details).toMatchObject({ code: "duplicate", previous: { state: "intent" } });
    release({ id: "tx-pay", status: "delivered", tokens: [], tokenTransfers: [] });
    expect((await paying).details).toMatchObject({ outcome: "paid" });
    expect(payments.send).not.toHaveBeenCalled();
  });

  it("still allows what is not the same payment, and a send the owner confirmed", async () => {
    payments.requests.pay.mockRejectedValueOnce(sdkError("CERTIFICATION_UNCONFIRMED", "keep open", { transferId: "tx-k" }));
    await respond({});
    expect((await sendToRequester({ amount: "1" })).details).toMatchObject({ outcome: "sent" });
    expect((await sendToRequester({ coin: "BTC" })).details).toMatchObject({ outcome: "sent" });
    expect((await sendToRequester({ recipient: "@bob" })).details).toMatchObject({ outcome: "sent" });
    expect((await sendToRequester({ allowDuplicate: true })).details).toMatchObject({ outcome: "sent" });
    expect(payments.send).toHaveBeenCalledTimes(4);
  });

  it("pays a request whose amount is not a base-unit integer without a send key", async () => {
    request.amount = "2.5";
    expect((await respond({})).details).toMatchObject({ outcome: "paid" });
    expect(ledgerEntries()[0]).not.toHaveProperty("sendKey");
  });
});

describe("decline", () => {
  it.each(["decline", "reject"])("%s declines the request", async (action) => {
    const result = await respond({ action });
    expect(payments.requests.decline).toHaveBeenCalledWith(REQUEST_ID);
    expect(payments.requests.pay).not.toHaveBeenCalled();
    expect(text(result)).toContain(`Declined payment request ${REQUEST_ID} (2 UCT from ${SENDER} (claims @trusted-vendor, unverified))`);
    expect(result.details).toMatchObject({ outcome: "declined" });
  });

  it("reports a refused decline", async () => {
    payments.requests.decline.mockRejectedValueOnce(sdkError("VALIDATION_ERROR", "server refused"));
    const result = await respond({ action: "decline" });
    expect(result.details).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
    expect(text(result)).toContain("server refused");
  });

  it("does not decline when the call was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await respondPaymentRequestTool.execute("call", { requestId: REQUEST_ID, action: "decline" }, controller.signal);
    expect(result.details).toMatchObject({ code: "aborted" });
    expect(payments.requests.decline).not.toHaveBeenCalled();
  });

  it("refuses to decline a request that is no longer pending", async () => {
    request.status = "paid";
    expect((await respond({ action: "decline" })).details).toMatchObject({ code: "request_not_pending" });
    expect(payments.requests.decline).not.toHaveBeenCalled();
  });

  it("rejects the removed accept action", async () => {
    expect((await respond({ action: "accept" })).details).toMatchObject({ code: "invalid_action" });
    expect(payments.requests.decline).not.toHaveBeenCalled();
  });
});
