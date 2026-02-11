#!/usr/bin/env bash
set -euo pipefail

# --- Configuration ---
NAMETAG="${NAMETAG:?NAMETAG env var is required}"
OWNER="${OWNER:-hui-6}"
TIMEOUT="${TIMEOUT:-120}"

echo "[entrypoint] nametag=$NAMETAG owner=$OWNER timeout=${TIMEOUT}s"

# --- Install plugin (before config references it) ---
mkdir -p "$HOME/.openclaw"
cat > "$HOME/.openclaw/openclaw.json" <<EOCFG
{ "gateway": { "mode": "local" } }
EOCFG

echo "[entrypoint] Installing plugin..."
openclaw plugins install /app/*.tgz
echo "[entrypoint] Plugin installed."

# --- Write full config with plugin settings ---
cat > "$HOME/.openclaw/openclaw.json" <<EOCFG
{
  "gateway": { "mode": "local" },
  "plugins": {
    "entries": {
      "openclaw-unicity": {
        "enabled": true,
        "config": {
          "network": "testnet",
          "nametag": "$NAMETAG",
          "owner": "$OWNER"
        }
      }
    }
  }
}
EOCFG

# --- Start gateway and capture output ---
LOGFILE="/tmp/gateway.log"
echo "[entrypoint] Starting gateway..."
OPENCLAW_GATEWAY_TOKEN=e2e-test-token openclaw gateway run 2>&1 | tee "$LOGFILE" &
GATEWAY_PID=$!

# --- Poll log for expected markers ---
STARTED=$(date +%s)

wait_for_line() {
  local pattern="$1"
  local label="$2"
  while true; do
    ELAPSED=$(( $(date +%s) - STARTED ))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "E2E_RESULT:FAIL:Timeout waiting for: $label (${TIMEOUT}s)"
      kill "$GATEWAY_PID" 2>/dev/null || true
      exit 1
    fi
    if grep -qF "$pattern" "$LOGFILE" 2>/dev/null; then
      echo "[entrypoint] Found: $label"
      return 0
    fi
    sleep 2
  done
}

# Wait for identity log line
wait_for_line "[unicity] Identity: $NAMETAG" "Identity line"

# Wait for greeting sent
wait_for_line "[unicity] Greeting sent to @$OWNER" "Greeting sent"

echo "E2E_RESULT:PASS"
kill "$GATEWAY_PID" 2>/dev/null || true
exit 0
