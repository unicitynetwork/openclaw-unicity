import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NAMED_KEY, UCT, ledgerEntries, makePayments, makeSphere, memFiles, pendingRow, registry, resetRegistry, resetStorage, sdkError, storageControl, text, type FakePayments, MEM_LEDGER_PATH } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);

const {
  isCleanMoneyFailure,
  payeeKey,
  pendingTransferIds,
  pendingTransfersNote,
  readPendingTransfers,
  remainderOutcome,
  reserveMoneyOp,
  resolveCoinAmount,
  settlingTo,
  settlingTransferLines,
} = await import("../../src/tools/money.js");
const { paymentKey, recordIntent, settle } = await import("../../src/ledger.js");
const sdk = await vi.importActual<typeof import("@unicitylabs/sphere-sdk")>("@unicitylabs/sphere-sdk");

let payments: FakePayments;

beforeEach(() => {
  resetRegistry();
  resetStorage();
  payments = makePayments();
});

describe("resolveCoinAmount", () => {
  it("resolves the coin and exact base units", async () => {
    expect(await resolveCoinAmount("uct", "1.5")).toEqual({
      coin: expect.objectContaining({ coinId: UCT, symbol: "UCT", decimals: 18 }),
      amount: 1_500_000_000_000_000_000n,
      human: "1.5 UCT",
    });
  });

  it.each([
    [["UCT", 1.5], "invalid_amount"],
    [["UCT", "0"], "invalid_amount"],
    [["SNAKE", "0.5"], "invalid_amount"],
    [["DOGE", "1"], "unknown_coin"],
  ])("refuses %j with %s", async ([coin, amount], code) => {
    expect(await resolveCoinAmount(coin, amount)).toEqual({ refused: expect.objectContaining({ details: { status: "error", code } }) });
  });

  it("refuses while the registry is not loaded", async () => {
    registry.ready = false;
    expect(await resolveCoinAmount("UCT", "1")).toMatchObject({ refused: { details: { code: "registry_not_ready" } } });
  });
});

