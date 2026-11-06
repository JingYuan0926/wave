#!/usr/bin/env bash
# Stops the local devnet and removes all chain data.
# The next up.sh creates a new chain, so every deployed contract is gone.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

docker info >/dev/null 2>&1 || die "Docker is not running."

compose --profile init down --remove-orphans --volumes

case "$WAVE_DEVNET_DATA" in
  "" | /) die "unsafe data path: '$WAVE_DEVNET_DATA'" ;;
esac
rm -rf "$WAVE_DEVNET_DATA"

log "stopped, and removed $WAVE_DEVNET_DATA"
