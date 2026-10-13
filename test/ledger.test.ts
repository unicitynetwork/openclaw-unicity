import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ledgerEntries, memFiles, resetStorage, storageControl, MEM_LEDGER_PATH, MEM_OUTGOING_REQUESTS_PATH } from "./tools/payments-fixtures.js";

vi.mock("../src/storage.js", async () => (await import("./tools/payments-fixtures.js")).storageExports);

const {
  DUPLICATE_WINDOW_MS,
  UNRESOLVED_WINDOW_MS,
  findBlockingEntry,
  latestPayAttempts,
  listOutgoingRequests,
  paymentKey,
  recordIntent,
  recordOutgoingRequest,
  recordPossiblyCommitted,
  recordedSendAmounts,
  settle,
} = await import("../src/ledger.js");

const MINUTE = 60_000;

beforeEach(() => {
  resetStorage();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("paymentKey", () => {
  it("treats @name and name alike and ignores case", () => {
    expect(paymentKey("@Alice", "ABCD", 5n)).toBe(paymentKey(" alice ", "abcd", 5n));
    expect(paymentKey("alice", "abcd", 5n)).not.toBe(paymentKey("alice", "abcd", 6n));
  });
});

describe("intent ledger", () => {
  it("persists an intent before the operation and settles it later", () => {
    const entry = recordIntent("send", "k1");
    expect(ledgerEntries()).toEqual([expect.objectContaining({ id: entry.id, op: "send", key: "k1", state: "intent" })]);
    settle(entry.id, "done", { transferId: "tx-1" });
    expect(ledgerEntries()[0]).toMatchObject({ state: "done", transferId: "tx-1" });
  });

  it("finds a recent identical operation in any state but failed", () => {
    const a = recordIntent("send", "k1");
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)?.id).toBe(a.id);
    settle(a.id, "possibly_committed", { transferId: "tx-a" });
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)?.state).toBe("possibly_committed");
    settle(a.id, "failed");
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toBeNull();
  });

  it("matches only the same op and key", () => {
    recordIntent("send", "k1");
    expect(findBlockingEntry("pay", ["k1"], DUPLICATE_WINDOW_MS)).toBeNull();
    expect(findBlockingEntry("send", ["k2"], DUPLICATE_WINDOW_MS)).toBeNull();
  });

  it("ignores entries older than the window", () => {
    recordIntent("send", "k1");
    vi.advanceTimersByTime(DUPLICATE_WINDOW_MS + 1);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toBeNull();
  });

  it("returns the most recent match", () => {
    recordIntent("send", "k1");
    vi.advanceTimersByTime(1000);
    const later = recordIntent("send", "k1");
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)?.id).toBe(later.id);
  });

  it("throws from recordIntent when the intent cannot be written", () => {
    storageControl.failWrites = true;
    expect(() => recordIntent("send", "k1")).toThrow("disk full");
  });

  it("never throws from settle and keeps the conservative intent state", () => {
    const entry = recordIntent("send", "k1");
    storageControl.failWrites = true;
    expect(() => settle(entry.id, "failed")).not.toThrow();
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)?.state).toBe("intent");
    expect(() => settle("missing", "done")).not.toThrow();
  });

  it("is bounded to the most recent 500 entries per operation", () => {
    for (let i = 0; i < 510; i++) recordIntent("send", `k${i}`);
    const entries = ledgerEntries();
    expect(entries).toHaveLength(500);
    expect(entries[0].key).toBe("k10");
  });

  it("never lets a flood of one operation evict another's entries", () => {
    const pay = recordIntent("pay", "request-1");
    settle(pay.id, "possibly_committed", { transferId: "tx-1" });
    recordIntent("send", "s1");
    for (let i = 0; i < 600; i++) recordIntent("request", `r${i}`);
    expect(findBlockingEntry("pay", ["request-1"], DUPLICATE_WINDOW_MS)).toMatchObject({ state: "possibly_committed", transferId: "tx-1" });
    expect(findBlockingEntry("send", ["s1"], DUPLICATE_WINDOW_MS)).not.toBeNull();
    expect(ledgerEntries().filter((e) => e.op === "request")).toHaveLength(500);
    settle(pay.id, "done");
    expect(findBlockingEntry("pay", ["request-1"], DUPLICATE_WINDOW_MS)?.state).toBe("done");
  });

  it("reads a missing ledger as empty and skips foreign rows", () => {
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toBeNull();
    memFiles.set(MEM_LEDGER_PATH, JSON.stringify([{ bogus: true }, null]));
    recordIntent("send", "k1");
    expect(ledgerEntries()).toHaveLength(1);
  });

  it.each([
    ["corrupt", "{not json"],
    ["not an array", JSON.stringify({ entries: [] })],
  ])("never treats a %s ledger as empty or overwrites it", (_label, bytes) => {
    memFiles.set(MEM_LEDGER_PATH, bytes);
    expect(() => findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toThrow();
    expect(() => recordIntent("send", "k1")).toThrow();
    expect(memFiles.get(MEM_LEDGER_PATH)).toBe(bytes);
  });

  it("throws on an unreadable ledger, so a possibly-committed record still blocks the retry", () => {
    const entry = recordIntent("send", "k1");
    settle(entry.id, "possibly_committed", { transferId: "tx-1" });
    const bytes = memFiles.get(MEM_LEDGER_PATH);
    storageControl.failReads = "EIO";
    expect(() => findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toThrow("EIO");
    expect(() => recordIntent("send", "k1")).toThrow("EIO");
    expect(() => settle(entry.id, "failed")).not.toThrow();
    storageControl.failReads = null;
    expect(memFiles.get(MEM_LEDGER_PATH)).toBe(bytes);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toMatchObject({ state: "possibly_committed", transferId: "tx-1" });
  });
});

