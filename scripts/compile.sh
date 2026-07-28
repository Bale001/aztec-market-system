#!/usr/bin/env bash
# Compiles every contract package with `aztec compile` (never bare nargo).
set -euo pipefail
. "$HOME/aztec-env.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for pkg in marketplace-registry marketplace test-arbiter order-escrow; do
  echo "=== aztec compile: contracts/$pkg ==="
  (cd "$ROOT/contracts/$pkg" && aztec compile)
done

echo "compile: all contracts OK"
