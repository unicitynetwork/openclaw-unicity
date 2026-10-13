import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWalletLock, readLockHolder, WalletLockedError, type LockInfo } from "../src/lock.js";
import { setDataDirForTests, WALLET_LOCK_PATH } from "../src/storage.js";

/**
 * macOS emulation: hide /proc from src/lock.ts and stand in for `ps`. Off unless a test turns it on. `uptime` pins the
 * host uptime the pre-boot rule sees (null = the real one), so those tests do not depend on when the host booted.
 */
const sys = vi.hoisted(() => ({ hideProc: false, execFileSync: vi.fn(), uptime: null as number | null }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: sys.execFileSync,
}));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, uptime: () => sys.uptime ?? real.uptime() };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (path: unknown, ...rest: unknown[]): unknown => {
    if (sys.hideProc && typeof path === "string" && path.startsWith("/proc/")) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  };
  return { ...real, readFileSync };
});

/*
 * Cross-process cases run real child Node processes over src/lock.ts (Node's built-in type stripping plus a tiny
 * resolve hook that maps the source's "./x.js" imports to "./x.ts"). Staleness thresholds are exercised by
 * back-dating the lock file's mtime instead of sleeping through them.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const root = mkdtempSync(join(tmpdir(), "unicity-lock-"));
const helpers = join(root, "helpers");
const REGISTER = join(helpers, "register.mjs");
const CHILD = join(helpers, "child.mjs");

const CHILD_SOURCE = `
import { pathToFileURL } from "node:url";
const [src, dataDir, mode, arg] = process.argv.slice(2);
const storage = await import(pathToFileURL(src + "/storage.ts").href);
const { acquireWalletLock, WalletLockedError } = await import(pathToFileURL(src + "/lock.ts").href);
storage.setDataDirForTests(dataDir);
process.on("SIGTERM", () => process.exit(0));
try {
  const lock = await acquireWalletLock({
    role: mode === "hold" ? "gateway" : "cli",
    command: mode,
    ...(mode === "wait" ? { wait: { timeoutMs: Number(arg) } } : {}),
  });
  console.log("ACQUIRED " + process.pid);
  if (mode === "hold" && arg) {
    await new Promise((r) => setTimeout(r, Number(arg)));
    await lock.release();
    console.log("RELEASED");
  } else if (mode === "hold" || mode === "contend") {
    setInterval(() => {}, 1 << 30);
  } else {
    await lock.release();
  }
} catch (e) {
  console.log(e instanceof WalletLockedError ? "LOCKED " + JSON.stringify(e.holder) : "ERROR " + e.message);
}
`;

const HOOKS_SOURCE = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && /^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}
`;

type Child = { proc: ChildProcess; nextLine(): Promise<string>; exited: Promise<void>; stderr(): string };
const children: Child[] = [];
let dir = "";
let n = 0;

function startChild(...args: string[]): Child {
  const proc = spawn(process.execPath, ["--no-warnings", "--import", REGISTER, CHILD, SRC, dir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiting: Array<(l: string) => void> = [];
  let buf = "";
  let err = "";
  proc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<void>((r) => proc.on("exit", () => r()));
  const child: Child = {
    proc,
    exited,
    stderr: () => err,
    nextLine: () => {
      const l = lines.shift();
      if (l !== undefined) return Promise.resolve(l);
      return new Promise<string>((resolveLine, reject) => {
        waiting.push(resolveLine);
        void exited.then(() => setTimeout(() => reject(new Error(`child exited: ${err}`)), 50));
      });
    },
  };
  children.push(child);
  return child;
}

function writeLock(info: Partial<LockInfo> | string, ageMs: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(WALLET_LOCK_PATH, typeof info === "string" ? info : JSON.stringify(info));
  backdate(ageMs);
}

function backdate(ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(WALLET_LOCK_PATH, t, t);
}

/** Field 22 of /proc/<pid>/stat, as src/lock.ts records it. */
function linuxProcStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

/** Fake setTimeout, Date and performance.now (the lock's poll sleep and its monotonic watch). */
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => c.on("exit", r));
  return c.pid!;
}

const foreign = (over: Partial<LockInfo> = {}): LockInfo => ({
  token: "t-other",
  pid: 999_999,
  host: hostname(),
  role: "gateway",
  acquiredAt: Date.now(),
  ...over,
});

beforeAll(() => {
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, "hooks.mjs"), HOOKS_SOURCE);
  writeFileSync(REGISTER, 'import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n');
  writeFileSync(CHILD, CHILD_SOURCE);
});

