import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@unicitylabs/sphere-sdk", () => ({
  isValidNametag: (n: string) => /^[a-z0-9_-]{3,20}$/.test(n) || /^\+[1-9][0-9]{6,14}$/.test(n),
}));

import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import {
  AllowFromResolver,
  PairingChallenger,
  classifyAllowEntry,
  decideDmAccess,
  effectiveDmPolicy,
  formatAllowEntry,
  hasConfiguredCommandOwner,
  normalizeAllowEntry,
  stripChannelPrefix,
} from "../src/access.js";
import type { DmPolicy } from "../src/config.js";

const SENDER = "c".repeat(64);
const OTHER = "d".repeat(64);
const ALICE = "e".repeat(64);

function decide(policy: DmPolicy, over: Partial<Parameters<typeof decideDmAccess>[0]> = {}) {
  return decideDmAccess({
    policy,
    senderKey: SENDER,
    isOwner: false,
    allowKeys: new Set(),
    allowAll: false,
    pairedKeys: new Set(),
    mayPair: true,
    ...over,
  });
}

describe("decideDmAccess", () => {
  it("disabled drops everyone, the owner included", () => {
    expect(decide("disabled")).toEqual({ kind: "drop", reason: "dm-disabled" });
    expect(decide("disabled", { isOwner: true })).toEqual({ kind: "drop", reason: "dm-disabled" });
  });

  it("admits the owner under open, allowlist and pairing", () => {
    for (const policy of ["open", "allowlist", "pairing"] as const) {
      expect(decide(policy, { isOwner: true })).toEqual({ kind: "admit", isOwner: true });
    }
  });

  it("open admits strangers", () => {
    expect(decide("open")).toEqual({ kind: "admit", isOwner: false });
  });

  it("allowlist admits listed keys or '*', drops others and never pairs", () => {
    expect(decide("allowlist", { allowKeys: new Set([SENDER]) })).toEqual({ kind: "admit", isOwner: false });
    expect(decide("allowlist", { allowAll: true })).toEqual({ kind: "admit", isOwner: false });
    expect(decide("allowlist", { allowKeys: new Set([OTHER]) })).toEqual({ kind: "drop", reason: "not-allowlisted" });
    expect(decide("allowlist", { pairedKeys: new Set([SENDER]) })).toEqual({ kind: "drop", reason: "not-allowlisted" });
  });

  it("pairing admits listed or paired keys and challenges the rest", () => {
    expect(decide("pairing", { allowKeys: new Set([SENDER]) })).toEqual({ kind: "admit", isOwner: false });
    expect(decide("pairing", { pairedKeys: new Set([SENDER]) })).toEqual({ kind: "admit", isOwner: false });
    expect(decide("pairing")).toEqual({ kind: "pair" });
  });

  it("pairing never challenges when pairing is not allowed (wallet events)", () => {
    expect(decide("pairing", { mayPair: false })).toEqual({ kind: "drop", reason: "not-paired" });
  });
});

describe("effectiveDmPolicy", () => {
  it("defaults to open", () => {
    expect(effectiveDmPolicy(undefined, undefined)).toBe("open");
    expect(effectiveDmPolicy(undefined, [])).toBe("open");
  });

  it("treats open with concrete entries as allowlist, but not with '*'", () => {
    expect(effectiveDmPolicy("open", ["@alice"])).toBe("allowlist");
    expect(effectiveDmPolicy("open", ["*", "@alice"])).toBe("open");
    expect(effectiveDmPolicy(undefined, [SENDER])).toBe("allowlist");
  });

  it("keeps explicit non-open policies", () => {
    expect(effectiveDmPolicy("pairing", ["@alice"])).toBe("pairing");
    expect(effectiveDmPolicy("disabled", [])).toBe("disabled");
  });
});

describe("hasConfiguredCommandOwner", () => {
  it("counts only concrete commands.ownerAllowFrom entries, like core", () => {
    expect(hasConfiguredCommandOwner({ commands: { ownerAllowFrom: [`unicity:${SENDER}`] } })).toBe(true);
    expect(hasConfiguredCommandOwner({ commands: { ownerAllowFrom: ["*", "telegram:123"] } })).toBe(true);
    for (const cfg of [undefined, null, {}, { commands: {} }, { commands: { ownerAllowFrom: "unicity:x" } }]) {
      expect(hasConfiguredCommandOwner(cfg)).toBe(false);
    }
    for (const ownerAllowFrom of [[], ["*"], ["unicity:*"], ["  ", ""], [null, { id: 1 }]]) {
      expect(hasConfiguredCommandOwner({ commands: { ownerAllowFrom } })).toBe(false);
    }
  });
});

