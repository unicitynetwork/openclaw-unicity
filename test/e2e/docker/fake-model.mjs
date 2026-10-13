#!/usr/bin/env node
// @ts-check
/**
 * Deterministic OpenAI-compatible model for the Docker e2e (Node built-ins only).
 *
 *   node fake-model.mjs serve <port>      GET /v1/models, POST /v1/chat/completions (JSON, or SSE when stream:true)
 *   node fake-model.mjs check <baseUrl>   smoke-test a running server: both response modes, text and tool calls; exit 1 on mismatch
 *
 * Reply: "pong: <token>" when a user message carries an E2E-PING-<token> marker (the host test's ping; the
 * gateway may wrap or follow the DM with other user-role text), otherwise "pong: <last user text>".
 * Scripted tool call: when that message also carries E2E-CALL-<tool>, the model calls <tool> with no arguments:
 * directly when the request offers it, through OpenClaw Tool Search's `tool_call` control when only that is offered,
 * otherwise directly anyway (the gateway must refuse it). Once a tool result follows the marked message, the reply
 * is "pong: <token> result=<tool result text>".
 * MODEL_LOG (a file path) records every chat request as one JSON line: the token, the tools offered directly, the
 * deferred tools listed in the Tool Search directory of the prompt, and the call or reply. The host test asserts on it.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const MODEL_ID = process.env.MODEL_ID || "pong-1";
const MODEL_LOG = process.env.MODEL_LOG || "";
const PING = /E2E-PING-[A-Za-z0-9]+/;
const CALL = /E2E-CALL-([A-Za-z0-9_]+)/;
/** Tool Search control that calls a deferred catalog tool by id or name (openclaw docs/tools/tool-search.md). */
const TOOL_CALL = "tool_call";
/** Tool Search directory in the prompt: this heading, then one "- <name> (<owner>): <description>" row per tool. */
const DIRECTORY_HEADING = "Available deferred-schema tools:";
const DIRECTORY_ROW = /^- ([A-Za-z0-9][A-Za-z0-9_.:-]*)/;
const RESULT_MAX_CHARS = 400;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** @typedef {{ role?: unknown; content?: unknown }} ChatMessage */
/** @typedef {{ name: string; arguments: Record<string, unknown> }} ToolCall */
/** @typedef {{ token: string | null; reply: string } | { token: string; target: string; call: ToolCall }} Plan */

/** @param {string} msg */
const log = (msg) => console.log(`[fake-model] ${msg}`);

/** @param {unknown} content */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** @param {unknown} messages @returns {ChatMessage[]} */
const chatMessages = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m !== null && typeof m === "object");

/**
 * Names of the tools a request offers directly (OpenAI `tools[].function.name`).
 * @param {unknown} tools
 * @returns {string[]}
 */
function offeredTools(tools) {
  /** @type {Array<{ function?: { name?: unknown } } | null>} */
  const list = Array.isArray(tools) ? tools : [];
  return list
    .map((t) => t?.function?.name)
    .filter((n) => typeof n === "string")
    .sort();
}

/**
 * Deferred tool names listed in the Tool Search directory: the rows under DIRECTORY_HEADING, in any message.
 * @param {ChatMessage[]} messages
 * @returns {string[]}
 */
function deferredTools(messages) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const m of messages) {
    let inDirectory = false;
    for (const line of textOf(m.content).split("\n")) {
      if (line.trim() === DIRECTORY_HEADING) {
        inDirectory = true;
        continue;
      }
      const row = inDirectory ? line.match(DIRECTORY_ROW) : null;
      if (row) names.add(row[1]);
      else inDirectory = false;
    }
  }
  return [...names].sort();
}

/**
 * A tool result as one capped line. OpenClaw's tool_call wraps the target result in a JSON envelope: keep only
 * its text/message/error strings. Anything else (e.g. a plain error) is used as is.
 * @param {string} raw
 */
