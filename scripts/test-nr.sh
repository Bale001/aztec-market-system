#!/usr/bin/env bash
# Runs Noir tests (TXE) for every Noir package with `aztec test`.
set -euo pipefail
. "$HOME/aztec-env.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The marketplace and order-escrow TXE tests deploy the payment token via
# env.deploy("@token_contract/Token"), which the TXE server resolves to
# <package>/target/token_contract-Token.json. If that file is
# missing the server CRASHES (unhandled ReadStream error) and every
# remaining test fails with "Failed calling external resolver". The payment
# token is cUSDC = the aztec-standards Token (its class matches the deployed
# cUSDC), so ship THAT compiled artifact into place -- not the noir-contracts
# one, whose ABI (transfer_in_private, ...) the marketplace no longer calls.
#
# Removed again on exit: `aztec codegen target` generates a binding for EVERY
# artifact in target/, so leaving it behind makes codegen emit a stray Token
# binding into @market/contract-bindings.
TOKEN_SRC="$ROOT/node_modules/@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json"
TOKEN_ARTIFACTS=(
  "$ROOT/contracts/marketplace/target/token_contract-Token.json"
  "$ROOT/contracts/order-escrow/target/token_contract-Token.json"
)
for artifact in "${TOKEN_ARTIFACTS[@]}"; do
  mkdir -p "$(dirname "$artifact")"
  cp "$TOKEN_SRC" "$artifact"
done

# The marketplace tests need the OrderEscrow artifact too: place_order opens
# this order's escrow, so the TXE has to resolve that contract. The name must be
# PACKAGE-QUALIFIED ("@order_escrow_contract/OrderEscrow") -- a bare
# "OrderEscrow" resolves against the calling package and finds the marketplace's
# own re-export instead.
ESCROW_ARTIFACT="$ROOT/contracts/marketplace/target/order_escrow_contract-OrderEscrow.json"
(cd "$ROOT/contracts/order-escrow" && aztec compile >/dev/null)
cp "$ROOT/contracts/order-escrow/target/order_escrow_contract-OrderEscrow.json" "$ESCROW_ARTIFACT"

# The order-escrow tests also need the TestArbiter fixture artifact in place
# (it stands in for the arbitrating marketplace's public order_states map), so
# compile it first and stage it the same way.
ARBITER_ARTIFACT="$ROOT/contracts/order-escrow/target/test_arbiter_contract-TestArbiter.json"
(cd "$ROOT/contracts/test-arbiter" && aztec compile >/dev/null)
cp "$ROOT/contracts/test-arbiter/target/test_arbiter_contract-TestArbiter.json" "$ARBITER_ARTIFACT"
trap 'rm -f "${TOKEN_ARTIFACTS[@]}" "$ARBITER_ARTIFACT" "$ESCROW_ARTIFACT"' EXIT

for pkg in market-protocol marketplace-registry marketplace order-escrow; do
  echo "=== aztec test: contracts/$pkg ==="
  (cd "$ROOT/contracts/$pkg" && aztec test)
done
echo "test:nr: all Noir tests OK"