describe("blocking past the duplicate window (settling check)", () => {
  const settled = (state: "done" | "possibly_committed", transferId?: string) => {
    const e = recordIntent("send", "k1");
    settle(e.id, state, { transferId });
    return e;
  };

  it("keeps blocking while the entry's transfer is still pending, in any non-failed state", () => {
    for (const state of ["done", "possibly_committed"] as const) {
      resetStorage();
      settled(state, "tx-1");
      vi.advanceTimersByTime(20 * MINUTE);
      expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS)).toBeNull();
      expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(["tx-1"]) })).toMatchObject({ state });
      expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(["tx-other"]) })).toBeNull();
    }
  });

  it("keeps blocking an unresolved entry with no transfer to look up for the unresolved window", () => {
    recordIntent("send", "k1");
    vi.advanceTimersByTime(60 * MINUTE);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set() })).toMatchObject({ state: "intent" });
    vi.advanceTimersByTime(UNRESOLVED_WINDOW_MS);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set() })).toBeNull();
  });

  it("fails closed when pending transfers could not be read, but not for a completed entry", () => {
    settled("possibly_committed", "tx-1");
    vi.advanceTimersByTime(20 * MINUTE);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: null })).toMatchObject({ state: "possibly_committed" });
    resetStorage();
    settled("done", "tx-2");
    vi.advanceTimersByTime(20 * MINUTE);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: null })).toBeNull();
  });

  it("fails closed for a completed send whose delivery was still pending, for the unresolved window", () => {
    const e = recordIntent("send", "k1");
    settle(e.id, "done", { transferId: "tx-d", deliveryPending: true });
    expect(ledgerEntries()[0]).toMatchObject({ state: "done", transferId: "tx-d", deliveryPending: true });
    vi.advanceTimersByTime(20 * MINUTE);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: null })).toMatchObject({ state: "done", deliveryPending: true });
    // A readable snapshot that no longer lists the transfer ends the block at once.
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set() })).toBeNull();
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(["tx-d"]) })).not.toBeNull();
    vi.advanceTimersByTime(UNRESOLVED_WINDOW_MS);
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: null })).toBeNull();
  });

  it("records deliveryPending only when it is true", () => {
    const e = recordIntent("send", "k1");
    settle(e.id, "done", { transferId: "tx-1", deliveryPending: false });
    expect(ledgerEntries()[0]).not.toHaveProperty("deliveryPending");
  });

  it("honours a custom unresolved window, including no limit", () => {
    recordIntent("pay", "r1");
    vi.advanceTimersByTime(2 * UNRESOLVED_WINDOW_MS);
    expect(findBlockingEntry("pay", ["r1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(), unresolvedWindowMs: Number.POSITIVE_INFINITY })).not.toBeNull();
  });

  it("never blocks on a failed entry", () => {
    const e = recordIntent("send", "k1");
    settle(e.id, "failed", { transferId: "tx-1" });
    expect(findBlockingEntry("send", ["k1"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(["tx-1"]) })).toBeNull();
  });
});

describe("key aliases", () => {
  it("matches an entry under its key or any alias, and stores only distinct aliases", () => {
    const e = recordIntent("send", "canonical", ["typed", "canonical", "typed"]);
    expect(ledgerEntries()[0]).toMatchObject({ key: "canonical", aliases: ["typed"] });
    expect(findBlockingEntry("send", ["typed"], DUPLICATE_WINDOW_MS)?.id).toBe(e.id);
    expect(findBlockingEntry("send", ["other", "canonical"], DUPLICATE_WINDOW_MS)?.id).toBe(e.id);
    expect(findBlockingEntry("send", ["other"], DUPLICATE_WINDOW_MS)).toBeNull();
  });

  it("omits aliases when there are none and ignores malformed ones", () => {
    recordIntent("send", "k1", ["k1"]);
    expect(ledgerEntries()[0]).not.toHaveProperty("aliases");
    memFiles.set(MEM_LEDGER_PATH, JSON.stringify([{ id: "x", op: "send", key: "k2", aliases: "k3", at: Date.now(), state: "intent" }]));
    expect(findBlockingEntry("send", ["k2"], DUPLICATE_WINDOW_MS)?.id).toBe("x");
    expect(findBlockingEntry("send", ["k3"], DUPLICATE_WINDOW_MS)).toBeNull();
  });
});

describe("a pay as the send it makes", () => {
  it("counts a pay recorded with its send key as that send, under the one entry settle() updates", () => {
    const pay = recordIntent("pay", "request-1", undefined, "payee|coin|5");
    expect(ledgerEntries()[0]).toMatchObject({ op: "pay", key: "request-1", sendKey: "payee|coin|5" });
    expect(findBlockingEntry("send", ["typed|coin|5", "payee|coin|5"], DUPLICATE_WINDOW_MS)?.id).toBe(pay.id);
    expect(findBlockingEntry("send", ["payee|coin|6"], DUPLICATE_WINDOW_MS)).toBeNull();
    expect(findBlockingEntry("pay", ["request-1"], DUPLICATE_WINDOW_MS)?.id).toBe(pay.id);
    settle(pay.id, "possibly_committed", { transferId: "tx-p" });
    vi.advanceTimersByTime(20 * MINUTE);
    expect(findBlockingEntry("send", ["payee|coin|5"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(["tx-p"]) })).toMatchObject({ state: "possibly_committed" });
    expect(findBlockingEntry("send", ["payee|coin|5"], DUPLICATE_WINDOW_MS, { pendingIds: new Set() })).toBeNull();
    settle(pay.id, "failed");
    expect(findBlockingEntry("send", ["payee|coin|5"], DUPLICATE_WINDOW_MS, { pendingIds: new Set(["tx-p"]) })).toBeNull();
  });

  it("never counts a send as a pay, nor a pay's send key as a request id", () => {
    recordIntent("send", "payee|coin|5");
    recordIntent("pay", "request-1", undefined, "other|coin|5");
    expect(findBlockingEntry("pay", ["payee|coin|5"], DUPLICATE_WINDOW_MS)).toBeNull();
    expect(findBlockingEntry("pay", ["other|coin|5"], DUPLICATE_WINDOW_MS)).toBeNull();
  });

  it("omits the send key when there is none, and only a pay's counts", () => {
    recordIntent("pay", "request-1");
    expect(ledgerEntries()[0]).not.toHaveProperty("sendKey");
    memFiles.set(MEM_LEDGER_PATH, JSON.stringify([{ id: "m", op: "mint", key: "self|coin|5", sendKey: "payee|coin|5", at: Date.now(), state: "intent" }]));
    expect(findBlockingEntry("send", ["payee|coin|5"], DUPLICATE_WINDOW_MS)).toBeNull();
  });
});

describe("recordPossiblyCommitted", () => {
  it("records an operation as possibly committed, with aliases and transfer", () => {
    recordPossiblyCommitted("send", "k1", { aliases: ["k2"], transferId: "tx-r", note: "remainder of tx-p" });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ op: "send", key: "k1", aliases: ["k2"], state: "possibly_committed", transferId: "tx-r", note: "remainder of tx-p" }),
    ]);
    expect(findBlockingEntry("send", ["k2"], DUPLICATE_WINDOW_MS)).toMatchObject({ state: "possibly_committed" });
  });

  it("never throws and never overwrites an unreadable ledger", () => {
    memFiles.set(MEM_LEDGER_PATH, "{corrupt");
    expect(() => recordPossiblyCommitted("send", "k1")).not.toThrow();
    expect(memFiles.get(MEM_LEDGER_PATH)).toBe("{corrupt");
    resetStorage();
    storageControl.failWrites = true;
    expect(() => recordPossiblyCommitted("send", "k1")).not.toThrow();
  });
});

