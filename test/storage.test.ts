import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "../src/storage.js";

const root = mkdtempSync(join(tmpdir(), "unicity-storage-"));
let dir = "";
let n = 0;

const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  dir = join(root, `case-${n++}`);
  storage.setDataDirForTests(dir);
});

afterEach(() => storage.setDataDirForTests());
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("are resolved on first use, not at import, under OpenClaw's state dir, and kept for the process", async () => {
    storage.setDataDirForTests();
    vi.resetModules();
    vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "state-at-import"));
    const fresh = await import("../src/storage.js");
    expect(fresh.DATA_DIR).toBe("");
    expect(fresh.MNEMONIC_PATH).toBe("");

    const stateDir = join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    expect(fresh.walletExists()).toBe(false);
    expect(fresh.DATA_DIR).toBe(join(stateDir, "unicity"));
    expect(fresh.MNEMONIC_PATH).toBe(join(stateDir, "unicity", "mnemonic.txt"));
    expect(fresh.WALLET_PATH).toBe(join(stateDir, "unicity", "wallet.json"));
    expect(fresh.WALLET_LOCK_PATH).toBe(join(stateDir, "unicity", "wallet.lock"));

    // A later redirect of the state dir, or a re-imported copy of the module (plugin reload), keeps the first answer.
    vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "redirected"));
    expect(fresh.resolveDataDir()).toBe(join(stateDir, "unicity"));
    vi.resetModules();
    const reloaded = await import("../src/storage.js");
    expect(reloaded.resolveDataDir()).toBe(join(stateDir, "unicity"));
    expect(reloaded.OWNER_PIN_PATH).toBe(join(stateDir, "unicity", "owner-pin.json"));
  });

  it("follow OPENCLAW_HOME when no state dir is set", () => {
    const home = join(root, "home");
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    vi.stubEnv("OPENCLAW_HOME", home);
    storage.setDataDirForTests();
    storage.ensureDataDir();
    expect(storage.DATA_DIR).toBe(join(home, ".openclaw", "unicity"));
    expect(mode(join(home, ".openclaw", "unicity"))).toBe(0o700);
  });

  it("refuse a path export that was read before the data dir was resolved", () => {
    storage.setDataDirForTests();
    const unresolved = storage.LEDGER_PATH;
    expect(unresolved).toBe("");
    expect(() => storage.readJsonFileStrict(unresolved, [])).toThrow(/before the data dir was resolved/);
    expect(() => storage.readJsonFile(unresolved, [])).toThrow(/before the data dir was resolved/);
    expect(() => storage.writeJsonFileAtomic(unresolved, [])).toThrow(/before the data dir was resolved/);
  });

  it("follow the test seam", () => {
    storage.setDataDirForTests(dir);
    expect(storage.DATA_DIR).toBe(dir);
    expect(storage.MNEMONIC_PATH).toBe(join(dir, "mnemonic.txt"));
    expect(storage.WALLET_LOCK_PATH).toBe(join(dir, "wallet.lock"));
    expect(storage.DEVICE_ID_PATH).toBe(join(dir, "wallet-api-device.json"));
    expect(storage.OWNER_PIN_PATH).toBe(join(dir, "owner-pin.json"));
    expect(storage.STATUS_PATH).toBe(join(dir, "gateway-status.json"));
    expect(storage.EVENT_STATE_PATH).toBe(join(dir, "event-state.json"));
    expect(storage.LEDGER_PATH).toBe(join(dir, "payment-ledger.json"));
    expect(storage.OUTGOING_REQUESTS_PATH).toBe(join(dir, "outgoing-requests.json"));
    expect(storage.GROUPS_APPROVED_PATH).toBe(join(dir, "groups-approved.json"));
  });
});

describe("data dir and mnemonic", () => {
  it("ensureDataDir creates the dir with mode 0700", () => {
    storage.ensureDataDir();
    expect(mode(dir)).toBe(0o700);
  });

  it("walletExists checks mnemonic.txt or wallet.json without opening anything", () => {
    storage.ensureDataDir();
    expect(storage.walletExists()).toBe(false);
    writeFileSync(join(dir, "wallet.json"), "{}");
    expect(storage.walletExists()).toBe(true);
    rmSync(join(dir, "wallet.json"));
    storage.saveMnemonic("alpha beta");
    expect(storage.walletExists()).toBe(true);
  });

  it("saves the mnemonic with mode 0600 and reads it back trimmed", () => {
    expect(storage.readMnemonic()).toBeUndefined();
    storage.saveMnemonic("alpha beta gamma");
    expect(mode(storage.MNEMONIC_PATH)).toBe(0o600);
    expect(readFileSync(storage.MNEMONIC_PATH, "utf-8")).toBe("alpha beta gamma\n");
    expect(storage.readMnemonic()).toBe("alpha beta gamma");
  });

  it("treats an empty mnemonic.txt as absent but never an unreadable one", () => {
    storage.ensureDataDir();
    writeFileSync(storage.MNEMONIC_PATH, " \n");
    expect(storage.readMnemonic()).toBeUndefined();
    rmSync(storage.MNEMONIC_PATH);
    mkdirSync(storage.MNEMONIC_PATH);
    expect(() => storage.readMnemonic()).toThrow(/EISDIR/);
  });
});

