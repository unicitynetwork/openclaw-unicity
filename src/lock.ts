/**
 * Cross-process wallet lock over DATA_DIR/wallet.lock. Only one process may hold a Sphere over the data dir:
 * FileStorageProvider rewrites the whole wallet.json from its own snapshot, so a second writer loses updates.
 *
 * Acquire = atomic O_CREAT|O_EXCL create. The holder touches the file every 5 s. A lock on this host is stale when it
 * carries this process's pid but a token this process does not hold and is 10 s old (a dead predecessor whose pid was
 * reused, e.g. in a restarted container); its pid is dead and it is 12 s old (a pid namespace can make a live holder
 * look dead); its pid is alive but started at a different time (Linux /proc, macOS ps) and it is 10 s old; or its
 * pid's start time is unknown (Windows) and it was last touched before the host booted. Otherwise a live pid of unknown
 * start time, and a lock from another host (container), are only suspect once 120 s old, and are broken after this
 * process watched them for 15 s (monotonic) with an unchanged token and mtime: a live holder touches the file within
 * 5 s, whatever its clock says and also right after waking from sleep. An unparsable lock is stale once 5 s old.
 * Locks are broken only under a short O_EXCL `wallet.lock.break` guard after re-reading the lock under it.
 * A holder whose lock file disappears re-creates it on the next heartbeat.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { resolveDataDir, WALLET_LOCK_PATH } from "./storage.js";

export type LockInfo = {
  token: string;
  pid: number;
  host: string;
  procStart?: string;
  role: "gateway" | "cli";
  command?: string;
  acquiredAt: number;
};

export type WalletLock = { readonly info: LockInfo; release(): Promise<void> };

const HEARTBEAT_MS = 5_000;
const LOCAL_DEAD_STALE_MS = 12_000;
const SUSPECT_AFTER_MS = 120_000;
const CONFIRM_MS = 3 * HEARTBEAT_MS;
const PRE_BOOT_SLACK_MS = 60_000;
const UNPARSABLE_STALE_MS = 5_000;
const GUARD_STALE_MS = 10_000;
const POLL_MS = 500;

/** Tokens of the locks this process holds, shared by every copy of this module (a plugin reload re-imports it). */
const HELD = ((globalThis as unknown as Record<symbol, Set<string> | undefined>)[Symbol.for("openclaw-unicity.walletLock.held")] ??=
  new Set<string>());

export class WalletLockedError extends Error {
  readonly holder: LockInfo;

  constructor(holder: LockInfo) {
    super(describeHolder(holder));
    this.name = "WalletLockedError";
    this.holder = holder;
  }
}

function describeHolder(h: LockInfo): string {
  if (!h.token) return `Unicity wallet lock file ${WALLET_LOCK_PATH} is unreadable; it is treated as stale after a few seconds`;
  const what = h.command ? `${h.role} (${h.command})` : h.role;
  return (
    `Unicity wallet is in use by the ${what}, pid ${h.pid} on ${h.host} since ${new Date(h.acquiredAt).toISOString()} ` +
    `(lock file ${WALLET_LOCK_PATH})`
  );
}

type Seen = { info: LockInfo | null; mtimeMs: number };
/** A suspect lock as first observed by this process, at performance.now() `since`. */
type Watch = { token: string; mtimeMs: number; since: number };
type Verdict = "live" | "stale" | "suspect";

const sameAs = (w: Watch, seen: Seen): boolean => w.token === (seen.info?.token ?? "") && w.mtimeMs === seen.mtimeMs;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Process start time, which defeats pid reuse: field 22 of /proc/<pid>/stat (Linux), else `ps -o lstart=` in a fixed
 * locale and zone (macOS). Undefined elsewhere (Windows) or when the pid is gone.
 */
function procStartOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
  } catch {
    // no /proc (macOS, Windows) or no such pid
  }
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      env: { LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

function parseInfo(raw: string): LockInfo | null {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      v && typeof v.token === "string" && v.token && typeof v.pid === "number" && typeof v.host === "string" &&
      (v.role === "gateway" || v.role === "cli") && typeof v.acquiredAt === "number"
    ) {
      return v as LockInfo;
    }
  } catch {
    // unparsable (torn or corrupt) lock file
  }
  return null;
}

function readSeen(path: string): Seen | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    return { info: parseInfo(readFileSync(path, "utf8")), mtimeMs };
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** "suspect" locks may only be broken after a confirming watch (see the module comment). */
function judge({ info, mtimeMs }: Seen): Verdict {
  const age = Date.now() - mtimeMs;
  if (!info) return age > UNPARSABLE_STALE_MS ? "stale" : "live";
  // Another host's mtime is stamped by its own clock: only a confirming watch can tell it is not heartbeating.
  if (info.host !== hostname()) return age > SUSPECT_AFTER_MS ? "suspect" : "live";
  // The age checks keep a holder safe that shares the hostname and the pid from another pid namespace.
  if (info.pid === process.pid) return HELD.has(info.token) || age <= HEARTBEAT_MS * 2 ? "live" : "stale";
  if (!pidAlive(info.pid)) return age > LOCAL_DEAD_STALE_MS ? "stale" : "live";
  // Every verdict below needs an older lock; returning here also spares a heartbeating holder the ps spawn (macOS)
  // on each poll.
  if (age <= HEARTBEAT_MS * 2) return "live";
  const now = procStartOf(info.pid);
  if (info.procStart !== undefined && now !== undefined) return now !== info.procStart ? "stale" : "live";
  // Start time unknown: a lock last touched before this boot cannot have a live holder (its pid was reused).
  if (mtimeMs < Date.now() - uptime() * 1000 - PRE_BOOT_SLACK_MS) return "stale";
  return age > SUSPECT_AFTER_MS ? "suspect" : "live";
}