function resultText(raw) {
  /** @type {string[]} */
  const parts = [];
  /** @param {unknown} value @param {string} [key] */
  const collect = (value, key) => {
    if (typeof value === "string") {
      if (key === "text" || key === "message" || key === "error") parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, key);
    } else if (value !== null && typeof value === "object") {
      for (const [k, item] of Object.entries(value)) collect(item, k);
    }
  };
  try {
    collect(JSON.parse(raw));
  } catch {
    // Not JSON: the raw text is the result.
  }
  const text = (parts.length ? parts.join(" | ") : raw).replace(/\s+/g, " ").trim();
  return text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS - 1)}…` : text;
}

/**
 * What to answer: the reply text, or the scripted tool call.
 * @param {ChatMessage[]} messages
 * @param {string[]} offered tools offered directly
 * @returns {Plan}
 */
function plan(messages, offered) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = textOf(messages[i].content);
    const ping = text.match(PING);
    if (!ping) continue;
    const token = ping[0];
    const results = messages.slice(i + 1).filter((m) => m.role === "tool").map((m) => resultText(textOf(m.content)));
    if (results.length) return { token, reply: `pong: ${token} result=${results.join(" | ")}` };
    const target = text.match(CALL)?.[1];
    if (!target) return { token, reply: `pong: ${token}` };
    const viaToolSearch = !offered.includes(target) && offered.includes(TOOL_CALL);
    return { token, target, call: viaToolSearch ? { name: TOOL_CALL, arguments: { id: target, args: {} } } : { name: target, arguments: {} } };
  }
  const users = messages.filter((m) => m.role === "user");
  return { token: null, reply: `pong: ${textOf(users.at(-1)?.content).trim().slice(0, 500)}` };
}

/** @param {string} output */
function usage(output) {
  const completion = output.split(/\s+/).filter(Boolean).length;
  return { prompt_tokens: 16, completion_tokens: completion, total_tokens: 16 + completion };
}

const completionId = () => `chatcmpl-e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const toolCallId = () => `call_e2e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** @param {Record<string, unknown>} entry */
function record(entry) {
  if (!MODEL_LOG) return;
  try {
    appendFileSync(MODEL_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    log(`could not record the request in ${MODEL_LOG}: ${String(err)}`);
  }
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} model
 * @param {Plan} p
 * @param {boolean} includeUsage
 */
function streamReply(res, model, p, includeUsage) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  /** @param {unknown[]} choices @param {Record<string, unknown>} [extra] */
  const chunk = (choices, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`);
  let output;
  if ("call" in p) {
    output = JSON.stringify(p.call.arguments);
    const call = { index: 0, id: toolCallId(), type: "function", function: { name: p.call.name, arguments: "" } };
    chunk([{ index: 0, delta: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: null }]);
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: output } }] }, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
  } else {
    output = p.reply;
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    chunk([{ index: 0, delta: { content: output }, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
  }
  if (includeUsage) chunk([], { usage: usage(output) });
  res.end("data: [DONE]\n\n");
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} model
 * @param {Plan} p
 */
function jsonReply(res, model, p) {
  const call = "call" in p;
  const output = call ? JSON.stringify(p.call.arguments) : p.reply;
  const message = call
    ? { role: "assistant", content: null, tool_calls: [{ id: toolCallId(), type: "function", function: { name: p.call.name, arguments: output } }] }
    : { role: "assistant", content: output };
  sendJson(res, 200, {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop", logprobs: null }],
    usage: usage(output),
  });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handle(req, res) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    sendJson(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "openclaw-unicity-e2e" }] });
    return;
  }
  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (err) {
      sendJson(res, 400, { error: { message: `invalid JSON body: ${String(err)}`, type: "invalid_request_error" } });
      return;
    }
    const messages = chatMessages(body.messages);
    const tools = offeredTools(body.tools);
    const deferred = deferredTools(messages);
    const p = plan(messages, tools);
    const model = typeof body.model === "string" ? body.model : MODEL_ID;
    const stream = body.stream === true;
    const action = "call" in p ? `call ${p.call.name} ${JSON.stringify(p.call.arguments)}` : JSON.stringify(p.reply);
    log(`chat stream=${stream} messages=${messages.length} tools=${tools.length} deferred=${deferred.length} token=${p.token ?? "-"} -> ${action}`);
    record({ token: p.token, stream, messages: messages.length, tools, deferred, ...("call" in p ? { target: p.target, call: p.call } : { reply: p.reply }) });
    if (stream) streamReply(res, model, p, body.stream_options?.include_usage === true);
    else jsonReply(res, model, p);
    return;
  }
  log(`no route for ${req.method} ${path}`);
  sendJson(res, 404, { error: { message: `fake model: no route for ${req.method} ${path}`, type: "invalid_request_error" } });
}

/** @param {number} port */
function serve(port) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`handler error: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err), type: "server_error" } });
      else res.end();
    });
  });
  server.listen(port, "127.0.0.1", () => log(`listening on http://127.0.0.1:${port}/v1 (model ${MODEL_ID})`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** @typedef {{ reply: string | undefined; call: { name: unknown; arguments: unknown } | undefined }} Answer */

/**
 * The assistant's text and first tool call from an SSE body (deltas concatenated).
 * @param {string} sse
 * @returns {Answer}
 */
function parseStream(sse) {
  const events = sse.split("\n\n").map((e) => e.trim()).filter(Boolean);
  if (events.at(-1) !== "data: [DONE]") throw new Error(`stream did not end with [DONE]: ${JSON.stringify(sse.slice(-200))}`);
  let reply = "";
  let name;
  let args = "";
  for (const event of events.slice(0, -1)) {
    const delta = JSON.parse(event.replace(/^data: /, "")).choices?.[0]?.delta ?? {};
    reply += delta.content ?? "";
    const fn = delta.tool_calls?.[0]?.function;
    name ??= fn?.name;
    args += fn?.arguments ?? "";
  }
  return { reply: name === undefined ? reply : undefined, call: name === undefined ? undefined : { name, arguments: JSON.parse(args) } };
}

