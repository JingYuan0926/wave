// The demo agent key. Server side only. A real agent would hold its own key.
import { isHex, size, type Address } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { ApiFailure } from './http'

/** Null if WAVE_AGENT_DEMO_KEY is not set. */
export function agentKeyAccount(): PrivateKeyAccount | null {
  const key = process.env.WAVE_AGENT_DEMO_KEY?.trim()
  if (!key) return null
  if (!isHex(key) || size(key) !== 32) {
    throw new ApiFailure('AGENT_KEY_INVALID', 'WAVE_AGENT_DEMO_KEY is not 32 bytes of hex.', 500)
  }
  return privateKeyToAccount(key)
}

export function agentSigner(): Address {
  const account = agentKeyAccount()
  if (!account) throw new ApiFailure('AGENT_KEY_MISSING', 'Set WAVE_AGENT_DEMO_KEY in .env.local, then restart the server.', 503)
  return account.address
}
