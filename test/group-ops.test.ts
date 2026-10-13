import { afterEach, describe, expect, it, vi } from "vitest";
import { beginGroupOp, endGroupOp, groupOpsIdle } from "../src/group-ops.js";

/** Resolves to whether `p` settled within the current macrotask turn. */
async function settledNow(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  return done;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("group operations in flight", () => {
  it("is idle at once when no operation runs", async () => {
    expect(await settledNow(groupOpsIdle())).toBe(true);
  });

  it("waits until every operation in flight has ended", async () => {
    beginGroupOp();
    beginGroupOp();
    const idle = groupOpsIdle();
    expect(await settledNow(idle)).toBe(false);
    endGroupOp();
    expect(await settledNow(idle)).toBe(false);
    endGroupOp();
    expect(await settledNow(idle)).toBe(true);
  });

  it("stops waiting after maxMs, so a hung operation cannot hold it back forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    beginGroupOp();
    const idle = groupOpsIdle(30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await settledNow(idle)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settledNow(idle)).toBe(true);
    endGroupOp();
  });

  it("never counts below zero: an extra end does not make a later operation look finished", async () => {
    endGroupOp();
    beginGroupOp();
    const idle = groupOpsIdle();
    expect(await settledNow(idle)).toBe(false);
    endGroupOp();
    expect(await settledNow(idle)).toBe(true);
  });

  it("is shared by every copy of the module (a plugin reload re-imports it)", async () => {
    vi.resetModules();
    const reloaded = await import("../src/group-ops.js");
    beginGroupOp();
    const idle = reloaded.groupOpsIdle();
    expect(await settledNow(idle)).toBe(false);
    endGroupOp();
    expect(await settledNow(idle)).toBe(true);
  });
});
