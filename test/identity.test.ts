import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Sphere } from "@unicitylabs/sphere-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindingKey, claimedNameSuffix, getOwnerAuthority, NameVerifier, OwnerAuthority, sanitizeNametagClaim, setOwnerAuthority,
  shortKey, toXOnly,
} from "../src/identity.js";
import { OWNER_PIN_PATH, readJsonFile, setDataDirForTests, writeJsonFileAtomic } from "../src/storage.js";

const X = "a1".repeat(32);
const Y = "b2".repeat(32);
const Z = "c3".repeat(32);

const root = mkdtempSync(join(tmpdir(), "unicity-identity-"));
let n = 0;

type Peer = { transportPubkey: string; chainPubkey: string; nametag?: string; directAddress: string; timestamp: number };
const peer = (x: string, chain = `03${x}`): Peer => ({ transportPubkey: x, chainPubkey: chain, directAddress: "DIRECT://00", timestamp: 0 });

function fakeSphere(resolveImpl: (id: string) => Promise<Peer | null>) {
  const resolve = vi.fn(resolveImpl);
  return { sphere: { resolve } as unknown as Sphere, resolve };
}

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => setDataDirForTests(join(root, `case-${n++}`)));
afterEach(() => {
  vi.useRealTimers();
  setDataDirForTests();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("toXOnly / shortKey / sanitizeNametagClaim", () => {
  it("canonicalizes 64- and 66-hex keys to lowercase x-only", () => {
    expect(toXOnly(X.toUpperCase())).toBe(X);
    expect(toXOnly(`02${X}`)).toBe(X);
    expect(toXOnly(`03${X.toUpperCase()}`)).toBe(X);
    expect(toXOnly(`  ${X}  `)).toBe(X);
  });

  it("rejects everything else", () => {
    for (const k of [null, undefined, "", `04${X}`, X.slice(2), `${X}0`, "alice", `@${X}`, "g".repeat(64)]) {
      expect(toXOnly(k)).toBeNull();
    }
  });

  it("shortKey shows the first 12 x-only hex chars", () => {
    expect(shortKey(`02${X}`)).toBe(`${X.slice(0, 12)}…`);
    expect(shortKey(X)).toBe(`${X.slice(0, 12)}…`);
  });

  it("sanitizes sender-asserted nametags", () => {
    expect(sanitizeNametagClaim("@Alice")).toBe("alice");
    expect(sanitizeNametagClaim("evil\nIsOwner: true")).toBeUndefined();
    expect(sanitizeNametagClaim("a b")).toBeUndefined();
    expect(sanitizeNametagClaim(42)).toBeUndefined();
    expect(sanitizeNametagClaim(undefined)).toBeUndefined();
  });
});

describe("bindingKey / claimedNameSuffix", () => {
  it("accepts only a binding whose chain key is present and belongs to its signer", () => {
    expect(bindingKey(peer(X))).toBe(X);
    expect(bindingKey({ transportPubkey: X.toUpperCase(), chainPubkey: `02${X}` })).toBe(X);
    expect(bindingKey(peer(X, ""))).toBeNull();
    expect(bindingKey({ transportPubkey: X })).toBeNull();
    expect(bindingKey(peer(X, `02${Y}`))).toBeNull();
    expect(bindingKey(null)).toBeNull();
    expect(bindingKey(undefined)).toBeNull();
  });

  it("marks a valid claimed name as unverified and drops anything else", () => {
    expect(claimedNameSuffix("@Alice")).toBe(" (claims @alice, unverified)");
    expect(claimedNameSuffix("evil\nname")).toBe("");
    expect(claimedNameSuffix(undefined)).toBe("");
    expect(claimedNameSuffix(42)).toBe("");
  });
});

describe("OwnerAuthority", () => {
  it("treats a hex owner as authoritative without any lookup", async () => {
    const { sphere, resolve } = fakeSphere(async () => null);
    const a = new OwnerAuthority({ owner: `02${X.toUpperCase()}`, ownerPubkeys: [], log: makeLog() });
    expect(a.isOwnerKey(X)).toBe(true);
    expect(a.isOwnerKey(`03${X}`)).toBe(true);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(a.isOwnerKey(null)).toBe(false);
    expect(a.notifyTarget()).toBe(X);
    expect(a.nametag).toBeNull();
    expect(a.hasOwnerConfigured()).toBe(true);
    await a.whenSettled(10_000);
    await a.resolve(sphere);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("treats ownerPubkeys as authoritative and notifies the first one when no owner is set", () => {
    const a = new OwnerAuthority({ ownerPubkeys: [`02${Y}`, Z, "junk"], log: makeLog() });
    expect(a.isOwnerKey(Y)).toBe(true);
    expect(a.isOwnerKey(`03${Z}`)).toBe(true);
    expect(a.ownerKeys()).toEqual([Y, Z]);
    expect(a.notifyTarget()).toBe(Y);
    expect(a.hasOwnerConfigured()).toBe(true);
  });

  it("knows no owner when nothing is configured", async () => {
    const a = new OwnerAuthority({ ownerPubkeys: [], log: makeLog() });
    expect(a.hasOwnerConfigured()).toBe(false);
    expect(a.notifyTarget()).toBeNull();
    expect(a.isOwnerKey(X)).toBe(false);
    await a.whenSettled(10_000);
  });

  it("resolves a nametag owner once, pins it TOFU and trusts only the pinned key", async () => {
    const log = makeLog();
    const { sphere, resolve } = fakeSphere(async () => peer(X));
    const a = new OwnerAuthority({ owner: "@Alice", ownerPubkeys: [], log });
    expect(a.nametag).toBe("alice");
    expect(a.isOwnerKey(X)).toBe(false);
    expect(a.notifyTarget()).toBeNull();

    const settled = a.whenSettled(10_000);
    await Promise.all([a.resolve(sphere), a.resolve(sphere)]);
    await settled;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("@alice");
    expect(a.isOwnerKey(`02${X}`)).toBe(true);
    expect(a.notifyTarget()).toBe(X);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`Owner @alice pinned to ${X}`));
    expect(readJsonFile(OWNER_PIN_PATH, {})).toEqual({ pins: { alice: { key: X, pinnedAt: expect.any(Number) } } });

    await a.resolve(sphere); // pinned + audited: nothing left to do
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("loads an existing pin without waiting for the network and keeps it when the name now resolves elsewhere", async () => {
    writeJsonFileAtomic(OWNER_PIN_PATH, { pins: { alice: { key: X, pinnedAt: 1 } } });
    const log = makeLog();
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    expect(a.isOwnerKey(X)).toBe(true);
    await a.whenSettled(10_000);

    const { sphere } = fakeSphere(async () => peer(Y));
    await a.resolve(sphere);
    expect(a.isOwnerKey(X)).toBe(true);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`now resolves to ${Y}.*keeping the pin`)));
    expect(readJsonFile(OWNER_PIN_PATH, {})).toEqual({ pins: { alice: { key: X, pinnedAt: 1 } } });
  });

  it("keeps a pin another process wrote meanwhile instead of replacing it", async () => {
    const log = makeLog();
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    writeJsonFileAtomic(OWNER_PIN_PATH, { pins: { alice: { key: Z, pinnedAt: 1 } } });
    await a.resolve(fakeSphere(async () => peer(X)).sphere);
    expect(a.isOwnerKey(Z)).toBe(true);
    expect(a.isOwnerKey(X)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`${Z} is already pinned`));
  });

  it("pins per owner name, so changing the owner re-pins without losing the old pin", async () => {
    writeJsonFileAtomic(OWNER_PIN_PATH, { pins: { alice: { key: X, pinnedAt: 1 } } });
    const a = new OwnerAuthority({ owner: "bob", ownerPubkeys: [], log: makeLog() });
    expect(a.isOwnerKey(X)).toBe(false);
    await a.resolve(fakeSphere(async () => peer(Y)).sphere);
    expect(a.isOwnerKey(Y)).toBe(true);
    expect(Object.keys(readJsonFile<{ pins: object }>(OWNER_PIN_PATH, { pins: {} }).pins).sort()).toEqual(["alice", "bob"]);
  });

  it("refuses a binding whose chain key is not the signer's key", async () => {
    const log = makeLog();
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    await a.resolve(fakeSphere(async () => peer(X, `02${Y}`)).sphere);
    expect(a.isOwnerKey(X)).toBe(false);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not resolve to a self-consistent key"));
    expect(existsSync(OWNER_PIN_PATH)).toBe(false);
    await a.whenSettled(10_000);
  });

  it("does not pin a binding without a chain key", async () => {
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log: makeLog() });
    await a.resolve(fakeSphere(async () => peer(X, "")).sphere);
    expect(a.isOwnerKey(X)).toBe(false);
    expect(existsSync(OWNER_PIN_PATH)).toBe(false);
  });

  it("never throws from resolve(), even when logging the failure throws", async () => {
    const log = makeLog();
    log.warn.mockImplementation(() => {
      throw new Error("logger down");
    });
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    const { sphere } = fakeSphere(async () => {
      throw new Error("TRANSPORT_ERROR");
    });
    await expect(a.resolve(sphere)).resolves.toBeUndefined();
    await expect(a.whenSettled(1_000)).resolves.toBeUndefined();
    expect(a.isOwnerKey(X)).toBe(false);
  });

  it("fails closed on lookup errors and retries at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const log = makeLog();
    const { sphere, resolve } = fakeSphere(async () => {
      throw new Error("TRANSPORT_ERROR");
    });
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    await a.resolve(sphere);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Owner @alice lookup failed: TRANSPORT_ERROR"));
    expect(a.isOwnerKey(X)).toBe(false);
    await a.whenSettled(10_000);

    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    resolve.mockImplementation(async () => peer(X));
    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(a.isOwnerKey(X)).toBe(true);
  });

  it("grants no authority while the pin cannot be saved, and pins on a later lookup once it can", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The data dir sits behind a dangling link: the pin reads as absent, and writing it fails (ENOENT).
    const target = join(root, `gone-${n++}`);
    const parent = join(root, `parent-${n++}`);
    mkdirSync(parent);
    symlinkSync(target, join(parent, "link"));
    setDataDirForTests(join(parent, "link", "unicity"));
    const log = makeLog();
    const { sphere, resolve } = fakeSphere(async () => peer(X));
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(a.isOwnerKey(X)).toBe(false);
    expect(a.ownerKeys()).toEqual([]);
    expect(a.notifyTarget()).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/Owner @alice resolved to .*the pin cannot be saved.*ENOENT/));
    expect(log.info).not.toHaveBeenCalled();
    await a.whenSettled(1_000);

    mkdirSync(target); // writable again
    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(1); // at most one lookup a minute
    vi.setSystemTime(Date.now() + 61_000);
    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(a.isOwnerKey(X)).toBe(true);
    expect(readJsonFile(OWNER_PIN_PATH, {})).toEqual({ pins: { alice: { key: X, pinnedAt: expect.any(Number) } } });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`Owner @alice pinned to ${X}`));
  });

  it("bounds resolve() and whenSettled() by their timeouts and still pins a late answer", async () => {
    let answer!: (p: Peer) => void;
    const { sphere } = fakeSphere(() => new Promise<Peer>((r) => (answer = r)));
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log: makeLog() });
    await a.whenSettled(20);
    await a.resolve(sphere, { timeoutMs: 20 });
    await a.whenSettled(20);
    expect(a.isOwnerKey(X)).toBe(false);
    answer(peer(X));
    await a.whenSettled(1_000);
    expect(a.isOwnerKey(X)).toBe(true);
  });

  it("is shared through setOwnerAuthority/getOwnerAuthority", () => {
    const a = new OwnerAuthority({ ownerPubkeys: [X], log: makeLog() });
    setOwnerAuthority(a);
    expect(getOwnerAuthority()).toBe(a);
  });

  it("finds the pin under OpenClaw's state dir when nothing else resolved the data dir first", async () => {
    const stateDir = join(root, `state-${n++}`);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      setDataDirForTests();
      writeJsonFileAtomic(join(stateDir, "unicity", "owner-pin.json"), { pins: { alice: { key: X, pinnedAt: 1 } } });
      const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log: makeLog() });
      expect(a.isOwnerKey(X)).toBe(true);
      expect(OWNER_PIN_PATH).toBe(join(stateDir, "unicity", "owner-pin.json"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("OwnerAuthority with an unusable pin file", () => {
  /** Owner @alice with `contents` in owner-pin.json, while @alice now resolves to Y. */
  async function withPinFile(contents: string, owner = "alice") {
    mkdirSync(dirname(OWNER_PIN_PATH), { recursive: true });
    writeFileSync(OWNER_PIN_PATH, contents);
    const log = makeLog();
    const { sphere, resolve } = fakeSphere(async () => peer(Y));
    const a = new OwnerAuthority({ owner, ownerPubkeys: [Z], log });
    await a.whenSettled(1_000);
    await a.resolve(sphere);
    return { a, log, resolve };
  }

  it.each([
    ["corrupt JSON", `{"pins":{"alice":{"key":"${X}","pinnedAt":1}},`],
    ["a non-object pins", '{"pins":[]}'],
    ["pins missing", "{}"],
    ["not an object", "null"],
    ["a malformed key for the owner", '{"pins":{"alice":{"key":"zz","pinnedAt":1}}}'],
    ["a malformed entry for the owner", '{"pins":{"alice":null}}'],
  ])("fails closed on %s: no lookup, no re-pin, the file left as it is", async (_case, contents) => {
    const { a, log, resolve } = await withPinFile(contents);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(a.isOwnerKey(X)).toBe(false);
    expect(a.isOwnerKey(Z)).toBe(true); // explicit owner keys keep working
    expect(a.notifyTarget()).toBe(Z);
    expect(a.hasOwnerConfigured()).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(readFileSync(OWNER_PIN_PATH, "utf8")).toBe(contents);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`Owner pin file ${OWNER_PIN_PATH} cannot be used`));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("fails closed when the pin file exists but cannot be read", async () => {
    mkdirSync(OWNER_PIN_PATH, { recursive: true }); // EISDIR stands in for EIO/EACCES (root ignores permissions)
    const log = makeLog();
    const { sphere, resolve } = fakeSphere(async () => peer(Y));
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    await a.resolve(sphere);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/cannot be used \(.*EISDIR/));
  });

  it("settles at once, so nothing waits for an owner lookup that will not run", async () => {
    mkdirSync(dirname(OWNER_PIN_PATH), { recursive: true });
    writeFileSync(OWNER_PIN_PATH, "{trunc");
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log: makeLog() });
    vi.useFakeTimers();
    const settled = vi.fn();
    void a.whenSettled(60_000).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalled();
  });

  it.each([
    ["corrupt", "{trunc"],
    ["a malformed pin for the owner", '{"pins":{"alice":{"key":"zz"}}}'],
  ])("does not pin when the file got %s after start, and stays off", async (_case, contents) => {
    const log = makeLog();
    const a = new OwnerAuthority({ owner: "alice", ownerPubkeys: [], log });
    mkdirSync(dirname(OWNER_PIN_PATH), { recursive: true });
    writeFileSync(OWNER_PIN_PATH, contents);
    const { sphere, resolve } = fakeSphere(async () => peer(Y));
    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(a.notifyTarget()).toBeNull();
    expect(readFileSync(OWNER_PIN_PATH, "utf8")).toBe(contents);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("cannot be used"));
    expect(log.info).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await a.resolve(sphere);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed pin of another name", async () => {
    const contents = `{"pins":{"bob":{"key":"zz"}}}`;
    const { a } = await withPinFile(contents);
    expect(a.isOwnerKey(Y)).toBe(true);
    expect(readJsonFile<{ pins: object }>(OWNER_PIN_PATH, { pins: {} }).pins).toEqual({
      bob: { key: "zz" },
      alice: { key: Y, pinnedAt: expect.any(Number) },
    });
  });

  it("honours a pin written as a 66-hex chain key and keeps it when the name now resolves elsewhere", async () => {
    const contents = JSON.stringify({ pins: { alice: { key: `02${X.toUpperCase()}`, pinnedAt: 1 } } });
    const { a, log } = await withPinFile(contents);
    expect(a.isOwnerKey(X)).toBe(true);
    expect(a.isOwnerKey(Y)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`now resolves to ${Y}.*keeping the pin`)));
    expect(readFileSync(OWNER_PIN_PATH, "utf8")).toBe(contents);
  });

  it("reads only the owner's own entry, never an inherited property of the pin map", async () => {
    const { a } = await withPinFile('{"pins":{}}', "constructor");
    expect(a.isOwnerKey(Y)).toBe(true);
  });
});