describe("JSON helpers", () => {
  it("readJsonFile returns the fallback for missing or corrupt files", () => {
    const p = join(dir, "x.json");
    expect(storage.readJsonFile(p, { a: 1 })).toEqual({ a: 1 });
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, "{not json");
    expect(storage.readJsonFile(p, null)).toBeNull();
  });

  it("readJsonFileStrict falls back only for a missing file and throws on unreadable or corrupt ones", () => {
    const p = join(dir, "x.json");
    expect(storage.readJsonFileStrict(p, [])).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, "[1]");
    expect(storage.readJsonFileStrict(p, [])).toEqual([1]);
    writeFileSync(p, "{not json");
    expect(() => storage.readJsonFileStrict(p, [])).toThrow(SyntaxError);
    rmSync(p);
    mkdirSync(p); // EISDIR stands in for EIO/EACCES (root ignores permissions)
    expect(() => storage.readJsonFileStrict(p, [])).toThrow(/EISDIR/);
  });

  it("writeJsonFileAtomic writes 0600 by default, honours a mode and leaves no temp files", () => {
    const p = join(dir, "nested", "x.json");
    storage.writeJsonFileAtomic(p, { a: 1 });
    expect(storage.readJsonFile(p, null)).toEqual({ a: 1 });
    expect(mode(p)).toBe(0o600);
    storage.writeJsonFileAtomic(p, { a: 2 }, 0o644);
    expect(mode(p)).toBe(0o644);
    expect(readdirSync(join(dir, "nested"))).toEqual(["x.json"]);
  });
});

describe("getOrCreateDeviceId", () => {
  it("creates a persistent openclaw-unicity-<uuid> id", () => {
    const id = storage.getOrCreateDeviceId();
    expect(id).toMatch(/^openclaw-unicity-[0-9a-f-]{36}$/);
    expect(storage.getOrCreateDeviceId()).toBe(id);
    const rec = storage.readJsonFile<Record<string, unknown>>(storage.DEVICE_ID_PATH, {});
    expect(rec).toMatchObject({ deviceId: id, createdAt: expect.any(String) });
  });

  it("replaces a corrupt file and keeps it aside", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storage.DEVICE_ID_PATH, "garbage");
    const id = storage.getOrCreateDeviceId();
    expect(id).toMatch(/^openclaw-unicity-/);
    expect(readFileSync(`${storage.DEVICE_ID_PATH}.corrupt`, "utf-8")).toBe("garbage");
  });
});