describe("allowFrom entry normalization", () => {
  it("strips the channel prefix", () => {
    expect(stripChannelPrefix(" Unicity:@bob ")).toBe("@bob");
    expect(stripChannelPrefix("@bob")).toBe("@bob");
  });

  it("normalizes hex keys to x-only lowercase", () => {
    expect(normalizeAllowEntry(`03${"A".repeat(64)}`)).toBe("a".repeat(64));
    expect(normalizeAllowEntry(`unicity:${"B".repeat(64)}`)).toBe("b".repeat(64));
  });

  it("normalizes nametags to @lowercase and keeps '*'", () => {
    expect(normalizeAllowEntry("Alice")).toBe("@alice");
    expect(normalizeAllowEntry(" @Bob ")).toBe("@bob");
    expect(normalizeAllowEntry("*")).toBe("*");
  });

  it("formats entries for core command auth without '@'", () => {
    expect(formatAllowEntry("@Alice")).toBe("alice");
    expect(formatAllowEntry(`02${"c".repeat(64)}`)).toBe("c".repeat(64));
  });

  it("classifies pubkeys as verified and nametags as asserted", () => {
    expect(classifyAllowEntry(SENDER)).toBe("verified");
    expect(classifyAllowEntry("@alice")).toBe("asserted");
    expect(classifyAllowEntry("*")).toBeUndefined();
    expect(classifyAllowEntry("not a valid entry!")).toBeUndefined();
  });
});

type PeerLike = { transportPubkey: string; chainPubkey: string; nametag?: string } | null;