describe("recordedSendAmounts", () => {
  it("reads the coin and amount of the sends recorded under the given transfer ids", () => {
    const send = recordIntent("send", "b0b0|aabb|1500");
    settle(send.id, "done", { transferId: "tx-1" });
    recordPossiblyCommitted("send", "b0b0|aabb|500", { transferId: "tx-2" });
    const pay = recordIntent("pay", "request-1");
    settle(pay.id, "done", { transferId: "tx-3" });
    const odd = recordIntent("send", "no-amount");
    settle(odd.id, "done", { transferId: "tx-4" });
    const notBaseUnits = recordIntent("send", "b0b0|aabb|1.5");
    settle(notBaseUnits.id, "done", { transferId: "tx-6" });
    const extraField = recordIntent("send", "b0b0|aabb|15|x");
    settle(extraField.id, "done", { transferId: "tx-7" });
    const mint = recordIntent("mint", "self|aabb|7");
    settle(mint.id, "done", { transferId: "tx-8" });
    expect(recordedSendAmounts(["tx-1", "tx-2", "tx-3", "tx-4", "tx-5", "tx-6", "tx-7", "tx-8"])).toEqual(
      new Map([
        ["tx-1", { coinId: "aabb", amount: "1500" }],
        ["tx-2", { coinId: "aabb", amount: "500" }],
      ]),
    );
  });

  it("is empty when the ledger cannot be read", () => {
    const send = recordIntent("send", "b0b0|aabb|1500");
    settle(send.id, "done", { transferId: "tx-1" });
    storageControl.failReads = "EIO";
    expect(recordedSendAmounts(["tx-1"])).toEqual(new Map());
  });
});

