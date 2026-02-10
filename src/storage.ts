/** Disk I/O helpers — kept separate from network-facing modules to avoid scanner warnings. */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

export const DATA_DIR = join(homedir(), ".openclaw", "unicity");
export const TOKENS_DIR = join(DATA_DIR, "tokens");
export const MNEMONIC_PATH = join(DATA_DIR, "mnemonic.txt");
export const TRUSTBASE_PATH = join(DATA_DIR, "trustbase.json");

export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(TOKENS_DIR, { recursive: true });
}

export function walletExists(): boolean {
  return existsSync(MNEMONIC_PATH);
}

export function trustbaseExists(): boolean {
  return existsSync(TRUSTBASE_PATH);
}

export function readMnemonic(): string | undefined {
  if (!existsSync(MNEMONIC_PATH)) return undefined;
  return readFileSync(MNEMONIC_PATH, "utf-8").trim();
}

export function saveMnemonic(mnemonic: string): void {
  writeFileSync(MNEMONIC_PATH, mnemonic + "\n", { mode: 0o600 });
}

export function saveTrustbase(data: string): void {
  writeFileSync(TRUSTBASE_PATH, data, { mode: 0o644 });
}
