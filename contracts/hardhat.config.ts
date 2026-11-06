import { spawn } from 'node:child_process'
import path from 'node:path'
import type { HardhatUserConfig } from 'hardhat/config'
import type { HardhatPlugin } from 'hardhat/types/plugins'
import type { Compiler, CompilerInput, CompilerOutput } from 'hardhat/types/solidity'

// The contracts use EIP-8141 opcodes, which no released solc knows. Run `npm run fetch-solc`.
// Set SOLC to use another path.
const SOLC = process.env.SOLC ?? path.resolve('.solc/solc-eip8141')
const EVM_VERSION = 'osaka+eip8141'

function runSolc(input: CompilerInput): Promise<CompilerOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(SOLC, ['--standard-json'])
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e: Error) => reject(new Error(`could not run ${SOLC}: ${e.message}`)))
    child.on('close', (code: number | null) => {
      if (code !== 0) return reject(new Error(`${SOLC} exited ${code}: ${err.trim()}`))
      try {
        resolve(JSON.parse(out) as CompilerOutput)
      } catch {
        reject(new Error(`${SOLC} gave output that is not JSON: ${out.slice(0, 400)}`))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

// Hardhat does not know the evmVersion "osaka+eip8141", so the value goes in here, on the way
// to the compiler.
const eip8141Compiler: Compiler = {
  version: '0.8.38',
  longVersion: '0.8.38-eip8141.0',
  compilerPath: SOLC,
  isSolcJs: false,
  async compile(input: CompilerInput): Promise<CompilerOutput> {
    input.settings = { ...input.settings, evmVersion: EVM_VERSION }
    return runSolc(input)
  },
}

const eip8141SolcPlugin: HardhatPlugin = {
  id: 'eip8141-solc',
  hookHandlers: {
    solidity: async () => ({
      default: async () => ({
        downloadCompilers: async () => {},
        getCompiler: async () => eip8141Compiler,
      }),
    }),
  },
}

const config: HardhatUserConfig = {
  plugins: [eip8141SolcPlugin],
  paths: { sources: 'src' },
  solidity: { version: '0.8.38', settings: { optimizer: { enabled: true, runs: 200 } } },
}

export default config
