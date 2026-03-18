/** Sphere SDK singleton — wallet identity and communications. */

import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import { TRUSTBASE_URL, type UnicityConfig } from "./config.js";
import {
  DATA_DIR, TOKENS_DIR, TRUSTBASE_PATH, MNEMONIC_PATH,
  ensureDirs, walletExists, trustbaseExists,
  readMnemonic, saveMnemonic, saveTrustbase,
} from "./storage.js";

export { DATA_DIR, MNEMONIC_PATH, walletExists };

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
  cfg: UnicityConfig,
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
  if (trustbaseExists()) return;

  const log = logger ?? console;
  log.info(`[unicity] Downloading trustbase from ${TRUSTBASE_URL}...`);

  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: ${res.status} ${res.statusText}`);
  }
  const data = await res.text();
  saveTrustbase(data);
  log.info(`[unicity] Trustbase saved to ${TRUSTBASE_PATH}`);
}

async function doInitSphere(
  cfg: UnicityConfig,
  logger?: SphereLogger,
): Promise<InitSphereResult> {
  ensureDirs();

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

  // If a mnemonic backup exists, pass it so the SDK restores the same wallet
  // even if its internal storage was lost. Without this, autoGenerate would
  // create a brand-new wallet with a different mnemonic.
  const existingMnemonic = readMnemonic();

  const groupChat = cfg.groupChat !== false;
  const groupChatRelays = typeof cfg.groupChat === "object" && cfg.groupChat?.relays
    ? cfg.groupChat.relays
    : undefined;

  const result = await Sphere.init({
    ...providers,
    ...(existingMnemonic ? { mnemonic: existingMnemonic } : { autoGenerate: true }),
    ...(cfg.nametag ? { nametag: cfg.nametag } : {}),
    ...(groupChat ? { groupChat: groupChatRelays ? { relays: groupChatRelays } : true } : {}),
    dmSince: Math.floor(Date.now() / 1000) - 86400,
  });

  sphereInstance = result.sphere;

  if (result.created && result.generatedMnemonic) {
    saveMnemonic(result.generatedMnemonic);
    const log = logger ?? console;
    log.info(`[unicity] Mnemonic saved to ${MNEMONIC_PATH}`);
  }

  // Log helpful messages about nametag state
  if (result.created && !cfg.nametag) {
    const log = logger ?? console;
    log.warn("[unicity] Wallet created without nametag. Run 'openclaw unicity setup' to configure.");
  }

  // Register nametag if configured and wallet doesn't have one yet
  // Normalize: strip leading '@' for consistent comparison
  const walletNametag = result.sphere.identity?.nametag?.replace(/^@/, "");
  const cfgNametag = cfg.nametag?.replace(/^@/, "");
  if (cfgNametag && !walletNametag) {
    try {
      await result.sphere.registerNametag(cfg.nametag);
      const log = logger ?? console;
      log.info(`[unicity] Nametag '${cfg.nametag}' registered successfully.`);
    } catch (err) {
      // Non-fatal; nametag may already be taken
      const msg = `[unicity] Failed to register nametag "${cfg.nametag}": ${err}`;
      if (logger) {
        logger.warn(msg);
      } else {
        console.warn(msg);
      }
    }
  } else if (cfgNametag && walletNametag && cfgNametag !== walletNametag) {
    // Nametag changed — check if another address in this wallet already owns it,
    // otherwise derive a new HD address and mint the nametag there.
    const log = logger ?? console;
    try {
      const activeAddresses = result.sphere.getActiveAddresses() as
        { index: number; nametag?: string }[];
      const existing = activeAddresses.find(
        (a) => a.nametag?.replace(/^@/, "") === cfgNametag,
      );
      if (existing) {
        log.info(`[unicity] Switching to existing address ${existing.index} for nametag '${cfg.nametag}'...`);
        await result.sphere.switchToAddress(existing.index);
        log.info(`[unicity] Switched to address ${existing.index} with nametag '${cfg.nametag}'.`);
      } else {
        const nextIndex = activeAddresses.length > 0
          ? Math.max(...activeAddresses.map((a) => a.index)) + 1
          : 1;
        log.info(`[unicity] Minting nametag '${cfg.nametag}' on new address ${nextIndex}...`);
        await result.sphere.switchToAddress(nextIndex, { nametag: cfg.nametag });
        log.info(`[unicity] Switched to address ${nextIndex} with nametag '${cfg.nametag}'.`);
      }
    } catch (err) {
      log.warn(`[unicity] Failed to switch address for nametag '${cfg.nametag}': ${err}`);
    }
  }

  // Send greeting DM to owner on first wallet creation
  if (cfg.owner && result.created) {
    const log = logger ?? console;
    const myNametag = result.sphere.identity?.nametag ?? "unknown";
    const greeting = `I'm online, master! I am @${myNametag}. What can I do for you?`;
    log.info(`[unicity] Sending greeting to owner @${cfg.owner}...`);
    try {
      await result.sphere.communications.sendDM(`@${cfg.owner}`, greeting);
      log.info(`[unicity] Greeting sent to @${cfg.owner}`);
    } catch (err) {
      log.warn(`[unicity] Failed to send greeting to @${cfg.owner}: ${err}`);
    }
  }

  return {
    sphere: result.sphere,
    created: result.created,
  };
}

export function getSphere(): Sphere {
  if (!sphereInstance) {
    throw new Error("[unicity] Sphere not initialized. Run `openclaw unicity init` first.");
  }
  return sphereInstance;
}

export function getSphereOrNull(): Sphere | null {
  return sphereInstance;
}

/** Wait for sphere initialization (even if it hasn't started yet). */
export function waitForSphere(timeoutMs = 30_000): Promise<Sphere | null> {
  if (sphereInstance) return Promise.resolve(sphereInstance);
  return Promise.race([
    sphereReady.promise,
    new Promise<Sphere | null>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[unicity] Sphere initialization timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
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
