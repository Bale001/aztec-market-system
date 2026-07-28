#!/usr/bin/env bash
# Stops instances launched by launch-two.sh.
#
# The bracket in the pattern is deliberate: it keeps the pattern from matching
# this script's own command line, which would otherwise make pkill kill the
# shell running it.
set -uo pipefail

pkill -f "electron/main[.]cjs" || true
sleep 2
echo "electron processes left: $(pgrep -c -f 'electron/main[.]cjs' || echo 0)"
echo
echo "Instance data is KEPT at ~/.config/Electron/instances/<name>."
echo "To reset one to a first-run state:  rm -rf ~/.config/Electron/instances/<name>"
