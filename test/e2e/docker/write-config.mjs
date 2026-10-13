#!/usr/bin/env node
// @ts-check
/**
 * Merges the e2e gateway settings into the OpenClaw config that `openclaw plugins install` left behind
 * at image build time (keeping whatever the install recorded, e.g. plugins.allow), then prints it.
 * Inputs (env): AGENT_NAMETAG, OWNER_NAMETAG, MODEL_PORT, MODEL_ID.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "e2efake";
/**
 * The plugin ships no API key (operators get theirs at https://sphere.unicity.network): the gateway under test gets the
 * shared public testnet2 key explicitly, so it composes payments.
 */
const TESTNET2_API_KEY = "sk_ddc3cfcc001e4a28ac3fad7407f99590";

/** @param {string} name */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep merge: objects merge key by key, everything else (arrays included) is replaced by `over`.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 * @returns {Record<string, unknown>}
 */
function merge(base, over) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isObject(value) && isObject(prev) ? merge(prev, value) : value;
  }
  return out;
}

const modelId = required("MODEL_ID");
const modelPort = Number(required("MODEL_PORT"));
if (!Number.isInteger(modelPort) || modelPort < 1 || modelPort > 65535) throw new Error(`MODEL_PORT must be a TCP port, got ${process.env.MODEL_PORT}`);
const overlay = {
  gateway: { mode: "local" },
  agents: { defaults: { model: { primary: `${PROVIDER}/${modelId}` } } },
  models: {
    mode: "merge",
    providers: {
      [PROVIDER]: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        apiKey: "e2e-local",
        api: "openai-completions",
        timeoutSeconds: 30,
        models: [{ id: modelId, name: "E2E pong", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024 }],
      },
    },
  },
  channels: { unicity: { dmPolicy: "open", allowFrom: ["*"] } },
  plugins: {
    entries: {
      "openclaw-unicity": {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: {
          network: "testnet2",
          apiKey: TESTNET2_API_KEY,
          nametag: required("AGENT_NAMETAG"),
          owner: required("OWNER_NAMETAG"),
        },
      },
    },
  },
};

const configPath = join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "openclaw.json");
/** @type {Record<string, unknown>} */
let base = {};
if (existsSync(configPath)) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (isObject(parsed)) base = parsed;
  } catch (err) {
    console.log(`[write-config] ${configPath} is not plain JSON (${String(err)}); replacing it`);
  }
}

const merged = merge(base, overlay);
const tmp = `${configPath}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
renameSync(tmp, configPath);
console.log(`[write-config] wrote ${configPath}:\n${JSON.stringify(merged, null, 2)}`);
