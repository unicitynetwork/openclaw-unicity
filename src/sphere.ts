/** Sphere SDK singleton — wallet identity and communications. */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { Sphere } from "@unicitylabs/sphere-sdk";
import { createNodeProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import type { UniclawConfig } from "./config.js";

const DATA_DIR = join(homedir(), ".openclaw", "unicity");
const TOKENS_DIR = join(DATA_DIR, "tokens");

let sphereInstance: Sphere | null = null;
let generatedMnemonicOnce: string | undefined;

export type InitSphereResult = {
  sphere: Sphere;
  created: boolean;
  generatedMnemonic?: string;
};

export async function initSphere(cfg: UniclawConfig): Promise<InitSphereResult> {
  if (sphereInstance) {
    return { sphere: sphereInstance, created: false };
  }

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
    generatedMnemonicOnce = result.generatedMnemonic;
  }

  // Mint nametag only when the wallet doesn't already have one
  if (cfg.nametag && !result.sphere.identity?.nametag) {
    try {
      await result.sphere.registerNametag(cfg.nametag);
    } catch (err) {
      // Non-fatal; nametag may already be taken by someone else
      console.warn(`[uniclaw] Failed to mint nametag "${cfg.nametag}":`, err);
    }
  }

  return {
    sphere: result.sphere,
    created: result.created,
    generatedMnemonic: result.generatedMnemonic,
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

export function getGeneratedMnemonic(): string | undefined {
  return generatedMnemonicOnce;
}

export async function destroySphere(): Promise<void> {
  if (sphereInstance) {
    await sphereInstance.destroy();
    sphereInstance = null;
  }
}
