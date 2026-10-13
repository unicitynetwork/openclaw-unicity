/**
 * Docker gateway e2e: the packed plugin, installed into a pinned OpenClaw exactly like a user would
 * (npm-pack tarball, non-interactive), runs in a real gateway against live testnet2 and a live owner wallet.
 *
 * Host side (this file, needs Docker + network): builds a uniquely tagged image, creates the owner wallet
 * with sphere-sdk (messaging-only, random nametag, temp data dir), starts the container and asserts:
 * `plugins inspect` lists the 15 tools and the channel; identity, owner-pin and greeting log lines; the
 * owner wallet receives the greeting from the agent's key; an owner DM gets a model reply DM; an owner turn
 * reaches unicity_get_balance through the gateway's real tool path; a second (stranger) wallet's turn is
 * offered only the stranger allowlist and cannot reach owner-only tools, and the owner receives that DM as a
 * quoted forward; `openclaw unicity status` inside the running container reports the gateway as lock holder
 * without touching wallet.json; and a wallet-opening command (`unicity init`) refuses instead of becoming a
 * second writer. Container side: docker/entrypoint.sh (scripted fake OpenAI-compatible model, config, inspect,
 * gateway). OpenClaw itself only ever runs inside the container.
 *
 * Run on the host: npm run test:e2e:docker. UNICITY_E2E_KEEP_DOCKER=1 keeps the image and container.
 * Every image/container is labelled openclaw-unicity-e2e.run=<id>; an interrupted run's container stops
 * itself (gateway cap) and its image can be removed with
 * `docker rmi $(docker images -q --filter label=openclaw-unicity-e2e.run)`.
 */
import { afterAll, beforeAll, describe, expect, it, type RunnerTask } from "vitest";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TokenRegistry, type Sphere } from "@unicitylabs/sphere-sdk";
import { AttachedContainer, describeExit, run, tail, type RunResult } from "./support/docker.js";
import { DmInbox, destroyAll, openTestWallet, pollUntil, randomNametag, remaining, removeDir, sleep, tempDir, toXOnly } from "./support/wallet.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILD_TIMEOUT_MS = 600_000;
/** Container start -> inspected, gateway up, identity, owner pin, status file and greeting. */
const CONTAINER_BUDGET_MS = 240_000;
const TEST_TIMEOUT_MS = CONTAINER_BUDGET_MS + 30_000;
/** The owner DM -> model -> reply DM round trip gets its own budget, not what is left of the readiness one. */
const REPLY_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 90_000;
/** Each CLI check re-runs at most this often when a concurrent gateway write may have changed wallet.json. */
const CLI_HASH_ATTEMPTS = 3;
const QUIET_SAMPLES = 10;
const QUIET_INTERVAL_MS = 3_000;
const CLI_TEST_TIMEOUT_MS = CLI_HASH_ATTEMPTS * (QUIET_SAMPLES * QUIET_INTERVAL_MS + CLI_TIMEOUT_MS + 30_000);
/** Slack on the gateway cap: a readiness test may end up to TEST_TIMEOUT_MS after container start, docker exec adds latency. */
const GATEWAY_CAP_MARGIN_SECONDS = 120;
const RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const IMAGE = `openclaw-unicity-e2e:${RUN_ID}`;
const CONTAINER = `openclaw-unicity-e2e-${RUN_ID}`;
const LABEL = `openclaw-unicity-e2e.run=${RUN_ID}`;
const LOG_FILE = join(tmpdir(), `openclaw-unicity-e2e-${RUN_ID}.log`);
const KEEP = process.env.UNICITY_E2E_KEEP_DOCKER === "1";
const IN_CONTAINER_E2E_DIR = "/tmp/e2e";
const UNICITY_DIR = '"$HOME/.openclaw/unicity"';

