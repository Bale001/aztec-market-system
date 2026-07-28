#!/usr/bin/env bash
# Full CI pipeline: compile -> codegen -> test:nr -> test:js
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$ROOT/scripts/compile.sh"
bash "$ROOT/scripts/codegen.sh"
bash "$ROOT/scripts/test-nr.sh"
. "$HOME/aztec-env.sh"
(cd "$ROOT" && yarn test:js)
echo "ci: all green"
