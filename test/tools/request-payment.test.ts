import { describe, it, expect, vi, beforeEach } from "vitest";
import { NAMED_KEY, UCT, USDCE, binding, ledgerEntries, makePayments, makeSphere, memFiles, registry, resetRegistry, resetStorage, text, wallet, type FakePayments, MEM_OUTGOING_REQUESTS_PATH } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/sphere.js", async () => {
  const f = await import("./payments-fixtures.js");
  return { getSphereOrNull: () => f.wallet.sphere };
});

const { requestPaymentTool } = await import("../../src/tools/request-payment.js");
const { SENDER_SCOPED_FLAG_PARAM } = await import("../../src/owner-gate.js");

const REQUEST_ID = "c0ffee00-1111-4222-8333-444455556666";
const NAMED_CHAIN_KEY = `02${NAMED_KEY}`;
let payments: FakePayments;
let sphere: ReturnType<typeof makeSphere>;

const request = (params: Record<string, unknown>) =>
  requestPaymentTool.execute("call", { recipient: "@bob", amount: "10", coin: "UCT", ...params });

const outgoing = () => JSON.parse(memFiles.get(MEM_OUTGOING_REQUESTS_PATH) ?? "[]");

beforeEach(() => {
  resetRegistry();
  resetStorage();
  payments = makePayments();
  payments.requests.create.mockResolvedValue({ success: true, requestId: REQUEST_ID });
  sphere = makeSphere(payments);
  wallet.sphere = sphere;
});