beforeEach(() => {
  dir = join(root, `case-${n++}`);
  setDataDirForTests(dir);
});

afterEach(async () => {
  vi.useRealTimers();
  sys.uptime = null;
  for (const c of children.splice(0)) {
    if (c.proc.exitCode === null && c.proc.signalCode === null) {
      c.proc.kill("SIGKILL");
      await c.exited;
    }
  }
  setDataDirForTests();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("across processes", () => {
  it("refuses a fail-fast contender while another process holds the lock", async () => {
    const holder = startChild("hold");
    expect(await holder.nextLine()).toBe(`ACQUIRED ${holder.proc.pid}`);

    const err = await acquireWalletLock({ role: "cli", command: "status" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletLockedError);
    expect((err as WalletLockedError).holder).toMatchObject({ pid: holder.proc.pid, role: "gateway", host: hostname() });
    expect((err as WalletLockedError).message).toMatch(/in use by the gateway \(hold\), pid \d+/);
    expect(readLockHolder()).toMatchObject({ pid: holder.proc.pid, role: "gateway" });

    holder.proc.kill("SIGTERM");
    await holder.exited;
    expect(existsSync(WALLET_LOCK_PATH)).toBe(false);
    expect(readLockHolder()).toBeNull();
  }, 20_000);

  it("lets a waiter acquire as soon as the holder releases", async () => {
    const holder = startChild("hold", "1500");
    expect(await holder.nextLine()).toMatch(/^ACQUIRED/);
    const t0 = Date.now();
    const lock = await acquireWalletLock({ role: "gateway", wait: { timeoutMs: 15_000 } });
    expect(Date.now() - t0).toBeGreaterThan(500);
    expect(await holder.nextLine()).toBe("RELEASED");
    expect(readLockHolder()).toMatchObject({ pid: process.pid, token: lock.info.token });
    await lock.release();
  }, 20_000);

  it("child waiters acquire after the in-process holder releases", async () => {
    const lock = await acquireWalletLock({ role: "gateway" });
    const waiter = startChild("wait", "15000");
    const failFast = startChild("contend");
    expect(await failFast.nextLine()).toMatch(/^LOCKED .*"role":"gateway"/);
    await new Promise((r) => setTimeout(r, 300));
    await lock.release();
    expect(await waiter.nextLine()).toBe(`ACQUIRED ${waiter.proc.pid}`);
  }, 20_000);

  it("takes over from a SIGKILLed holder only after its heartbeat goes stale", async () => {
    const holder = startChild("hold");
    expect(await holder.nextLine()).toMatch(/^ACQUIRED/);
    holder.proc.kill("SIGKILL");
    await holder.exited;

    // Dead pid but a fresh heartbeat: still held (a pid namespace can make a live holder look dead).
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError);

    backdate(13_000);
    expect(readLockHolder()).toBeNull();
    const lock = await acquireWalletLock({ role: "cli" });
    expect(JSON.parse(readFileSync(WALLET_LOCK_PATH, "utf8"))).toMatchObject({ pid: process.pid, token: lock.info.token });
    await lock.release();
  }, 20_000);

  it("lets exactly one of many concurrent contenders break a stale lock", async () => {
    writeLock(foreign({ pid: await deadPid() }), 60_000);
    const contenders = Array.from({ length: 10 }, () => startChild("contend"));
    const results = await Promise.all(contenders.map((c) => c.nextLine()));
    const winners = results.filter((r) => r.startsWith("ACQUIRED"));
    expect(winners, results.join("\n")).toHaveLength(1);
    expect(results.filter((r) => r.startsWith("LOCKED"))).toHaveLength(9);
    expect(existsSync(`${WALLET_LOCK_PATH}.break`)).toBe(false);
  }, 30_000);
});

describe("staleness rules", () => {
  it.runIf(existsSync("/proc/self/stat"))("never steals from a live pid with a matching start time, however old the heartbeat", async () => {
    writeLock(foreign({ pid: process.ppid, procStart: linuxProcStart(process.ppid) }), 3_600_000);
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError);
    expect(readLockHolder()).toMatchObject({ token: "t-other" });
  });

  it.runIf(existsSync("/proc/self/stat"))("treats a lock under this process's pid that it does not hold as a dead predecessor's", async () => {
    // Same pid and even the same start time: only the token tells the relaunched holder from its predecessor.
    const old = foreign({ token: "predecessor", pid: process.pid, procStart: linuxProcStart(process.pid) });
    writeLock(old, 0);
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError); // fresh: may share the pid from another namespace
    backdate(11_000);
    expect(readLockHolder()).toBeNull();
    const lock = await acquireWalletLock({ role: "cli" });
    await lock.release();
  });

  it("keeps a lock this process holds live however old its heartbeat, also for another module instance", async () => {
    const lock = await acquireWalletLock({ role: "gateway" });
    backdate(3_600_000);
    expect(readLockHolder()).toMatchObject({ token: lock.info.token });
    vi.resetModules();
    const fresh = (await import("../src/lock.js")) as typeof import("../src/lock.js");
    (await import("../src/storage.js")).setDataDirForTests(dir);
    expect(fresh.readLockHolder()).toMatchObject({ token: lock.info.token });
    await expect(fresh.acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(fresh.WalletLockedError);
    await lock.release();
  });

  it("breaks a lock of a live pid with unknown start time that was last touched before this boot", async () => {
    sys.uptime = 300;
    writeLock(foreign({ pid: process.ppid }), 300_000 + 120_000);
    expect(readLockHolder()).toBeNull();
    const lock = await acquireWalletLock({ role: "cli" }); // no confirmation wait
    await lock.release();
  });

  it("breaks a live-pid lock of unknown start time only after watching it unchanged for 15 s", async () => {
    sys.uptime = 86_400; // booted long before the lock was last touched: the pre-boot rule does not apply
    writeLock(foreign({ pid: process.ppid }), 200_000); // Windows: no start time recorded
    fakeClock();
    expect(readLockHolder()).toBeNull();
    let settled = false;
    const acquiring = acquireWalletLock({ role: "cli" }).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    expect(JSON.parse(readFileSync(WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "t-other" });
    await vi.advanceTimersByTimeAsync(2_000);
    const lock = await acquiring;
    expect(lock.info.pid).toBe(process.pid);
    await lock.release();
  });

  it("never breaks a live-pid lock of unknown start time that keeps heartbeating", async () => {
    sys.uptime = 86_400;
    writeLock(foreign({ pid: process.ppid }), 200_000);
    fakeClock();
    const outcome = acquireWalletLock({ role: "cli" }).then(() => "acquired", (e: unknown) => e);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      backdate(200_000); // touched, by a clock far behind
    }
    expect(await outcome).toBeInstanceOf(WalletLockedError);
    expect(JSON.parse(readFileSync(WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "t-other" });
  });

  it.runIf(existsSync("/proc/self/stat"))("holds a fresh lock of a live pid with another start time, and breaks it as a reused pid once 10 s old", async () => {
    // Fresh: the holder may share the hostname and the pid number from another pid namespace.
    writeLock(foreign({ pid: process.ppid, procStart: "1" }), 0);
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError);
    expect(readLockHolder()).toMatchObject({ token: "t-other" });
    backdate(11_000);
    expect(readLockHolder()).toBeNull();
    const lock = await acquireWalletLock({ role: "cli" });
    expect(lock.info.procStart).toMatch(/^\d+$/);
    await lock.release();
  });

  it("holds a foreign-host lock while its heartbeat is under 120 s, then breaks it after a 15 s watch", async () => {
    writeLock(foreign({ host: "other-container" }), 100_000);
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError);
    backdate(121_000);
    fakeClock();
    const acquiring = acquireWalletLock({ role: "cli" });
    await vi.advanceTimersByTimeAsync(16_000);
    const lock = await acquiring;
    await lock.release();
  });

  it("never breaks a foreign-host lock that keeps heartbeating, however far behind the holder's clock is", async () => {
    writeLock(foreign({ host: "other-container" }), 180_000);
    fakeClock();
    expect(readLockHolder()).toBeNull(); // unconfirmed: the acquire path decides
    const outcome = acquireWalletLock({ role: "cli", command: "status" }).then(() => "acquired", (e: unknown) => e);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      backdate(180_000); // the holder's heartbeat, stamped 3 min in the past
    }
    const err = await outcome;
    expect(err).toBeInstanceOf(WalletLockedError);
    expect((err as WalletLockedError).holder).toMatchObject({ token: "t-other", role: "gateway" });
    expect(JSON.parse(readFileSync(WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "t-other" });
  });

  it("a waiting acquire keeps watching a heartbeating foreign lock and takes it once it stops", async () => {
    writeLock(foreign({ host: "other-container" }), 180_000);
    fakeClock();
    let settled = false;
    const acquiring = acquireWalletLock({ role: "gateway", wait: { timeoutMs: 120_000 } }).finally(() => (settled = true));
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      backdate(180_000);
    }
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(16_000); // holder gone: no more touches
    const lock = await acquiring;
    await lock.release();
  });

  it("holds an unparsable lock for 5 s, then breaks it", async () => {
    writeLock("garbage", 0);
    const err = (await acquireWalletLock({ role: "cli" }).catch((e: unknown) => e)) as WalletLockedError;
    expect(err).toBeInstanceOf(WalletLockedError);
    expect(err.holder.token).toBe("");
    expect(err.message).toMatch(/unreadable/);
    expect(readLockHolder()).toBeNull();
    backdate(6_000);
    const lock = await acquireWalletLock({ role: "cli" });
    await lock.release();
  });

  it("clears a leftover break guard once it is old", async () => {
    writeLock(foreign({ pid: await deadPid() }), 60_000);
    writeFileSync(`${WALLET_LOCK_PATH}.break`, "");
    // A fresh guard means another contender is breaking the lock right now.
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError);
    const t = new Date(Date.now() - 11_000);
    utimesSync(`${WALLET_LOCK_PATH}.break`, t, t);
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError); // removes the old guard
    const lock = await acquireWalletLock({ role: "cli" });
    await lock.release();
  });
});

