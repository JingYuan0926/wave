#!/usr/bin/env bash
# Downloads the EIP-8141 fork of solc for macOS arm64 and checks its hash.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=.solc/solc-eip8141
SHA=f4e964e68aca8f9ecb94a9f0a2e4d08fbf074f11861b222c2d68fa27234a8051
URL=https://github.com/chiranjeev13/solidity/releases/download/v0.8.38-eip8141.0/solc-eip8141-macos-arm64
mkdir -p .solc
[ -x "$BIN" ] || { curl -fsSL -o "$BIN" "$URL"; chmod +x "$BIN"; }
echo "$SHA  $BIN" | shasum -a 256 -c -
