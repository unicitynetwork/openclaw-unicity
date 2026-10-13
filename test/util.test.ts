import { afterEach, describe, expect, it, vi } from "vitest";
import { errorMessage, withTimeout } from "../src/util.js";

afterEach(() => vi.useRealTimers());

describe("errorMessage", () => {
  it("returns an Error's message or the stringified value", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });

  it("never throws, whatever was thrown", () => {
    const hostile = { toString: () => { throw new Error("nope"); } };
    expect(errorMessage(Object.create(null))).toBe("unknown error");
    expect(errorMessage(hostile)).toBe("unknown error");
  });
});

describe("withTimeout", () => {
  it("passes the value or rejection of a promise that settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error("inner")), 1_000)).rejects.toThrow("inner");
  });

  it("rejects with a labelled timeout and clears its timer", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 500, "greeting DM");
    const outcome = expect(pending).rejects.toThrow("greeting DM timed out after 500ms");
    await vi.advanceTimersByTimeAsync(500);
    await outcome;
    await withTimeout(Promise.resolve(1), 500);
    expect(vi.getTimerCount()).toBe(0);
  });
});
