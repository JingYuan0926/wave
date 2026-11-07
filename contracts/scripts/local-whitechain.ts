// LOCAL DRY RUN of WAVE on Whitechain. Prepares a local Hardhat node so that
// deploy-whitechain.ts works on it unchanged:
//
//   npx hardhat node --config hardhat.whitechain.config.ts --chain-id 1874 --port 8599
//   WC_RPC_URL=http://127.0.0.1:8599 WC_DEPLOYER_KEY=<hardhat account 0> npx tsx scripts/local-whitechain.ts
//   WC_RPC_URL=http://127.0.0.1:8599 WC_DEPLOYER_KEY=<hardhat account 0> WC_RELAYER_KEY=<hardhat account 1> npm run deploy:wc
//
// It places EntryPoint v0.7 at its canonical address with hardhat_setCode. It refuses any RPC
// that is not on this machine.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createTestClient, createWalletClient, http, type Abi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ENTRY_POINT_V07, whitechainSepolia } from './deploy-whitechain'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RPC = process.env.WC_RPC_URL ?? 'http://127.0.0.1:8599'
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)) throw new Error(`refusing: ${RPC} is not a local node`)

// A funded account of the local node. No key goes in a tracked file, so it comes from the shell.
const LOCAL_KEY = process.env.WC_DEPLOYER_KEY
if (!LOCAL_KEY || !/^0x[0-9a-fA-F]{64}$/.test(LOCAL_KEY)) throw new Error('Set WC_DEPLOYER_KEY to a funded account of the local node')

const { abi, bytecode } = JSON.parse(
  readFileSync(path.join(HERE, '../artifacts-wc/whitechain/src/EntryPointImport.sol/LocalEntryPoint.json'), 'utf8'),
) as { abi: Abi; bytecode: Hex }

const transport = http(RPC)
const chain = { ...whitechainSepolia, rpcUrls: { default: { http: [RPC] } } }
const client = createPublicClient({ chain, transport })
if ((await client.getChainId()) !== 1874) throw new Error('start the node with --chain-id 1874')

if (((await client.getCode({ address: ENTRY_POINT_V07 })) ?? '0x') !== '0x') {
  console.log('EntryPoint v0.7 is already at', ENTRY_POINT_V07)
} else {
  const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(LOCAL_KEY as Hex) })
  const hash = await wallet.deployContract({ abi, bytecode, chain, account: wallet.account, type: 'eip1559' })
  const r = await client.waitForTransactionReceipt({ hash })
  const code = await client.getCode({ address: r.contractAddress! })
  // EntryPoint v0.7 keeps its SenderCreator address as an immutable, so the copied code works.
  await createTestClient({ chain, transport, mode: 'hardhat' }).setCode({ address: ENTRY_POINT_V07, bytecode: code! })
  console.log('EntryPoint v0.7 placed at', ENTRY_POINT_V07)
}