describe("atomic writes", () => {
  it("never leaves a cut-short file behind: the old content stays and no temp file remains", async () => {
    storage.saveMnemonic("old seed words");
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      return {
        ...fs,
        writeSync: (fd: number, buf: Uint8Array, off = 0) => {
          if (!Buffer.from(buf).includes("new seed")) return fs.writeSync(fd, buf, off);
          fs.writeSync(fd, buf, off, 3);
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
      };
    });
    try {
      const failing = await import("../src/storage.js");
      failing.setDataDirForTests(dir);
      expect(() => failing.saveMnemonic("new seed words")).toThrow(/ENOSPC/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    expect(readdirSync(dir)).toEqual(["mnemonic.txt"]);
    expect(storage.readMnemonic()).toBe("old seed words");
  });
});

describe("handled event ids", () => {
  it("marks once, persists across reloads and keeps kinds separate", () => {
    expect(storage.isEventHandled("payreq", "r1")).toBe(false);
    expect(storage.markEventHandled("payreq", "r1")).toBe(true);
    expect(storage.markEventHandled("payreq", "r1")).toBe(false);
    expect(storage.isEventHandled("transfer", "r1")).toBe(false);

    expect(storage.isEventHandled("payreq", "r1")).toBe(true);
    expect(storage.markEventHandled("transfer", "r1")).toBe(true);
    expect(storage.markEventHandled("dm", "r1", 5_000, "k1")).toBe(true);
    expect(storage.markEventHandled("dm", "r1", 6_000, "k1")).toBe(false);
    expect(storage.isEventHandled("dm", "r1")).toBe(true);
    expect(storage.readJsonFile(storage.EVENT_STATE_PATH, {})).toEqual({
      payreq: ["r1"],
      transfer: ["r1"],
      dm: [{ id: "r1", ts: 5_000, markedAt: expect.any(Number), peer: "k1" }],
    });
  });

  it("marks a batch in one write: counts only new ids, writes nothing when none are new", () => {
    expect(storage.areEventsHandled("transfer", ["a", "b"])).toBe(false);
    expect(storage.markEventsHandled("transfer", ["a", "b", "a"])).toBe(2);
    expect(storage.areEventsHandled("transfer", ["a", "b"])).toBe(true);
    expect(storage.areEventsHandled("transfer", ["a", "c"])).toBe(false);
    expect(storage.areEventsHandled("payreq", ["a"])).toBe(false);
    // Written in another shape than the helpers write, so a rewrite would show.
    storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, { transfer: ["a", "b"] });
    const written = readFileSync(storage.EVENT_STATE_PATH, "utf-8");
    expect(storage.markEventsHandled("transfer", ["b", "a"])).toBe(0);
    expect(readFileSync(storage.EVENT_STATE_PATH, "utf-8")).toBe(written);
    expect(storage.markEventsHandled("transfer", ["b", "c"])).toBe(1);
    expect(storage.readJsonFile(storage.EVENT_STATE_PATH, {})).toEqual({ payreq: [], transfer: ["a", "b", "c"], dm: [] });
  });

  it("stamps every DM marker of a batch with the given time, the time of marking and the sender", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 9_000 });
    try {
      expect(storage.markEventsHandled("dm", ["d1", "d2"], 7_000, "k")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
    expect(storage.readJsonFile<{ dm: unknown[] }>(storage.EVENT_STATE_PATH, { dm: [] }).dm).toEqual([
      { id: "d1", ts: 7_000, markedAt: 9_000, peer: "k" },
      { id: "d2", ts: 7_000, markedAt: 9_000, peer: "k" },
    ]);
  });

  it("writes a batch once, and leaves none of it marked when that write fails (no half-marked payment)", async () => {
    storage.markEventHandled("transfer", "earlier");
    let writes = 0;
    let fail = false;
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      return {
        ...fs,
        renameSync: (from: string, to: string) => {
          if (String(to).endsWith("event-state.json")) {
            writes++;
            if (fail) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
          }
          return fs.renameSync(from, to);
        },
      };
    });
    try {
      const mocked = await import("../src/storage.js");
      mocked.setDataDirForTests(dir);
      expect(mocked.markEventsHandled("transfer", ["a1", "a2", "a3"])).toBe(3);
      expect(writes).toBe(1);
      fail = true;
      expect(() => mocked.markEventsHandled("transfer", ["r1", "r2", "r3"])).toThrow(/EIO/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    expect(storage.areEventsHandled("transfer", ["earlier", "a1", "a2", "a3"])).toBe(true);
    for (const id of ["r1", "r2", "r3"]) expect(storage.isEventHandled("transfer", id)).toBe(false);
    expect(readdirSync(dir)).toEqual(["event-state.json"]);
  });

  it("stamps a DM marker without a message timestamp with the current time", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 42_000 });
    try {
      storage.markEventHandled("dm", "d1");
    } finally {
      vi.useRealTimers();
    }
    expect(storage.readJsonFile<{ dm: unknown[] }>(storage.EVENT_STATE_PATH, { dm: [] }).dm).toEqual([
      { id: "d1", ts: 42_000, markedAt: 42_000 },
    ]);
  });

  it("is bounded to the newest 2000 ids per kind", () => {
    storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, { payreq: [], transfer: Array.from({ length: 2000 }, (_, i) => `t${i}`) });
    for (let i = 2000; i < 2005; i++) expect(storage.markEventHandled("transfer", `t${i}`)).toBe(true);
    expect(storage.isEventHandled("transfer", "t4")).toBe(false);
    expect(storage.isEventHandled("transfer", "t5")).toBe(true);
    expect(storage.isEventHandled("transfer", "t2004")).toBe(true);
    expect(storage.readJsonFile<{ transfer: string[] }>(storage.EVENT_STATE_PATH, { transfer: [] }).transfer).toHaveLength(2000);
  });

  it("replaces an event's earlier marker in the same write, so each event counts once toward the 2000 its kind keeps", () => {
    // 1999 delivered receipts, then one whose turn ran while its owner notice was still owed.
    storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, { transfer: [...Array.from({ length: 1999 }, (_, i) => `t${i}`), "x#turn"] });
    expect(storage.replaceEventsHandled("transfer", ["x"], ["x#turn"])).toBe(1);
    const transfer = storage.readJsonFile<{ transfer: string[] }>(storage.EVENT_STATE_PATH, { transfer: [] }).transfer;
    expect(transfer).toHaveLength(2000);
    expect(transfer.at(-1)).toBe("x");
    expect(storage.areEventsHandled("transfer", ["t0", "x"])).toBe(true);
    expect(storage.isEventHandled("transfer", "x#turn")).toBe(false);
  });

  it("replaces markers of one kind only, keeps an id it marks, and writes nothing when nothing changes", () => {
    storage.markEventsHandled("transfer", ["a#turn", "b#turn"]);
    storage.markEventsHandled("payreq", ["a#turn"]);
    expect(storage.replaceEventsHandled("transfer", ["a", "b#turn"], ["a#turn", "b#turn", "c#turn"])).toBe(1);
    expect(storage.readJsonFile(storage.EVENT_STATE_PATH, {})).toEqual({ payreq: ["a#turn"], transfer: ["b#turn", "a"], dm: [] });
    const written = readFileSync(storage.EVENT_STATE_PATH, "utf-8");
    expect(storage.replaceEventsHandled("transfer", ["a"], ["a#turn"])).toBe(0);
    expect(readFileSync(storage.EVENT_STATE_PATH, "utf-8")).toBe(written);
    // Removing alone is a change.
    expect(storage.replaceEventsHandled("transfer", ["a"], ["b#turn"])).toBe(0);
    expect(storage.readJsonFile(storage.EVENT_STATE_PATH, {})).toEqual({ payreq: ["a#turn"], transfer: ["a"], dm: [] });
  });

  it("never loses ids written by another module instance or process", () => {
    expect(storage.markEventHandled("payreq", "mine")).toBe(true);
    const onDisk = storage.readJsonFile<{ payreq: string[]; transfer: string[] }>(storage.EVENT_STATE_PATH, { payreq: [], transfer: [] });
    storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, { ...onDisk, payreq: [...onDisk.payreq, "theirs"] });
    expect(storage.isEventHandled("payreq", "theirs")).toBe(true);
    expect(storage.markEventHandled("payreq", "next")).toBe(true);
    expect(storage.readJsonFile(storage.EVENT_STATE_PATH, {})).toEqual({ payreq: ["mine", "theirs", "next"], transfer: [], dm: [] });
  });

  it("skips malformed entries but keeps the rest", () => {
    storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, {
      transfer: [1, "t1"],
      dm: ["bare-id", { id: "d0" }, { id: "d1", ts: 7, peer: 3 }, { id: "d2", ts: 8, markedAt: 9, peer: "k" }],
    });
    expect(storage.isEventHandled("transfer", "t1")).toBe(true);
    expect(storage.isEventHandled("dm", "d1")).toBe(true);
    expect(storage.isEventHandled("dm", "d0")).toBe(false);
    expect(storage.markEventHandled("payreq", "p1")).toBe(true);
    expect(storage.readJsonFile(storage.EVENT_STATE_PATH, {})).toEqual({
      payreq: ["p1"],
      transfer: ["t1"],
      dm: [{ id: "d1", ts: 7, markedAt: expect.any(Number) }, { id: "d2", ts: 8, markedAt: 9, peer: "k" }],
    });
  });

  it.each([
    ["torn JSON", '{"dm": [{"id": "owner-dm", "ts": 1'],
    ["not an object", "[]"],
    ["a kind that is not a list", '{"dm": [], "payreq": "nope"}'],
    ["a DM floor that is not a number", '{"dm": [], "dmFloor": "soon"}'],
    ["sender floors that are not an object", '{"dm": [], "dmPeerFloors": [5]}'],
    ["a sender floor that is not a number", '{"dm": [], "dmPeerFloors": {"k": null}}'],
    ["a DM marker whose real timestamp is not a number", '{"dm": [{"id": "d", "ts": 1, "peer": "k", "aheadTs": null}]}'],
    ["ahead floors that are not an object", '{"dm": [], "dmPeerAheadFloors": 5}'],
    ["an ahead floor without its rank", '{"dm": [], "dmPeerAheadFloors": {"k": {"floor": 5}}}'],
  ])("refuses to read or overwrite a state file with %s, so its markers, floors and watermark survive", (_what, content) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storage.EVENT_STATE_PATH, content);
    for (const kind of ["dm", "payreq", "transfer"] as const) {
      expect(() => storage.isEventHandled(kind, "x")).toThrow(/event-state\.json\b.*stop the gateway, then repair or remove it/);
      expect(() => storage.areEventsHandled(kind, ["x", "y"])).toThrow(/event-state\.json/);
      expect(() => storage.markEventHandled(kind, "x")).toThrow(/event-state\.json/);
      expect(() => storage.markEventsHandled(kind, ["x", "y"])).toThrow(/event-state\.json/);
      if (kind !== "dm") expect(() => storage.replaceEventsHandled(kind, ["x"], ["x#turn"])).toThrow(/event-state\.json/);
    }
    expect(() => storage.isBelowDmFloor(1_000, "k")).toThrow(/event-state\.json/);
    expect(() => storage.getTransferWatermark()).toThrow(/event-state\.json/);
    expect(() => storage.setTransferWatermark(1_000)).toThrow(/event-state\.json/);
    expect(readFileSync(storage.EVENT_STATE_PATH, "utf-8")).toBe(content);
  });

  it("refuses an unreadable state file (read error other than a missing file)", () => {
    mkdirSync(storage.EVENT_STATE_PATH, { recursive: true });
    expect(() => storage.isEventHandled("dm", "x")).toThrow(/EISDIR/);
    expect(() => storage.markEventHandled("dm", "x")).toThrow(/EISDIR/);
    expect(() => storage.replaceEventsHandled("transfer", ["x"], ["x#turn"])).toThrow(/EISDIR/);
    expect(() => storage.isBelowDmFloor(1_000, "k")).toThrow(/EISDIR/);
  });

  describe("DM markers", () => {
    const OWNER = "o".repeat(64);
    const MINUTE = 60_000;
    const DAY = 24 * 60 * MINUTE;
    type Marker = { id: string; ts: number; markedAt?: number; peer?: string; aheadTs?: number };
    const seed = (dm: Marker[], extra: Record<string, unknown> = {}) =>
      storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, { payreq: [], transfer: [], dm, ...extra });
    const markers = () => storage.readJsonFile<{ dm: Marker[] }>(storage.EVENT_STATE_PATH, { dm: [] }).dm;
    const dmIds = () => markers().map((m) => m.id);
    const floors = () =>
      storage.readJsonFile<{
        dmFloor?: number;
        dmPeerFloors?: Record<string, number>;
        dmPeerAheadFloors?: Record<string, { floor: number; rank: number }>;
      }>(storage.EVENT_STATE_PATH, {});
    /** `count` markers dated and marked from `from` on, spread over six keys (under the per-sender cap). */
    const later = (from: number, count = 1_999) =>
      Array.from({ length: count }, (_, i) => ({ id: `n${i}`, ts: from + i, markedAt: from + i, peer: `k${i % 6}` }));
    const atTime = <T>(now: number, f: () => T): T => {
      vi.useFakeTimers({ toFake: ["Date"], now });
      try {
        return f();
      } finally {
        vi.useRealTimers();
      }
    };

    it("evict by message timestamp, not handling order: a flood of backdated DMs cannot push out a newer owner DM", () => {
      seed([
        { id: "owner-dm", ts: 1_000_000, peer: OWNER },
        // Handled after the owner's DM but dated before it, each from a throwaway key.
        ...Array.from({ length: 1_999 }, (_, i) => ({ id: `junk${i}`, ts: 500_000 + i, peer: `k${i}` })),
      ]);
      for (let i = 0; i < 5; i++) expect(storage.markEventHandled("dm", `late${i}`, 600_000 + i, `late${i}`)).toBe(true);
      expect(storage.isEventHandled("dm", "owner-dm")).toBe(true);
      for (let i = 0; i < 5; i++) expect(storage.isEventHandled("dm", `junk${i}`)).toBe(false);
      expect(storage.isEventHandled("dm", "junk5")).toBe(true);
      expect(storage.isEventHandled("dm", "late0")).toBe(true);
      expect(dmIds()).toHaveLength(2_000);
      expect(dmIds()[0]).toBe("owner-dm"); // handling order is kept on disk
      expect(floors().dmFloor).toBe(500_004);
    });

    it("keep at most 400 per sender, so one key's future-dated flood cannot push out the owner DM either", () => {
      const flood = Array.from({ length: 1_999 }, (_, i) => ({ id: `f${i}`, ts: 2_000_000 + i, peer: "attacker" }));
      seed([{ id: "owner-dm", ts: 1_000_000, peer: OWNER }, ...flood]);
      expect(storage.markEventHandled("dm", "f-last", 9_000_000, "attacker")).toBe(true);
      expect(storage.isEventHandled("dm", "owner-dm")).toBe(true);
      expect(dmIds()).toHaveLength(401);
      expect(storage.isEventHandled("dm", "f1599")).toBe(false); // the attacker's oldest went
      expect(storage.isEventHandled("dm", "f1600")).toBe(true);
      expect(storage.isEventHandled("dm", "f-last")).toBe(true);
      expect(floors()).toEqual(expect.objectContaining({ dmPeerFloors: { attacker: 2_001_599 } }));
      expect(storage.isBelowDmFloor(1_000_000, OWNER)).toBe(false); // the attacker's floor is the attacker's alone
    });

    it("leave a floor when the overall cap evicts a marker, so a relay re-delivering that DM finds it handled", () => {
      // The owner's DM at T, then 2,100 DMs dated after it from seven keys, none of them over the per-sender cap.
      const T = 1_000_000;
      seed([
        { id: "owner-dm", ts: T, peer: OWNER },
        ...Array.from({ length: 1_999 }, (_, i) => ({ id: `n${i}`, ts: T + 1 + i, peer: `k${i % 6}` })),
      ]);
      const more = Array.from({ length: 101 }, (_, i) => `m${i}`);
      expect(storage.markEventsHandled("dm", more, T + 5_000, "k6")).toBe(101);
      expect(storage.isEventHandled("dm", "owner-dm")).toBe(false);
      expect(storage.isBelowDmFloor(T, OWNER)).toBe(true);
      expect(storage.isBelowDmFloor(T + 100, "anyone")).toBe(true); // n0..n99 went with it
      expect(storage.isBelowDmFloor(T + 101, OWNER)).toBe(false); // a newer DM nobody handled is still new
      expect(storage.isEventHandled("dm", "n100")).toBe(true);
      // Persisted (every check reads the file), and no sender floor below the overall one is kept.
      expect(floors()).toEqual(expect.objectContaining({ dmFloor: T + 100 }));
      expect(floors().dmPeerFloors).toBeUndefined();
      // Writes of other state keep it.
      storage.markEventHandled("payreq", "p1");
      storage.setTransferWatermark(1_000);
      expect(floors()).toEqual(expect.objectContaining({ dmFloor: T + 100 }));
      expect(storage.isBelowDmFloor(T, OWNER)).toBe(true);
    });

    it("keep a sender's floor through writes of other state", () => {
      seed(Array.from({ length: 400 }, (_, i) => ({ id: `o${i}`, ts: 1_000 + i, peer: OWNER })));
      storage.markEventHandled("dm", "o-next", 5_000, OWNER);
      storage.markEventHandled("transfer", "t1");
      storage.setTransferWatermark(1_000);
      expect(floors().dmPeerFloors).toEqual({ [OWNER]: 1_000 });
      expect(storage.isBelowDmFloor(1_000, OWNER)).toBe(true);
    });

    it("leave a floor for that sender only when the per-sender cap evicts a marker", () => {
      seed(Array.from({ length: 400 }, (_, i) => ({ id: `o${i}`, ts: 1_000 + i, peer: OWNER })));
      expect(storage.markEventHandled("dm", "o-next", 5_000, OWNER)).toBe(true);
      expect(storage.isEventHandled("dm", "o0")).toBe(false);
      expect(storage.isBelowDmFloor(1_000, OWNER)).toBe(true);
      expect(storage.isBelowDmFloor(1_001, OWNER)).toBe(false);
      expect(storage.isBelowDmFloor(1_000, "someone-else")).toBe(false);
      expect(storage.isBelowDmFloor(1_000)).toBe(false);
      expect(floors()).toEqual(expect.objectContaining({ dmPeerFloors: { [OWNER]: 1_000 } }));
      expect(floors().dmFloor).toBeUndefined();
    });

    it("order and floor by the time of marking at the latest: a future-dated flood holds no slot and cannot push the overall floor ahead", () => {
      const NOW = 10_000_000;
      seed([
        // Dated far ahead by their senders, marked before the owner's DM.
        ...Array.from({ length: 1_999 }, (_, i) => ({ id: `f${i}`, ts: 9e15, markedAt: 9_000_000 + i, peer: `k${i}` })),
        { id: "owner-dm", ts: 9_500_000, markedAt: 9_500_000, peer: OWNER },
      ]);
      expect(atTime(NOW, () => storage.markEventHandled("dm", "live", NOW, "k-live"))).toBe(true);
      expect(storage.isEventHandled("dm", "owner-dm")).toBe(true);
      expect(storage.isEventHandled("dm", "f0")).toBe(false);
      expect(floors().dmFloor).toBe(9_000_000);
      expect(storage.isBelowDmFloor(9_000_001, "anyone")).toBe(false); // live DMs still pass
      // The sender's own floor allows for its clock running up to five minutes ahead.
      expect(floors().dmPeerFloors).toEqual({ k0: 9_000_000 + 5 * 60_000 });
    });

    it("cover an evicted DM dated up to five minutes ahead of its marking, for its sender only", () => {
      const markedAt = 1_000_000;
      const ts = markedAt + 2 * 60_000; // the owner's clock runs two minutes ahead
      seed([
        { id: "owner-dm", ts, markedAt, peer: OWNER },
        ...Array.from({ length: 1_999 }, (_, i) => ({ id: `n${i}`, ts: 2_000_000, markedAt: 2_000_000, peer: `k${i % 5}` })),
      ]);
      expect(storage.markEventHandled("dm", "n-last", 2_000_000, "k-last")).toBe(true);
      expect(storage.isEventHandled("dm", "owner-dm")).toBe(false);
      expect(floors().dmFloor).toBe(markedAt);
      expect(storage.isBelowDmFloor(ts, OWNER)).toBe(true);
      expect(storage.isBelowDmFloor(ts, "someone-else")).toBe(false);
    });

    it("only raise a sender's floor, also when a later evicted marker of theirs is dated before an earlier one", () => {
      seed([
        { id: "ahead", ts: 1_240_000, markedAt: 1_000_000, peer: OWNER }, // the owner's clock ran four minutes ahead...
        { id: "fixed", ts: 1_100_000, markedAt: 1_100_000, peer: OWNER }, // ...and was then set right
        ...Array.from({ length: 398 }, (_, i) => ({ id: `o${i}`, ts: 2_000_000 + i, markedAt: 2_000_000 + i, peer: OWNER })),
      ]);
      expect(storage.markEventHandled("dm", "o-next", 3_000_000, OWNER)).toBe(true);
      expect(storage.isEventHandled("dm", "ahead")).toBe(false);
      expect(floors().dmPeerFloors).toEqual({ [OWNER]: 1_240_000 });
      expect(storage.markEventHandled("dm", "o-next2", 3_000_001, OWNER)).toBe(true);
      expect(storage.isEventHandled("dm", "fixed")).toBe(false);
      expect(floors().dmPeerFloors).toEqual({ [OWNER]: 1_240_000 });
      expect(storage.isBelowDmFloor(1_240_000, OWNER)).toBe(true); // "ahead" delivered again is still handled
    });

    it("keep the real timestamp of a DM dropped as dated ahead on its marker, only with a sender key", () => {
      const D = 1_000_000;
      atTime(D, () => {
        storage.markEventHandled("dm", "ahead", D + 5 * MINUTE, OWNER, { aheadTs: D + 10 * MINUTE });
        storage.markEventHandled("dm", "no-peer", D + 5 * MINUTE, undefined, { aheadTs: D + 10 * MINUTE });
        storage.markEventHandled("dm", "bad", D + 5 * MINUTE, OWNER, { aheadTs: Number.NaN });
      });
      expect(markers()).toEqual([
        { id: "ahead", ts: D + 5 * MINUTE, markedAt: D, peer: OWNER, aheadTs: D + 10 * MINUTE },
        { id: "no-peer", ts: D + 5 * MINUTE, markedAt: D },
        { id: "bad", ts: D + 5 * MINUTE, markedAt: D, peer: OWNER },
      ]);
    });

    it("cover a DM dropped as dated ahead at its real timestamp once its marker is evicted, for its sender only", () => {
      // The owner's clock runs ten minutes ahead: the DM is dropped at D and marked as dated five minutes ahead.
      const D = 1_000_000;
      const T = D + 10 * MINUTE;
      atTime(D, () => storage.markEventHandled("dm", "ahead", D + 5 * MINUTE, OWNER, { aheadTs: T }));
      // 2,000 DMs dated between the drop and T, from six keys: the drop marker is the oldest and goes.
      seed([...markers(), ...later(D + 1)]);
      expect(atTime(D + 3_000, () => storage.markEventHandled("dm", "n-last", D + 3_000, "k6"))).toBe(true);
      expect(storage.isEventHandled("dm", "ahead")).toBe(false);
      // The overall floor and the sender's own floor stay where a capped timestamp puts them...
      expect(floors().dmFloor).toBe(D);
      expect(floors().dmPeerFloors).toEqual({ [OWNER]: D + 5 * MINUTE });
      // ...and the ahead floor covers the DM once the clock has caught up and it is replayed or re-delivered.
      expect(floors().dmPeerAheadFloors).toEqual({ [OWNER]: { floor: T, rank: D + 5 * MINUTE } });
      expect(storage.isBelowDmFloor(T, OWNER)).toBe(true);
      expect(storage.isBelowDmFloor(T + 1_000, OWNER)).toBe(false);
      expect(storage.isBelowDmFloor(T, "k0")).toBe(false); // the owner's alone
      expect(storage.isBelowDmFloor(D + 6 * MINUTE)).toBe(false);
      // Kept through writes of other state.
      storage.markEventHandled("payreq", "p1");
      storage.setTransferWatermark(1_000);
      expect(storage.isBelowDmFloor(T, OWNER)).toBe(true);
    });

    it("let an ahead floor reach a week past its marking at most", () => {
      const D = 1_000_000;
      seed([{ id: "year-ahead", ts: D + 5 * MINUTE, markedAt: D, peer: OWNER, aheadTs: D + 365 * DAY }, ...later(D + 1)]);
      expect(atTime(D + 3_000, () => storage.markEventHandled("dm", "n-last", D + 3_000, "k6"))).toBe(true);
      expect(storage.isEventHandled("dm", "year-ahead")).toBe(false);
      expect(storage.isBelowDmFloor(D + 7 * DAY, OWNER)).toBe(true);
      expect(storage.isBelowDmFloor(D + 7 * DAY + 1_000, OWNER)).toBe(false);
    });

    it("only raise an ahead floor, ranking it by the capped floor its markers left", () => {
      seed([
        { id: "far", ts: 1_000_000 + 5 * MINUTE, markedAt: 1_000_000, peer: OWNER, aheadTs: 1_000_000 + 60 * MINUTE },
        { id: "near", ts: 1_100_000 + 5 * MINUTE, markedAt: 1_100_000, peer: OWNER, aheadTs: 1_100_000 + 10 * MINUTE },
        ...Array.from({ length: 398 }, (_, i) => ({ id: `o${i}`, ts: 9_000_000 + i, markedAt: 9_000_000 + i, peer: OWNER })),
      ]);
      expect(atTime(9_500_000, () => storage.markEventsHandled("dm", ["x1", "x2"], 9_500_000, OWNER))).toBe(2);
      expect(storage.isEventHandled("dm", "far")).toBe(false);
      expect(storage.isEventHandled("dm", "near")).toBe(false);
      const expected = { [OWNER]: { floor: 1_000_000 + 60 * MINUTE, rank: 1_100_000 + 5 * MINUTE } };
      expect(floors().dmPeerAheadFloors).toEqual(expected);
      // A marker evicted later with a lower floor and rank lowers neither.
      expect(atTime(9_600_000, () => storage.markEventHandled("dm", "odd", 1_000_000, OWNER, { aheadTs: 1_200_000 }))).toBe(true);
      expect(storage.isEventHandled("dm", "odd")).toBe(false);
      expect(floors().dmPeerAheadFloors).toEqual(expected);
    });

    it("keep ahead floors apart from sender floors: far-future drops from many keys never push out a sender floor", () => {
      const ahead = Object.fromEntries(
        Array.from({ length: 1_000 }, (_, i) => [`a${i}`, { floor: 9e15, rank: 3_000_000 + i }]),
      );
      seed(
        [
          { id: "late-ahead", ts: 4_000_000 + 5 * MINUTE, markedAt: 4_000_000, peer: "late", aheadTs: 4_000_000 + 20 * MINUTE },
          ...later(5_000_000),
        ],
        { dmPeerFloors: { [OWNER]: 6_000_000 }, dmPeerAheadFloors: ahead },
      );
      expect(atTime(5_100_000, () => storage.markEventHandled("dm", "n-last", 5_100_000, "k6"))).toBe(true);
      const f = floors();
      expect(f.dmFloor).toBe(4_000_000);
      expect(f.dmPeerFloors).toEqual({ [OWNER]: 6_000_000, late: 4_000_000 + 5 * MINUTE });
      expect(storage.isBelowDmFloor(6_000_000, OWNER)).toBe(true);
      // Past 1,000 senders the lowest-ranked ahead floor goes, however far ahead it reaches.
      expect(Object.keys(f.dmPeerAheadFloors!)).toHaveLength(1_000);
      expect(f.dmPeerAheadFloors).not.toHaveProperty("a0");
      expect(f.dmPeerAheadFloors).toHaveProperty("a1");
      expect(f.dmPeerAheadFloors).toHaveProperty("late", { floor: 4_000_000 + 20 * MINUTE, rank: 4_000_000 + 5 * MINUTE });
    });

    it("drop an ahead floor that the overall floor or the sender's own floor covers", () => {
      seed(later(3_000_000, 2_000), {
        dmFloor: 4_000_000,
        dmPeerFloors: { k: 4_500_000 },
        dmPeerAheadFloors: { gone: { floor: 4_000_000, rank: 1 }, k: { floor: 4_500_000, rank: 2 }, stays: { floor: 4_000_001, rank: 3 } },
      });
      expect(storage.isBelowDmFloor(4_000_001, "stays")).toBe(true);
      expect(atTime(5_100_000, () => storage.markEventHandled("dm", "n-last", 5_100_000, "k6"))).toBe(true);
      expect(floors().dmPeerAheadFloors).toEqual({ stays: { floor: 4_000_001, rank: 3 } });
    });

    it("keep an ahead floor that no other floor covers, also when every sender floor is covered by the overall one", () => {
      const D = 1_000_000;
      const T = D + 10 * MINUTE;
      seed([
        { id: "ahead", ts: D + 5 * MINUTE, markedAt: D, peer: OWNER, aheadTs: T },
        { id: "k-old", ts: D + 6 * MINUTE, markedAt: D + 6 * MINUTE, peer: "k0" },
        ...later(D + 7 * MINUTE),
      ]);
      // One over the cap after this mark: both oldest go, and the overall floor passes the sender floors they leave.
      expect(atTime(D + 8 * MINUTE, () => storage.markEventHandled("dm", "n-last", D + 8 * MINUTE, "k6"))).toBe(true);
      expect(storage.isEventHandled("dm", "ahead")).toBe(false);
      expect(floors().dmFloor).toBe(D + 6 * MINUTE);
      expect(floors().dmPeerFloors).toBeUndefined();
      expect(floors().dmPeerAheadFloors).toEqual({ [OWNER]: { floor: T, rank: D + 5 * MINUTE } });
      expect(storage.isBelowDmFloor(T, OWNER)).toBe(true);
    });

    it("count a DM without a usable timestamp as below the floor, even before any floor exists", () => {
      expect(storage.isBelowDmFloor(Number.NaN, OWNER)).toBe(true);
      expect(storage.isBelowDmFloor(1_000, OWNER)).toBe(false);
    });

    it("treat a marker without a valid marking time as marked no later than now", () => {
      const NOW = 10_000_000;
      seed([
        { id: "odd", ts: 9e15, peer: "k5" },
        ...Array.from({ length: 1_999 }, (_, i) => ({ id: `n${i}`, ts: 20_000_000, peer: `k${i % 5}` })),
      ]);
      expect(atTime(NOW, () => storage.markEventHandled("dm", "next", NOW, "k-next"))).toBe(true);
      expect(storage.isEventHandled("dm", "odd")).toBe(false);
      expect(floors().dmFloor).toBe(NOW);
    });

    it("evict the earliest marked among equal timestamps, and the new marker itself when it is the oldest", () => {
      seed(Array.from({ length: 2_000 }, (_, i) => ({ id: `s${i}`, ts: 1_000 })));
      expect(storage.markEventHandled("dm", "same", 1_000)).toBe(true);
      expect(storage.isEventHandled("dm", "s0")).toBe(false);
      expect(storage.isEventHandled("dm", "s1")).toBe(true);
      expect(storage.isEventHandled("dm", "same")).toBe(true);
      expect(storage.markEventHandled("dm", "ancient", 1)).toBe(true);
      expect(storage.isEventHandled("dm", "ancient")).toBe(false);
      expect(dmIds()).toHaveLength(2_000);
      expect(floors().dmFloor).toBe(1_000); // floors only move up
    });

    it("drop sender floors the overall floor covers, and past 1000 keep the highest", () => {
      const high = Object.fromEntries(Array.from({ length: 1_001 }, (_, i) => [`h${i}`, 2_000_000 + i]));
      seed(
        Array.from({ length: 2_000 }, (_, i) => ({ id: `d${i}`, ts: 10_000 + i, markedAt: 50_000, peer: `p${i}` })),
        { dmFloor: 20_000, dmPeerFloors: { low: 15_000, ...high } },
      );
      expect(storage.markEventHandled("dm", "next", 40_000, "p-next")).toBe(true);
      expect(storage.isEventHandled("dm", "d0")).toBe(false);
      const { dmFloor, dmPeerFloors } = floors();
      expect(dmFloor).toBe(20_000);
      expect(Object.keys(dmPeerFloors!)).toHaveLength(1_000);
      expect(dmPeerFloors).not.toHaveProperty("low");
      expect(dmPeerFloors).not.toHaveProperty("p0");
      expect(dmPeerFloors).not.toHaveProperty("h0");
      expect(dmPeerFloors).toHaveProperty("h1", 2_000_001);
    });
  });
});