describe("NameVerifier", () => {
  it("verifies a claim that forward-resolves to the authenticated key", async () => {
    const { sphere, resolve } = fakeSphere(async () => peer(X));
    const v = new NameVerifier(() => sphere);
    expect(await v.verify("@Alice", `02${X}`)).toEqual({ verified: "alice" });
    expect(resolve).toHaveBeenCalledWith("@alice");
    expect(v.label({ verified: "alice" }, X)).toBe("@alice");
  });

  it("marks a claim unverified when the name belongs to someone else or does not resolve", async () => {
    const v = new NameVerifier(() => fakeSphere(async (id) => (id === "@alice" ? peer(X) : null)).sphere);
    expect(await v.verify("alice", Y)).toEqual({ claimed: "alice" });
    expect(await v.verify("ghost", Y)).toEqual({ claimed: "ghost" });
    expect(v.label({ claimed: "alice" }, Y)).toBe(`${Y.slice(0, 12)}… (claims @alice, unverified)`);
    expect(v.label({}, `03${Y}`)).toBe(`${Y.slice(0, 12)}…`);
  });

  it("leaves a claim unverified when the binding has no chain key", async () => {
    const v = new NameVerifier(() => fakeSphere(async () => peer(X, "")).sphere);
    expect(await v.verify("alice", X)).toEqual({ claimed: "alice" });
  });

  it("drops unusable claims and keys without a lookup", async () => {
    const { sphere, resolve } = fakeSphere(async () => peer(X));
    const v = new NameVerifier(() => sphere);
    expect(await v.verify(undefined, X)).toEqual({});
    expect(await v.verify("evil\nname", X)).toEqual({});
    expect(await v.verify("alice", "not-a-key")).toEqual({ claimed: "alice" });
    expect(resolve).not.toHaveBeenCalled();
    expect(v.label({ claimed: "evil\nname" }, X)).toBe(`${X.slice(0, 12)}…`);
  });

  it("deduplicates in-flight lookups and caches hits for 10 min and misses for 1 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sphere, resolve } = fakeSphere(async (id) => (id === "@alice" ? peer(X) : null));
    const v = new NameVerifier(() => sphere);
    await Promise.all([v.verify("alice", X), v.verify("alice", Y), v.verify("ghost", X)]);
    expect(resolve).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 61_000);
    await v.verify("alice", X);
    await v.verify("ghost", X);
    expect(resolve).toHaveBeenCalledTimes(3); // only the miss expired

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await v.verify("alice", X);
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it("treats lookup errors as unverified and does not cache while the wallet is closed", async () => {
    let sphere: Sphere | null = null;
    const v = new NameVerifier(() => sphere);
    expect(await v.verify("alice", X)).toEqual({ claimed: "alice" });

    const failing = fakeSphere(async () => {
      throw new Error("NOT_INITIALIZED");
    });
    sphere = failing.sphere;
    expect(await v.verify("alice", X)).toEqual({ claimed: "alice" });
    expect(failing.resolve).toHaveBeenCalledTimes(1);
    await v.verify("alice", X);
    expect(failing.resolve).toHaveBeenCalledTimes(1); // cached miss
  });
});