describe("macOS (no /proc): start time from ps", () => {
  let platform: PropertyDescriptor | undefined;

  beforeEach(() => {
    sys.hideProc = true;
    platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  });

  afterEach(() => {
    sys.hideProc = false;
    Object.defineProperty(process, "platform", platform!);
    sys.execFileSync.mockReset();
  });

  const psStart = (byPid: Record<number, string>) =>
    sys.execFileSync.mockImplementation((_file: string, args: string[]) => `${byPid[Number(args.at(-1))] ?? ""}\n`);

  it("records the holder's start time in a fixed locale and zone", async () => {
    psStart({ [process.pid]: "Mon Oct 12 09:00:00 2026" });
    const lock = await acquireWalletLock({ role: "cli" });
    expect(lock.info.procStart).toBe("Mon Oct 12 09:00:00 2026");
    expect(sys.execFileSync).toHaveBeenCalledWith(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      expect.objectContaining({ env: { LC_ALL: "C", TZ: "UTC" } }),
    );
    await lock.release();
  });

  const psCalls = (pid: number) => sys.execFileSync.mock.calls.filter((c) => (c[1] as string[]).at(-1) === String(pid)).length;

  it("detects a reused pid by its ps start time, and keeps a matching one", async () => {
    psStart({ [process.ppid]: "Mon Oct 12 10:00:00 2026" });
    writeLock(foreign({ pid: process.ppid, procStart: "Mon Oct 12 10:00:00 2026" }), 20_000);
    expect(readLockHolder()).toMatchObject({ token: "t-other" });

    writeLock(foreign({ pid: process.ppid, procStart: "Sun Oct 11 08:00:00 2026" }), 20_000);
    expect(readLockHolder()).toBeNull();
    const lock = await acquireWalletLock({ role: "cli" });
    await lock.release();
  });

  it("does not spawn ps while polling a heartbeating holder, only once its lock is over 10 s old", async () => {
    psStart({ [process.ppid]: "Mon Oct 12 10:00:00 2026" });
    // Another start time than ps reports, but fresh: possibly a holder in another pid namespace.
    writeLock(foreign({ pid: process.ppid, procStart: "Sun Oct 11 08:00:00 2026" }), 0);
    fakeClock();
    const outcome = acquireWalletLock({ role: "gateway", wait: { timeoutMs: 3_000 } }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await outcome).toBeInstanceOf(WalletLockedError);
    expect(readLockHolder()).toMatchObject({ token: "t-other" });
    expect(psCalls(process.ppid)).toBe(0);

    backdate(11_000);
    expect(readLockHolder()).toBeNull();
    expect(psCalls(process.ppid)).toBe(1);
  });
});

