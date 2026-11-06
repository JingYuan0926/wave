#!/usr/bin/env bash
# Starts the local devnet from nothing, or repairs a running one.
# You can run this script again at any time. It does not reset the chain.
# A first start takes about 8 minutes: frame transactions start at epoch 2.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_docker() {
  docker info >/dev/null 2>&1 && return 0
  command -v orb >/dev/null 2>&1 || die "Docker is not running. Start it and run up.sh again."
  log "starting OrbStack"
  orb start >/dev/null
  wait_for "Docker is ready" 60 sh -c 'docker info >/dev/null 2>&1'
}

# Stops with a clear error if another program holds a port that we need.
check_port() {
  local owner
  owner=$(docker ps --filter "publish=$1" --format '{{.Label "com.docker.compose.project"}}|{{.Names}}' | head -1)
  case "$owner" in
    "$WAVE_DEVNET_PROJECT|"*) return 0 ;;
    "") ;;
    *) die "port $1 is in use by container ${owner#*|}. Stop that container and run up.sh again." ;;
  esac
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $1 is in use: $(lsof -nP -iTCP:"$1" -sTCP:LISTEN | tail -1)"
  fi
}

peers_connected() { [ "$(connected_peers)" -ge 1 ] 2>/dev/null; }
have_first_block() { [ "$(block_number)" -ge 1 ] 2>/dev/null; }

stack_healthy() {
  [ -f "$INIT_MARKER" ] && peers_connected && blocks_advance 15 &&
    registry_has_code && sidecar_ok && explorer_ok
}

init_chain() {
  log "no finished genesis found: creating a new chain"
  compose --profile init down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WAVE_DEVNET_DATA"
  mkdir -p "$WAVE_DEVNET_DATA/genesis" "$WAVE_DEVNET_DATA/validator-keys"

  # Pull first. A pull that runs after genesis uses up the genesis delay.
  # A failed pull is not an error here: local images work without a network.
  compose --profile init pull --quiet --ignore-pull-failures

  GENESIS_TIMESTAMP=$(date +%s)
  export GENESIS_TIMESTAMP
  compose run --rm --no-deps genesis
  compose run --rm --no-deps validator-keys
  mkdir -p "$WAVE_DEVNET_DATA/lighthouse-validator"
  date +%s >"$INIT_MARKER"
}

# lighthouse-beacon-2 needs the ENR of lighthouse-beacon before it starts.
fetch_enr() {
  local enr
  enr=$(curl -s --max-time 5 "$BEACON_URL/eth/v1/node/identity" 2>/dev/null |
    sed -n 's/.*"enr":"\(enr:[^"]*\)".*/\1/p')
  [ -n "$enr" ] || return 1
  printf '%s\n' "$enr" >"$ENR_FILE"
}

hegota_active() {
  local now start
  now=$(block_timestamp)
  start=$(hegota_time)
  [ -n "$now" ] && [ -n "$start" ] && [ "$now" -ge "$start" ]
}

start_docker

for port in "$WAVE_RPC_PORT" "$WAVE_SIDECAR_PORT" "$WAVE_EXPLORER_PORT" "$WAVE_BEACON_PORT"; do
  check_port "$port"
done

if stack_healthy; then
  log "the stack is already healthy"
  exec "$DEVNET_DIR/status.sh"
fi

# Only a finished init leaves the marker. A failed init starts again from zero.
[ -f "$INIT_MARKER" ] || init_chain

if [ ! -f "$ENR_FILE" ]; then
  compose up -d --no-deps ethrex lighthouse-beacon
  wait_for "lighthouse-beacon API and ENR" 120 fetch_enr
  LIGHTHOUSE_BEACON_1_ENR=$(cat "$ENR_FILE")
  export LIGHTHOUSE_BEACON_1_ENR
fi

compose up -d

# After a long sleep the beacon nodes lose their peer and do not find it again.
# A restart of the consensus containers fixes this and keeps the chain.
# See "After the Mac sleeps" in README.md.
if have_first_block && { ! blocks_advance 20 || ! peers_connected; }; then
  log "the chain is stuck or has no peer: restarting the consensus containers"
  compose restart lighthouse-beacon lighthouse-beacon-2 lighthouse-validator
fi

wait_for "beacon nodes are peered" 180 peers_connected
wait_for "first block" 240 have_first_block
wait_for "registry has code" 30 registry_has_code
wait_for "sidecar answers" 120 sidecar_ok
wait_for "explorer answers" 120 explorer_ok
log "waiting for Hegota: frame transactions start 384 s after genesis"
wait_for "Hegota is active" 600 hegota_active
wait_for "blocks advance" 60 blocks_advance 30

exec "$DEVNET_DIR/status.sh"
