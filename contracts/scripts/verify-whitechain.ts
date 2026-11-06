// Verifies the contracts in deployments/whitechain-sepolia.json on the Whitechain Sepolia
// Blockscout explorer, with the exact standard JSON input from the Hardhat build info.
// Blockscout's Etherscan-compatible API needs no key.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const API = 'https://explorer.testnet.whitechain.io/api'

const d = JSON.parse(readFileSync(path.join(ROOT, 'deployments/whitechain-sepolia.json'), 'utf8'))
const infoDir = path.join(ROOT, 'artifacts-wc/build-info')
const infoFile = readdirSync(infoDir).find((f) => f.endsWith('.json') && !f.endsWith('.output.json'))
if (!infoFile) throw new Error('no build info: run the Whitechain build first')
const info = JSON.parse(readFileSync(path.join(infoDir, infoFile), 'utf8'))
const sourceOf = (name: string) =>
  Object.keys(info.input.sources).find((s) => s.endsWith(`whitechain/src/${name}.sol`)) ?? ''

const contracts: [string, string][] = [
  ['WaveTestToken', d.tokens.find((t: { symbol: string }) => t.symbol === 'tUSDT').address],
  ['WavePasskeyValidator', d.passkeyValidator],
  ['WaveAccount4337', d.implementation],
  ['WaveAccount4337Factory', d.factory],
  ['WavePaymaster', d.paymaster],
]

async function verify(name: string, address: string) {
  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    codeformat: 'solidity-standard-json-input',
    contractaddress: address,
    contractname: `${sourceOf(name)}:${name}`,
    compilerversion: `v${info.solcLongVersion}`,
    sourceCode: JSON.stringify(info.input),
    constructorArguements: (d.constructorArgs[address] ?? '0x').slice(2),
  })
  const res = await fetch(API, { method: 'POST', body })
  const j = (await res.json()) as { status: string; message: string; result: string }
  const done = j.status === '1' || /already verified/i.test(`${j.message} ${j.result}`)
  console.log(name.padEnd(24), address, done ? 'submitted' : `FAILED: ${j.message} ${j.result}`)
}

for (const [name, address] of contracts) await verify(name, address)
console.log('Check each one at', `${d.explorer}/address/<address>?tab=contract`)
