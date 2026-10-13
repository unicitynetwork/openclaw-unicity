#!/usr/bin/env bash
# Container side of the Docker gateway e2e (driven by test/e2e/plugin-lifecycle-docker.test.ts).
# The plugin is already installed in the image (npm-pack, see Dockerfile). This script starts the fake
# OpenAI-compatible model, merges the run's gateway config, records `openclaw plugins inspect` for the
# host to assert on, then runs the gateway in the foreground under a hard time cap.
# stdout markers for the host: E2E_PHASE:<name> on progress, E2E_FAIL:<reason> on any failure.
set -Eeuo pipefail

: "${AGENT_NAMETAG:?AGENT_NAMETAG is required}"
: "${OWNER_NAMETAG:?OWNER_NAMETAG is required}"
: "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}"
export MODEL_PORT="${MODEL_PORT:-18231}"
export MODEL_ID="${MODEL_ID:-pong-1}"
GATEWAY_SECONDS="${GATEWAY_SECONDS:-600}"
E2E_DIR="${E2E_DIR:-/tmp/e2e}"
# One JSON line per model request (offered tools, scripted tool calls) for the host test to assert on.
export MODEL_LOG="${MODEL_LOG:-$E2E_DIR/model-requests.jsonl}"
PLUGIN_ID="openclaw-unicity"

log() { printf '[entrypoint] %s\n' "$*"; }
phase() { printf 'E2E_PHASE:%s\n' "$1"; }
fail() {
  printf 'E2E_FAIL:%s\n' "$*"
  exit 1
}
trap 'rc=$?; printf "E2E_FAIL:entrypoint line %s: %s (exit %s)\n" "$LINENO" "$BASH_COMMAND" "$rc"; exit "$rc"' ERR

nametag_re='^[a-z0-9_-]{3,20}$'
[[ "$AGENT_NAMETAG" =~ $nametag_re ]] || fail "AGENT_NAMETAG '$AGENT_NAMETAG' is not a valid nametag"
[[ "$OWNER_NAMETAG" =~ $nametag_re ]] || fail "OWNER_NAMETAG '$OWNER_NAMETAG' is not a valid nametag"
[[ "$GATEWAY_SECONDS" =~ ^[0-9]+$ ]] || fail "GATEWAY_SECONDS must be a number of seconds"
mkdir -p "$E2E_DIR"
# `|| true` keeps the errtrace ERR trap (inherited by command substitutions) from firing on a diagnostic.
openclaw_version="$(openclaw --version 2>/dev/null || true)"
log "agent=@$AGENT_NAMETAG owner=@$OWNER_NAMETAG openclaw=${openclaw_version%%$'\n'*} node=$(node --version || true)"

# 1. Fake model: background server, wait until it answers, then smoke-test both response modes (text and tool calls).
node /app/fake-model.mjs serve "$MODEL_PORT" &
model_pid=$!
model_url="http://127.0.0.1:${MODEL_PORT}"
model_up=0
for _ in $(seq 1 50); do
  kill -0 "$model_pid" 2>/dev/null || fail "fake model server exited during startup"
  if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$model_url/v1/models"; then
    model_up=1
    break
  fi
  sleep 0.2
done
((model_up == 1)) || fail "fake model server did not answer on $model_url within 10s"
node /app/fake-model.mjs check "$model_url" || fail "fake model self-test failed"
phase model-up

# 2. Gateway config for this run (nametags, owner, model provider, open DMs).
node /app/write-config.mjs || fail "could not write the gateway config"
phase configured

# 3. Plugin inspection, metadata and runtime; exit codes (124 = hung) are recorded for the host instead of
#    aborting here.
inspect() {
  local out="$1"
  shift
  local rc=0
  timeout --kill-after=10 120 openclaw plugins inspect "$PLUGIN_ID" --json "$@" >"$out" 2>"$out.stderr" || rc=$?
  printf '%s\n' "$rc" >"$out.rc"
  log "plugins inspect $PLUGIN_ID --json $* -> exit $rc"
}
inspect "$E2E_DIR/inspect.json"
inspect "$E2E_DIR/inspect-runtime.json" --runtime
phase inspected

# 4. Gateway in the foreground; the cap guarantees the container ends even if the host never stops it.
phase gateway-starting
rc=0
timeout --kill-after=15 "$GATEWAY_SECONDS" openclaw gateway run || rc=$?
kill "$model_pid" 2>/dev/null || true
if ((rc == 124)); then
  log "gateway stopped by the ${GATEWAY_SECONDS}s cap"
  exit 0
fi
fail "gateway exited with status $rc"