describe("latestPayAttempts", () => {
  it("returns the newest non-failed pay entry per request, with no time window", () => {
    const old = recordIntent("pay", "r1");
    settle(old.id, "possibly_committed", { transferId: "tx-1" });
    vi.advanceTimersByTime(1000);
    const retry = recordIntent("pay", "r1");
    settle(retry.id, "failed");
    const other = recordIntent("pay", "r2");
    settle(other.id, "failed");
    recordIntent("send", "r3");
    vi.advanceTimersByTime(365 * 24 * 60 * MINUTE);
    const attempts = latestPayAttempts();
    expect([...(attempts?.keys() ?? [])]).toEqual(["r1"]);
    expect(attempts?.get("r1")).toMatchObject({ id: old.id, state: "possibly_committed", transferId: "tx-1" });
  });

  it("is null when the ledger cannot be read", () => {
    storageControl.failReads = "EIO";
    expect(latestPayAttempts()).toBeNull();
  });
});

describe("data dir resolution", () => {
  it("resolves the data dir before its first read or write, even when no other storage helper ran yet", () => {
    expect(storageControl.resolved).toBe(false);
    recordOutgoingRequest({ requestId: "r1", to: "@bob", coinId: "aa", amount: "1", createdAt: 1 });
    expect(listOutgoingRequests().map((r) => r.requestId)).toEqual(["r1"]);
  });

  it("reads and writes the ledger from a cold start", () => {
    expect(storageControl.resolved).toBe(false);
    recordIntent("send", "k1");
    expect(ledgerEntries()).toHaveLength(1);
  });
});

