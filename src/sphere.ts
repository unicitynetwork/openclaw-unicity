/** Sphere SDK singleton — wallet identity and communications. */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import type { UniclawConfig } from "./config.js";

const DATA_DIR = join(homedir(), ".openclaw", "unicity");
const TOKENS_DIR = join(DATA_DIR, "tokens");
export const MNEMONIC_PATH = join(DATA_DIR, "mnemonic.txt");
const TRUSTBASE_PATH = join(DATA_DIR, "trustbase.json");
const TRUSTBASE_URL = "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json";

/** Default testnet API key (from Sphere app) */
const DEFAULT_API_KEY = "sk_06365a9c44654841a366068bcfc68986";

let sphereInstance: Sphere | null = null;
let initPromise: Promise<InitSphereResult> | null = null;

// Deferred that channels can await — resolved once initSphere completes.
let sphereReady: { promise: Promise<Sphere | null>; resolve: (s: Sphere | null) => void };
function resetSphereReady() {
  let resolve!: (s: Sphere | null) => void;
  const promise = new Promise<Sphere | null>((r) => { resolve = r; });
  sphereReady = { promise, resolve };
}
resetSphereReady();

export type SphereLogger = {
  warn: (msg: string) => void;
  info: (msg: string) => void;
};

export type InitSphereResult = {
  sphere: Sphere;
  created: boolean;
};

export async function initSphere(
  cfg: UniclawConfig,
  logger?: SphereLogger,
): Promise<InitSphereResult> {
  if (sphereInstance) {
    return { sphere: sphereInstance, created: false };
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInitSphere(cfg, logger);
  try {
    const result = await initPromise;
    sphereReady.resolve(result.sphere);
    return result;
  } catch (err) {
    initPromise = null;
    sphereReady.resolve(null);
    resetSphereReady();
    throw err;
  }
}

async function ensureTrustbase(logger?: SphereLogger): Promise<void> {
  if (existsSync(TRUSTBASE_PATH)) return;

  const log = logger ?? console;
  log.info(`[uniclaw] Downloading trustbase from ${TRUSTBASE_URL}...`);

  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: ${res.status} ${res.statusText}`);
  }
  const data = await res.text();
  writeFileSync(TRUSTBASE_PATH, data, { mode: 0o644 });
  log.info(`[uniclaw] Trustbase saved to ${TRUSTBASE_PATH}`);
}

async function doInitSphere(
  cfg: UniclawConfig,
  logger?: SphereLogger,
): Promise<InitSphereResult> {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(TOKENS_DIR, { recursive: true });

  // Download trustbase if not present
  await ensureTrustbase(logger);

  const apiKey = cfg.apiKey ?? DEFAULT_API_KEY;

  const providers = createNodeProviders({
    network: cfg.network ?? "testnet",
    dataDir: DATA_DIR,
    tokensDir: TOKENS_DIR,
    oracle: {
      trustBasePath: TRUSTBASE_PATH,
      apiKey,
    },
    transport: {
      debug: true,
      ...(cfg.additionalRelays?.length ? { additionalRelays: cfg.additionalRelays } : {}),
    },
  });

  const result = await Sphere.init({
    ...providers,
    autoGenerate: true,
    ...(cfg.nametag ? { nametag: cfg.nametag } : {}),
  });

  sphereInstance = result.sphere;

  if (result.created && result.generatedMnemonic) {
    writeFileSync(MNEMONIC_PATH, result.generatedMnemonic + "\n", { mode: 0o600 });
    const log = logger ?? console;
    log.info(`[uniclaw] Mnemonic saved to ${MNEMONIC_PATH}`);
  }

  // Mint nametag only when the wallet doesn't already have one
  if (cfg.nametag && !result.sphere.identity?.nametag) {
    try {
      await result.sphere.registerNametag(cfg.nametag);
    } catch (err) {
      // Non-fatal; nametag may already be taken by someone else
      const msg = `[uniclaw] Failed to mint nametag "${cfg.nametag}": ${err}`;
      if (logger) {
        logger.warn(msg);
      } else {
        console.warn(msg);
      }
    }
  }

  // Send greeting DM to owner if configured
  if (cfg.owner) {
    const log = logger ?? console;
    const myNametag = result.sphere.identity?.nametag ?? "unknown";
    const greeting = `I'm online, master! I am @${myNametag}. What can I do for you?`;
    log.info(`[uniclaw] Sending greeting to owner @${cfg.owner}...`);
    try {
      await result.sphere.communications.sendDM(`@${cfg.owner}`, greeting);
      log.info(`[uniclaw] Greeting sent to @${cfg.owner}`);
    } catch (err) {
      log.warn(`[uniclaw] Failed to send greeting to @${cfg.owner}: ${err}`);
    }
  }

  return {
    sphere: result.sphere,
    created: result.created,
  };
}

export function getSphere(): Sphere {
  if (!sphereInstance) {
    throw new Error("[uniclaw] Sphere not initialized. Run `openclaw uniclaw init` first.");
  }
  return sphereInstance;
}

export function getSphereOrNull(): Sphere | null {
  return sphereInstance;
}

/** Wait for sphere initialization (even if it hasn't started yet). */
export function waitForSphere(): Promise<Sphere | null> {
  if (sphereInstance) return Promise.resolve(sphereInstance);
  return sphereReady.promise;
}

/** Resolve the sphere-ready deferred to null (for tests). */
export function cancelSphereWait(): void {
  sphereReady.resolve(null);
}

export async function destroySphere(): Promise<void> {
  initPromise = null;
  if (sphereInstance) {
    await sphereInstance.destroy();
    sphereInstance = null;
  }
  resetSphereReady();
}
