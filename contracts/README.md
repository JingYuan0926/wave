# WAVE contracts

| File | Job |
|---|---|
| `src/WaveAccount.sol` | The account. Contract route. `verify`, six SENDER entry points, configuration through the queue. |
| `src/WavePolicy.sol` | Tiers, period counters, queue, recovery, config version. It has no frame opcodes. |
| `src/WorldIDFrameValidator.sol` | World ID 3.0 proof over sig_hash, with a recent-root reference. |
| `src/PasskeyFrameValidator.sol` | WebAuthn P-256 assertion over sig_hash. One instance per slot. It can be the owner method: the key is then in the clone config, and a recovery writes a new key to storage. |
| `src/AgentKeyFrameValidator.sol` | secp256k1 signature over sig_hash, for agent wallets only. It is method bit 6. A main wallet cannot install it. |
| `src/WaveAccountFactory.sol` | CREATE2 clones with the configuration in code. Main wallets and agent wallets use the same factory. It calls `setup` in the deploy call, so a wallet with extra methods never exists without them. |
| `src/SemaphoreVerifier.sol` | World's Groth16 verifier, unchanged apart from one import path. |
| `src/RecentRootRead.yul` | Runs RECENTROOTREFLOAD. The solc fork has no builtin for it. |
| `src/WaveGasStation.sol` | The local gas sponsor. An EIP-8141 paymaster that needs the sponsor key's signature. Local network only. |
| `src/TestUSDC.sol` | Local test token. Not real USDC. Open mint. |

## Commands

Run these in `contracts/`. The devnet must run first.

1. Run `npm install`.
2. Run `npm run fetch-solc` to get the EIP-8141 fork of solc (macOS arm64).
3. Run `npm run compile`.
4. Run `npm run export-abi` to write `../lib/wave-abi.ts`.
5. Run `npm run deploy` to deploy and write `deployments/local.json`. Each run deploys new addresses. On the local network, it also deploys the gas station and funds it with 100 ETH from the dev key.
6. Run `forge test` for the policy unit tests. Forge cannot build frame opcodes, so it builds only `WavePolicy.sol`, with stock solc.

Run the end-to-end cases from the repo root:

1. Run `scripts/fetch-zk.sh` once.
2. Run `npx tsx scripts/e2e.ts`. It takes about 20 minutes, because it waits for real blocks and delays.
3. Run `npx tsx scripts/unit.ts` for the checks that need no chain. It takes a few seconds.

## Rule choices

- `methods`: bit 0 is the owner method. Bit N is passkey slot N. Bit 7 marks a small tier.
- The clone args name the owner method. It is World ID or a passkey validator. `_ownerValidator()` returns it, and every owner-only rule checks it.
- `demoDelay` in the clone args is the wait. 0 means real delays. `NO_WAIT` (`0xffffffff`) means no wait. Another value caps the config, loosen, other-call and recovery delays through `effectiveDelay`. A tier delay never goes through `effectiveDelay`.
- `setup` installs the extra methods and first rules. The clone args hold the hash of its bytes (155 bytes in all). It runs once, and no SENDER frame can reach it.
- `setOwnerKey` is the recovery of an owner passkey. `setOwner` and `setRootSource` revert `WrongOwnerKind` on a wallet with a passkey owner, and `setOwnerKey` reverts on a World ID wallet.
- A listed token is ETH, `defaultToken`, or a token with tiers. Other tokens are sensitive calls.
- A plain transfer counts against the cap when it runs, or at `schedule` if it is delayed. A cancel gives no refund.
- `dailyLimit` is one hard total per token. All methods and all tiers share one counter and one 24 hour window. `_checkTransfer` tests it first, so `DailyLimitReached` comes before any tier choice. 0 means no limit. `tighten` can add or lower it. `setTiers` can set any value, so a caller must send the current limit to keep it. `setup` can set it. `agentSetup`, `agentTighten` and `agentSetTiers` do not touch it.
- A tighten does not change the config version. A queued transfer of that token fails with `RuleChanged`. Other queued actions continue.
- The recovery proposal counts as the first approval.
- A call with target 0 is a self-call, because `ERC7579Utils` runs it as one. `execute` reverts `SelfCall`. `schedule` reverts `NotSchedulable`. A recovery reverts `BadRecovery`.
- `verify` rejects a transaction above `MAX_FEE_PER_GAS` (50 gwei) or `MAX_TX_COST` (0.05 ETH) with `FeeTooHigh`. It reads `TXPARAM(0x04)` and `TXPARAM(0x06)`, which hold these values on the ethrex devnet. The newer EIP text gives `0x04` another meaning and has no `0x06`.

## Agent wallets

An agent wallet is the same `WaveAccount` from the same factory. Its clone args end with 20 `master` bytes (143 bytes in all). A main wallet has 123 bytes, so its `master` reads as zero. The factory requires a nonzero master and owner 0 on an agent wallet.

- The agent wallet has no owner method and no recovery. `isValidatorInstalled` is false for the clone validator there.
- The agent spends through the normal tiers. A token with no tiers stays denied.
- Administration uses the `IWaveAgent` functions, and each one needs `msg.sender == master`.

The main wallet classifies a call to its own agent wallet in `WavePolicy._agentClass`:

| Call | Who can approve | Delay |
|---|---|---|
| `agentSetup`, once, with the key and the first rules | The owner method | None |
| `agentRevoke`, `agentPause`, `agentTighten`, `agentWithdraw` | Any enrolled method | None |
| `agentUnpause`, `agentSetTiers`, `agentSetKey` | The owner method, through `schedule` | 48 hours, or the chosen wait |

- The exception needs more than the selector. `isAgentClone` reads the code of the target. The code must be a clone of this implementation that names this wallet as master.
- Each other call to an agent wallet follows the normal rules. Plain funding follows the spending rules.
- `agentSetup` emits `AgentLinked(agent)` on the main wallet. That event is the record of children. Anyone can deploy a clone that names a master, but only the main wallet can emit this event.
- `agentWithdraw` can pay only the master.
- A revoke bumps the agent wallet's config version, so its queued transfers fail. A pause stops validation and `executeScheduled`.
- An agent wallet cannot have agent wallets. `_isOwnAgent` is false there.
