import { describe, it, expect, vi, beforeEach } from "vitest";
import { BTC, NAMED_KEY, UCT, makePayments, makeSphere, pendingRow, resetRegistry, resetStorage, text, wallet, type FakePayments } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/sphere.js", async () => (await import("./payments-fixtures.js")).sphereExports());

const { getTransactionHistoryTool } = await import("../../src/tools/get-transaction-history.js");

const RECIPIENT = `02${"1".repeat(64)}`;
const SENDER = `03${"2".repeat(64)}`;
let payments: FakePayments;

beforeEach(() => {
  resetRegistry();
  resetStorage();
  payments = makePayments();
  payments.history.mockResolvedValue({
    entries: [
      { id: "h1", type: "SENT", coinId: UCT, amount: "1500000000000000000", timestamp: Date.UTC(2026, 9, 3), transferId: "tx-sent-full-id", recipientPubkey: RECIPIENT, memo: "coffee" },
      { id: "h2", type: "RECEIVED", coinId: BTC, amount: "25000000", timestamp: Date.UTC(2026, 9, 2), senderPubkey: SENDER, senderNametag: "Alice", tokenId: "t".repeat(64) },
      { id: "h3", type: "MINT", coinId: UCT, amount: "100000000000000000000", timestamp: Date.UTC(2026, 9, 1) },
      { id: "h4", type: "RECEIVED", coinId: "", amount: "0", timestamp: Date.UTC(2026, 8, 30), senderPubkey: SENDER, tokenId: "f".repeat(64) },
    ],
    more: false,
    cursor: null,
  });
  wallet.sphere = makeSphere(payments);
});