/** Breaks a stale lock, or a suspect one still exactly as `watched` saw it; false when it is live or the guard is busy. */
function tryBreakStale(path: string, watched: Watch | null): boolean {
  const guard = `${path}.break`;
  try {
    closeSync(openSync(guard, "wx", 0o600));
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) unlinkSync(guard);
    } catch {
      // guard vanished meanwhile
    }
    return false;
  }
  try {
    const seen = readSeen(path);
    if (!seen) return true;
    const verdict = judge(seen);
    if (verdict === "live" || (verdict === "suspect" && !(watched && sameAs(watched, seen)))) return false;
    unlinkSync(path);
    return true;
  } finally {
    try { unlinkSync(guard); } catch { /* already removed */ }
  }
}

function tryCreate(path: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(info));
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* best effort */ }
    throw err;
  }
  closeSync(fd);
  return true;
}

function hold(path: string, info: LockInfo, onLost?: (reason: string) => void): WalletLock {
  let done = false;
  HELD.add(info.token);
  const lost = (reason: string): void => {
    if (done) return;
    done = true;
    HELD.delete(info.token);
    clearInterval(timer);
    process.removeListener("exit", releaseSync);
    onLost?.(reason);
  };
  const timer = setInterval(() => {
    let seen: Seen | null;
    try {
      seen = readSeen(path);
      // Deleted by hand while held: put it back so no other process opens the wallet next to this one,
      // unless another process has already claimed it.
      if (!seen && restore()) return;
      seen ??= readSeen(path);
    } catch {
      return; // transient read error: check again on the next beat
    }
    if (!seen) return lost(`${path} was removed and could not be restored`);
    if (seen.info?.token !== info.token) {
      return lost(seen.info ? `${path} was taken over: ${describeHolder(seen.info)}` : `${path} was overwritten`);
    }
    const now = new Date();
    try { utimesSync(path, now, now); } catch { /* next beat retries */ }
  }, HEARTBEAT_MS);
  timer.unref();

  function restore(): boolean {
    try {
      return tryCreate(path, info);
    } catch {
      return false;
    }
  }

  function releaseSync(): void {
    if (done) return;
    done = true;
    HELD.delete(info.token);
    clearInterval(timer);
    process.removeListener("exit", releaseSync);
    try {
      if (readSeen(path)?.info?.token === info.token) unlinkSync(path);
    } catch {
      // nothing left to release
    }
  }
  process.on("exit", releaseSync);

  return { info: { ...info }, release: async () => releaseSync() };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Acquire the wallet lock. Without `wait` it fails fast with WalletLockedError; with `wait` it polls until the lock is
 * free or stale, rejecting with WalletLockedError after `timeoutMs` or with the signal's reason when aborted. Either
 * way a suspect lock is watched through one confirmation window (15 s), so a dead holder never blocks for good.
 * `onLost` fires once if the heartbeat finds the lock taken over, or removed and impossible to re-create.
 */
export async function acquireWalletLock(opts: {
  role: "gateway" | "cli";
  command?: string;
  wait?: { timeoutMs: number; signal?: AbortSignal };
  onLost?: (reason: string) => void;
}): Promise<WalletLock> {
  mkdirSync(resolveDataDir(), { recursive: true, mode: 0o700 });
  const path = WALLET_LOCK_PATH;
  const procStart = procStartOf(process.pid);
  const signal = opts.wait?.signal;
  let deadline = performance.now() + (opts.wait?.timeoutMs ?? 0);
  let watch: Watch | null = null;
  let extended = false;
  for (;;) {
    signal?.throwIfAborted();
    const info: LockInfo = {
      token: randomUUID(),
      pid: process.pid,
      host: hostname(),
      ...(procStart ? { procStart } : {}),
      role: opts.role,
      ...(opts.command ? { command: opts.command } : {}),
      acquiredAt: Date.now(),
    };
    if (tryCreate(path, info)) return hold(path, info, opts.onLost);
    const seen = readSeen(path);
    if (!seen) continue;
    const verdict = judge(seen);
    if (verdict !== "suspect") {
      watch = null;
    } else if (!watch || !sameAs(watch, seen)) {
      watch = { token: seen.info?.token ?? "", mtimeMs: seen.mtimeMs, since: performance.now() };
      if (!extended) deadline = Math.max(deadline, watch.since + CONFIRM_MS + POLL_MS);
      extended = true;
    }
    const confirmed = watch !== null && performance.now() - watch.since >= CONFIRM_MS;
    if ((verdict === "stale" || confirmed) && tryBreakStale(path, watch)) continue;
    const left = deadline - performance.now();
    if (left <= 0) {
      throw new WalletLockedError(seen.info ?? { token: "", pid: 0, host: "unknown", role: "cli", acquiredAt: seen.mtimeMs });
    }
    await sleep(Math.min(POLL_MS, left), signal);
  }
}

/** The live holder of the wallet lock, or null when it is free, stale, unreadable or suspected stale. */
export function readLockHolder(): LockInfo | null {
  try {
    resolveDataDir();
    const seen = readSeen(WALLET_LOCK_PATH);
    return seen?.info && judge(seen) === "live" ? seen.info : null;
  } catch {
    return null;
  }
}