describe("transfer watermark", () => {
  it("is null until set, only moves forward and survives id updates", () => {
    expect(storage.getTransferWatermark()).toBeNull();
    storage.setTransferWatermark(1_000);
    storage.markEventHandled("transfer", "t1");
    expect(storage.getTransferWatermark()).toBe(1_000);
    storage.setTransferWatermark(500);
    expect(storage.getTransferWatermark()).toBe(1_000);
    storage.setTransferWatermark(2_000);
    expect(storage.getTransferWatermark()).toBe(2_000);
    expect(storage.isEventHandled("transfer", "t1")).toBe(true);
  });

  it("ignores a malformed watermark", () => {
    storage.writeJsonFileAtomic(storage.EVENT_STATE_PATH, { transferWatermark: "soon" });
    expect(storage.getTransferWatermark()).toBeNull();
  });
});

describe("sanctioned groups", () => {
  const K1 = "a".repeat(64);
  const K2 = "b".repeat(64);

  it("approves only groups the owner joined or created, per wallet key", () => {
    expect(storage.isGroupApproved(K1, "g1")).toBe(false);
    storage.approveGroup(K1, "g1");
    storage.approveGroup(K1, "g1");
    expect(storage.isGroupApproved(K1, "g1")).toBe(true);
    expect(storage.isGroupApproved(K1, "g2")).toBe(false);
    expect(storage.isGroupApproved(K2, "g1")).toBe(false);
    expect(storage.readJsonFile(storage.GROUPS_APPROVED_PATH, {})).toEqual({ [K1]: { approved: ["g1"], notified: [] } });
    expect(mode(storage.GROUPS_APPROVED_PATH)).toBe(0o600);
  });

  it("checks the notice mark without writing, and marks it once", () => {
    expect(storage.isGroupNotified(K1, "x")).toBe(false);
    expect(existsSync(storage.GROUPS_APPROVED_PATH)).toBe(false);
    expect(storage.markGroupNotified(K1, "x")).toBe(true);
    expect(storage.isGroupNotified(K1, "x")).toBe(true);
    expect(storage.isGroupNotified(K2, "x")).toBe(false);
    expect(storage.markGroupNotified(K1, "x")).toBe(false);
    expect(storage.isGroupApproved(K1, "x")).toBe(false);
    expect(storage.readJsonFile(storage.GROUPS_APPROVED_PATH, {})).toEqual({ [K1]: { approved: [], notified: ["x"] } });
  });

  it("revokes a group the wallet left: approval and notice mark go, other groups and keys stay", () => {
    storage.approveGroup(K1, "g1");
    storage.approveGroup(K1, "g2");
    storage.markGroupNotified(K1, "spam");
    storage.approveGroup(K2, "g1");
    storage.revokeGroup(K1, "g1");
    storage.revokeGroup(K1, "spam");
    expect(storage.isGroupApproved(K1, "g1")).toBe(false);
    expect(storage.isGroupApproved(K1, "g2")).toBe(true);
    expect(storage.isGroupApproved(K2, "g1")).toBe(true);
    expect(storage.readJsonFile(storage.GROUPS_APPROVED_PATH, {})).toEqual({
      [K1]: { approved: ["g2"], notified: [] },
      [K2]: { approved: ["g1"], notified: [] },
    });
    // Re-added by a group admin later: ignored, and the owner is told again.
    expect(storage.isGroupNotified(K1, "spam")).toBe(false);
    expect(storage.markGroupNotified(K1, "spam")).toBe(true);
    // Joining again on request approves it again.
    storage.approveGroup(K1, "g1");
    expect(storage.isGroupApproved(K1, "g1")).toBe(true);
  });

  it("writes nothing when a revocation has nothing to forget", () => {
    storage.revokeGroup(K1, "g1");
    expect(existsSync(storage.GROUPS_APPROVED_PATH)).toBe(false);
  });

  it("fails closed on an unreadable or corrupt file: no approval, nothing overwritten", () => {
    mkdirSync(dir, { recursive: true });
    for (const bad of ["{not json", "[]", "7"]) {
      writeFileSync(storage.GROUPS_APPROVED_PATH, bad);
      expect(() => storage.isGroupApproved(K1, "g1"), bad).toThrow(/groups-approved\.json .*repair it/);
      expect(() => storage.isGroupNotified(K1, "g1"), bad).toThrow(/groups-approved\.json/);
      expect(() => storage.approveGroup(K1, "g1"), bad).toThrow(/groups-approved\.json/);
      expect(() => storage.markGroupNotified(K1, "g1"), bad).toThrow(/groups-approved\.json/);
      expect(() => storage.revokeGroup(K1, "g1"), bad).toThrow(/groups-approved\.json/);
      expect(readFileSync(storage.GROUPS_APPROVED_PATH, "utf8")).toBe(bad);
    }
    rmSync(storage.GROUPS_APPROVED_PATH);
    mkdirSync(storage.GROUPS_APPROVED_PATH);
    expect(() => storage.isGroupApproved(K1, "g1")).toThrow(/unreadable or corrupt/);
  });

  it("reads a malformed entry as approving nothing, and replaces it on the next approval", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storage.GROUPS_APPROVED_PATH, `{"${K1}": {"approved": "g1"}, "${K2}": 7}`);
    expect(storage.isGroupApproved(K1, "g1")).toBe(false);
    expect(storage.isGroupNotified(K2, "g1")).toBe(false);
    storage.approveGroup(K1, "g1");
    expect(storage.isGroupApproved(K1, "g1")).toBe(true);
  });
});

describe("gateway status", () => {
  it("writes, reads and deletes the status file", () => {
    expect(storage.readGatewayStatus()).toBeNull();
    const s = { pid: 42, startedAt: 1, network: "testnet2", nametag: "bot", hasPayments: true };
    storage.writeGatewayStatus(s);
    expect(storage.readGatewayStatus()).toEqual(s);
    expect(mode(storage.STATUS_PATH)).toBe(0o600);
    storage.writeGatewayStatus(null);
    expect(existsSync(storage.STATUS_PATH)).toBe(false);
    storage.writeGatewayStatus(null);
  });

  it("ignores malformed status files", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storage.STATUS_PATH, '{"pid":"x"}');
    expect(storage.readGatewayStatus()).toBeNull();
  });
});