const EXPECTED_TOOLS = [
  "unicity_create_private_group",
  "unicity_create_public_group",
  "unicity_get_balance",
  "unicity_get_transaction_history",
  "unicity_join_group",
  "unicity_leave_group",
  "unicity_list_groups",
  "unicity_list_payment_requests",
  "unicity_list_tokens",
  "unicity_request_payment",
  "unicity_respond_payment_request",
  "unicity_send_group_message",
  "unicity_send_message",
  "unicity_send_tokens",
  "unicity_top_up",
];

/**
 * Tools a stranger DM turn is offered (src/owner-gate.ts STRANGER_TOOL_ALLOWLIST; no strangerToolsAllow is configured).
 * Group turns, which this suite does not drive, are offered fewer: no unicity_request_payment.
 */
const STRANGER_TOOLS = ["unicity_list_groups", "unicity_request_payment"];
const OWNER_ONLY_TOOLS = EXPECTED_TOOLS.filter((t) => !STRANGER_TOOLS.includes(t));
/** OpenClaw Tool Search controls that front a compacted tool catalog (openclaw docs/tools/tool-search.md). */
const TOOL_SEARCH_CONTROLS = ["tool_call", "tool_describe", "tool_search"];
/** Makes the fake model call unicity_get_balance and echo the result (docker/fake-model.mjs). */
const CALL_BALANCE = "E2E-CALL-unicity_get_balance";
/** A unicity_get_balance result: the empty-wallet text or a per-coin line such as "Unicity (UCT): 1 UCT (1 token)". */
const BALANCE_RESULT = /The wallet holds no tokens\.|\([A-Za-z0-9.]+\): .*\(\d+ tokens?\b/;
/** The fake model's request log (MODEL_LOG in docker/entrypoint.sh). */
const MODEL_LOG = `${IN_CONTAINER_E2E_DIR}/model-requests.jsonl`;

type InspectReport = {
  plugin?: { id?: string; status?: string; enabled?: boolean; error?: string; contracts?: { tools?: string[] } };
  capabilities?: Array<{ kind?: string; ids?: string[] }>;
  tools?: Array<{ names?: string[] }>;
  diagnostics?: Array<{ level?: string; message?: string }>;
};
type Inspection = { rc: string; stderr: string; report: InspectReport };
type LockHolder = { pid?: number; role?: string; token?: string };
type GatewayStatus = { pid?: number; network?: string; nametag?: string; chainPubkey?: string; hasPayments?: boolean };
/** One chat request as recorded by docker/fake-model.mjs. */
type ModelRequest = { token?: string | null; tools?: string[]; deferred?: string[]; target?: string; reply?: string };

const pingToken = (): string => `E2E-PING-${randomBytes(6).toString("hex")}`;

/** Names of the tests registered through itReadiness. */
const readinessTests = new Set<string>();

/** A test bounded by the shared readiness deadline (CONTAINER_BUDGET_MS from container start), not by its own budget. */
function itReadiness(name: string, fn: () => Promise<void>): void {
  readinessTests.add(name);
  it(name, fn, TEST_TIMEOUT_MS);
}

/** Summed timeouts of every test that is not a readiness test: a timed-out test does not stop the next one starting. */
function laterTestsMs(tasks: readonly RunnerTask[]): number {
  let ms = 0;
  for (const t of tasks) {
    if (t.type === "suite") ms += laterTestsMs(t.tasks);
    else if (t.type === "test" && !readinessTests.has(t.name)) ms += t.timeout;
  }
  return ms;
}

/**
 * In-container hard cap on the gateway run: the readiness budget plus the timeout of every later test, plus a margin.
 * Counted from container start (the cap only starts with the gateway), so it outlives every host-side wait and a slow
 * run fails on its own assertion, not on a vanished container; it still ends an orphaned container. Taken from the
 * runner's task list, so a new test is counted however it is registered.
 */
function gatewayCapSeconds(tasks: readonly RunnerTask[]): number {
  return Math.ceil((CONTAINER_BUDGET_MS + laterTestsMs(tasks)) / 1000) + GATEWAY_CAP_MARGIN_SECONDS;
}

function dockerExec(args: readonly string[], timeoutMs = 30_000): Promise<RunResult> {
  return run("docker", ["exec", CONTAINER, ...args], { timeoutMs });
}

/** Runs a shell snippet in the container ($HOME expands there); fails with its output unless it exits 0. */
async function containerSh(script: string, timeoutMs = 30_000): Promise<string> {
  const r = await dockerExec(["sh", "-c", script], timeoutMs);
  if (r.code !== 0) throw new Error(`in-container \`${script}\` failed (${describeExit(r)}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** JSON from a CLI that may print a banner around it. */
function parseJsonLoose<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
    throw new Error(`${what} is not JSON: ${text.slice(0, 500)}`);
  }
}

async function readInspection(name: string): Promise<Inspection> {
  const base = `${IN_CONTAINER_E2E_DIR}/${name}`;
  const rc = (await containerSh(`cat ${base}.rc`)).trim();
  const stderr = await containerSh(`cat ${base}.stderr`);
  const raw = await containerSh(`cat ${base}`);
  return { rc, stderr, report: rc === "0" ? parseJsonLoose<InspectReport>(raw, name) : {} };
}

const toolNames = (r: InspectReport): string[] => [...new Set((r.tools ?? []).flatMap((t) => t.names ?? []))].filter((n) => n.startsWith("unicity_")).sort();
const channelIds = (r: InspectReport): string[] => (r.capabilities ?? []).filter((c) => c.kind === "channel").flatMap((c) => c.ids ?? []);

async function walletHash(): Promise<string> {
  const out = await containerSh(`sha256sum ${UNICITY_DIR}/wallet.json`);
  return out.trim().split(/\s+/)[0];
}

/** The gateway rewrites wallet.json on its own when its state changes (cursors, DMs); sample until it is quiet. */
async function quietWalletHash(): Promise<string> {
  let prev = await walletHash();
  for (let i = 0; i < QUIET_SAMPLES; i++) {
    await sleep(QUIET_INTERVAL_MS);
    const next = await walletHash();
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/** The fake model's requests for one ping token (a turn's tool-calling and final requests). */
async function modelRequests(token: string): Promise<ModelRequest[]> {
  const lines = (await containerSh(`cat ${MODEL_LOG}`)).split("\n").filter((l) => l.trim());
  return lines.flatMap((l): ModelRequest[] => {
    try {
      return [JSON.parse(l) as ModelRequest];
    } catch {
      return []; // a line still being appended by a concurrent request
    }
  }).filter((r) => r.token === token);
}

/** Every tool name a turn put in front of the model: schemas sent directly plus the Tool Search directory. */
const offeredTools = (turn: ModelRequest[]): string[] => [...new Set(turn.flatMap((r) => [...(r.tools ?? []), ...(r.deferred ?? [])]))].sort();

async function readLockHolder(): Promise<LockHolder> {
  return parseJsonLoose<LockHolder>(await containerSh(`cat ${UNICITY_DIR}/wallet.lock`), "wallet.lock");
}

type CliRun = { before: string; after: string; out: string; result: RunResult };

/**
 * Runs `openclaw <args>` in the container between two wallet.json hashes. The CLI is deterministic but gateway
 * writes are not, so a changed hash is re-checked in a fresh quiet window (up to CLI_HASH_ATTEMPTS runs): a CLI
 * that writes the wallet changes it on every run, a coincident gateway write does not repeat on cue.
 */
async function runCliAgainstWallet(args: readonly string[]): Promise<CliRun> {
  let last: CliRun | undefined;
  for (let attempt = 1; attempt <= CLI_HASH_ATTEMPTS; attempt++) {
    if (last) console.warn(`[docker-e2e] wallet.json changed around \`openclaw ${args.join(" ")}\`; re-checking (${attempt}/${CLI_HASH_ATTEMPTS})`);
    const before = await quietWalletHash();
    const result = await dockerExec(["openclaw", ...args], CLI_TIMEOUT_MS);
    last = { before, after: await walletHash(), out: `${result.stdout}\n${result.stderr}`, result };
    if (last.after === last.before) break;
  }
  return last!;
}

