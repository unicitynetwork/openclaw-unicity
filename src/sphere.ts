/** Sphere SDK singleton — wallet identity and communications. */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import type { UniclawConfig } from "./config.js";

const DATA_DIR = join(homedir(), ".openclaw", "unicity");
const TOKENS_DIR = join(DATA_DIR, "tokens");
export const MNEMONIC_PATH = join(DATA_DIR, "mnemonic.txt");

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

async function doInitSphere(
  cfg: UniclawConfig,
  logger?: SphereLogger,
): Promise<InitSphereResult> {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(TOKENS_DIR, { recursive: true });

  const providers = createNodeProviders({
    network: cfg.network ?? "testnet",
    dataDir: DATA_DIR,
    tokensDir: TOKENS_DIR,
    ...(cfg.additionalRelays?.length
      ? { transport: { additionalRelays: cfg.additionalRelays } }
      : {}),
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
