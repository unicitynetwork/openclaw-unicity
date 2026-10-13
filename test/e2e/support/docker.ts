/** Host-side helpers for the Docker gateway e2e: bounded child processes and an attached container's log. */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { sleep } from "./wallet.js";

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean };

/** Runs a command to completion, SIGKILLing it after `timeoutMs`. Rejects only when it cannot be spawned (e.g. ENOENT). */
export function run(cmd: string, args: readonly string[], opts: { timeoutMs: number; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    };
    child.on("close", finish);
    // After a timeout kill, a surviving grandchild may hold the pipes open (so no 'close'): settle on exit.
    child.on("exit", (code, signal) => {
      if (!timedOut) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(code, signal);
    });
  });
}

export function describeExit(r: RunResult): string {
  if (r.timedOut) return "timed out";
  return r.signal ? `signal ${r.signal}` : `exit ${r.code}`;
}

export function tail(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n");
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * `docker run` in the foreground (attached), so the client process lives exactly as long as the container
 * and its stdout/stderr are the container log. Every line is mirrored to `logFile`.
 */
export class AttachedContainer {
  readonly lines: string[] = [];
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly closed: Promise<void>;
  private readonly partial = { stdout: "", stderr: "" };
  private readonly client: ChildProcess;

  constructor(runArgs: readonly string[], private readonly logFile: string) {
    const child = spawn("docker", ["run", ...runArgs], { stdio: ["ignore", "pipe", "pipe"] });
    this.client = child;
    child.stdout.setEncoding("utf8").on("data", (c: string) => this.ingest("stdout", c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => this.ingest("stderr", c));
    this.closed = new Promise((resolve) => {
      child.on("error", (err) => {
        this.push(`[docker-e2e] docker run failed to start: ${String(err)}`);
        this.exit = { code: null, signal: null };
        resolve();
      });
      child.on("close", (code, signal) => {
        for (const stream of ["stdout", "stderr"] as const) if (this.partial[stream]) this.push(this.partial[stream]);
        this.exit = { code, signal };
        resolve();
      });
    });
  }

  /**
   * Drops the attached client so the test process can exit; the container itself keeps running. SIGKILL
   * because `docker run` proxies catchable signals (SIGTERM/SIGINT) into the container.
   */
  detach(): void {
    if (!this.exit) this.client.kill("SIGKILL");
  }

  tail(n = 150): string {
    return this.lines.slice(-n).join("\n");
  }

  /**
   * Resolves with the first log line matching `pred`; fails fast on an E2E_FAIL marker, a line matching `fatal`,
   * container exit or the deadline.
   */
  async waitFor(what: string, pred: (line: string) => boolean, deadline: number, fatal?: (line: string) => boolean): Promise<string> {
    let scanned = 0;
    for (;;) {
      for (; scanned < this.lines.length; scanned++) {
        const line = this.lines[scanned];
        if (pred(line)) return line;
        if (line.startsWith("E2E_FAIL:") || fatal?.(line)) {
          throw new Error(`container reported a failure before ${what}: ${line}\n--- container log (tail) ---\n${this.tail()}`);
        }
      }
      if (this.exit) {
        throw new Error(`container exited (code ${this.exit.code}, signal ${this.exit.signal}) before ${what}\n--- container log (tail) ---\n${this.tail()}`);
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}\n--- container log (tail) ---\n${this.tail()}`);
      await sleep(250);
    }
  }

  private ingest(stream: "stdout" | "stderr", chunk: string): void {
    const parts = (this.partial[stream] + chunk).split("\n");
    this.partial[stream] = parts.pop() ?? "";
    for (const p of parts) this.push(p);
  }

  private push(raw: string): void {
    const line = raw.replace(ANSI, "").replace(/\r$/, "");
    this.lines.push(line);
    try {
      appendFileSync(this.logFile, `${line}\n`);
    } catch {
      // The log file is a debugging aid only.
    }
  }
}
