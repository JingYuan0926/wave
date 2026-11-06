#!/usr/bin/env bash
# Sends real frame transactions through the sidecar and checks that they are mined.
# Each run uses one nonce of the genesis key per test wallet.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

cd "$DEVNET_DIR/smoke"
[ -d node_modules ] || npm install --silent --no-audit --no-fund

EL="$RPC_URL" SC="$SIDECAR_URL" EXPLORER="$EXPLORER_URL" node smoke.mjs
