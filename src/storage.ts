/**
 * Disk helpers for the plugin data dir, `<OpenClaw state dir>/unicity` (~/.openclaw/unicity by default; follows
 * OPENCLAW_STATE_DIR, OPENCLAW_HOME, --profile and --dev) — no network.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { errorMessage } from "./util.js";

/** The data dir as first resolved, shared by every copy of this module (a plugin reload re-imports it). */
const DATA_DIR_KEY = Symbol.for("openclaw-unicity.dataDir");
const shared = globalThis as unknown as Record<symbol, string | undefined>;

/** Empty until resolveDataDir() first runs (see there). */
export let DATA_DIR = "";
export let MNEMONIC_PATH = "";
export let WALLET_PATH = "";
export let WALLET_LOCK_PATH = "";
export let DEVICE_ID_PATH = "";
export let OWNER_PIN_PATH = "";
export let STATUS_PATH = "";
export let EVENT_STATE_PATH = "";
export let LEDGER_PATH = "";
export let OUTGOING_REQUESTS_PATH = "";
export let GROUPS_APPROVED_PATH = "";

/** Roots every path export at `dir`; null empties them again. */
function rootAt(dir: string | null): void {
  const at = (file: string): string => (dir === null ? "" : join(dir, file));
  DATA_DIR = dir ?? "";
  MNEMONIC_PATH = at("mnemonic.txt");
  WALLET_PATH = at("wallet.json");
  WALLET_LOCK_PATH = at("wallet.lock");
  DEVICE_ID_PATH = at("wallet-api-device.json");
  OWNER_PIN_PATH = at("owner-pin.json");
  STATUS_PATH = at("gateway-status.json");
  EVENT_STATE_PATH = at("event-state.json");
  LEDGER_PATH = at("payment-ledger.json");
  OUTGOING_REQUESTS_PATH = at("outgoing-requests.json");
  GROUPS_APPROVED_PATH = at("groups-approved.json");
}

/**
 * The data dir. The first call resolves it from OpenClaw's state dir and roots every path export at it; it is never
 * resolved at import, and once resolved it is kept for the life of the process (some OpenClaw runs redirect
 * OPENCLAW_STATE_DIR for a while). The helpers here call it themselves; code that reads a path export calls it first.
 */
export function resolveDataDir(): string {
  if (!DATA_DIR) rootAt((shared[DATA_DIR_KEY] ??= join(resolveStateDir(), "unicity")));
  return DATA_DIR;
}

/**
 * TEST-ONLY seam: roots DATA_DIR and every path above at `dir`; no argument restores the default, resolved again on
 * next use. The exports are live ESM bindings, so modules reading them at call time follow the change.
 */
export function setDataDirForTests(dir?: string): void {
  if (dir) shared[DATA_DIR_KEY] = dir;
  else delete shared[DATA_DIR_KEY];
  rootAt(dir ?? null);
}

/** A path export read before the data dir was resolved is empty: refuse it rather than fall back or write to the cwd. */
function checkedPath(path: string): string {
  if (!path) throw new Error("[unicity] a data dir path was used before the data dir was resolved");
  return path;
}

export function ensureDataDir(): void {
  mkdirSync(resolveDataDir(), { recursive: true, mode: 0o700 });
}

/** True when a wallet is on disk (mnemonic.txt or wallet.json); never opens the wallet. */
export function walletExists(): boolean {
  resolveDataDir();
  return existsSync(MNEMONIC_PATH) || existsSync(WALLET_PATH);
}

/**
 * The saved mnemonic, or undefined when mnemonic.txt is missing or empty. Throws when it exists but cannot be read:
 * treating an unreadable backup as absent would let a fresh wallet be generated and its seed overwrite the file.
 */
