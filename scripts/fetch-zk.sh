#!/usr/bin/env bash
# Downloads the Semaphore circuit files of the World ID simulator to scripts/.zk (gitignored).
# The dev World ID mode and scripts/e2e.ts prove with them.
set -euo pipefail
cd "$(dirname "$0")"
COMMIT=ae8e4b807a97cb7a386408e4ba9d2aa2da206c17
BASE="https://raw.githubusercontent.com/worldcoin/simulator/$COMMIT/public/semaphore"
mkdir -p .zk
[ -f .zk/semaphore.wasm ] || curl -fsSL -o .zk/semaphore.wasm "$BASE/semaphore.wasm"
[ -f .zk/semaphore.zkey ] || curl -fsSL -o .zk/semaphore.zkey "$BASE/semaphore.zkey"
shasum -a 256 -c - <<'SUMS'
e20607caef27bc760d50c29daa489bfdccf16bddef31abb0a1c4b7a3a384069d  .zk/semaphore.wasm
00aaa6d8cb426655ef880794a57a6e674b4d244f484d6960fe3430488fbba948  .zk/semaphore.zkey
SUMS
