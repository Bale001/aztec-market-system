#!/usr/bin/env bash
# Launches two PRODUCTION desktop instances for two-party end-to-end testing.
#
# Each gets its own MARKET_INSTANCE partition, so they have separate wallet
# seeds, per-market identities, messaging databases and localStorage -- without
# that they would share one wallet and deadlock on the messaging core's SQLite
# store (see electron/main.cjs).
#
# Production, not dev: no VITE_DEV_SERVER_URL is set, so the renderer is served
# from dist/ over the app:// scheme, exactly as in a packaged build. Run
# `yarn build` first.
#
#   ./scripts/launch-two.sh [instanceA] [instanceB]
#
# Detached with setsid so the instances outlive the launching shell. Logs go to
# /tmp/market-<instance>.log. Stop them with ./scripts/stop-two.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
A="${1:-vendor}"
B="${2:-buyer}"

if [ ! -f "$HERE/dist/index.html" ]; then
  echo "dist/ is missing -- run 'yarn build' in apps/desktop first" >&2
  exit 1
fi

launch() {
  local name="$1"
  echo "launching instance '$name' (log: /tmp/market-$name.log)"
  cd "$HERE"
  MARKET_INSTANCE="$name" setsid nohup npx electron electron/main.cjs --no-sandbox \
    > "/tmp/market-$name.log" 2>&1 < /dev/null &
  disown || true
}

launch "$A"
sleep 5
launch "$B"
sleep 8

echo
echo "running electron processes: $(pgrep -c -f 'electron/main[.]cjs' || echo 0)"
echo "userData partitions under: ~/.config/Aztec Market/instances/{$A,$B}"