describe("unicity_get_transaction_history", () => {
  it("has no BURN/split wording and marks its output as network content", () => {
    expect(getTransactionHistoryTool.description).not.toMatch(/BURN|split|IsOwner/);
    expect(getTransactionHistoryTool.description).toContain("Owner only (enforced by the plugin)");
    expect(getTransactionHistoryTool.resultContentSource).toBe("network");
  });

  it("renders SENT, RECEIVED, MINT and NFT rows with registry decimals", async () => {
    const out = text(await getTransactionHistoryTool.execute("call", {}));
    expect(payments.history).toHaveBeenCalledWith({ limit: 20 });
    expect(out.split("\n")).toEqual([
      `[2026-10-03T00:00:00.000Z] SENT 1.5 UCT to ${"1".repeat(12)}… [transfer tx-sent-full-id] memo: "coffee"`,
      `[2026-10-02T00:00:00.000Z] RECEIVED 0.25 BTC from ${"2".repeat(12)}… (claims @alice, unverified)`,
      "[2026-10-01T00:00:00.000Z] MINT 100 UCT",
      `[2026-09-30T00:00:00.000Z] RECEIVED NFT token ${"f".repeat(12)}… from ${"2".repeat(12)}…`,
    ]);
  });

  it("shows every asset of a multi-asset row, not just the first", async () => {
    // sdk 0.18.1 History.toEntry: coinId/amount carry only the first asset; tokenIds lists all of them.
    payments.history.mockResolvedValueOnce({
      entries: [
        {
          id: "m1",
          type: "RECEIVED",
          coinId: UCT,
          amount: "5000000000000000000",
          tokenIds: [{ id: UCT, amount: "5000000000000000000" }, { id: BTC, amount: "25000000" }],
          timestamp: Date.UTC(2026, 9, 4),
          senderPubkey: SENDER,
        },
      ],
      more: false,
      cursor: null,
    });
    expect(text(await getTransactionHistoryTool.execute("call", {}))).toBe(
      `[2026-10-04T00:00:00.000Z] RECEIVED 5 UCT, 0.25 BTC from ${"2".repeat(12)}…`,
    );
  });

  it("shows a sender's name as verified only when it resolves to the sender's key", async () => {
    // Every nametag resolves to NAMED_KEY in the fake wallet.
    const received = (id: string, senderPubkey: string, senderNametag: string) =>
      ({ id, type: "RECEIVED", coinId: UCT, amount: "1000000000000000000", timestamp: Date.UTC(2026, 9, 4), senderPubkey, senderNametag });
    payments.history.mockResolvedValueOnce({
      entries: [received("r1", `03${NAMED_KEY}`, "alice"), received("r2", SENDER, "alice")],
      more: false,
      cursor: null,
    });
    expect(text(await getTransactionHistoryTool.execute("call", {})).split("\n")).toEqual([
      `[2026-10-04T00:00:00.000Z] RECEIVED 1 UCT from @alice (verified, ${"b0".repeat(6)}…)`,
      `[2026-10-04T00:00:00.000Z] RECEIVED 1 UCT from ${"2".repeat(12)}… (claims @alice, unverified)`,
    ]);
    expect(getTransactionHistoryTool.description).toContain("shows the sender as @name (verified, <key>) only when the name resolves");
    expect(getTransactionHistoryTool.description).not.toContain("Sender names on RECEIVED rows are unverified claims");
  });

  it("reads a failed or slow name lookup as unverified", async () => {
    vi.useFakeTimers();
    try {
      const sphere = wallet.sphere as ReturnType<typeof makeSphere>;
      sphere.resolve.mockImplementation(async (id: string) => (id === "@alice" ? Promise.reject(new Error("relay down")) : new Promise(() => {})));
      payments.history.mockResolvedValueOnce({
        entries: [
          { id: "r1", type: "RECEIVED", coinId: UCT, amount: "1", timestamp: 0, senderPubkey: `03${NAMED_KEY}`, senderNametag: "alice" },
          { id: "r2", type: "RECEIVED", coinId: UCT, amount: "1", timestamp: 0, senderPubkey: `03${NAMED_KEY}`, senderNametag: "bob" },
        ],
        more: false,
        cursor: null,
      });
      const result = getTransactionHistoryTool.execute("call", {});
      await vi.advanceTimersByTimeAsync(5_000);
      const out = text(await result);
      expect(out).toContain(`from ${"b0".repeat(6)}… (claims @alice, unverified)`);
      expect(out).toContain(`from ${"b0".repeat(6)}… (claims @bob, unverified)`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up every sender's name at once, so slow lookups hold the history up one lookup timeout at most", async () => {
    vi.useFakeTimers();
    try {
      (wallet.sphere as ReturnType<typeof makeSphere>).resolve.mockImplementation(() => new Promise(() => {}));
      payments.history.mockResolvedValueOnce({
        entries: ["alice", "bob", "carol"].map((name, i) => (
          { id: `r${i}`, type: "RECEIVED", coinId: UCT, amount: "1", timestamp: 0, senderPubkey: `03${NAMED_KEY}`, senderNametag: name }
        )),
        more: false,
        cursor: null,
      });
      let settled = false;
      const result = getTransactionHistoryTool.execute("call", {}).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(text(await result)).toContain(`from ${"b0".repeat(6)}… (claims @carol, unverified)`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail the whole listing on a row with a missing timestamp", async () => {
    payments.history.mockResolvedValueOnce({ entries: [{ id: "x", type: "MINT", coinId: UCT, amount: "1000000000000000000" }], more: false, cursor: null });
    expect(text(await getTransactionHistoryTool.execute("call", {}))).toBe("[unknown time] MINT 1 UCT");
  });

  it("passes the requested limit, capped at 100", async () => {
    await getTransactionHistoryTool.execute("call", { limit: 5 });
    expect(payments.history).toHaveBeenLastCalledWith({ limit: 5 });
    await getTransactionHistoryTool.execute("call", { limit: 1000 });
    expect(payments.history).toHaveBeenLastCalledWith({ limit: 100 });
  });

  it("reports empty history and server failures", async () => {
    payments.history.mockResolvedValueOnce({ entries: [], more: false, cursor: null });
    expect(text(await getTransactionHistoryTool.execute("call", {}))).toBe("No transaction history.");
    payments.history.mockRejectedValueOnce(new Error("wallet-api 503"));
    const failed = await getTransactionHistoryTool.execute("call", {});
    expect(failed.details).toMatchObject({ status: "error", code: "history_unavailable" });
    expect(text(failed)).toContain("wallet-api 503");
  });

  describe("transfers still settling (sdk 0.18.1 writes a SENT row only once a transfer completes)", () => {
    it("lists open transfers apart, never partial-send shortfalls, and says a missing row is no proof", async () => {
      payments.pendingTransfers.mockResolvedValue([
        pendingRow("tx-open", { amount: "2000000000000000000", recipient: RECIPIENT, legs: { certified: 1, total: 2 } }),
        pendingRow("tx-journal", { coinId: "", amount: "", recipient: RECIPIENT }),
        pendingRow("tx-short", { kind: "shortfall", amount: "5" }),
      ]);
      const result = await getTransactionHistoryTool.execute("call", {});
      const out = text(result);
      expect(out).toContain(
        "\n\nStill settling (in progress, not in the history yet):\n" +
          `- tx-open: 2 UCT to ${RECIPIENT} (1/2 legs certified, delivery pending)\n` +
          `- tx-journal: a completed transfer (amount not recorded by the wallet) to ${RECIPIENT} (1/1 legs certified, delivery pending)`,
      );
      expect(out.startsWith(`[2026-10-03T00:00:00.000Z] SENT 1.5 UCT`)).toBe(true);
      expect(out).not.toContain("tx-short");
      expect(result.details).toMatchObject({ count: 4, settling: 2 });
      expect(getTransactionHistoryTool.description).toContain("a missing row does not prove that nothing was sent");
    });

    it("lists them when the history is still empty", async () => {
      payments.history.mockResolvedValueOnce({ entries: [], more: false, cursor: null });
      payments.pendingTransfers.mockResolvedValue([pendingRow("tx-open", { amount: "1000000000000000000" })]);
      expect(text(await getTransactionHistoryTool.execute("call", {}))).toBe(
        "No transaction history.\n\nStill settling (in progress, not in the history yet):\n- tx-open: 1 UCT to 02aa (1/1 legs certified, delivery pending)",
      );
    });

    it("says so when they cannot be read", async () => {
      payments.pendingTransfers.mockRejectedValue(new Error("kv down"));
      const result = await getTransactionHistoryTool.execute("call", {});
      expect(text(result)).toContain("Still settling (in progress, not in the history yet): the wallet's pending transfers could not be read.");
      expect(result.details).toMatchObject({ settling: null });
    });
  });

  it("reports a wallet that is not ready", async () => {
    wallet.sphere = null;
    expect((await getTransactionHistoryTool.execute("call", {})).details).toMatchObject({ code: "wallet_not_ready" });
  });
});
