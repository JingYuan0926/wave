# Shared settings and helpers for up.sh, down.sh, status.sh and smoke.sh.
# This file is sourced. Do not run it.
# Keep this file compatible with the bash 3.2 that ships with macOS.

DEVNET_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The defaults are the addresses that the WAVE app expects. Override them only
# to run a second stack next to the first one.
export WAVE_DEVNET_PROJECT=${WAVE_DEVNET_PROJECT:-wave-devnet}
export WAVE_DEVNET_DATA=${WAVE_DEVNET_DATA:-$DEVNET_DIR/.data}
export WAVE_DEVNET_SUBNET=${WAVE_DEVNET_SUBNET:-10.181.37}
export WAVE_RPC_PORT=${WAVE_RPC_PORT:-8545}
export WAVE_SIDECAR_PORT=${WAVE_SIDECAR_PORT:-14337}
export WAVE_EXPLORER_PORT=${WAVE_EXPLORER_PORT:-5173}
export WAVE_BEACON_PORT=${WAVE_BEACON_PORT:-5052}

RPC_URL="http://localhost:$WAVE_RPC_PORT"
SIDECAR_URL="http://localhost:$WAVE_SIDECAR_PORT/rpc"
EXPLORER_URL="http://localhost:$WAVE_EXPLORER_PORT"
BEACON_URL="http://localhost:$WAVE_BEACON_PORT"

REGISTRY_ADDRESS=0x0000000000000000000000000000000000008421
INIT_MARKER="$WAVE_DEVNET_DATA/.init-done"
ENR_FILE="$WAVE_DEVNET_DATA/lighthouse-beacon.enr"

# Compose must see the same ENR at every call, or it recreates lighthouse-beacon-2.
if [ -f "$ENR_FILE" ]; then
  LIGHTHOUSE_BEACON_1_ENR=$(cat "$ENR_FILE")
  export LIGHTHOUSE_BEACON_1_ENR
fi

log() { printf '[devnet] %s\n' "$*"; }
die() { printf '[devnet] ERROR: %s\n' "$*" >&2; exit 1; }

compose() { docker compose -f "$DEVNET_DIR/docker-compose.yml" "$@"; }

# rpc <url> <method> [json params]: prints the raw JSON reply, or nothing.
rpc() {
  curl -s --max-time 5 -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1" 2>/dev/null
}

# hex_result: reads a JSON-RPC reply on stdin, prints the hex result as decimal.
hex_result() {
  local hex
  hex=$(sed -n 's/.*"result":"0x\([0-9a-fA-F]*\)".*/\1/p')
  [ -n "$hex" ] && printf '%d\n' "0x$hex"
}

block_number() { rpc "$RPC_URL" eth_blockNumber | hex_result; }

# Prints the timestamp of the head block.
block_timestamp() {
  local hex
  hex=$(rpc "$RPC_URL" eth_getBlockByNumber '["latest",false]' |
    sed -n 's/.*"timestamp":"0x\([0-9a-fA-F]*\)".*/\1/p')
  [ -n "$hex" ] && printf '%d\n' "0x$hex"
}

head_slot() {
  curl -s --max-time 5 "$BEACON_URL/eth/v1/beacon/headers/head" 2>/dev/null |
    sed -n 's/.*"slot":"\([0-9]*\)".*/\1/p'
}

connected_peers() {
  curl -s --max-time 5 "$BEACON_URL/eth/v1/node/peer_count" 2>/dev/null |
    sed -n 's/.*"connected":"\([0-9]*\)".*/\1/p'
}

# Prints the time when frame transactions start. ethrex calls Hegota "bogota".
hegota_time() {
  grep -o '"bogotaTime": *[0-9]*' "$WAVE_DEVNET_DATA/genesis/metadata/genesis.json" 2>/dev/null |
    grep -o '[0-9]*$'
}

registry_has_code() {
  rpc "$RPC_URL" eth_getCode "[\"$REGISTRY_ADDRESS\",\"latest\"]" | grep -q '"result":"0x[0-9a-fA-F]'
}

sidecar_ok() { rpc "$SIDECAR_URL" skandha_config | grep -q '"result":'; }

explorer_ok() { curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$EXPLORER_URL/" 2>/dev/null | grep -q '^200$'; }

# Tests if the chain moves. Waits up to $1 seconds for a new block.
blocks_advance() {
  local start now waited=0
  start=$(block_number)
  [ -n "$start" ] || return 1
  while [ "$waited" -lt "$1" ]; do
    sleep 3
    waited=$((waited + 3))
    now=$(block_number)
    if [ -n "$now" ] && [ "$now" -gt "$start" ]; then
      return 0
    fi
  done
  return 1
}

# wait_for <description> <seconds> <command...>
wait_for() {
  local what=$1 limit=$2 waited=0
  shift 2
  while ! "$@"; do
    if [ "$waited" -ge "$limit" ]; then
      die "timeout after ${limit}s: $what. See 'docker compose -p $WAVE_DEVNET_PROJECT logs'."
    fi
    sleep 3
    waited=$((waited + 3))
  done
  log "ok: $what (${waited}s)"
}