describe("unicity_request_payment", () => {
  it("has a string amount and no IsOwner wording", () => {
    const props = (requestPaymentTool.parameters as { properties: Record<string, { type: string }> }).properties;
    expect(props.amount.type).toBe("string");
    expect(requestPaymentTool.description).not.toContain("IsOwner");
    expect(requestPaymentTool.executionMode).toBe("sequential");
  });

  it("creates the request with the pinned chain key, registry hex id, base units and memo, prints the full id and records it locally", async () => {
    const result = await request({ message: "lunch" });

    expect(sphere.resolve).toHaveBeenCalledWith("@bob");
    expect(payments.requests.create).toHaveBeenCalledWith(NAMED_CHAIN_KEY, { coinId: UCT, amount: "10000000000000000000", memo: "lunch" });
    expect(text(result)).toBe(`Payment request sent to @bob for 10 UCT. Request id: ${REQUEST_ID}.`);
    expect(result.details).toMatchObject({ outcome: "requested", requestId: REQUEST_ID, recipientKey: NAMED_CHAIN_KEY });
    expect(outgoing()).toEqual([
      expect.objectContaining({ requestId: REQUEST_ID, to: "@bob", toKey: NAMED_CHAIN_KEY, coinId: UCT, amount: "10000000000000000000", memo: "lunch" }),
    ]);
    expect(ledgerEntries()[0]).toMatchObject({ op: "request", state: "done" });
  });

  it("records who asked for the request: the payer when the owner gate marks the call sender-scoped, else the owner", async () => {
    expect(Object.keys((requestPaymentTool.parameters as { properties: Record<string, unknown> }).properties)).not.toContain(SENDER_SCOPED_FLAG_PARAM);
    await request({ amount: "1", [SENDER_SCOPED_FLAG_PARAM]: true });
    await request({ amount: "2" });
    await request({ amount: "3", [SENDER_SCOPED_FLAG_PARAM]: false });
    await request({ amount: "4", [SENDER_SCOPED_FLAG_PARAM]: "true" });
    expect(outgoing().map((r: { origin?: string }) => r.origin)).toEqual(["sender", "owner", "owner", "owner"]);
  });

  it("maps USDC to USDC.e", async () => {
    await request({ coin: "usdc", amount: "0.25" });
    expect(payments.requests.create).toHaveBeenCalledWith(NAMED_CHAIN_KEY, { coinId: USDCE, amount: "250000" });
  });

  it("treats a failed create as possibly delivered: no 'NOT sent', and an identical retry is refused", async () => {
    payments.requests.create.mockResolvedValueOnce({
      success: false,
      error: "wallet-api request failed: POST https://api/v1/payment-requests: TimeoutError: The operation was aborted due to timeout",
    });
    const result = await request({});
    expect(text(result)).toContain("PAYMENT REQUEST OUTCOME UNKNOWN — DO NOT RE-SEND");
    expect(text(result)).not.toContain("NOT sent");
    expect(result.details).toMatchObject({ outcome: "possibly_committed", recipient: "@bob", coinId: UCT });
    expect(result.details).not.toHaveProperty("status");
    expect(outgoing()).toEqual([]);
    expect(ledgerEntries()[0].state).toBe("possibly_committed");

    expect((await request({})).details).toMatchObject({ code: "duplicate", previous: { state: "possibly_committed" } });
    expect((await request({ allowDuplicate: true })).details).toMatchObject({ outcome: "requested" });
    expect(payments.requests.create).toHaveBeenCalledTimes(2);
  });

  it("treats an unexpected throw from create as possibly delivered", async () => {
    payments.requests.create.mockRejectedValue(Object.assign(new Error("offline"), { code: "TRANSPORT_ERROR" }));
    const result = await request({});
    expect(result.details).toMatchObject({ outcome: "possibly_committed" });
    expect(text(result)).toContain("TRANSPORT_ERROR: offline");
  });

  describe("recipient key pinning", () => {
    const STRANGER = "5a".repeat(32);
    const VICTIM = "77".repeat(32);

    it("refuses a 64-hex key whose binding names someone else's chain key, before recording anything", async () => {
      sphere.resolve.mockResolvedValueOnce(binding(STRANGER, `02${VICTIM}`));
      const result = await request({ recipient: STRANGER });
      expect(result.details).toMatchObject({ status: "error", code: "invalid_recipient" });
      expect(text(result)).toContain("Payment request NOT sent");
      expect(payments.requests.create).not.toHaveBeenCalled();
      expect(ledgerEntries()).toEqual([]);
    });

    it("addresses a 64-hex key (the key the owner gate forces for non-owners) to its own 66-hex chain key", async () => {
      await request({ recipient: STRANGER.toUpperCase() });
      expect(sphere.resolve).toHaveBeenCalledWith(STRANGER);
      expect(payments.requests.create).toHaveBeenCalledWith(`02${STRANGER}`, expect.objectContaining({ coinId: UCT }));
    });

    it("refuses a binding signed by a different key than the 64-hex key asked for", async () => {
      sphere.resolve.mockResolvedValueOnce(binding(VICTIM));
      expect((await request({ recipient: STRANGER })).details).toMatchObject({ code: "invalid_recipient" });
      expect(payments.requests.create).not.toHaveBeenCalled();
    });

    it.each([
      ["no binding", null],
      ["a 64-hex chain key", binding(NAMED_KEY, NAMED_KEY)],
      ["a foreign chain key", binding(NAMED_KEY, `03${VICTIM}`)],
    ])("refuses a nametag with %s", async (_label, peer) => {
      sphere.resolve.mockResolvedValueOnce(peer);
      expect((await request({ recipient: "@bob" })).details).toMatchObject({ code: "invalid_recipient" });
      expect(payments.requests.create).not.toHaveBeenCalled();
    });

    it("refuses when the lookup fails", async () => {
      sphere.resolve.mockRejectedValueOnce(new Error("relay down"));
      expect((await request({ recipient: "@bob" })).details).toMatchObject({ code: "invalid_recipient" });
    });

    it("refuses when the lookup does not answer within 15 seconds, before recording anything", async () => {
      vi.useFakeTimers();
      try {
        sphere.resolve.mockReturnValueOnce(new Promise<null>(() => undefined));
        const pending = request({ recipient: "@bob" });
        await vi.advanceTimersByTimeAsync(15_000);
        expect((await pending).details).toMatchObject({ code: "invalid_recipient" });
        expect(payments.requests.create).not.toHaveBeenCalled();
        expect(ledgerEntries()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("passes a 66-hex chain key through unchanged without a lookup", async () => {
      const key = `03${VICTIM}`;
      await request({ recipient: key });
      expect(sphere.resolve).not.toHaveBeenCalled();
      expect(payments.requests.create).toHaveBeenCalledWith(key, expect.objectContaining({ coinId: UCT }));
    });
  });

  it.each([
    [{ amount: 10 }, "invalid_amount"],
    [{ amount: "ten" }, "invalid_amount"],
    [{ amount: "0.0000000000000000001" }, "invalid_amount"],
    [{ recipient: "PROXY:abc" }, "invalid_recipient"],
    [{ coin: "DOGE" }, "unknown_coin"],
  ])("rejects %j before creating anything", async (params, code) => {
    expect((await request(params)).details).toMatchObject({ code });
    expect(payments.requests.create).not.toHaveBeenCalled();
  });

  it("does not create a request when the call was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await requestPaymentTool.execute("call", { recipient: "@bob", amount: "10", coin: "UCT" }, controller.signal);
    expect(result.details).toMatchObject({ status: "error", code: "aborted" });
    expect(payments.requests.create).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
  });

  it("refuses while the registry is not loaded", async () => {
    registry.ready = false;
    expect((await request({})).details).toMatchObject({ code: "registry_not_ready" });
  });

  it("refuses an identical request to the same payer within 15 minutes unless allowDuplicate", async () => {
    await request({});
    expect((await request({ recipient: "bob" })).details).toMatchObject({ code: "duplicate" });
    expect((await request({ recipient: NAMED_CHAIN_KEY })).details).toMatchObject({ code: "duplicate" });
    expect((await request({ allowDuplicate: true })).details).toMatchObject({ outcome: "requested" });
    expect(payments.requests.create).toHaveBeenCalledTimes(2);
  });

  it("still reports success when the local record cannot be saved", async () => {
    payments.requests.create.mockImplementation(async () => {
      const { storageControl } = await import("./payments-fixtures.js");
      storageControl.failWrites = true;
      return { success: true, requestId: REQUEST_ID };
    });
    const result = await request({});
    expect(result.details).toMatchObject({ outcome: "requested", requestId: REQUEST_ID });
    expect(text(result)).toContain("could not be saved to the local list");
  });
});