/**
 * @param {unknown} body a non-streaming chat completion
 * @returns {Answer}
 */
function parseJson(body) {
  const completion = /** @type {{ choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> } | null} */ (body);
  const message = completion?.choices?.[0]?.message;
  const fn = message?.tool_calls?.[0]?.function;
  return { reply: fn ? undefined : message?.content, call: fn ? { name: fn.name, arguments: JSON.parse(fn.arguments ?? "") } : undefined };
}

/** @param {string} base */
async function check(base) {
  if (!MODEL_LOG) throw new Error("MODEL_LOG is required: the self-test checks the request log");
  const token = "E2E-PING-selftest";
  const models = /** @type {{ data?: Array<{ id?: string }> }} */ (await (await fetch(`${base}/v1/models`)).json());
  if (models?.data?.[0]?.id !== MODEL_ID) throw new Error(`/v1/models returned ${JSON.stringify(models)}`);

  /** @param {string} name */
  const tool = (name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
  /** @param {Record<string, unknown>} extra */
  const post = (extra) =>
    fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL_ID, ...extra }) });
  /**
   * Both response modes must give `expected`.
   * @param {string} what @param {Record<string, unknown>} request @param {Answer} expected
   */
  const expectAnswer = async (what, request, expected) => {
    const answers = [
      parseJson(await (await post(request)).json()),
      parseStream(await (await post({ ...request, stream: true, stream_options: { include_usage: true } })).text()),
    ];
    for (const [i, answer] of answers.entries()) {
      if (JSON.stringify(answer) !== JSON.stringify(expected)) {
        throw new Error(`${what} (${i ? "stream" : "non-stream"}): got ${JSON.stringify(answer)}, expected ${JSON.stringify(expected)}`);
      }
    }
  };

  const ask = (/** @type {string} */ text) => ({ role: "user", content: [{ type: "text", text }] });
  await expectAnswer("text reply", { messages: [{ role: "system", content: "self-test" }, ask(`${token} are you there?`)] }, {
    reply: `pong: ${token}`,
    call: undefined,
  });

  const calling = ask(`${token} E2E-CALL-unicity_get_balance`);
  const directory = [
    "Tool rules.",
    DIRECTORY_HEADING,
    "- unicity_get_balance (openclaw-unicity): Get the wallet's spendable token balances.",
    "- unicity_list_groups (openclaw-unicity): List groups.",
    "",
    "- not_a_directory_row: after the blank line",
  ].join("\n");
  const viaToolSearch = { messages: [{ role: "system", content: directory }, calling], tools: [tool("tool_search"), tool(TOOL_CALL)] };
  await expectAnswer("call through Tool Search", viaToolSearch, {
    reply: undefined,
    call: { name: TOOL_CALL, arguments: { id: "unicity_get_balance", args: {} } },
  });
  await expectAnswer("direct call", { messages: [calling], tools: [tool(TOOL_CALL), tool("unicity_get_balance")] }, {
    reply: undefined,
    call: { name: "unicity_get_balance", arguments: {} },
  });

  const envelope = { tool: { id: "unicity_get_balance", name: "unicity_get_balance" }, result: { content: [{ type: "text", text: "The wallet holds\nno tokens." }], details: { balances: [] } } };
  const answered = [
    calling,
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: TOOL_CALL, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: JSON.stringify(envelope, null, 2) },
  ];
  await expectAnswer("reply with the tool result", { messages: answered }, { reply: `pong: ${token} result=The wallet holds no tokens.`, call: undefined });
  await expectAnswer("reply with a plain tool error", { messages: [...answered.slice(0, 2), { role: "tool", tool_call_id: "call_1", content: "Tool x not found" }] }, {
    reply: `pong: ${token} result=Tool x not found`,
    call: undefined,
  });

  const logged = readFileSync(MODEL_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const searchRequest = logged.findLast((r) => r.token === token && r.call?.name === TOOL_CALL);
  const expectedDeferred = ["unicity_get_balance", "unicity_list_groups"];
  if (JSON.stringify(searchRequest?.deferred) !== JSON.stringify(expectedDeferred) || JSON.stringify(searchRequest?.tools) !== JSON.stringify([TOOL_CALL, "tool_search"])) {
    throw new Error(`request log: ${JSON.stringify(searchRequest)}, expected deferred ${JSON.stringify(expectedDeferred)}`);
  }
  log(`self-test passed against ${base}`);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "serve" && arg) {
  serve(Number(arg));
} else if (mode === "check" && arg) {
  check(arg.replace(/\/+$/, "")).catch((err) => {
    log(`self-test FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  console.error("usage: fake-model.mjs serve <port> | check <baseUrl>");
  process.exit(2);
}