describe("reserveMoneyOp", () => {
  const reserve = (extra?: Record<string, unknown>) =>
    reserveMoneyOp({ op: "send", key: "k1", what: "send 1 UCT to @bob", nothingDone: "nothing was sent", allowDuplicate: undefined, ...extra });
  const refusalText = (r: ReturnType<typeof reserveMoneyOp>) => ("refused" in r ? text(r.refused) : "");

  it("records an intent", () => {
    const r = reserve();
    expect(r).toEqual({ intent: expect.objectContaining({ op: "send", key: "k1", state: "intent" }) });
    expect(ledgerEntries()).toHaveLength(1);
  });

  it("refuses a duplicate unless allowDuplicate is exactly true", () => {
    reserve();
    expect(reserve()).toMatchObject({ refused: { details: { code: "duplicate" } } });
    expect(reserve({ allowDuplicate: "yes" })).toMatchObject({ refused: { details: { code: "duplicate" } } });
    expect(reserve({ allowDuplicate: true })).toHaveProperty("intent");
  });

  it("honours a custom window", () => {
    vi.useFakeTimers();
    try {
      reserve();
      vi.advanceTimersByTime(60_000);
      expect(reserve({ windowMs: 30_000 })).toHaveProperty("intent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks on an earlier entry recorded under any alias and records the aliases", () => {
    expect(reserve({ key: "payee-key", aliases: ["typed-key"] })).toHaveProperty("intent");
    expect(ledgerEntries()[0]).toMatchObject({ key: "payee-key", aliases: ["typed-key"] });
    expect(reserve({ key: "typed-key" })).toMatchObject({ refused: { details: { code: "duplicate" } } });
    expect(reserve({ key: "other-payee", aliases: ["payee-key"] })).toMatchObject({ refused: { details: { code: "duplicate" } } });
  });

  it("keeps refusing past the window while the earlier transfer is still settling, and says so", () => {
    vi.useFakeTimers();
    try {
      const r = reserve();
      if (!("intent" in r)) throw new Error("expected an intent");
      memFiles.set(MEM_LEDGER_PATH, JSON.stringify([{ ...r.intent, state: "possibly_committed", transferId: "tx-9" }]));
      vi.advanceTimersByTime(20 * 60_000);
      const refused = reserve({ settling: { pendingIds: new Set(["tx-9"]) } });
      expect(refused).toMatchObject({ refused: { details: { code: "duplicate", previous: { transferId: "tx-9", settling: true } } } });
      expect(refusalText(refused)).toContain(
        "transfer tx-9 is still settling and will complete automatically",
      );
      expect(reserve({ settling: { pendingIds: new Set() } })).toHaveProperty("intent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the transfers to the same payee that are still settling, apart from the earlier entry's own", () => {
    vi.useFakeTimers();
    try {
      const r = reserve();
      if (!("intent" in r)) throw new Error("expected an intent");
      memFiles.set(MEM_LEDGER_PATH, JSON.stringify([{ ...r.intent, state: "possibly_committed" }]));
      vi.advanceTimersByTime(60 * 60_000);
      const refused = reserve({ settling: { pendingIds: new Set(["tx-a", "tx-b"]) }, settlingToPayee: ["tx-a", "tx-b"] });
      expect(refused).toMatchObject({ refused: { details: { code: "duplicate", settlingToRecipient: ["tx-a", "tx-b"] } } });
      expect(refusalText(refused)).toContain(
        "Transfers tx-a, tx-b to the same recipient are still settling (a payment in progress).",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("a pay's send key (a pay is a send of the requested amount to the requester)", () => {
    const SEND_KEY = "payee|coin|5";
    const DAY = 24 * 3600_000;
    const pay = (extra?: Record<string, unknown>) =>
      reserveMoneyOp({
        op: "pay",
        key: "request-1",
        sendKey: SEND_KEY,
        what: "pay request request-1",
        nothingDone: "nothing was sent",
        allowDuplicate: undefined,
        windowMs: 30 * DAY,
        settling: { pendingIds: new Set<string>(), unresolvedWindowMs: Number.POSITIVE_INFINITY },
        ...extra,
      });
    /** An earlier send under the send key, settled into `state`. */
    const earlierSend = (state: "done" | "possibly_committed", transferId?: string) =>
      settle(recordIntent("send", SEND_KEY, ["typed|coin|5"]).id, state, transferId ? { transferId } : undefined);

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("records the send key with the pay intent, so the pay refuses an identical send", () => {
      expect(pay()).toHaveProperty("intent");
      expect(ledgerEntries()[0]).toMatchObject({ op: "pay", key: "request-1", sendKey: SEND_KEY });
      const refused = reserve({ key: SEND_KEY, aliases: ["typed|coin|5"], what: "send 5 to @payee" });
      expect(refused).toMatchObject({ refused: { details: { code: "duplicate", previous: { state: "intent", requestId: "request-1" } } } });
      expect(refusalText(refused)).toContain(
        "NOT DONE: send 5 to @payee would repeat the payment of request request-1, which was already started (outcome unknown)",
      );
    });

    it("is refused by an earlier send of the same amount to the payee, and by a payment of another request that made one", () => {
      earlierSend("possibly_committed", "tx-9");
      const refused = pay();
      expect(refused).toMatchObject({ refused: { details: { code: "duplicate", previous: { state: "possibly_committed", transferId: "tx-9" } } } });
      expect(refusalText(refused)).toContain(
        "NOT DONE: pay request request-1 would repeat a send of the same coin and amount to the same payee",
      );
      resetStorage();
      expect(pay({ key: "request-0" })).toHaveProperty("intent");
      expect(pay()).toMatchObject({ refused: { details: { code: "duplicate", previous: { requestId: "request-0" } } } });
    });

    it("judges the earlier send by a send's window, not the pay's", () => {
      earlierSend("done", "tx-9");
      vi.advanceTimersByTime(20 * 60_000);
      expect(pay({ settling: { pendingIds: new Set(["tx-9"]), unresolvedWindowMs: Number.POSITIVE_INFINITY } })).toHaveProperty("refused");
      expect(pay()).toHaveProperty("intent");
      resetStorage();
      earlierSend("possibly_committed");
      vi.advanceTimersByTime(20 * 60_000);
      expect(pay()).toHaveProperty("refused");
      vi.advanceTimersByTime(DAY);
      expect(pay()).toHaveProperty("intent");
    });

    it("pays anyway with allowDuplicate", () => {
      earlierSend("possibly_committed", "tx-9");
      expect(pay({ allowDuplicate: true })).toHaveProperty("intent");
    });

    it("leaves other operations alone: without a send key nothing but the same request blocks a pay", () => {
      earlierSend("possibly_committed", "tx-9");
      expect(pay({ sendKey: undefined })).toHaveProperty("intent");
      expect(ledgerEntries()[1]).not.toHaveProperty("sendKey");
    });
  });

  it("does nothing once the call is cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const r = reserve({ signal: controller.signal });
    expect(r).toMatchObject({ refused: { details: { code: "aborted" } } });
    expect(refusalText(r)).toContain("nothing was sent");
    expect(memFiles.size).toBe(0);
  });

  it.each(["EIO", "EACCES"] as const)("refuses when the ledger cannot be read (%s) and leaves it untouched", (code) => {
    memFiles.set(MEM_LEDGER_PATH, JSON.stringify([{ id: "e0", op: "send", key: "k1", at: Date.now(), state: "possibly_committed" }]));
    const bytes = memFiles.get(MEM_LEDGER_PATH);
    storageControl.failReads = code;
    const r = reserve();
    expect(r).toMatchObject({ refused: { details: { status: "error", code: "ledger_unavailable" } } });
    expect(refusalText(r)).toContain("payment-ledger.json");
    expect(memFiles.get(MEM_LEDGER_PATH)).toBe(bytes);
  });

  it("refuses when the ledger is corrupt instead of resetting it", () => {
    memFiles.set(MEM_LEDGER_PATH, "{not json");
    expect(reserve()).toMatchObject({ refused: { details: { code: "ledger_unavailable" } } });
    expect(memFiles.get(MEM_LEDGER_PATH)).toBe("{not json");
  });

  it("refuses when the intent cannot be written", () => {
    storageControl.failWrites = true;
    expect(reserve()).toMatchObject({ refused: { details: { code: "ledger_unavailable" } } });
  });
});

describe("isCleanMoneyFailure", () => {
  const BEFORE = new Set(["old-1"]);

  beforeEach(() => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("old-1")]);
  });

  it.each(["SEND_INSUFFICIENT_BALANCE", "INVALID_RECIPIENT", "SEND_QUEUE_TIMEOUT", "SEND_QUEUE_FULL"])(
    "%s with no new pending transfer is clean",
    async (code) => expect(await isCleanMoneyFailure(sdkError(code), payments as never, BEFORE)).toBe(true),
  );

  it.each([
    // possibly-committed SDK outcomes
    "SEND_SYNC_PENDING",
    "CERTIFICATION_UNCONFIRMED",
    "CHECKPOINT_PERSIST_FAILED",
    "SPLIT_CHECKPOINT_LOST",
    "CHECKPOINT_TRUSTBASE_MISMATCH",
    "SEND_PARTIALLY_COMPLETED",
    // raised after certification: a failed intent completion, a lost race or a leg error inside the transfer machine
    "NOT_FOUND",
    "HTTP_502",
    "RATE_LIMITED",
    "NETWORK",
    "TRANSFER_CONFLICT",
    "VALIDATION_ERROR",
    "TRANSPORT_ERROR",
    "STORAGE_ERROR",
    "ENOSPC",
  ])("%s is never a clean failure", async (code) => {
    expect(await isCleanMoneyFailure(sdkError(code), payments as never, BEFORE)).toBe(false);
  });

  it("treats uncoded errors and errors flagged mayHaveCertified as possibly committed", async () => {
    expect(await isCleanMoneyFailure(new TypeError("boom"), payments as never, BEFORE)).toBe(false);
    expect(await isCleanMoneyFailure("boom", payments as never, BEFORE)).toBe(false);
    expect(await isCleanMoneyFailure(sdkError("INVALID_RECIPIENT", "x", { mayHaveCertified: true }), payments as never, BEFORE)).toBe(false);
  });

  it("is not clean when a pending transfer appeared during the call", async () => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("old-1"), pendingRow("tx-new", { createdAt: 0 })]);
    expect(await isCleanMoneyFailure(sdkError("SEND_INSUFFICIENT_BALANCE"), payments as never, BEFORE)).toBe(false);
  });

  it("is not clean when either pending-transfer read failed", async () => {
    expect(await isCleanMoneyFailure(sdkError("SEND_INSUFFICIENT_BALANCE"), payments as never, null)).toBe(false);
    payments.pendingTransfers.mockRejectedValue(new Error("kv down"));
    expect(await isCleanMoneyFailure(sdkError("SEND_INSUFFICIENT_BALANCE"), payments as never, BEFORE)).toBe(false);
  });
});

describe("payeeKey", () => {
  it("takes a 66-hex chain key as given, without a lookup", async () => {
    const sphere = makeSphere(payments);
    expect(await payeeKey(sphere as never, `03${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    expect(sphere.resolve).not.toHaveBeenCalled();
  });

  it("looks up anything else the way the SDK does and keys on the chain key its binding names", async () => {
    const sphere = makeSphere(payments);
    expect(await payeeKey(sphere as never, "@alice")).toBe(NAMED_KEY);
    expect(sphere.resolve).toHaveBeenLastCalledWith("@alice");
    sphere.resolve.mockResolvedValueOnce({ transportPubkey: "cd".repeat(32), chainPubkey: `02${"ef".repeat(32)}`, directAddress: "", timestamp: 1 });
    expect(await payeeKey(sphere as never, "cd".repeat(32))).toBe("ef".repeat(32));
  });

  it("is null when the lookup finds nothing, fails or hangs", async () => {
    const sphere = makeSphere(payments);
    sphere.resolve.mockResolvedValueOnce(null);
    expect(await payeeKey(sphere as never, "@nobody")).toBeNull();
    sphere.resolve.mockRejectedValueOnce(new Error("relay down"));
    expect(await payeeKey(sphere as never, "@alice")).toBeNull();
    sphere.resolve.mockImplementationOnce(() => {
      throw sdkError("NOT_INITIALIZED");
    });
    expect(await payeeKey(sphere as never, "@alice")).toBeNull();
    sphere.resolve.mockReturnValueOnce(new Promise(() => undefined));
    expect(await payeeKey(sphere as never, "@alice", 10)).toBeNull();
  });
});

describe("remainderOutcome", () => {
  const partial = (cause?: unknown) => new sdk.PartialSendConflictError("partly sent", "tx-p", ["tok"], "400", cause);

  it("is not_sent when the remainder was never attempted or failed before spending", () => {
    expect(remainderOutcome(partial())).toBe("not_sent");
    expect(remainderOutcome(partial(new sdk.SphereError("short", "SEND_INSUFFICIENT_BALANCE")))).toBe("not_sent");
    expect(remainderOutcome(partial(sdkError("SEND_QUEUE_FULL")))).toBe("not_sent");
  });

  it.each([
    ["SEND_SYNC_PENDING", new sdk.SphereError("committed", "SEND_SYNC_PENDING")],
    ["CERTIFICATION_UNCONFIRMED", new sdk.SphereError("keep open", "CERTIFICATION_UNCONFIRMED")],
    ["a wallet-api NOT_FOUND", { code: "NOT_FOUND" }],
    ["TRANSFER_CONFLICT", sdkError("TRANSFER_CONFLICT")],
    ["an uncoded error", new TypeError("socket hang up")],
    ["a pre-spend code flagged mayHaveCertified", sdkError("INVALID_RECIPIENT", "x", { mayHaveCertified: true })],
    ["null", null],
  ])("is unknown for a cause of %s", (_label, cause) => {
    expect(remainderOutcome(partial(cause))).toBe("unknown");
  });
});

describe("pendingTransferIds", () => {
  it("snapshots transfer ids", async () => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("a"), pendingRow("b", { kind: "shortfall" })]);
    expect(await pendingTransferIds(payments as never)).toEqual(new Set(["a", "b"]));
  });

  it("is null when the read fails, throws synchronously or hangs", async () => {
    payments.pendingTransfers.mockRejectedValue(new Error("x"));
    expect(await pendingTransferIds(payments as never)).toBeNull();
    payments.pendingTransfers.mockImplementation(() => {
      throw new Error("sync");
    });
    expect(await pendingTransferIds(payments as never)).toBeNull();
    payments.pendingTransfers.mockReturnValue(new Promise(() => undefined));
    expect(await pendingTransferIds(payments as never, 10)).toBeNull();
  });
});

describe("readPendingTransfers", () => {
  it("returns the rows, or null when the read fails or hangs", async () => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("a")]);
    expect(await readPendingTransfers(payments as never)).toEqual([pendingRow("a")]);
    payments.pendingTransfers.mockRejectedValue(new Error("x"));
    expect(await readPendingTransfers(payments as never)).toBeNull();
    payments.pendingTransfers.mockReturnValue(new Promise(() => undefined));
    expect(await readPendingTransfers(payments as never, 10)).toBeNull();
  });
});

describe("settlingTo", () => {
  const KEY = "ab".repeat(32);

  it("matches open transfers to the recipient under any spelling of its key, never shortfalls", () => {
    const rows = [
      pendingRow("a", { recipient: `02${KEY}` }),
      pendingRow("b", { recipient: KEY.toUpperCase() }),
      pendingRow("c", { recipient: `02${KEY}`, kind: "shortfall" }),
      pendingRow("d", { recipient: `03${"cd".repeat(32)}` }),
      pendingRow("e", { recipient: "" }),
      pendingRow("f", { recipient: 7 }),
    ];
    expect(settlingTo(rows as never, `03${KEY}`)).toEqual(["a", "b"]);
    expect(settlingTo(rows as never, KEY)).toEqual(["a", "b"]);
  });

  it("finds nothing without rows or a key", () => {
    expect(settlingTo(null, KEY)).toEqual([]);
    expect(settlingTo([pendingRow("a", { recipient: "" })] as never, "")).toEqual([]);
    expect(settlingTo([pendingRow("a", { recipient: KEY })] as never, undefined)).toEqual([]);
  });
});

describe("settlingTransferLines", () => {
  // sdk 0.18.1 journalOnlyRow: an intent that completed but still owes a deposit carries no coin or amount.
  const journalOnly = (id: string) => pendingRow(id, { kind: "open", coinId: "", amount: "", deliveryPending: true, createdAt: 0 });

  it("never prints an empty coin or amount for a completed transfer whose delivery is pending", () => {
    const [line] = settlingTransferLines([journalOnly("j1")] as never, 5);
    expect(line).toBe("- j1: a completed transfer (amount not recorded by the wallet) to 02aa (1/1 legs certified, delivery pending)");
    expect(line).not.toContain("base units of coin");
  });

  it("names the payment such a transfer belongs to from the payment ledger, never as the transfer's own amount", () => {
    // A partial send's error carries its FIRST attempt's transfer id, and a send that succeeded after a partial
    // attempt returns its LAST attempt's id; either way the ledger holds the full amount, which that transfer may not carry.
    const e = recordIntent("send", paymentKey("b0".repeat(32), UCT, 1_500_000_000_000_000_000n));
    settle(e.id, "possibly_committed", { transferId: "j1", note: "SEND_PARTIALLY_COMPLETED" });
    expect(settlingTransferLines([journalOnly("j1")] as never, 5)).toEqual([
      "- j1: part or all of a 1.5 UCT payment to 02aa (1/1 legs certified, delivery pending)",
    ]);
  });

  it("says so for an open transfer whose details cannot be read, and names a token-addressed one by its token", () => {
    const rows = [
      pendingRow("u1", { coinId: "", amount: "", deliveryPending: false, createdAt: 5 }),
      pendingRow("t1", { coinId: "", amount: "", tokenId: "tok-1" }),
      pendingRow("s1", { kind: "shortfall" }),
    ];
    expect(settlingTransferLines(rows as never, 5)).toEqual([
      "- u1: a transfer (details unreadable) to 02aa (1/1 legs certified)",
      "- t1: token tok-1 to 02aa (1/1 legs certified, delivery pending)",
    ]);
    expect(settlingTransferLines(rows as never, 1)).toHaveLength(1);
  });
});

describe("pendingTransfersNote", () => {
  it("lists settling transfers", async () => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("t1", { amount: "1000000000000000000", legs: { certified: 1, total: 2 } })]);
    expect(await pendingTransfersNote(payments as never)).toContain("t1: 1 UCT to 02aa (1/2 legs certified, delivery pending)");
  });

  it("lists a completed transfer whose delivery is pending without an empty amount", async () => {
    payments.pendingTransfers.mockResolvedValue([pendingRow("j1", { coinId: "", amount: "", createdAt: 0 })]);
    const note = await pendingTransfersNote(payments as never);
    expect(note).toContain("- j1: a completed transfer (amount not recorded by the wallet) to 02aa");
    expect(note).not.toContain('base units of coin ""');
  });

  // sdk 0.18.1 removes a partial send's shortfall row only when that same send finishes: the row of a send that threw
  // stays listed for good, also after the remainder was paid separately.
  const minutesAgo = (m: number) => Date.now() - m * 60_000;
  const shortfall = (id: string, amount: string, createdAt: number) =>
    pendingRow(id, { kind: "shortfall", amount, deliveryPending: false, createdAt });

  it("never calls an earlier shortfall owed and lists it apart from the transfers still settling", async () => {
    const at = minutesAgo(5);
    payments.pendingTransfers.mockResolvedValue([pendingRow("t1"), shortfall("t2", "40000000000000000000", at)]);
    for (const opts of [undefined, { before: new Set(["t1", "t2"]) }, { before: null }]) {
      const note = await pendingTransfersNote(payments as never, opts);
      expect(note).toMatch(/^\nTransfers still settling:\n- t1: [^\n]*\n\nPartial sends the wallet still lists/);
      expect(note).toContain("NOT proof that anything remains unpaid");
      expect(note).toContain(`- t2: 40 UCT to 02aa, shortfall of a partial send at ${new Date(at).toISOString()} (may have been paid separately since)`);
      expect(note).not.toMatch(/owed/);
      // A missing history row is never offered as the check that a remainder is still unpaid.
      expect(note).not.toMatch(/check unicity_get_transaction_history before paying/);
      expect(note).toContain("their absence does NOT show that nothing went out");
    }
  });

  it("labels the call's own shortfalls: the newest with the remainder's amount is the remainder, older ones superseded", async () => {
    payments.pendingTransfers.mockResolvedValue([
      shortfall("old", "20", minutesAgo(5)),
      shortfall("first", "70", minutesAgo(0.2)),
      shortfall("second", "20", minutesAgo(0.1)),
    ]);
    const before = new Set(["old"]);
    const notSent = await pendingTransfersNote(payments as never, { before, remainder: { outcome: "not_sent", amount: "20" } });
    expect(notSent).toMatch(/- second: .*\(this payment's unsent remainder\)/);
    expect(notSent).toMatch(/- first: .*\(superseded by a later attempt of this payment\)/);
    expect(notSent).toMatch(/- old: .*\(may have been paid separately since\)/);
    expect(notSent.indexOf("- second")).toBeLessThan(notSent.indexOf("- first"));
    const unknown = await pendingTransfersNote(payments as never, { before, remainder: { outcome: "unknown", amount: "20" } });
    expect(unknown).toMatch(/- second: .*\(remainder attempted again, outcome unknown\)/);
    expect(unknown).toMatch(/- first: .*\(superseded by a later attempt of this payment\)/);
    expect(unknown).toMatch(/- old: .*\(may have been paid separately since\)/);
  });

  it("does not call another payment's new shortfall superseded by this one", async () => {
    payments.pendingTransfers.mockResolvedValue([
      shortfall("other", "70", minutesAgo(0.2)),
      { ...shortfall("elsewhere", "70", minutesAgo(0.2)), recipient: "02bb" },
      shortfall("mine", "20", minutesAgo(0.1)),
    ]);
    const note = await pendingTransfersNote(payments as never, { before: new Set(), remainder: { outcome: "not_sent", amount: "20" } });
    expect(note).toMatch(/- mine: .*\(this payment's unsent remainder\)/);
    expect(note).toMatch(/- other: .*\(superseded by a later attempt of this payment\)/);
    expect(note).toMatch(/- elsewhere: .*\(may have been paid separately since\)/);
  });

  it("ties the remainder to the row with its amount, not to a newer shortfall another payment left meanwhile", async () => {
    payments.pendingTransfers.mockResolvedValue([
      shortfall("mine", "20", minutesAgo(0.2)),
      shortfall("same-payee", "70", minutesAgo(0.1)),
      { ...shortfall("other-payee", "50", minutesAgo(0.05)), recipient: "02bb" },
    ]);
    const note = await pendingTransfersNote(payments as never, { before: new Set(), remainder: { outcome: "not_sent", amount: "20" } });
    expect(note).toMatch(/- mine: .*\(this payment's unsent remainder\)/);
    expect(note).toMatch(/- same-payee: .*\(may have been paid separately since\)/);
    expect(note).toMatch(/- other-payee: .*\(may have been paid separately since\)/);
  });

  it("claims no row for the call without a snapshot from before it", async () => {
    payments.pendingTransfers.mockResolvedValue([shortfall("a", "20", minutesAgo(0.1))]);
    const note = await pendingTransfersNote(payments as never, { before: null, remainder: { outcome: "not_sent", amount: "20" } });
    expect(note).toMatch(/- a: .*\(may have been paid separately since\)/);
    expect(note).not.toMatch(/remainder\)|superseded/);
  });

  it("leaves out shortfalls from before the call that are older than the duplicate window", async () => {
    payments.pendingTransfers.mockResolvedValue([shortfall("stale", "20", minutesAgo(16))]);
    expect(await pendingTransfersNote(payments as never, { before: new Set(["stale"]) })).toBe("");
    expect(await pendingTransfersNote(payments as never, { before: null })).toContain("- stale:");
    payments.pendingTransfers.mockResolvedValue([pendingRow("t1"), shortfall("stale", "20", 0)]);
    const note = await pendingTransfersNote(payments as never, { before: new Set(["t1", "stale"]) });
    expect(note).toContain("- t1:");
    expect(note).not.toMatch(/stale|Partial sends/);
  });

  it("returns nothing when the read fails or hangs", async () => {
    payments.pendingTransfers.mockRejectedValue(new Error("x"));
    expect(await pendingTransfersNote(payments as never)).toBe("");
    payments.pendingTransfers.mockReturnValue(new Promise(() => undefined));
    expect(await pendingTransfersNote(payments as never, { timeoutMs: 10 })).toBe("");
  });
});
