import type { HardhatUserConfig } from 'hardhat/config'

// WAVE on Whitechain: ERC-4337 contracts built with stock solc. Whitechain runs Prague, and its
// docs name 0.8.30 with evmVersion "prague" as the target that works on mainnet and Sepolia.
// The EIP-8141 build is hardhat.config.ts. This one compiles only whitechain/src and what it
// imports (WavePolicy has no frame opcodes).
//
//   npx hardhat build --no-tests --config hardhat.whitechain.config.ts
// The tests run with forge: FOUNDRY_CONFIG=foundry.whitechain.toml forge test
const config: HardhatUserConfig = {
  paths: {
    sources: 'whitechain/src',
    artifacts: 'artifacts-wc',
    cache: 'cache-wc',
  },
  solidity: {
    version: '0.8.30',
    settings: { evmVersion: 'prague', optimizer: { enabled: true, runs: 200 }, viaIR: false },
  },
  networks: {
    whitechainSepolia: {
      type: 'http',
      chainType: 'op',
      url: 'https://rpc.testnet.whitechain.io',
      chainId: 1874,
    },
  },
}

export default config
