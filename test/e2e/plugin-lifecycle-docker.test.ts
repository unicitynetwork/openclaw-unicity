/**
 * Docker-based E2E test for the full OpenClaw plugin lifecycle.
 *
 * Verifies: npm pack -> docker build -> openclaw plugins install ->
 * openclaw gateway run -> nametag minted -> greeting DM sent to owner.
 *
 * Requires Docker to be running locally.
 * Run: npm run test:e2e:docker
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import { unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");

const rand = () => Math.random().toString(36).slice(2, 8);

function randomNametag(prefix: string): string {
  const suffix = rand().replace(/[^a-z0-9]/g, "");
  const ts = (Date.now() % 10000).toString();
  return `${prefix}${suffix}${ts}`.slice(0, 20);
}

const IMAGE_NAME = "uniclaw-e2e";
const OWNER = "hui-6";

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Docker Gateway E2E", () => {
  let builtImage = false;

  afterAll(() => {
    // Clean up .tgz files from project root
    try {
      const files = readdirSync(PROJECT_ROOT);
      for (const f of files) {
        if (f.endsWith(".tgz")) {
          unlinkSync(join(PROJECT_ROOT, f));
        }
      }
    } catch { /* ignore */ }

    // Remove docker image
    if (builtImage) {
      try {
        execSync(`docker rmi ${IMAGE_NAME}`, { stdio: "ignore" });
      } catch { /* ignore */ }
    }
  });

  it("starts gateway, mints nametag, and sends greeting DM", async () => {
    const nametag = randomNametag("e2e");

    // 1. npm pack
    console.log("[docker-e2e] Running npm pack...");
    execSync("npm pack", { cwd: PROJECT_ROOT, stdio: "pipe" });

    // 2. Docker build
    console.log("[docker-e2e] Building Docker image...");
    execSync(
      `docker build -f test/e2e/docker/Dockerfile -t ${IMAGE_NAME} .`,
      { cwd: PROJECT_ROOT, stdio: "inherit", timeout: 120_000 },
    );
    builtImage = true;

    // 3. Docker run — stream output and look for result marker
    console.log(`[docker-e2e] Running container with nametag=${nametag}...`);
    const result = await new Promise<{ pass: boolean; output: string }>((resolve) => {
      let output = "";
      let settled = false;

      const proc = spawn("docker", [
        "run", "--rm",
        "-e", `NAMETAG=${nametag}`,
        "-e", `OWNER=${OWNER}`,
        IMAGE_NAME,
      ], { cwd: PROJECT_ROOT });

      const settle = (pass: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ pass, output });
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        process.stdout.write(text);

        if (text.includes("E2E_RESULT:PASS")) {
          settle(true);
        } else if (text.includes("E2E_RESULT:FAIL")) {
          settle(false);
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        process.stderr.write(text);
      });

      proc.on("close", (code) => {
        settle(code === 0);
      });

      // Overall safety timeout (container should self-terminate)
      setTimeout(() => {
        if (!settled) {
          try { proc.kill(); } catch { /* ignore */ }
          settle(false);
        }
      }, 170_000);
    });

    expect(result.pass, `Container output:\n${result.output}`).toBe(true);
    expect(result.output).toContain(`[unicity] Identity: ${nametag}`);
    expect(result.output).toContain(`[unicity] Greeting sent to @${OWNER}`);
  }, 180_000);
});
