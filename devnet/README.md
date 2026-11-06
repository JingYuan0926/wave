# WAVE local devnet

This folder runs the full EIP-8141 stack on one machine:

| Service | Address | Job |
|---|---|---|
| ethrex | `http://localhost:8545`, chain 1337 | Execution client |
| Lighthouse (2 beacon nodes, 1 validator client) | `http://localhost:5052` | Consensus, 32 validators, 6 s slots |
| Sidecar | `http://localhost:14337/rpc` | Alternative mempool, patched as below |
| Explorer | `http://localhost:5173` | Shows the sidecar's mempool and transactions |

Deep link for one transaction: `http://localhost:5173/tx/<hash>?node=http://localhost:14337/rpc`.

All ports bind to `127.0.0.1` only. The chain and all keys are local and hold no real value.

## Commands

You need Docker (or OrbStack) and Node.js. The first run downloads about 2 GB of images.

1. Run `devnet/up.sh` to start the stack. A first start takes about 8 minutes.
2. Run `devnet/status.sh` to see the block height and the health of each service.
3. Run `devnet/smoke.sh` to send real frame transactions through the sidecar.
4. Run `devnet/down.sh` to stop the stack and delete the chain.

`up.sh` is idempotent. If the stack is healthy, it only prints the status. If the stack is
stopped or stuck, it repairs the stack and keeps the chain. Only `down.sh` deletes the chain.

`status.sh` exits with code 1 if a check fails, so a script can use it as a health check.

**After `down.sh` every deployed contract is gone.** Run the contract deploy again.

## Timing

- Slot 0 is 60 s after genesis creation.
- Hegota (frame transactions) starts at epoch 2. That is 384 s after slot 0.
- `up.sh` waits for Hegota. Do not send a frame transaction before it returns.

## Files

| File | Job |
|---|---|
| `docker-compose.yml` | All services. Every image is pinned by digest. |
| `genesis.values.env` | Fork schedule, premine, and the registry in genesis. |
| `config/sidecar.json` | Sidecar configuration, with the precompile list. |
| `patches/validationPrefix.js` | The built sidecar file with the one-line patch. Compose mounts it. |
| `patches/validationPrefix.diff` | The same change as a diff, for review. |
| `lib.sh` | Shared settings and helpers. |
| `smoke/` | Test script and its pinned dependencies. |
| `.data/` | Generated chain data. Git ignores it. |

## Sidecar changes, and why each one is safe

The stock sidecar image rejects a World ID validator for two reasons. We make two changes.
This sidecar is local, and a local sidecar is accepted for judging.

### 1. The verify gas budget comes from an env value

```diff
-export const MAX_VERIFY_GAS = BigInt(100000);
+export const MAX_VERIFY_GAS = BigInt(process.env.SKANDHA_MAX_VERIFY_GAS ?? 100000);
```

- **Why:** a Groth16 World ID check costs about 208k gas. The stock limit is 100k for all senders.
  The sidecar has no larger budget for staked senders. A test with a staked sender got the same
  error as an unstaked sender.
- **Value:** `SKANDHA_MAX_VERIFY_GAS=2500000` in `docker-compose.yml`.
- **How:** compose mounts `patches/validationPrefix.js` over the built file. So no image build
  is necessary. The image digest pin keeps the mounted file and the image in step.
- **Why it is safe:** the change only raises a resource limit. All opcode and storage rules still
  apply. Without the env value, the code keeps the stock limit. The alt-mempool team
  (Alex Forshtat) accepted this budget change.

### 2. The precompile list in `config/sidecar.json`

The file adds a `precompiles` list: `0x01` to `0x11` and `0x100`, as full lowercase addresses.

- **Why:** rule COD-010 rejects a call to an address with no code. Precompiles have no code. The
  list tells the sidecar that they are precompiles. The stock default is an empty list, so a
  call to `0x08` fails with
  `payer accesses un-deployed contract address 0x…08 with opcode STATICCALL`.
  World ID needs `0x06`, `0x07` and `0x08`. Passkeys need `0x02` and `0x100`.