export function readMnemonic(): string | undefined {
  resolveDataDir();
  try {
    return readFileSync(MNEMONIC_PATH, "utf-8").trim() || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function saveMnemonic(mnemonic: string): void {
  resolveDataDir();
  writeFileAtomic(MNEMONIC_PATH, `${mnemonic}\n`, 0o600);
}

/** Parsed JSON, or `fallback` when the file is missing, unreadable or corrupt (for state that may safely reset). */
export function readJsonFile<T>(path: string, fallback: T): T {
  checkedPath(path);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Parsed JSON, or `fallback` only when the file does not exist; any other read or parse error throws. */
export function readJsonFileStrict<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(checkedPath(path), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  return JSON.parse(text) as T;
}

/** tmp file + fsync + rename, so readers never see a torn file. */
export function writeJsonFileAtomic(path: string, data: unknown, mode = 0o600): void {
  writeFileAtomic(checkedPath(path), `${JSON.stringify(data, null, 2)}\n`, mode);
}

function writeFileAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const bytes = Buffer.from(content);
  const fd = openSync(tmp, "w", mode);
  try {
    try {
      for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    // Never leave a partial copy behind (it may hold the seed).
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Stable wallet-api session label for this data dir (a label, not a secret; not `.txt` — listWallets scans those). */
export function getOrCreateDeviceId(): string {
  resolveDataDir();
  try {
    const rec = JSON.parse(readFileSync(DEVICE_ID_PATH, "utf-8")) as { deviceId?: unknown };
    if (typeof rec.deviceId === "string" && rec.deviceId) return rec.deviceId;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      try { renameSync(DEVICE_ID_PATH, `${DEVICE_ID_PATH}.corrupt`); } catch { /* best effort */ }
    }
  }
  const deviceId = `openclaw-unicity-${randomUUID()}`;
  writeJsonFileAtomic(DEVICE_ID_PATH, { deviceId, createdAt: new Date().toISOString(), host: hostname() });
  return deviceId;
}

/*
 * Handled-event markers (EVENT_STATE_PATH). Payment-request and transfer markers keep the newest 2000 ids in handling
 * order, one per event (replaceEventsHandled); losing one repeats a notice or turn. The "dm" markers are load-bearing:
 * an owner DM delivered again without its marker runs again with owner authority, and DMs do come back after the SDK
 * cache dropped them. A channel restart or plugin reload replays every cached DM since the DM cutoff (getDmCutoff in
 * sphere.ts, kept for the process), and every new relay subscription (each Sphere.init, each reconnect) re-delivers the
 * gift wraps of roughly the last 2-4 days, which the SDK dedups only against that prunable cache and an in-memory id
 * set. Markers are bounded (400 per sender, 2000 in all; oldest first by message timestamp, taken as no later than the
 * marking time), and each eviction raises a floor: a DM at or below the floor that applies to it counts as handled
 * (isBelowDmFloor), also one that was never handled but arrives that late. Message timestamps are sender-chosen: the
 * overall floor never passes the time the evicted marker was written, so no flood can push it ahead of live DMs, and a
 * sender's own floor allows for that sender's clock running up to DM_CLOCK_SKEW_MS ahead.
 *
 * A DM dated further ahead is dropped by the inbound pipeline and marked like any other, with its real timestamp kept
 * on the marker (`aheadTs`). Its eviction raises that sender's ahead floor to that timestamp, so the DM still counts
 * as handled once the clock has caught up with it. That floor also skips the sender's own correctly dated DMs up to it
 * (failing safe). It reaches at most DM_AHEAD_HORIZON_MS past the marking: a wildly wrong sender clock locks that
 * sender out for a week at most, and a DM dated further ahead than that is no longer covered once its marker is gone.
 * Ahead floors are kept apart from sender floors and ranked like them, by the capped floor the marker left, so far
 * future dates gain no rank; past MAX_DM_PEER_FLOORS senders the lowest-ranked go first (as for sender floors, more
 * keys than that can push one out).
 *
 * Every helper throws, writing nothing, when the file exists but cannot be read, so a transient read error or a
 * corrupt file never wipes markers or floors.
 */

export type HandledEventKind = "payreq" | "transfer" | "dm";
/**
 * A handled DM: its SDK message timestamp, when it was marked, and the sender key decide its eviction and floor.
 * `aheadTs`: the real timestamp of a DM dropped for being dated too far ahead (its `ts` is the capped one).
 */
type DmMarker = { id: string; ts: number; markedAt: number; peer?: string; aheadTs?: number };
/** A sender's ahead floor and the rank (the highest sender floor its evicted markers left) that decides which stay. */
type AheadFloor = { floor: number; rank: number };
type EventState = {
  payreq: string[];
  transfer: string[];
  dm: DmMarker[];
  /** Highest clamped timestamp (see clampedTs) of a DM marker evicted by the overall cap. */
  dmFloor?: number;
  /** Per sender key: highest timestamp of an evicted marker of theirs, allowing DM_CLOCK_SKEW_MS past its marking. */
  dmPeerFloors?: Record<string, number>;
  /** Per sender key: highest real timestamp of an evicted marker of theirs that was dropped as dated ahead. */
  dmPeerAheadFloors?: Record<string, AheadFloor>;
  transferWatermark?: number;
};
const MAX_HANDLED_EVENTS = 2000;
const MAX_DM_MARKERS_PER_PEER = 400;
const MAX_DM_PEER_FLOORS = 1000;
/** How far ahead of its receipt a DM's own timestamp may be (the inbound pipeline drops live DMs dated further ahead). */
const DM_CLOCK_SKEW_MS = 5 * 60_000;
/** How far past its marking the ahead floor of a dropped DM may reach (see above). */
const DM_AHEAD_HORIZON_MS = 7 * 24 * 60 * 60_000;

/** A marker's timestamp for eviction order and the overall floor: never later than when it was written. */
const clampedTs = (m: DmMarker): number => Math.min(m.ts, m.markedAt);

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Always read from disk: no in-memory copy that a second module instance (plugin reload) could clobber. */
function readEventState(): EventState {
  resolveDataDir();
  const fix = "stop the gateway, then repair or remove it";
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(EVENT_STATE_PATH, {});
  } catch (err) {
    throw new Error(`${EVENT_STATE_PATH} is unreadable or corrupt (${errorMessage(err)}); ${fix}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${EVENT_STATE_PATH} is not a JSON object; ${fix}`);
  const r = raw as Record<string, unknown>;
  const entries = (key: HandledEventKind): unknown[] => {
    const v = r[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${EVENT_STATE_PATH}: "${key}" is not a list; ${fix}`);
    return v;
  };
  const ids = (key: HandledEventKind): string[] => entries(key).filter((x): x is string => typeof x === "string");
  const now = Date.now();
  const dm = entries("dm").flatMap((x): DmMarker[] => {
    const m = (x ?? {}) as Partial<DmMarker>;
    if (typeof m.id !== "string" || !isFiniteNumber(m.ts)) return [];
    // Without it, the ahead floor this marker leaves would be lost: refuse the file, as for an unreadable floor.
    if (m.aheadTs !== undefined && !isFiniteNumber(m.aheadTs)) {
      throw new Error(`${EVENT_STATE_PATH}: a "dm" marker's "aheadTs" is not a number; ${fix}`);
    }
    // A marker without a valid marking time was written no later than now.
    const markedAt = isFiniteNumber(m.markedAt) ? m.markedAt : now;
    return [{
      id: m.id,
      ts: m.ts,
      markedAt,
      ...(typeof m.peer === "string" ? { peer: m.peer } : {}),
      ...(m.aheadTs !== undefined ? { aheadTs: m.aheadTs } : {}),
    }];
  });
  // A floor that cannot be read would let evicted DMs run again: refuse the file, as for an unreadable one.
  const floor = r.dmFloor;
  if (floor !== undefined && !isFiniteNumber(floor)) throw new Error(`${EVENT_STATE_PATH}: "dmFloor" is not a number; ${fix}`);
  const floorMap = <T>(key: string, valid: (v: unknown) => v is T): Record<string, T> | undefined => {
    const raw = r[key];
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${EVENT_STATE_PATH}: "${key}" is not an object; ${fix}`);
    const out = Object.create(null) as Record<string, T>;
    for (const [peer, v] of Object.entries(raw)) {
      if (!valid(v)) throw new Error(`${EVENT_STATE_PATH}: "${key}" holds a malformed floor; ${fix}`);
      out[peer] = v;
    }
    return out;
  };
  const dmPeerFloors = floorMap("dmPeerFloors", isFiniteNumber);
  const dmPeerAheadFloors = floorMap("dmPeerAheadFloors", (v): v is AheadFloor => {
    const a = v !== null && typeof v === "object" ? (v as Partial<AheadFloor>) : {};
    return isFiniteNumber(a.floor) && isFiniteNumber(a.rank);
  });
  // A malformed watermark only seeds reconciliation, and the next reconcile rewrites it.
  const wm = r.transferWatermark;
  return {
    payreq: ids("payreq"),
    transfer: ids("transfer"),
    dm,
    ...(isFiniteNumber(floor) ? { dmFloor: floor } : {}),
    ...(dmPeerFloors ? { dmPeerFloors } : {}),
    ...(dmPeerAheadFloors ? { dmPeerAheadFloors } : {}),
    ...(isFiniteNumber(wm) ? { transferWatermark: wm } : {}),
  };
}

function writeEventState(state: EventState): void {
  ensureDataDir();
  writeJsonFileAtomic(EVENT_STATE_PATH, state);
}

/**
 * Evicts the oldest DM markers by clamped timestamp (earliest marked among equal ones): per sender, then in all. Every
 * eviction raises the evicted sender's floor (and ahead floor, for a DM dropped as dated ahead) and, for the overall
 * cap, the overall floor; floors only move up. Floors that a floor applying to the same DMs already covers add nothing
 * and are dropped, and past MAX_DM_PEER_FLOORS per kind the lowest-ranked go first.
 */
function pruneDmMarkers(state: EventState): void {
  const markers = state.dm;
  const oldestFirst = [...markers].sort((a, b) => clampedTs(a) - clampedTs(b)); // stable: marking order among equals
  const drop = new Set<DmMarker>();
  const peerFloors = state.dmPeerFloors ?? (Object.create(null) as Record<string, number>);
  const aheadFloors = state.dmPeerAheadFloors ?? (Object.create(null) as Record<string, AheadFloor>);
  const evict = (m: DmMarker): void => {
    drop.add(m);
    if (!m.peer) return;
    const floor = Math.min(m.ts, m.markedAt + DM_CLOCK_SKEW_MS);
    peerFloors[m.peer] = Math.max(peerFloors[m.peer] ?? -Infinity, floor);
    if (m.aheadTs === undefined) return;
    const prev = aheadFloors[m.peer];
    aheadFloors[m.peer] = {
      floor: Math.max(prev?.floor ?? -Infinity, Math.min(m.aheadTs, m.markedAt + DM_AHEAD_HORIZON_MS)),
      rank: Math.max(prev?.rank ?? -Infinity, floor),
    };
  };
  const perPeer = new Map<string, number>();
  for (const m of markers) if (m.peer) perPeer.set(m.peer, (perPeer.get(m.peer) ?? 0) + 1);
  for (const m of oldestFirst) {
    const count = m.peer ? perPeer.get(m.peer)! : 0;
    if (count <= MAX_DM_MARKERS_PER_PEER) continue;
    evict(m);
    perPeer.set(m.peer!, count - 1);
  }
  let excess = markers.length - drop.size - MAX_HANDLED_EVENTS;
  for (const m of oldestFirst) {
    if (excess <= 0) break;
    if (drop.has(m)) continue;
    evict(m);
    state.dmFloor = Math.max(state.dmFloor ?? -Infinity, clampedTs(m));
    excess--;
  }
  if (!drop.size) return;
  state.dm = markers.filter((m) => !drop.has(m));
  const overall = state.dmFloor ?? -Infinity;
  const kept = Object.entries(peerFloors)
    .filter(([, floor]) => floor > overall)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DM_PEER_FLOORS);
  delete state.dmPeerFloors;
  if (kept.length) {
    state.dmPeerFloors = Object.create(null) as Record<string, number>;
    for (const [peer, floor] of kept) state.dmPeerFloors[peer] = floor;
  }
  const keptAhead = Object.entries(aheadFloors)
    .filter(([peer, a]) => a.floor > Math.max(overall, state.dmPeerFloors?.[peer] ?? -Infinity))
    .sort((a, b) => b[1].rank - a[1].rank)
    .slice(0, MAX_DM_PEER_FLOORS);
  delete state.dmPeerAheadFloors;
  if (!keptAhead.length) return;
  state.dmPeerAheadFloors = Object.create(null) as Record<string, AheadFloor>;
  for (const [peer, a] of keptAhead) state.dmPeerAheadFloors[peer] = a;
}

function handledIds(state: EventState, kind: HandledEventKind): Set<string> {
  return new Set(kind === "dm" ? state.dm.map((m) => m.id) : state[kind]);
}

/** True when every id is marked (one read). Throws when the state file cannot be read (callers decide what that means). */
export function areEventsHandled(kind: HandledEventKind, ids: readonly string[]): boolean {
  const handled = handledIds(readEventState(), kind);
  return ids.every((id) => handled.has(id));
}

export function isEventHandled(kind: HandledEventKind, id: string): boolean {
  return areEventsHandled(kind, [id]);
}

/**
 * True when a DM dated `ts` from `peer` (x-only key) is at or below a floor an evicted marker left for it: it counts
 * as handled although its marker is gone (see above). Throws when the state file cannot be read; callers fail closed.
 */
export function isBelowDmFloor(ts: number, peer?: string): boolean {
  const state = readEventState();
  const peerFloor = peer ? state.dmPeerFloors?.[peer] : undefined;
  const aheadFloor = peer ? state.dmPeerAheadFloors?.[peer]?.floor : undefined;
  return !(ts > Math.max(state.dmFloor ?? -Infinity, peerFloor ?? -Infinity, aheadFloor ?? -Infinity));
}

/**
 * Marks every id handled in one read and one atomic write, so a crash never leaves part of a batch marked; returns how
 * many were newly marked (no write when none). For "dm", `ts` is the message timestamp (default now) and `peer` the
 * sender's x-only key; with the time of marking they decide the marker's eviction and the floor it leaves (see
 * above). A marker without `peer` counts only toward the overall cap and floor. `opts.aheadTs` (with `peer`): the real
 * timestamp of a DM dropped for being dated too far ahead, `ts` then being the capped one; it sets the sender's ahead
 * floor once the marker is evicted.
 */
export function markEventsHandled(
  kind: HandledEventKind,
  ids: readonly string[],
  ts?: number,
  peer?: string,
  opts?: { aheadTs?: number },
): number {
  const state = readEventState();
  const handled = handledIds(state, kind);
  const fresh = [...new Set(ids)].filter((id) => !handled.has(id));
  if (fresh.length === 0) return 0;
  if (kind === "dm") {
    const markedAt = Date.now();
    const at = ts !== undefined && Number.isFinite(ts) ? ts : markedAt;
    const aheadTs = opts?.aheadTs;
    const extra = peer ? { peer, ...(aheadTs !== undefined && Number.isFinite(aheadTs) ? { aheadTs } : {}) } : {};
    state.dm = [...state.dm, ...fresh.map((id): DmMarker => ({ id, ts: at, markedAt, ...extra }))];
    pruneDmMarkers(state);
  } else {
    state[kind] = [...state[kind], ...fresh].slice(-MAX_HANDLED_EVENTS);
  }
  writeEventState(state);
  return fresh.length;
}

/**
 * Payment-request and transfer markers: marks `ids` handled and removes `replaced` (an earlier marker of the same
 * events) in one read and one atomic write, so each event holds one of the 2000 markers its kind keeps. Returns how
 * many ids were newly marked; writes nothing when nothing changes.
 */
export function replaceEventsHandled(kind: "payreq" | "transfer", ids: readonly string[], replaced: readonly string[]): number {
  const state = readEventState();
  const handled = new Set(state[kind]);
  const fresh = [...new Set(ids)].filter((id) => !handled.has(id));
  const marking = new Set(ids);
  const drop = new Set(replaced.filter((id) => handled.has(id) && !marking.has(id)));
  if (fresh.length === 0 && drop.size === 0) return 0;
  state[kind] = [...state[kind].filter((id) => !drop.has(id)), ...fresh].slice(-MAX_HANDLED_EVENTS);
  writeEventState(state);
  return fresh.length;
}

/** markEventsHandled for one id; true if newly marked, false if already handled. */
export function markEventHandled(kind: HandledEventKind, id: string, ts?: number, peer?: string, opts?: { aheadTs?: number }): boolean {
  return markEventsHandled(kind, [id], ts, peer, opts) > 0;
}

/** Received-transfer history watermark (ms) for reconciliation; null until first set. */
export function getTransferWatermark(): number | null {
  return readEventState().transferWatermark ?? null;
}

/** Advances the transfer watermark to `ms`; never moves it backwards. */
export function setTransferWatermark(ms: number): void {
  if (!Number.isFinite(ms)) return;
  const state = readEventState();
  if (state.transferWatermark !== undefined && state.transferWatermark >= ms) return;
  writeEventState({ ...state, transferWatermark: ms });
}

// ───────────── owner-sanctioned groups (per wallet key; every helper throws on an unreadable file) ─────────────

type GroupState = { approved: string[]; notified: string[] };
const MAX_GROUP_IDS = 1000;

/**
 * Throws when the file exists but cannot be read or is not a JSON object: read as empty, the next write would replace
 * every approval with nothing. Callers fail closed (nothing approved, nothing recorded) until the file is repaired or
 * removed.
 */
function readGroupStates(): Record<string, GroupState> {
  resolveDataDir();
  const fix = "repair it, or remove it and ask the agent to join its groups again";
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(GROUPS_APPROVED_PATH, {});
  } catch (err) {
    throw new Error(`${GROUPS_APPROVED_PATH} is unreadable or corrupt (${errorMessage(err)}); ${fix}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${GROUPS_APPROVED_PATH} is not a JSON object; ${fix}`);
  }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const out: Record<string, GroupState> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    // A malformed entry approves nothing.
    const e = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
    out[key] = { approved: list(e.approved), notified: list(e.notified) };
  }
  return out;
}

function updateGroupState(walletKey: string, f: (g: GroupState) => GroupState): void {
  const states = readGroupStates();
  const next = f(states[walletKey] ?? { approved: [], notified: [] });
  states[walletKey] = { approved: next.approved.slice(-MAX_GROUP_IDS), notified: next.notified.slice(-MAX_GROUP_IDS) };
  ensureDataDir();
  writeJsonFileAtomic(GROUPS_APPROVED_PATH, states);
}

/** Records a group the owner joined or created. */
export function approveGroup(walletKey: string, groupId: string): void {
  updateGroupState(walletKey, (g) => ({ ...g, approved: [...g.approved.filter((id) => id !== groupId), groupId] }));
}

export function isGroupApproved(walletKey: string, groupId: string): boolean {
  return readGroupStates()[walletKey]?.approved.includes(groupId) ?? false;
}

/**
 * Forgets a group the wallet left, was kicked from, or saw deleted: its approval and its owner-notified mark. A group
 * admin who adds this key back later gets it ignored again, and the owner is told again. Writes nothing when there is
 * nothing to forget.
 */
export function revokeGroup(walletKey: string, groupId: string): void {
  const g = readGroupStates()[walletKey];
  if (!g || (!g.approved.includes(groupId) && !g.notified.includes(groupId))) return;
  updateGroupState(walletKey, (s) => ({
    approved: s.approved.filter((id) => id !== groupId),
    notified: s.notified.filter((id) => id !== groupId),
  }));
}

/** True when the owner was already told about this unsanctioned group (read-only). */
export function isGroupNotified(walletKey: string, groupId: string): boolean {
  return readGroupStates()[walletKey]?.notified.includes(groupId) ?? false;
}

/** Records that the owner was told about an unsanctioned group (once the notice is sent); true if newly marked. */
export function markGroupNotified(walletKey: string, groupId: string): boolean {
  if (readGroupStates()[walletKey]?.notified.includes(groupId)) return false;
  updateGroupState(walletKey, (g) => ({ ...g, notified: [...g.notified, groupId] }));
  return true;
}

export type GatewayStatus = {
  pid: number;
  startedAt: number;
  network: string;
  nametag?: string;
  chainPubkey?: string;
  directAddress?: string;
  hasPayments: boolean;
};

/** Written by the gateway for `openclaw unicity status`; null deletes it. */
export function writeGatewayStatus(s: GatewayStatus | null): void {
  if (s) {
    ensureDataDir();
    writeJsonFileAtomic(STATUS_PATH, s);
    return;
  }
  resolveDataDir();
  try { unlinkSync(STATUS_PATH); } catch { /* already absent */ }
}

export function readGatewayStatus(): GatewayStatus | null {
  resolveDataDir();
  const s = readJsonFile<Partial<GatewayStatus> | null>(STATUS_PATH, null);
  if (!s || typeof s.pid !== "number" || typeof s.network !== "string") return null;
  return s as GatewayStatus;
}
