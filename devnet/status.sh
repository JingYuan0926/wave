#!/usr/bin/env bash
# Prints block height and service health. Exits 1 if a check fails.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

failed=0
check() { # check <label> <detail> <command...>
  local label=$1 detail=$2
  shift 2
  if "$@"; then
    printf '  %-12s ok    %s\n' "$label" "$detail"
  else
    printf '  %-12s FAIL  %s\n' "$label" "$detail"
    failed=1
  fi
}

height=$(block_number)
slot=$(head_slot)
peers=$(connected_peers)
timestamp=$(block_timestamp)
hegota=$(hegota_time)
now=$(date +%s)

moving=no
if blocks_advance 15; then moving=yes; fi

hegota_detail="starts at ${hegota:-unknown}"
hegota_on() { [ -n "$timestamp" ] && [ -n "$hegota" ] && [ "$timestamp" -ge "$hegota" ]; }

echo "WAVE devnet ($WAVE_DEVNET_PROJECT)"
check "ethrex"    "$RPC_URL block ${height:-none}, head age $((now - ${timestamp:-$now}))s" [ -n "$height" ]
check "blocks"    "advancing: $moving" [ "$moving" = yes ]
check "beacon"    "slot ${slot:-none}, peers ${peers:-none}" [ "${peers:-0}" -ge 1 ]
check "hegota"    "$hegota_detail" hegota_on
check "registry"  "$REGISTRY_ADDRESS has code" registry_has_code
check "sidecar"   "$SIDECAR_URL" sidecar_ok
check "explorer"  "$EXPLORER_URL" explorer_ok

if [ "$failed" -ne 0 ]; then
  echo "Unhealthy. Run devnet/up.sh to repair it. See 'After the Mac sleeps' in devnet/README.md."
  exit 1
fi