describe("waiting", () => {
  it("gives up with WalletLockedError after timeoutMs", async () => {
    writeLock(foreign({ pid: process.pid }), 0);
    const t0 = Date.now();
    await expect(acquireWalletLock({ role: "gateway", wait: { timeoutMs: 700 } })).rejects.toBeInstanceOf(WalletLockedError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650);
  });

  it("rejects with the abort reason when the signal aborts", async () => {
    writeLock(foreign({ pid: process.pid }), 0);
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 200);
    await expect(acquireWalletLock({ role: "gateway", wait: { timeoutMs: 10_000, signal: ac.signal } })).rejects.toThrow("stop");
    await expect(acquireWalletLock({ role: "gateway", wait: { timeoutMs: 10_000, signal: ac.signal } })).rejects.toThrow("stop");
  });
});

describe("holding", () => {
  it("records the holder and releases idempotently", async () => {
    const exitListeners = process.listenerCount("exit");
    const lock = await acquireWalletLock({ role: "cli", command: "send" });
    expect(lock.info).toMatchObject({ pid: process.pid, host: hostname(), role: "cli", command: "send" });
    expect(lock.info.acquiredAt).toBeLessThanOrEqual(Date.now());
    expect(statSync(WALLET_LOCK_PATH).mode & 0o777).toBe(0o600);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    await lock.release();
    await lock.release();
    expect(existsSync(WALLET_LOCK_PATH)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  it("heartbeats the mtime and reports a takeover once via onLost, without deleting the new holder's lock", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onLost = vi.fn();
    const lock = await acquireWalletLock({ role: "gateway", onLost });

    backdate(60_000);
    vi.advanceTimersByTime(5_000);
    expect(Date.now() - statSync(WALLET_LOCK_PATH).mtimeMs).toBeLessThan(5_000);

    writeFileSync(WALLET_LOCK_PATH, JSON.stringify(foreign()));
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0][0]).toMatch(/taken over/);

    await lock.release();
    expect(JSON.parse(readFileSync(WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "t-other" });
  });

  it("re-creates a lock file deleted while held, so a contender is still refused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onLost = vi.fn();
    const lock = await acquireWalletLock({ role: "gateway", onLost });
    rmSync(WALLET_LOCK_PATH);
    vi.advanceTimersByTime(5_000);
    expect(onLost).not.toHaveBeenCalled();
    expect(readLockHolder()).toMatchObject({ token: lock.info.token, pid: process.pid, role: "gateway" });
    await expect(acquireWalletLock({ role: "cli" })).rejects.toBeInstanceOf(WalletLockedError);
    await lock.release();
    expect(existsSync(WALLET_LOCK_PATH)).toBe(false);
  });

  it("reports a deleted lock file another process claimed first as taken over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onLost = vi.fn();
    const lock = await acquireWalletLock({ role: "gateway", onLost });
    rmSync(WALLET_LOCK_PATH);
    writeFileSync(WALLET_LOCK_PATH, JSON.stringify(foreign({ role: "cli" })));
    vi.advanceTimersByTime(5_000);
    expect(onLost).toHaveBeenCalledWith(expect.stringMatching(/taken over/));
    await lock.release();
    expect(readLockHolder()).toMatchObject({ token: "t-other" });
  });

  it.skipIf(process.getuid?.() === 0)("reports a deleted lock file it cannot re-create via onLost", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onLost = vi.fn();
    const lock = await acquireWalletLock({ role: "gateway", onLost });
    rmSync(WALLET_LOCK_PATH);
    chmodSync(dir, 0o500);
    try {
      vi.advanceTimersByTime(5_000);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(onLost).toHaveBeenCalledWith(expect.stringMatching(/removed and could not be restored/));
    vi.advanceTimersByTime(5_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(existsSync(WALLET_LOCK_PATH)).toBe(false);
    await lock.release();
  });
});

describe("data dir", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes the lock under OpenClaw's state dir when nothing resolved the data dir before", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    setDataDirForTests();
    const lock = await acquireWalletLock({ role: "cli" });
    expect(WALLET_LOCK_PATH).toBe(join(dir, "unicity", "wallet.lock"));
    expect(JSON.parse(readFileSync(WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: lock.info.token });
    await lock.release();
    expect(existsSync(WALLET_LOCK_PATH)).toBe(false);
  });

  it("reads the holder under OpenClaw's state dir when nothing resolved the data dir before", () => {
    mkdirSync(join(dir, "unicity"), { recursive: true });
    writeFileSync(join(dir, "unicity", "wallet.lock"), JSON.stringify(foreign({ pid: process.pid })));
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    setDataDirForTests();
    expect(readLockHolder()).toMatchObject({ token: "t-other", pid: process.pid });
  });
});
