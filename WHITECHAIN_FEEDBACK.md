# Whitechain feedback

What we hit while building WAVE's Whitechain version: an ERC-4337 passkey wallet with
onchain spending rules. Checked on 2026-11-06 against the docs at https://docs.whitechain.io
and Whitechain Sepolia (chain ID 1874).

## What worked well

- **The docs are easy to give to an AI assistant.** `llms.txt`, `llms-full.txt` and the `.md`
  version of every page let our assistant read the whole site in a few fetches.
- **The network reference is exact.** Chain IDs, RPCs, explorers, the faucet limit and the
  hardfork level are on one page. "Use solc 0.8.30 with `evmVersion: prague`" was the right advice
  for both networks.
- **Blockscout's Etherscan-style API works from a browser.** It sends
  `access-control-allow-origin: *`, so our extension reads token transfers and logs without a
  backend.
- **The P-256 precompile is live on Sepolia.** A valid signature to `0x…0100` returns `1`, and a
  changed one returns empty. Passkey verification onchain costs little.

## What was hard to find, or missing

1. **ERC-4337 support is not documented.** The only mention is one line about genesis preinstalls
   in the migration page. We found EntryPoint v0.6 (`0x5FF1…2789`), v0.7 (`0x0000…a032`) and
   v0.8 (`0x4337…f108`) on Sepolia with `eth_getCode`.
   - **Ask:** list the EntryPoint versions and addresses on the network reference page.
   - **Ask:** say whether mainnet kept them.
2. **No bundler or paymaster service.** We found none in the docs, so our server calls
   `handleOps` itself.
   - **Ask:** one public Sepolia bundler endpoint, or a note that there is none. Either would
     save teams time.
3. **P256VERIFY on Sepolia is only implied.** The reference page says Sepolia has no Karst
   repricing of P256VERIFY. It never says the precompile exists. We had to call it to find out.
   - **Ask:** one line stating that the precompile exists and what it costs.
4. **Two "USDT" tokens on Sepolia.**
   - `0xcedf…55a7` is "USDT". Only its owner can mint it (`mint` reverts with "Ownable: caller is
     not the owner"), so builders cannot get it themselves.
   - `0xaa79…6f46` is "USDT.e" from the Portal bridge.
   - **Ask:** say which token builders should use, and how to get some (a faucet or a form).
5. **Foundry on Windows needs WSL.** The deploy guide says this. Our Windows machine had no WSL,
   so we used the Hardhat 3 guide. That guide worked as written.
6. **No ENS or other names.** The Reown page notes this. We accept only 0x addresses for
   recipients.

## Numbers from our tests

- 17 Solidity tests on a local EntryPoint v0.7. Real P-256 WebAuthn signatures and a verifying
  paymaster: all pass.
- An end-to-end run on a local node with chain ID 1874, with EntryPoint v0.7 at its canonical
  address. Faucet, a first payment that deploys the wallet, a second payment, two scheduled
  transfers, one cancel, and one run after the delay: all succeed.
- **Not run on Sepolia yet.** We will add the explorer links here after the first deployment.