describe("outgoing payment requests", () => {
  it("lists recorded requests newest first", () => {
    recordOutgoingRequest({ requestId: "r1", to: "@bob", coinId: "aa", amount: "1", createdAt: 1 });
    recordOutgoingRequest({ requestId: "r2", to: "@carol", coinId: "aa", amount: "2", memo: "lunch", createdAt: 2 });
    expect(listOutgoingRequests().map((r) => r.requestId)).toEqual(["r2", "r1"]);
    expect(listOutgoingRequests()[0].memo).toBe("lunch");
  });

  it("keeps the most recent 200", () => {
    for (let i = 0; i < 205; i++) recordOutgoingRequest({ requestId: `r${i}`, to: "@bob", coinId: "aa", amount: "1", createdAt: i });
    const all = listOutgoingRequests();
    expect(all).toHaveLength(200);
    expect(all.at(-1)?.requestId).toBe("r5");
  });

  it("is empty when nothing was recorded and drops malformed rows", () => {
    expect(listOutgoingRequests()).toEqual([]);
    memFiles.set(MEM_OUTGOING_REQUESTS_PATH, JSON.stringify([{ requestId: 5 }, "x", { requestId: "r", to: "@x", toKey: 5, coinId: "aa", amount: "1", createdAt: 1 }]));
    expect(listOutgoingRequests()).toEqual([]);
  });

  it("never lets requests payers asked for evict the owner's own", () => {
    recordOutgoingRequest({ requestId: "owner-1", to: "@bob", coinId: "aa", amount: "1", createdAt: 0, origin: "owner" });
    recordOutgoingRequest({ requestId: "owner-2", to: "@carol", coinId: "aa", amount: "1", createdAt: 1 });
    for (let i = 0; i < 300; i++) {
      const payer = `02${String(i % 30).padStart(2, "0").repeat(32)}`;
      recordOutgoingRequest({ requestId: `s${i}`, to: payer, toKey: payer, coinId: "aa", amount: String(i + 1), createdAt: 2 + i, origin: "sender" });
    }
    const all = listOutgoingRequests();
    expect(all.filter((r) => r.origin !== "sender").map((r) => r.requestId)).toEqual(["owner-2", "owner-1"]);
    expect(all.filter((r) => r.origin === "sender")).toHaveLength(200);
    expect(all.find((r) => r.requestId === "owner-1")?.origin).toBe("owner");
  });

  it("keeps the newest 20 requests per payer, so one payer cannot evict another's", () => {
    const other = `02${"cd".repeat(32)}`;
    const flooder = `03${"ef".repeat(32)}`;
    recordOutgoingRequest({ requestId: "other-1", to: other, toKey: other, coinId: "aa", amount: "1", createdAt: 0, origin: "sender" });
    for (let i = 0; i < 250; i++) {
      recordOutgoingRequest({ requestId: `f${i}`, to: flooder, toKey: flooder, coinId: "aa", amount: String(i + 1), createdAt: 1 + i, origin: "sender" });
    }
    const all = listOutgoingRequests();
    expect(all.map((r) => r.requestId)).toContain("other-1");
    expect(all.filter((r) => r.toKey === flooder).map((r) => r.requestId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `f${249 - i}`),
    );
  });

  it("drops rows with an unknown origin", () => {
    memFiles.set(
      MEM_OUTGOING_REQUESTS_PATH,
      JSON.stringify([{ requestId: "r", to: "@x", coinId: "aa", amount: "1", createdAt: 1, origin: "stranger" }]),
    );
    expect(listOutgoingRequests()).toEqual([]);
  });

  it("keeps the chain key a request was addressed to", () => {
    recordOutgoingRequest({ requestId: "r1", to: "@bob", toKey: `02${"ab".repeat(32)}`, coinId: "aa", amount: "1", createdAt: 1 });
    expect(listOutgoingRequests()[0].toKey).toBe(`02${"ab".repeat(32)}`);
  });

  it("refuses to overwrite an unreadable record", () => {
    memFiles.set(MEM_OUTGOING_REQUESTS_PATH, "[{oops");
    expect(() => listOutgoingRequests()).toThrow();
    expect(() => recordOutgoingRequest({ requestId: "r1", to: "@bob", coinId: "aa", amount: "1", createdAt: 1 })).toThrow();
    expect(memFiles.get(MEM_OUTGOING_REQUESTS_PATH)).toBe("[{oops");
  });
});