function sphereWith(resolve: (id: string) => Promise<PeerLike>) {
  const fn = vi.fn(resolve);
  return { sphere: { resolve: fn } as unknown as Sphere, resolve: fn };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("AllowFromResolver", () => {
  beforeEach(() => {
    vi.useRealTimers();
    log.warn.mockClear();
  });

  it("passes hex keys through and recognizes '*'", async () => {
    const r = new AllowFromResolver(() => null, log);
    const out = await r.resolve([`02${SENDER}`, "*"]);
    expect([...out.keys]).toEqual([SENDER]);
    expect(out.allowAll).toBe(true);
  });

  it("resolves nametags forward to self-consistent binding keys", async () => {
    const { sphere, resolve } = sphereWith(async (id) =>
      id === "@alice" ? { transportPubkey: ALICE, chainPubkey: `02${ALICE}`, nametag: "alice" } : null,
    );
    const r = new AllowFromResolver(() => sphere, log);
    const out = await r.resolve(["@alice", "@nobody"]);
    expect([...out.keys]).toEqual([ALICE]);
    expect(out.allowAll).toBe(false);
    expect(resolve).toHaveBeenCalledWith("@alice");
  });

  it("rejects bindings whose chain key does not match the transport key", async () => {
    const { sphere } = sphereWith(async () => ({ transportPubkey: ALICE, chainPubkey: `02${OTHER}` }));
    const r = new AllowFromResolver(() => sphere, log);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("not self-consistent"));
  });

  it("rejects bindings without a chain key, like owner pinning and name verification", async () => {
    const { sphere } = sphereWith(async () => ({ transportPubkey: ALICE, chainPubkey: "" }));
    const r = new AllowFromResolver(() => sphere, log);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("@alice"));
  });

  it("keeps the last good key when a lookup times out", async () => {
    vi.useFakeTimers();
    let hang = false;
    const { sphere } = sphereWith((): Promise<PeerLike> => (hang ? new Promise(() => {}) : Promise.resolve({ transportPubkey: ALICE, chainPubkey: `02${ALICE}` })));
    const r = new AllowFromResolver(() => sphere, log);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([ALICE]);
    hang = true;
    vi.advanceTimersByTime(6 * 60_000);
    const pending = r.resolve(["@alice"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toEqual({ keys: new Set([ALICE]), allowAll: false, unresolved: [] });
  });

  it("caches lookups", async () => {
    const { sphere, resolve } = sphereWith(async () => ({ transportPubkey: ALICE, chainPubkey: `03${ALICE}` }));
    const r = new AllowFromResolver(() => sphere, log);
    await r.resolve(["@alice"]);
    await r.resolve(["@alice"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good key when a later lookup errors, but fails closed when the name disappears", async () => {
    vi.useFakeTimers();
    let mode: "ok" | "error" | "absent" = "ok";
    const { sphere } = sphereWith(async () => {
      if (mode === "error") throw new Error("relay down");
      return mode === "ok" ? { transportPubkey: ALICE, chainPubkey: `02${ALICE}` } : null;
    });
    const r = new AllowFromResolver(() => sphere, log);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([ALICE]);
    mode = "error";
    vi.advanceTimersByTime(6 * 60_000);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([ALICE]);
    mode = "absent";
    vi.advanceTimersByTime(2 * 60_000);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([]);
  });

  it("fails closed when no wallet is open", async () => {
    const r = new AllowFromResolver(() => null, log);
    expect([...(await r.resolve(["@alice"])).keys]).toEqual([]);
  });

  it("reports a name whose lookup failed with no last good key as unresolved, also while that miss is cached", async () => {
    let mode: "error" | "absent" | "ok" = "error";
    const { sphere, resolve } = sphereWith(async (id) => {
      if (mode === "error" && id === "@alice") throw new Error("relay down");
      return mode === "ok" && id === "@alice" ? { transportPubkey: ALICE, chainPubkey: `02${ALICE}` } : null;
    });
    vi.useFakeTimers();
    const r = new AllowFromResolver(() => sphere, log);
    expect(await r.resolve(["@alice", "@nobody", SENDER])).toEqual({ keys: new Set([SENDER]), allowAll: false, unresolved: ["@alice"] });
    expect(await r.resolve(["@alice"])).toEqual({ keys: new Set(), allowAll: false, unresolved: ["@alice"] });
    expect(resolve).toHaveBeenCalledTimes(2);
    // A name that is not bound is an answer: it fails closed, and is not unresolved.
    mode = "absent";
    vi.advanceTimersByTime(2 * 60_000);
    expect(await r.resolve(["@alice"])).toEqual({ keys: new Set(), allowAll: false, unresolved: [] });
    mode = "ok";
    vi.advanceTimersByTime(2 * 60_000);
    expect(await r.resolve(["@alice"])).toEqual({ keys: new Set([ALICE]), allowAll: false, unresolved: [] });
    // Once resolved, a failure keeps the last good key and is not unresolved either.
    mode = "error";
    vi.advanceTimersByTime(6 * 60_000);
    expect(await r.resolve(["@alice"])).toEqual({ keys: new Set([ALICE]), allowAll: false, unresolved: [] });
  });

  it("looks failed names up again on request, keeping last good keys", async () => {
    let up = false;
    const { sphere, resolve } = sphereWith(async (id) => {
      if (!up || id === "@bob") throw new Error("relay down");
      return { transportPubkey: ALICE, chainPubkey: `02${ALICE}` };
    });
    const r = new AllowFromResolver(() => sphere, log);
    expect((await r.resolve(["@alice"])).unresolved).toEqual(["@alice"]);
    up = true;
    expect((await r.resolve(["@alice"])).unresolved).toEqual(["@alice"]);
    r.retryFailed();
    expect(await r.resolve(["@alice"])).toEqual({ keys: new Set([ALICE]), allowAll: false, unresolved: [] });
    expect(resolve).toHaveBeenCalledTimes(2);
    // A cached good key is not looked up again.
    r.retryFailed();
    await r.resolve(["@alice"]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("waits for a slow binding query as long as the SDK does (20 s) before giving up on it", async () => {
    vi.useFakeTimers();
    const { sphere } = sphereWith(
      (id) => new Promise((resolve) => setTimeout(() => resolve(id === "@alice" ? { transportPubkey: ALICE, chainPubkey: `02${ALICE}` } : null), 7_000)),
    );
    const r = new AllowFromResolver(() => sphere, log);
    const slow = r.resolve(["@alice"]);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await slow).toEqual({ keys: new Set([ALICE]), allowAll: false, unresolved: [] });
    const { sphere: hung } = sphereWith(() => new Promise(() => {}));
    const gaveUp = new AllowFromResolver(() => hung, log).resolve(["@bob"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await gaveUp).toEqual({ keys: new Set(), allowAll: false, unresolved: ["@bob"] });
  });

  it("warns about a failed lookup that no last good key stands in for, once per name in ten minutes", async () => {
    vi.useFakeTimers();
    const { sphere } = sphereWith(async () => {
      throw new Error("relay down");
    });
    const r = new AllowFromResolver(() => sphere, log);
    await r.resolve(["@alice", "@bob"]);
    vi.advanceTimersByTime(2 * 60_000);
    await r.resolve(["@alice", "@bob"]);
    const warned = () => log.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("lookup failed"));
    expect(warned()).toEqual([
      expect.stringMatching(/^\[unicity\] allowFrom @alice lookup failed \(relay down\); DMs that only it would admit are not decided/),
      expect.stringContaining("allowFrom @bob lookup failed"),
    ]);
    vi.advanceTimersByTime(10 * 60_000);
    await r.resolve(["@alice"]);
    expect(warned()).toHaveLength(3);
  });

  it("warns once about unrecognized entries", async () => {
    const r = new AllowFromResolver(() => null, log);
    await r.resolve(["not valid!"]);
    await r.resolve(["not valid!"]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

function pairingRuntime(result: { code: string; created: boolean }, store: string[] = []) {
  return {
    upsertPairingRequest: vi.fn(async () => result),
    readAllowFromStore: vi.fn(async () => store),
    buildPairingReply: vi.fn(({ idLine, code }: { idLine: string; code: string }) => `pairing code ${code} (${idLine})`),
    removeAllowFromStoreEntry: vi.fn(),
  } as unknown as PluginRuntime["channel"]["pairing"] & {
    upsertPairingRequest: ReturnType<typeof vi.fn>;
    buildPairingReply: ReturnType<typeof vi.fn>;
  };
}

describe("PairingChallenger", () => {
  it("upserts a request keyed by the x-only key and sends the code only when created", async () => {
    const pairing = pairingRuntime({ code: "ABCD1234", created: true });
    const send = vi.fn(async () => {});
    const c = new PairingChallenger(pairing, "default");
    const res = await c.challenge(SENDER, { claimedNametag: "@mallory" }, send);
    expect(res).toEqual({ code: "ABCD1234", created: true });
    expect(pairing.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "unicity",
      id: SENDER,
      accountId: "default",
      meta: { claimedNametag: "@mallory" },
    });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("ABCD1234"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining(SENDER));
  });

  it("does not reply when the request already existed", async () => {
    const pairing = pairingRuntime({ code: "", created: false });
    const send = vi.fn(async () => {});
    await new PairingChallenger(pairing, "default").challenge(SENDER, undefined, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("throttles repeat challenges for the same key", async () => {
    const pairing = pairingRuntime({ code: "ABCD1234", created: true });
    const c = new PairingChallenger(pairing, "default");
    const send = vi.fn(async () => {});
    await c.challenge(SENDER, undefined, send);
    expect(await c.challenge(SENDER, undefined, send)).toBeNull();
    expect(pairing.upsertPairingRequest).toHaveBeenCalledTimes(1);
    await c.challenge(OTHER, undefined, send);
    expect(pairing.upsertPairingRequest).toHaveBeenCalledTimes(2);
  });

  it("shares the per-sender throttle between challenges and other claims", async () => {
    const pairing = pairingRuntime({ code: "ABCD1234", created: true });
    const c = new PairingChallenger(pairing, "default");
    expect(c.claim(SENDER)).toBe(true);
    expect(c.claim(SENDER)).toBe(false);
    expect(await c.challenge(SENDER, undefined, vi.fn(async () => {}))).toBeNull();
    expect(pairing.upsertPairingRequest).not.toHaveBeenCalled();
  });

  it("reads approved keys as x-only and ignores other entries", async () => {
    const pairing = pairingRuntime({ code: "", created: false }, [`02${SENDER}`, OTHER.toUpperCase(), "@alice", "*"]);
    const keys = await new PairingChallenger(pairing, "default").readPairedKeys();
    expect([...keys].sort()).toEqual([SENDER, OTHER].sort());
  });
});