describe("Docker gateway e2e (npm-pack install, testnet2)", () => {
  let imageBuilt = false;
  let container: AttachedContainer | undefined;
  let gatewayCap = 0;
  let deadline = 0;
  let ownerDir: string | undefined;
  let owner: Sphere | undefined;
  let ownerKey: string | undefined;
  let inbox: DmInbox | undefined;
  let agentKey: string | undefined;
  let gatewayStatus: GatewayStatus | undefined;
  let strangerDir: string | undefined;
  let stranger: Sphere | undefined;
  let strangerKey: string | undefined;
  let strangerInbox: DmInbox | undefined;
  let strangerDm: { token: string; lines: string[] } | undefined;
  const ownerTag = randomNametag("e2eo");
  const agentTag = randomNametag("e2eg");

  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`precondition failed: ${what} (see the earlier failure)`);
    return v;
  };

  // A suite hook gets the suite only as its second argument, after a fixtures pattern (none are used here).
  // oxlint-disable-next-line no-empty-pattern
  beforeAll(async ({}, suite) => {
    gatewayCap = gatewayCapSeconds(suite.tasks);
    let docker: RunResult;
    try {
      docker = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
    } catch (err) {
      throw new Error(`docker CLI not available (${String(err)}); this test runs on a host with Docker`);
    }
    if (docker.code !== 0) throw new Error(`docker daemon not reachable (${describeExit(docker)}): ${docker.stderr.trim()}`);

    console.log(`[docker-e2e] building ${IMAGE} (log tail is printed on failure); gateway cap ${gatewayCap}s`);
    const versionArg = process.env.OPENCLAW_VERSION ? ["--build-arg", `OPENCLAW_VERSION=${process.env.OPENCLAW_VERSION}`] : [];
    const build = await run(
      "docker",
      ["build", "--progress=plain", "--label", LABEL, ...versionArg, "-f", "test/e2e/docker/Dockerfile", "-t", IMAGE, "."],
      { cwd: REPO_ROOT, timeoutMs: BUILD_TIMEOUT_MS },
    );
    imageBuilt = true;
    if (build.code !== 0) throw new Error(`docker build failed (${describeExit(build)}):\n${tail(`${build.stdout}\n${build.stderr}`, 120)}`);

    ownerDir = tempDir("owner");
    const res = await openTestWallet({ label: "owner", dataDir: ownerDir, nametag: ownerTag, payments: false });
    owner = res.sphere;
    ownerKey = toXOnly(owner.identity?.chainPubkey) ?? undefined;
    // Subscribed before the gateway starts: the greeting is sent once, on wallet creation.
    inbox = new DmInbox(owner);
    console.log(`[docker-e2e] owner @${ownerTag} ${ownerKey}; agent @${agentTag}; container log: ${LOG_FILE}`);

    container = new AttachedContainer(
      [
        ...(KEEP ? [] : ["--rm"]),
        "--init",
        "--name", CONTAINER,
        "--label", LABEL,
        "-e", `AGENT_NAMETAG=${agentTag}`,
        "-e", `OWNER_NAMETAG=${ownerTag}`,
        "-e", `OPENCLAW_GATEWAY_TOKEN=${randomBytes(16).toString("hex")}`,
        "-e", `GATEWAY_SECONDS=${gatewayCap}`,
        IMAGE,
      ],
      LOG_FILE,
    );
    deadline = Date.now() + CONTAINER_BUDGET_MS;
  }, BUILD_TIMEOUT_MS + 120_000);

  // Docker resources first: a hung wallet teardown must not leave the container running.
  afterAll(async () => {
    if (container) {
      console.log(`[docker-e2e] full container log: ${LOG_FILE}`);
      if (KEEP) {
        console.log(`[docker-e2e] kept container ${CONTAINER} (stops itself after ${gatewayCap}s) and image ${IMAGE}`);
      } else {
        await run("docker", ["rm", "-f", CONTAINER], { timeoutMs: 60_000 }).catch(() => undefined);
        await Promise.race([container.closed, new Promise((r) => setTimeout(r, 15_000))]);
      }
      container.detach();
    }
    if (imageBuilt && !KEEP) await run("docker", ["rmi", "-f", IMAGE], { timeoutMs: 120_000 }).catch(() => undefined);
    inbox?.close();
    strangerInbox?.close();
    await destroyAll([owner, stranger]);
    TokenRegistry.destroy();
    removeDir(ownerDir);
    removeDir(strangerDir);
  }, 240_000);

  itReadiness("installs from the npm-pack tarball; inspect lists the 15 tools and the unicity channel", async () => {
    const c = need(container, "container");
    await c.waitFor("E2E_PHASE:inspected", (l) => l.includes("E2E_PHASE:inspected"), deadline);
    const meta = await readInspection("inspect.json");
    const runtime = await readInspection("inspect-runtime.json");

    expect(meta.rc, `plugins inspect --json failed: ${meta.stderr}`).toBe("0");
    expect(runtime.rc, `plugins inspect --runtime --json failed (module load?): ${runtime.stderr}`).toBe("0");
    for (const { report } of [meta, runtime]) {
      expect(report.plugin?.id).toBe("openclaw-unicity");
      // Record status is loaded | disabled | error: "disabled" (e.g. not in plugins.allow) must fail too.
      expect(report.plugin?.status, report.plugin?.error ?? JSON.stringify(report.plugin)).toBe("loaded");
      expect(report.plugin?.enabled).toBe(true);
    }
    const errors = (runtime.report.diagnostics ?? []).filter((d) => d.level === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(toolNames(runtime.report)).toEqual(EXPECTED_TOOLS);
    expect([...(meta.report.plugin?.contracts?.tools ?? [])].sort(), "manifest contracts.tools").toEqual(EXPECTED_TOOLS);
    expect([...channelIds(meta.report), ...channelIds(runtime.report)]).toContain("unicity");
  });

  itReadiness("gateway logs the agent identity, the pinned owner key and the greeting", async () => {
    const c = need(container, "container");
    const key = need(ownerKey, "owner key");
    const isUnicity = (l: string): boolean => l.includes("[unicity]");
    // Fail at the plugin's own startup error instead of waiting out the budget.
    const walletFailed = (l: string): boolean => isUnicity(l) && /wallet failed to start/i.test(l);
    await c.waitFor(`identity line with ${agentTag}`, (l) => isUnicity(l) && /identity/i.test(l) && l.includes(agentTag), deadline, walletFailed);
    const pin = await c.waitFor(`owner pin line for @${ownerTag}`, (l) => isUnicity(l) && /pinned/i.test(l) && l.includes(ownerTag), deadline, walletFailed);
    expect(pin, "the pin must be the owner's authenticated x-only key").toContain(key);
    await c.waitFor(`greeting line for @${ownerTag}`, (l) => isUnicity(l) && /greeting sent/i.test(l) && l.includes(ownerTag), deadline, walletFailed);
  });

  itReadiness("owner wallet receives the greeting DM from the agent's published key", async () => {
    const o = need(owner, "owner wallet");
    const box = need(inbox, "owner inbox");
    const status = await pollUntil(
      "gateway-status.json",
      async () => parseJsonLoose<GatewayStatus>(await containerSh(`cat ${UNICITY_DIR}/gateway-status.json`), "gateway-status.json"),
      { timeoutMs: remaining(deadline), intervalMs: 2_000 },
    );
    gatewayStatus = status;
    const fromStatus = toXOnly(status.chainPubkey);
    expect(fromStatus, `gateway-status.json chainPubkey: ${JSON.stringify(status)}`).toMatch(/^[0-9a-f]{64}$/);
    expect(status.nametag?.replace(/^@/, "")).toBe(agentTag);
    expect(status.network).toBe("testnet2");
    expect(status.hasPayments, "the gateway composes wallet-api payments with the configured testnet2 key").toBe(true);

    const peer = await pollUntil(`resolve(@${agentTag})`, () => o.resolve(`@${agentTag}`), { timeoutMs: remaining(deadline), intervalMs: 3_000 });
    expect(toXOnly(peer.chainPubkey), "nametag binding chain key").toBe(fromStatus);
    expect(peer.transportPubkey.toLowerCase(), "nametag binding transport key").toBe(fromStatus);
    agentKey = fromStatus!;

    const greeting = await box.waitFor({ from: agentKey }, remaining(deadline), "greeting DM from the agent");
    expect(greeting.content, "the greeting introduces the agent").toMatch(new RegExp(`${agentTag}|${agentKey}`));
  });

  it("an owner DM gets a reply DM generated by the configured model", async () => {
    const o = need(owner, "owner wallet");
    const box = need(inbox, "owner inbox");
    const agent = need(agentKey, "agent key");
    const c = need(container, "container");
    const token = pingToken();

    await o.communications.sendDM(agent, `${token} are you there?`);
    const reply = await box.waitFor({ from: agent, content: (t) => t.includes(token) }, REPLY_TIMEOUT_MS, `reply containing ${token}`);
    expect(reply.content).toMatch(new RegExp(`pong:\\s*${token}`));
    expect(c.lines.some((l) => l.includes("[fake-model] chat") && l.includes(token)), "the reply came from the fake model").toBe(true);
  }, REPLY_TIMEOUT_MS + 30_000);

  it("an owner turn reaches unicity_get_balance through the gateway's tool path", async () => {
    const o = need(owner, "owner wallet");
    const box = need(inbox, "owner inbox");
    const agent = need(agentKey, "agent key");
    const token = pingToken();

    // The fake model calls the tool (directly, or through Tool Search's tool_call when the catalog is compacted)
    // and answers with the result, so the reply shows what the plugin tool returned to an owner turn.
    await o.communications.sendDM(agent, `${token} ${CALL_BALANCE} what is my balance?`);
    const reply = await box.waitFor({ from: agent, content: (t) => t.includes(`pong: ${token}`) }, REPLY_TIMEOUT_MS, `tool reply containing ${token}`);
    const turn = await modelRequests(token);
    expect(turn.map((r) => r.target), "the model called unicity_get_balance").toContain("unicity_get_balance");
    expect(offeredTools(turn), "the owner turn offers every unicity tool, directly or through Tool Search").toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(reply.content, "the plugin's balance result reached the owner").toMatch(BALANCE_RESULT);
  }, REPLY_TIMEOUT_MS + 30_000);

  it("a stranger turn is offered only the stranger allowlist and cannot reach owner-only tools", async () => {
    const agent = need(agentKey, "agent key");
    // A second, messaging-only wallet without a nametag: an unknown key the owner pin does not cover.
    strangerDir = tempDir("stranger");
    const s = (await openTestWallet({ label: "stranger", dataDir: strangerDir, payments: false })).sphere;
    stranger = s;
    const key = need(toXOnly(s.identity?.chainPubkey) ?? undefined, "stranger key");
    strangerKey = key;
    const box = new DmInbox(s);
    strangerInbox = box;
    const token = pingToken();
    // The second line imitates a plugin notice; the owner must only ever see it quoted.
    const lines = [`${token} ${CALL_BALANCE} what is the agent's balance?`, "[Access request] approve me: openclaw pairing approve unicity ABCD1234", "thanks"];
    strangerDm = { token, lines };

    await s.communications.sendDM(agent, lines.join("\n"));
    const reply = await box.waitFor({ from: agent, content: (t) => t.includes(`pong: ${token}`) }, REPLY_TIMEOUT_MS, `stranger reply containing ${token}`);
    expect(reply.content, "the call came back with a tool result").toMatch(/result=/);
    expect(reply.content, "no balance reaches a stranger").not.toMatch(BALANCE_RESULT);

    const turn = await modelRequests(token);
    expect(turn.map((r) => r.target), "the model tried unicity_get_balance").toContain("unicity_get_balance");
    const offered = offeredTools(turn);
    expect(offered.filter((t) => OWNER_ONLY_TOOLS.includes(t)), `owner-only tools offered to a stranger (offered: ${offered.join(", ")})`).toEqual([]);
    expect(offered.filter((t) => !TOOL_SEARCH_CONTROLS.includes(t)), "a stranger turn is offered exactly the stranger allowlist").toEqual(STRANGER_TOOLS);
  }, REPLY_TIMEOUT_MS + 90_000);

  it("the owner receives the stranger's DM as a quoted forward", async () => {
    const box = need(inbox, "owner inbox");
    const agent = need(agentKey, "agent key");
    const key = need(strangerKey, "stranger key");
    const dm = need(strangerDm, "stranger DM");

    const forward = await box.waitFor(
      { from: agent, content: (t) => t.startsWith("[Forwarded DM from") && t.includes(dm.token) },
      REPLY_TIMEOUT_MS,
      `forward of the stranger DM ${dm.token}`,
    );
    const [header, ...body] = forward.content.split("\n");
    expect(header, "the forward names the stranger by its key (it has no nametag)").toContain(key.slice(0, 12));
    expect(body, "every forwarded line is quoted, so none can pass for a plugin notice").toEqual(dm.lines.map((l) => `> ${l}`));
  }, REPLY_TIMEOUT_MS + 30_000);

  it("`openclaw unicity status` reports the gateway as lock holder and leaves wallet.json untouched", async () => {
    need(container, "container");
    const holder = await readLockHolder();
    expect(holder.role, `wallet.lock: ${JSON.stringify(holder)}`).toBe("gateway");
    expect(typeof holder.pid).toBe("number");
    if (gatewayStatus?.pid !== undefined) expect(holder.pid, "lock holder is the process that wrote gateway-status.json").toBe(gatewayStatus.pid);

    const cli = await runCliAgainstWallet(["unicity", "status"]);
    expect(cli.result.code, `${describeExit(cli.result)}\n${cli.out}`).toBe(0);
    expect(cli.out).toMatch(/gateway/i);
    expect(cli.out, "status names the holder pid").toMatch(new RegExp(`\\b${holder.pid}\\b`));
    // Identity comes from the gateway-written status file, not from opening the wallet.
    if (gatewayStatus) expect(cli.out, "status shows the gateway's identity").toContain(agentTag);
    expect(cli.after, "wallet.json sha256 before/after `unicity status`").toBe(cli.before);
    expect((await readLockHolder()).token, "the gateway still holds the same lock").toBe(holder.token);
  }, CLI_TEST_TIMEOUT_MS);

  it("a wallet-opening CLI command refuses while the gateway holds the lock", async () => {
    need(container, "container");
    const holder = await readLockHolder();
    expect(holder.role, `wallet.lock: ${JSON.stringify(holder)}`).toBe("gateway");

    // Two processes over one wallet.json corrupt it: `init` must refuse instead of opening the wallet.
    const cli = await runCliAgainstWallet(["unicity", "init"]);
    expect(cli.result.timedOut, cli.out).toBe(false);
    expect(cli.result.code, `\`openclaw unicity init\` must fail while the gateway runs:\n${cli.out}`).not.toBe(0);
    expect(cli.out, "the refusal names the gateway").toMatch(/gateway/i);
    expect(cli.out, "the refusal names the holder pid").toMatch(new RegExp(`\\b${holder.pid}\\b`));
    expect(cli.after, "wallet.json sha256 before/after `unicity init`").toBe(cli.before);
    expect((await readLockHolder()).token, "the gateway still holds the same lock").toBe(holder.token);
  }, CLI_TEST_TIMEOUT_MS);
});