- **How:** this is a configuration value. It needs no code change.
- **Why it is safe:** the list matches rule CALLING-040 of ERC-8421. That rule allows
  "the core precompiles 0x01 to 0x11 and the P256VERIFY precompile". `0x100` is P256VERIFY here.
  The empty default is stricter than the rule. The list holds only those addresses, so no other
  address gets an exception.

### Other values in `config/sidecar.json`

- `stakingRegistryAddress` is `0x0000000000000000000000000000000000008421`, the address of the
  registry in `genesis.values.env`. Do not put the registry at `0xe8bd…4b88`. That address is the
  first CREATE address of the genesis key, so the first deploy from that key reverts.
- `relayers` holds the public genesis key. The bundler signs with it.

## Differences from the sidecar repo's `deploy/devnet`

Source: `forshtat/mempool-workshop-sidecar` at commit `2e22ff0`.

| Change | Reason |
|---|---|
| All images are pinned by digest | Tags such as `latest` and `focil` can move. |
| `GENESIS_DELAY` is 60, not 300 | A local start needs no long delay. |
| The registry is in genesis, not deployed | The sidecar answers `Internal error` until the registry has code. A genesis entry removes that step and keeps the address fixed. |
| Fixed subnet `10.181.37.0/24`, fixed beacon IP `.100` | Docker subnets differ per machine. The ENR holds the IP, so the IP must not change on restart. |
| `up.sh` reads the ENR through a published port | The stock steps call the container IP, which macOS cannot reach. So port 5052 is open on localhost. |
| `genesis` and `validator-keys` use the `init` profile | They fail when their output exists. A profile keeps them out of a normal `up`. |
| `--enable-private-discovery` on the beacon nodes | The nodes must find each other again on a private subnet after a restart. |
| `restart: unless-stopped`, log size limits | See below. A full disk from logs stopped the public devnet once. |
| Port 30303 is not published | The chain has no execution peers. |
| Sidecar and explorer are compose services | One command starts everything. |

## After the Mac sleeps

Run `devnet/up.sh` when the Mac wakes. It keeps the chain, and it takes about 30 s.

- All long-running containers use `restart: unless-stopped`. After a Mac restart, they start
  again when OrbStack starts. `up.sh` starts OrbStack if it is not running.
- When the containers wake, the chain fills the gap with empty slots and continues by itself.
  A test froze the stack with `docker compose pause` for 27 minutes. Blocks advanced again after
  15 s, and frame transactions were mined.
- **The problem:** the two beacon nodes do not connect again after that freeze. The chain still
  advances, but it depends on one node that reports `is_syncing: true`. `status.sh` shows
  `beacon FAIL`, with `peers 0`.
- **The fix:** `up.sh` restarts the three consensus containers. The peer returned in 5 s.
- `docker compose pause` is not the same as a real sleep. The test did not put a Mac to sleep.

Only if `up.sh` cannot repair the stack, run `devnet/down.sh`, then `devnet/up.sh`. That deletes
the chain, so you must deploy the contracts again.

## Traps

- **Base fee.** The base fee starts near 1 gwei and then falls. A transaction with a fee of
  0.002 gwei stays pending in the first blocks. Use 5 gwei for legacy transactions.
- **Direct send.** `eth_sendRawTransaction` rejects a frame transaction above the public verify
  limit with `Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`.
  Send it through the sidecar. `ethrex_simulateFrameTransaction` can report
  `canonicalMempoolValid: false` for such a transaction. This is expected.
- **Images run under emulation.** The ethrex and sidecar images exist for amd64 only. On Apple
  silicon they run under emulation, and this works.
- **Second stack.** Set `WAVE_DEVNET_PROJECT`, `WAVE_DEVNET_DATA`, `WAVE_DEVNET_SUBNET` and the
  `WAVE_*_PORT` values to run a second stack beside the first. See `lib.sh`.
- **Subnet conflict.** If Docker reports a pool overlap, set `WAVE_DEVNET_SUBNET` to a free
  `a.b.c` prefix, for example `10.181.99`.
