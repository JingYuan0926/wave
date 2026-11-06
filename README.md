# WAVE

**Wallet Authorization & Verified Execution**

*Your identity. Your wallet. Your rules.*

**A wallet you create and approve with World ID, with no seed phrase and no separate EOA
signing key.** Add passkeys in Settings. The account enforces permissions and delays onchain.
NFC signing cards come later.

Built at ETHGlobal Mumbai 2026 on EIP-8141 frame transactions, ERC-8286 frame validators,
EIP-8250 keyed nonces and EIP-8272 recent roots.

> **Status: a working prototype on a local stack.** Every test ran on a local chain with a
> local sidecar. No real World ID scan has run yet. No real Face ID or Touch ID has run yet.
> The gas sponsor runs on the local network only. Agent wallets and World ID Agent Pass are built
> but not tested. A claim is proven only when its item in [Build status](#build-status) is checked.
> Not audited.

**What the name means:** the account first checks **authorization**: does the owner's rule allow
this method for this action? Then it **verifies** the World ID proof or the passkey assertion.
Only then does it permit **execution** of the requested calls, under the owner's limits, delays
and cancel rules. "Verified Execution" does not mean a separate cryptographic proof of execution.

---

## The problem

1. **A leaked key gives no warning.** A private key or seed phrase can leak without any sign.
   You learn that it leaked only when the attacker spends your funds.
2. **A device does not remove every path.** A hardware wallet keeps the key inside the device.
   But a seed-phrase backup can still be phished, photographed or copied.
   <!-- TODO: add a sourced link to the incident you mean, or delete this item. -->
3. **One key is all the power.** Whoever has the key can move everything, at once, with no
   delay and no second check.
4. **People are afraid of keys.** New users and merchants do not want to store a seed phrase.

## The idea

1. **No seed phrase and no separate EOA signing key.** At creation, the account's only validator
   is a World ID check. World ID still uses cryptographic secrets. World App on the owner's phone
   holds them, and the owner never manages them as a seed phrase.
2. **Mix and match.** In Settings, the owner can add passkeys (Face ID, Touch ID or a security
   key). NFC signing cards come later. These methods bring their own keys, held in the device or
   in the card. The owner chooses which method approves which action.
3. **Owner-set limits.** The owner sets amount limits per method. For example, Face ID approves
   transfers under 100 USDC, and World ID approves 100 USDC or more. The owner also sets time
   limits: a delay for each tier, and totals per day or per week.
4. **A cancellation window.** Sensitive actions are scheduled first and run only after a delay.
   Enrolled methods can cancel them, under the cancel rules below. Spending under the daily limit
   stays immediate.
5. **Wallets for your agents (built, not tested).** Create a separate WAVE wallet for each agent.
   Give each one its own balance and spending limits. Your main WAVE wallet is its master.

## How it works

### Standards we use

| Standard | What it gives us |
|---|---|
| [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) Frame transactions | Native account abstraction. The account's own code decides if a transaction is valid, in a `VERIFY` frame, and calls `APPROVE`. |
| [ERC-8286](https://eips.ethereum.org/EIPS/eip-8286) Modular accounts for frame transactions | ERC-7579 "frame validator" modules (module type `11`). We write one validator per method. |
| [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) Keyed nonces | Independent nonce domains. **Our account's convention**, taken from ERC-8286 and its playground: `nonce_keys[0]` holds the validator address. The account reads it with `TXPARAM(0x10)`. |
| [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272) Recent roots | Proves that a root was recently published under a given source. On this chain it is an **envelope field**, not a `VERIFY` frame. It does **not** prove that the root is authentic. |
| World ID 3.0 onchain proofs | A zero-knowledge proof that the account's owner, a unique human, approved this exact transaction. |

### Chain facts

Chain 1337 runs an early revision of these EIPs. Its addresses differ from the EIP texts. The
addresses in the EIP texts have no code here.

| Contract | Address on chain 1337 |
|---|---|
| Nonce manager (EIP-8250) | `0x0000000000000000000000000000000000008250` |
| Recent roots (EIP-8272) | `0x0000000000000000000000000000000000008272` |
| Expiry verifier (EIP-8141) | `0x0000000000000000000000000000000000008141` |

The frame transaction has this wire format:

```
0x06 || rlp([chainId, nonceKeys, nonceSeq, sender, frames, signatures,
             [maxPriorityFee, maxFee, maxBlobFee], blobHashes, recentRootReferences])
```

`deploy.ts` writes the WAVE contract addresses to `contracts/deployments/local.json`. Each deploy
makes new addresses.

### World ID version

We target **World ID 3.0 (legacy) onchain proofs**. We deploy World's Groth16 verifier on our
chain and call it directly:

```solidity
verifyProof(uint256[8] proof, uint256[4] input)
// input = [root, nullifierHash, signalHash, externalNullifierHash]
```

- The source is `src/SemaphoreVerifier.sol` in `worldcoin/world-id-contracts`.
- The function returns nothing. It reverts on a bad proof, so the validator uses `try/catch`.
- It costs about 208k gas. It calls the precompiles `0x06`, `0x07` and `0x08`.
- The onchain 3.0 path is Orb-only. IDKit's `orbLegacy` preset asks for that credential.
- This verifier has no `groupId` argument. The published root selects the tree.
- **Signal:** `signalHash = uint256(keccak256(abi.encodePacked(sigHash))) >> 8`. The app passes
  `orbLegacy({ signal: sigHashHex })` with the `0x` prefix, and sets `allow_legacy_proofs: true`.
- **External nullifier:** `hashToField(packed(hashToField(app_id), action))`. The action is
  `wave-approve`.
- World ID 4.0 uses a different proof and a different verifier interface. This design does not
  use 4.0.
- The design compares one fixed owner nullifier, scoped to our app and action. That matches 3.0
  semantics. Do not confuse it with how 4.0 handles nullifiers.
- World's Mumbai prize page notes mocked proofs, but only under the Agent Pass track. That note
  does not cover IDKit, and it does not confirm that 3.0 test proofs are available.
- **We must show that an official test credential produces a transaction-bound 3.0 proof, and
  that our verifier accepts it on the devnet.** Until then, this part is unproven. See
  [World ID modes](#world-id-modes).

### Account creation

We follow the account and factory pattern of the
[ERC-8286 playground](https://github.com/chiranjeev13/erc8286-playground). Its
`SphincsFrameValidator` already shows an account with no ECDSA key (it uses a post-quantum key).
We replace that key with a World ID check.

```
args     = validator || approvalScopes || modeBits || executionRoute || demoDelay || initData
initData = ownerNullifierHash || externalNullifierHash || rootSourceId      (initial values)
salt     = keccak256(ownerNullifierHash)
account  = CREATE2(factory, salt, clone code || args)
```

- `ownerNullifierHash` is the owner's anonymous World ID 3.0 nullifier for our app and action.
  The same human gets the same value every time for the same action.
- The address commits to the validator and the initial owner. Nobody can deploy this address
  with a different owner.
- `demoDelay` (uint32) caps every delay, for the demo. Zero means real delays. The default is 120
  seconds. The address commits to it, and the app shows "Demo delay: 2 minutes (real: 48 hours)".
- **Initial values sit in the clone code. Changes go to storage and override them**, the same way
  the playground's getters read storage first and fall back to code. This covers the owner
  nullifier, the root source, the methods and the limits. Every change goes through the delay
  queue, except a stricter rule.
- On the public devnet, the account deploys itself in the first frame of its own first
  transaction (a `DEFAULT` frame that calls the factory). It must hold ETH before that transaction.
- On the local network, the gas sponsor deploys the account with a plain transaction. See
  [Gas sponsor](#gas-sponsor-local-network-only).

### Gas sponsor (local network only)

**With `WAVE_NETWORK=local`, every WAVE transaction is gasless for every wallet, with no setting.**
With `WAVE_NETWORK=devnet` there is no sponsor, and each wallet pays its own gas.

```
frame[0]  VERIFY  target = account          scope = execution    the method approves
frame[1]  VERIFY  target = WaveGasStation   scope = payment      calls pay()
frame[2+] SENDER  target = account

signatures = [ ARBITRARY entry with the witness, SECP256K1 entry from the sponsor key ]
```

- `WaveGasStation` pays when entry 1 is a `SECP256K1` signature over `sig_hash` from its immutable
  sponsor address. It reads no storage, so it needs no foreign read in validation.
- The server holds the sponsor key. Before it signs, it checks the frame order, the wallet code, a
  fee cap (10 gwei per gas, 0.05 ETH per transaction) and a budget per wallet per day
  (`WAVE_SPONSOR_DAILY_TX`, default 50).
- **The chain does not enforce these limits.** The budget lives in server memory, so a server
  restart clears it. The local sponsor key is derivable, and anyone who has it can spend the
  station balance. This design is for a local network only.
- The sponsor deploys a wallet at its first `tx/prepare`, because a deploy frame does not fit the
  500,000 state gas limit of the prefix when the gas station pays. The wallet needs no ETH.
- The account's fee limits and all rule checks stay the same.
- The Fund button gives test tokens. A wallet needs them only to have something to send.

### One transaction, step by step (canonical-hash path)

> This section and the validator below follow the **canonical-hash path**. They depend on root
> option 1 in [The root dependency](#the-root-dependency).

```
frame[0]  DEFAULT  target = factory   createAccount      first transaction only
frame[n]  VERIFY   target = account   data = index of the proof entry
frame[n+1] SENDER  target = account (contract-dispatched route), calls one of six selectors

nonce_keys[0]          = address of the validator          (our convention)
signatures             = [ ARBITRARY entry, empty msg, witness ]
recent_root_references = [ (source_id, slot, root) ]       (envelope field, World ID only)
```

This is the shape of a self-paid transaction. The World ID witness is
`root || nullifierHash || proof`, 320 bytes. The passkey witness is 512 bytes.

1. Get the World ID root that the proof will use. See [The root dependency](#the-root-dependency).
2. Build the transaction with a recent-root reference for that root.
3. Put a **placeholder of the exact final witness length** into the `ARBITRARY` entry.
4. Compute `sig_hash` (`TXPARAM(0x08)`). The EIP-8141 text leaves out the bytes of an empty-`msg`
   entry, but it **commits to their length**. Ethrex on chain 1337 leaves out the length too. A
   fixed length works under both rules.
5. Show the decoded transaction to the owner, before the app asks World App for a proof.
6. World App makes a World ID proof with `signal = sig_hash`.
7. If the proof returns another root, go back to step 2 with that root, and scan again.
8. Replace the placeholder with the real witness of the same length. `sig_hash` does not change.
9. Simulate with `ethrex_simulateFrameTransaction`. Stop if the validation prefix fails.
10. Send with `eth_sendFrameTransaction` to the sidecar. The sidecar bundles every 10 seconds.

A failed `VERIFY` frame makes the transaction invalid, so nothing is mined. A failed `SENDER`
frame mines with status `0x0`. That transaction spends gas and moves the nonce.

### The root dependency

The root reference is part of `sig_hash`. The proof must use the same root.

- If World's prover returns a proof for a different root, we must rebuild the reference.
- Rebuilding the reference changes `sig_hash`, so the proof no longer matches the transaction.

**We chose option 1, with a root hint.** IDKit has no setting that pins a root. So the app keeps
the last root it saw, and it uses that root as its guess:

1. The server publishes the hint root under the pinned source (`POST /api/root/publish`).
2. The transaction references that root.
3. If the proof returns another `merkle_root`, the server publishes that root. The app rebuilds
   the transaction and asks for one more scan. The UI says "World's root changed. Scan again."
4. The app keeps the last `merkle_root` as the hint for the next transaction.
5. The first hint is the creation scan's `merkle_root`. If that is missing, the server reads
   `latestRoot()` on World Chain. In staging, it reads World Chain Sepolia.
6. The server publishes a root again after 8000 slots, before the 8191-slot limit.

**Trade-off:** a root change costs the owner a second scan. We do not yet know how often a real
scan hits this.

**The option we did not build:** bind the proof to a custom digest that leaves out only the root
reference. The validator then checks that the reference's root equals the root inside the proof.

- The proof then no longer approves the full canonical `sig_hash`.
- This path needs its own exact commitment definition. The digest must still bind the root
  source, the root's freshness, the fees, every action, the nonce keys and the chain ID.
- EIP-8141 warns that custom hashes need careful transaction binding.
- It also costs more gas, because the validator must rebuild the digest from introspection data.

### The World ID validator (canonical-hash path)

```solidity
// Shortened from contracts/src/WorldIDFrameValidator.sol. World ID 3.0 style.
// Runs by DELEGATECALL in the account's context, inside a VERIFY frame.
function validateFrame(bytes calldata data) external view returns (uint8) {
    if (!LibERC8286.isTargetedFrame()) return APPROVE_NONE;

    (uint256 owner, uint256 ext, bytes32 source) = LibWaveIdentity.read(); // storage, else clone args
    bytes memory w = LibWitness.witness(data);                             // SIGPARAM / SIGDATACOPY
    if (w.length != WITNESS_LEN) return APPROVE_NONE;
    (uint256 root, uint256 nullifier, uint256[8] memory proof) = abi.decode(w, (uint256, uint256, uint256[8]));

    if (nullifier != owner) return APPROVE_NONE;              // only the owner
    if (!_rootReferenced(source, root)) return APPROVE_NONE;  // TXPARAM(0x11), RECENTROOTREFLOAD (0xB6)

    uint256 signalHash = uint256(keccak256(abi.encodePacked(LibERC8286.sigHash()))) >> 8;
    try VERIFIER.verifyProof(proof, [root, nullifier, signalHash, ext]) {} catch { return APPROVE_NONE; }

    return LibERC8286.allowedScope(LibERC8286.currentFrameIndex());
}
```

- `VERIFIER` is a pure Groth16 verifier contract that we deploy on the devnet. It reads no storage.
- When the validator returns `APPROVE_NONE`, the account reverts with `ValidationFailed`. The
  chain does not mine the transaction.
- The proof signs `sig_hash`. `sig_hash` commits every frame, the fees, the nonce keys, the root
  references and the chain ID. So nobody can reuse a proof for another transaction or another chain.
- World's verifier contracts do not track nullifiers. We do not mark the nullifier as used. We
  check that it **equals** the owner's nullifier. The signed nonce prevents replay.

### Where the World ID root comes from

World ID roots live on World Chain and Ethereum, not on the devnet.

1. A root publisher reads a World ID root. It sends exactly `salt || root` (64 bytes, value 0) to
   the EIP-8272 contract at `0x…8272`. This writes the root under
   `source_id = keccak256(caller || salt)`.
2. The transaction names `(source_id, slot, root)` in its `recent_root_references` envelope field.
   The protocol rejects a reference that is not committed or that is too old.
3. The validator reads the count with `TXPARAM(0x11)`, and each field with `RECENTROOTREFLOAD`
   (`0xB6`). The solc fork has no builtin for `0xB6`, so a small helper contract runs it
   (`contracts/src/RecentRootRead.yul`).
4. The validator accepts only roots from the `source_id` in the account's configuration.

**What EIP-8272 does and does not give:**

- Validation reads no other contract's storage. EIP-8272 is the intended way to bring a root in.
- A root written in slot S works from slot S+1 until slot S+8191. After that, the chain rejects
  the reference.
- **EIP-8272 checks publication recency, not cross-chain authenticity.** It does not prove that
  the root is current on World Chain, and it does not respect World ID revocation.
- **The prototype trusts the configured root publisher** to publish authentic and fresh World ID
  roots.
- A fabricated root alone does not give an attacker the owner's credential, because the
  nullifier must still match. But this does not prove that theft is impossible in every case,
  for example with a compromised or revoked credential.
- **Our publisher does not check that a root is real.** `POST /api/root/publish` writes the root
  that it receives. A check could block a real scan, because a proof root can exist on Ethereum
  before it reaches World Chain.
- Anyone who can reach this route can publish any root under the pinned source. The route accepts
  local callers only. A public deployment must close this gap.
- Anyone can publish under their own source. Nobody else can write under our pinned source,
  because the source ID holds the publisher's address.
- **Deadlock risk:** if our source stops, and a source change needs a World ID proof that uses
  that same source, the account cannot change it. So a source change is also possible with
  two device-bound methods, after a delay.

### More methods: mix and match

Each method is its own ERC-8286 frame validator. The owner installs them in Settings.

| Validator | What the user does | What the chain checks | Status |
|---|---|---|---|
| `WorldIDFrameValidator` | Approves in World App | A World ID 3.0 proof bound to `sig_hash` | Core |
| `PasskeyFrameValidator` | Face ID, Touch ID or a security key | A WebAuthn P-256 assertion over `sig_hash` | Core |
| `NfcCardFrameValidator` | Taps an NFC signing card | A signature from the key inside the card | Later. Not built. Settings shows "NFC card: coming later". |

- **Face ID and Touch ID only unlock the passkey on the device.** The chain never sees a face or
  a fingerprint. It verifies the WebAuthn assertion.
- **Passkeys can be device-bound or synced** (for example through iCloud Keychain or Google
  Password Manager). The security of a synced passkey includes the security of the sync account.
- **Face ID and Touch ID are probably synced passkeys.** passkeys.dev lists device-bound passkeys
  on iOS, macOS and Android for security keys only. We have not tested this on a real device.
  The app reads `BE` at enrolment and shows "Synced passkey" or "Device-bound passkey".
- The passkey validator stores the WebAuthn `BE` flag at enrolment and rejects a later mismatch.
  It also rejects `BS` when `BE` is 0.
- **This check alone does not establish hardware-backed storage**, and it does not prove that
  Face ID was used. That would need an attestation policy.
- Backup-eligible (synced) passkeys can approve only the tiers that the owner marks as small.
  They cannot propose or approve a fallback change (`SyncedNotAllowed`).
- A passkey validator instance serves one slot. The deployment holds three, so an account can
  enrol three passkeys.
- An NFC card works only if it can sign our transaction digest with a key the chain can verify.
  A FIDO2 NFC key should work through the passkey flow with no new contract. We have not tested
  this.
- Each validator uses its own nonce key, so each one has its own nonce domain. The mempool still
  allows only one pending frame transaction per sender.

### Rules per action

The account uses the **contract-dispatched execution route**.

- **In validation:** the account's `verify` reverts with `SenderFrameNotAllowed` unless every
  `SENDER` frame targets the account itself. ERC-8286 verify step 5 clears the execution approval
  instead. The effect is the same, and a revert gives the app a decoded reason.
- **Targeting the account is not enough.** A frame that targets the account could still call
  `installModule` or another exposed function directly. Such a call arrives as a self-call, so a
  "self-call only" check does not stop it.
- **So validation also restricts entry points.** `verify` reads each `SENDER` frame's function
  selector. It allows only six: `execute`, `schedule`, `approveRecovery`, `cancel`,
  `executeScheduled` and `tighten`. This check reads no storage.
- **Configuration functions are not entry points.** Module changes, loosened limits, owner changes
  and root source changes run only from inside `executeScheduled`, after the delay.
- **`tighten` changes limits at once.** It checks onchain that the new tiers are stricter than the
  old ones, and it reverts with `NotStricter` otherwise.
- **Summary:** validation restricts execution routes, and every sensitive account entry point
  enforces the authorization and delay policy, including direct calls to configuration functions.
- **In execution:** `execute` reads `TXPARAM(0x10)` to see which validator approved the
  transaction, and applies the owner's rules.
- We put time-based rules in `execute`, not in validation, because the mempool restricts what
  validation code can read.

**Default deny.** `execute` treats every call as sensitive unless it is a plain transfer of ETH or
of a listed token that the owner's spending rules allow. Sensitive calls include token approvals (`approve`,
`permit`, `setApprovalForAll`), operator permissions, unknown contract calls, any batch that holds
a sensitive call, and module or configuration changes.

A **listed token** is ETH, the Test USDC of the deployment, or a token that has tiers. A new
account has no tiers. So World ID alone approves any transfer of a listed token, with no delay.

**Period limits are cumulative.** Each limit (for example, per day or per week) is one counter
across all methods, all transactions and all batches. It is not checked separately for each
method.

| Action | Who can approve | Delay |
|---|---|---|
| Plain transfer of ETH or a listed token | The method that the owner's spending rule names for that amount | The delay that the rule names |
| Token approval, operator permission, unknown contract call | World ID | 24 hours, cancellable |
| Make the spending rules stricter (lower amount, stronger method, longer delay) | Any enrolled method | None |
| Add or remove a method, loosen the spending rules, change the root source | World ID | 48 hours, cancellable |
| Fallback owner change (World ID lost) | Two distinct device-bound methods. A synced passkey cannot take part. | 7 days, only World ID can cancel |
| Root source change (publisher stopped) | Two distinct device-bound methods. A synced passkey cannot take part. | 7 days, only World ID can cancel |

### Owner-set spending rules

The owner sets the spending rules in Settings. Each rule has amount tiers, and each tier names:

1. **An upper amount** per transfer.
2. **The methods** that may approve it.
3. **A delay** before the transfer runs. Zero means "at once".
4. **A period cap** (optional): a total per day or per week for that tier. When the cap is used
   up, the next tier's rule applies.
5. **A small mark** (optional). A synced passkey can approve a tier only if it has this mark.

**Example rule for USDC:**

| Amount per transfer | Method | Delay | Period cap |
|---|---|---|---|
| Under 100 USDC (marked small) | Face ID (passkey) | None | 300 USDC per day |
| 100 to 1,000 USDC | World ID | None | 2,000 USDC per week |
| Over 1,000 USDC | World ID | 24 hours, cancellable | None |

The local chain has no real USDC. The app uses Test USDC (`tUSDC`), with 6 decimals and an open
mint.

**How the account checks a transfer:**

1. `execute` reads the token, the amount, the period counter and the approving validator
   (`TXPARAM(0x10)`).
2. It finds the tier for that amount and that counter.
3. If the tier does not allow the approving validator, the call reverts.
4. If the tier has a delay, the transfer must go through `schedule` and `executeScheduled`.

**Rules for changing the rules:**

- **Making the rules stricter applies at once**, with any enrolled method. Examples: a lower
  amount, a stronger method or a longer delay.
- **Making the rules looser needs World ID and waits 48 hours.** No rule can bring this 48-hour
  floor down, so an attacker cannot remove the delays quickly.
- **Trade-off:** a stolen method can make the rules stricter. This can annoy the owner, but it
  cannot move funds to an attacker's address.
- **Gas fees pass no spending rule.** The signer sets the fee, so `verify` rejects a fee above
  50 gwei per gas or a total above 0.05 ETH per transaction. A stolen method can still repeat
  transactions and burn ETH up to that limit each time, until the owner removes it.

**Limits of the prototype:**

- Rules are set per token, in that token's own units, because the prototype uses no price oracle.
  A rule for ETH is set in ETH.
- Synced (backup-eligible) passkeys can approve only tiers that the owner marks as small.

**The delay queue** has separate onchain operations:

1. `schedule`: stores the exact action (a hash of its calls), the validator that proposed it,
   the configuration version, the earliest execution time and a status.
2. `approveRecovery`: for actions that need two methods. Each method approves the **same action
   hash** in its own transaction, because each transaction names one validator. The proposal
   counts as the first approval. The account counts **distinct validators**. A second approval
   from the same validator does not count. The delay starts when the second distinct approval
   arrives.
3. `cancel`: see the cancel rules below.
4. `executeScheduled`: after the delay, anyone can execute exactly the stored action, once. It
   fails if the configuration version has changed.

**Cancel rules:**

- Any enrolled method can cancel a normal pending action.
- Only World ID can cancel a fallback owner change or a fallback source change.
- **Trade-off:** a compromised method can cancel normal actions again and again. It cannot block
  the fallback recovery. But an attacker who controls World ID can block the fallback recovery.

**Configuration version:** owner changes, method revocations and security-policy changes increase
a configuration version. Each scheduled action and each collected recovery approval stores the
version from the moment it was made. A version change invalidates all of them. So a removed
credential cannot leave a queued action behind.

`tighten` does not change the version. A queued transfer of that token fails with `RuleChanged`.
Other queued actions continue.

**Independence:** two methods on one compromised phone are not independent. The chain cannot check
this. The app recommends methods on different devices, for example a passkey on the phone and a
security key.

Scheduled actions emit events, and the app shows them. This **creates a cancellation window**.
It does not guarantee that the owner sees the action in time. Spending under the daily limit is
still immediate.

**An account with World ID only has no fallback.** If the owner loses World ID access for good,
the funds are lost. An account with only synced passkeys has the same problem. The app asks the
owner to enroll at least two more device-bound methods. Today that means two security keys.

### Agent wallets

> **Status: built, not tested.** The contracts, routes and `/agents` page compile. No agent wallet
> has run on a chain.

**You create each agent wallet. Your main wallet is its master. You create it the same way that you
create a normal wallet.**

```
You -> World ID -> Main WAVE wallet
                        | master
                        v
                  Agent WAVE wallet
                  - Separate address and balance
                  - One agent key
                  - The same spending tiers as a main wallet
```

An agent wallet is the same `WaveAccount` clone from the same factory, with the same rules, tiers
and delay queue. It has one more clone argument: `master`, the address of the main wallet. The
agent wallet's address commits to `master`, so nobody can deploy it with another master. A main
wallet has no `master` bytes.

| Account | Authorization |
|---|---|
| Main wallet | The owner's World ID and other enrolled methods |
| Agent wallet | The agent key spends inside the tiers. Only the master can administer the wallet. |

EIP-8141 supplies the verification and execution steps. ERC-8286 supplies the validator interface.
Neither one defines a parent and child relationship. **Our account contracts implement that
ownership.**

**To create an agent wallet:**

1. Open `/agents`, then set the limits and the "ask a human above" amount.
2. Approve with World ID, in the same screens as a normal wallet.
3. The server deploys the agent wallet with a plain transaction, as the sponsor does for a main
   wallet.
4. The main wallet sends `agentSetup`, which sets the agent key and the first tiers. This works
   once. The main wallet emits `AgentLinked`, and the app lists only those wallets.

**When the agent spends:**

1. The `VERIFY` frame runs `AgentKeyFrameValidator`: a secp256k1 signature over `sig_hash`. A pause
   or a revoke stops it.
2. `execute` enforces the spending tiers. The default is deny, as in the main wallet.
3. On the local network the gas sponsor pays, as for every wallet. On the devnet the agent wallet
   pays for its own gas, so it must hold ETH.

**When the owner takes control:**

1. The main wallet authenticates the owner, by the normal rules for each action.
2. The main wallet calls the agent wallet.
3. The agent wallet accepts an administrative call only if `msg.sender` is its `master`.

If the main wallet changes its owner through recovery, its address stays the same. So it keeps
control of its agent wallets. An agent wallet has no World ID owner and no recovery.

**Owner actions on an agent wallet:**

| Action | Who can approve | Delay |
|---|---|---|
| Create an agent wallet (it holds no funds yet) | World ID | None |
| Send funds to an agent wallet | The main wallet's spending rule for that amount | The delay that the rule names |
| Revoke the agent key, or pause the agent | Any enrolled method | None |
| Make the agent's limits stricter | Any enrolled method | None |
| Withdraw funds to the main wallet | Any enrolled method | None |
| Loosen the agent's limits, replace the key, unpause | World ID | 48 hours (or the demo delay), cancellable |

The main wallet's default deny treats other contract calls as unknown calls, which wait 24 hours.
A revoke must not wait. So `execute` has a defined exception for these actions, and the exception
reads the code of the target. The target must be a clone that names this main wallet as master.

**An agent cannot create an agent wallet.** That permission is off.

**Limits of this design:**

- The agent key is a signing key. The "no seed phrase and no EOA key" claim covers the main wallet,
  not the agent wallet.
- A stolen agent key can spend up to the agent's limits, until the owner revokes it.
- A stolen main wallet method can revoke or pause an agent. The restore needs World ID and 48 hours.
- There is no list of allowed targets. The limits set the amount, not the recipient.
- An agent wallet does not prove that a human runs the agent. World ID authenticates the owner of
  the main wallet, not the agent.

#### Human approval with World ID Agent Pass

> **Status: built, not tested.** No World ID login has completed through this flow, and no agent
> spend has run through it.

An agent can act alone only up to a limit. Above that limit, a human must approve this exact
action at that moment. World ID Agent Pass gives this fresh human check.

**The trust moment:** an agent asks to spend more than the owner allows it to spend alone.

**How it works:**

1. The agent asks for a spend above its "ask a human above" amount. The server stores the exact
   action (agent wallet, recipient, token, amount), with a 5-minute expiry and a one-use approval
   ID. Nothing runs yet.
2. `/agents` shows "Needs human approval" with the decoded action.
3. The owner completes a fresh World ID authentication. WAVE requests `max_age=0`.
4. The backend validates the ID token: signature, issuer, audience, expiry, `state`, `nonce`, `acr`,
   `auth_time`, and the `(iss, sub)` pair that is linked to this agent wallet.
5. The backend uses the approval ID once. Only then does it send the agent's transaction.

**When the action does not run:** the owner cancels, the attempt expires, another person
authenticates, the `acr` value is not accepted, a callback is replayed, or the provider returns an
error. If Agent Pass is not configured, the action stays blocked. There is no bypass.

**Limits of this design:**

- The backend enforces this check, not the contract. The demo agent key is on the server, so you
  must trust the server.
- Pending actions are in server memory in the demo, so a server restart removes them.
- The "ask a human above" amounts and the identity links are in `.wave/agents-<network>.json` on
  the server, so a restart keeps them. A token with no amount asks a human for every spend.
- A higher "ask a human above" amount needs an approval too. A first value or a lower value does
  not.
- The first approval for a wallet links the identity. No earlier check proves that this person
  owns the wallet.
- The amount applies per spend. An agent can split a large spend into small ones, up to its daily
  limit.
- Sandbox identities are fake. A sandbox run does not prove that a real person is Orb verified.
- Agent Pass has no simulator. Testing uses the sandbox World ID app.
- The app uses the authorization code flow only, so it needs the tunnel. The Device Authorization
  Grant is not built.

The Settings card "Agent approval (World ID Agent Pass)" is a separate test panel. It guards a mint
of 1 test USDC, not an agent spend.

### Why this needs the alternative mempool

The EF track names two cases that only the alternative mempool allows. We use case (a):

- **(a) Verification above 100k gas.** The public mempool caps validation gas at 100k. We
  measured the World ID `VERIFY` frame on the local stack. It uses about 236.8k gas, or 253.8k in
  a first transaction.
- **(b) Flexible state access.** We avoid this case on purpose. EIP-8272 brings the root in
  without an external storage read.

| `VERIFY` frame | Gas used, measured by `scripts/e2e.ts` |
|---|---|
| World ID | 236,599 to 236,804 |
| World ID, first transaction (deploy and first use of the nonce key) | 253,803 |
| Passkey | 30,195 to 30,417 |
| Passkey, first use of the nonce key | 50,195 to 50,417 |

**The stock sidecar does not admit this.** It has one flat limit of 100k. A staked sender gets no
larger budget: a test with a staked sender got the same error. The stock sidecar also rejects a
call to a precompile, because its precompile list is empty. So we run a local sidecar with two
changes. See [the local devnet](#the-local-devnet).

For comparison, the playground's SPHINCS validator uses about 389k–416k gas in its `VERIFY` frame.

## Why World ID, and why this credential

**The trust moment:** a sensitive action, or a change of who controls the account. The account
must know that **this specific human** approved **this exact transaction**.

**The credential:** Orb Proof of Human, only where control or large value is at stake.

- A change of control needs the strongest uniqueness proof that is available.
- World's onchain 3.0 path accepts Orb proofs only (`groupId = 1`).
- Small transfers do not need it. After setup, a passkey approves them, and the owner's spending
  rules decide where "small" ends. This keeps Orb proofs for the moments that need them.
- World ID is not a login here. It is the approval itself.

**Alternative paths we demo:**

| Path | What happens | Tested |
|---|---|---|
| The owner cancels in World App | No proof. The app sends nothing. | No. This needs a real scan. |
| A different human proves | The nullifier does not match. `validateFrame` returns `APPROVE_NONE`. The transaction is invalid. | Yes, with test identities. |
| The root reference is too old | The chain rejects the reference. The transaction is invalid. | Age not tested. An uncommitted root and a wrong source are rejected. |
| A stolen passkey tries to install a module | Rejected at once with `SenderFrameNotAllowed`. The rules need World ID for module changes. | Yes, with a virtual authenticator. |
| Face ID tries a 150 USDC transfer | Rejected with `MethodNotAllowed`. The owner's rule needs World ID for 100 USDC or more. | Yes, with a virtual authenticator. |
| A World ID-approved sensitive change | It waits in the delay queue. Another enrolled method cancels it. | Yes, with a test identity and a virtual authenticator. |

## Security model

We remove one risk: **no seed phrase and no separate EOA signing key is required**, so there is no
such key to steal, leak, export or phish. Optional passkeys are still signing keys. The other
risks move. This table lists them.

| Threat | Result | Our defense | Remaining risk |
|---|---|---|---|
| A malicious frontend shows one transaction and asks for a proof for another. World App does not decode transactions. | An attacker gets a proof for their own transaction. | Caps. The delay queue for every sensitive action. | **Remains.** A trusted approval surface that decodes the transaction independently would fix it. |
| Someone controls the owner's phone and World App | They can make valid World ID proofs. | Daily limits. Delays. Other methods can cancel. | Immediate spending under the daily limit. |
| World ID recovery or reset | If recovery keeps the nullifier, whoever passes World's recovery can approve. If a reset changes the nullifier, World ID stops working for this account. | The fallback owner change with two distinct device-bound methods and a 7-day delay. | An account with World ID only has no fallback. An account with only synced passkeys has none either. |
| A downgrade attack with a weaker method | A stolen method tries to remove the stronger ones. | Module and rule changes need World ID and a delay. Configuration functions are not entry points. | Tests pass on the local stack. No audit has checked bypass resistance. |
| A stolen method burns the ETH balance as gas fees | The ETH goes to the block producer. The spending rules do not see it. | `verify` limits the fee per gas and the total cost of one transaction. | Repeated transactions up to the limit, until the owner removes the method. |
| A removed credential leaves a queued action behind | The action could run after the credential is gone. | The configuration version invalidates every queued action and collected approval. | Tests pass on the local stack. No audit. |
| An inauthentic or stale root from the publisher | A fabricated root alone does not give the owner's credential. | A pinned source. | **We trust the publisher** for authenticity, freshness and revocation. The publisher route does not check a root. |
| The root publisher stops | World ID approvals stop. | Source change with two distinct device-bound methods and a 7-day delay. | An account with World ID only freezes. |
| The alternative mempool is not available | Transactions that need the larger budget cannot be sent. | Passkey `VERIFY` frames use about 30k to 50k gas, under the 100k cap. | The stock sidecar still rejects passkeys, because they call precompiles. World ID transactions cannot be sent without a changed sidecar. |
| A bad or buggy validator module | A module runs with full control of the account (`DELEGATECALL`). | Install only reviewed modules. Changes need World ID and a delay. | Module bugs. |
| Dapps that ask for offchain signatures (ERC-1271, permits, sign-in) | The prototype cannot sign them. | None yet. | Some dapps will not work. |
| Coercion | The owner is forced to approve. | Delays on sensitive actions. | Immediate spending under the daily limit. |
| A stolen agent credential (built, not tested) | The attacker can act as the agent. | The agent's budget and permissions. The owner can revoke at once. | Spending up to the budget before the owner revokes. |
| A wallet that falsely names our main wallet as owner (built, not tested) | It can look like one of our agent wallets. | The app lists only the agent wallets that the main wallet recorded. | Other apps can still show the false wallet. |

## CROPS

- **C (censorship resistance):** The wallet depends on a World ID root publisher and on
  alternative-mempool nodes. If our publisher stops, roots expire after 8191 slots. The owner can
  move to another publisher with two distinct device-bound methods, after a 7-day delay. Anyone
  can run a publisher.
- **O (open source):** The code is under the MIT license. A user can build and run everything from
  this repo.
- **P (privacy):** A World ID proof reveals no name and no biometric data. The nullifier is
  specific to our app and action, so it does not link the owner across apps. Our servers see no
  identity. The test identity is the exception: the server makes that proof, so it sees the test
  secrets. RPC reads go through **TODO** (we plan to test Anon-RPC).
- **S (security):** No seed phrase and no separate EOA signing key is required. Optional passkeys
  are signing keys. Each proof signs one exact transaction. We trust the World ID protocol, the
  configured root publisher and the verifier contract. See the security model.

## Agent wallets and human approval — built, not tested

The user's main WAVE wallet is the master of separate agent wallets. Each
agent receives a spending limit per transfer and per day. The owner can
revoke access.

Agents operate automatically within those permissions. When an action
requires the owner, WAVE pauses the request and uses World ID Agent Pass
to request fresh human authentication.

Our backend validates the result and checks that it matches the identity
previously linked to the owner. WAVE then shows the exact action for
explicit approval, including the recipient, token and amount.

The approved action still goes through the wallet's onchain authorization
and policy checks. Agent Pass authentication alone cannot move funds or
override spending limits and delays.

Denied, cancelled, expired or invalid requests remain blocked. Changes
to the requested action require a new approval.

Agent Pass is a separate integration from the World ID 3.0 proof used by
our frame validator. Its authentication result is not automatically an
EIP-8141 transaction authorization.



## Demo (3 minutes)

> **Demo-only settings:** adding a method takes the full delay, so the demo uses an account whose
> passkey was enrolled before the demo. The demo account caps every delay at 2 minutes. The
> address commits to that cap. The real delays are 24 hours to 7 days.

1. Show an account created with World ID only. Show that no seed phrase and no EOA key exist.
2. Send a small transfer, approved in World App.
3. Switch to the account with the pre-enrolled passkey. Show its rule: Face ID under 100 USDC,
   marked small, and World ID from 100 USDC.
4. Send 50 USDC with Face ID. It goes through at once.
5. Try 150 USDC with Face ID. **It is rejected.** Approve the same transfer with World ID.
6. In Settings, open the security demos. Use a "stolen" passkey to call `installModule` directly.
   **It is rejected at once.**
7. Approve a sensitive change with World ID. It enters the delay queue.
8. Cancel it with the passkey.
9. Open the admitted transaction on the devnet explorer.

**Demo notes:**

- **Face ID and Touch ID are likely synced passkeys.** They approve small tiers only. So mark the
  "under 100 USDC" tier as small, or the transfer fails with `SyncedNotAllowed`.
- The demo rule needs no device-bound passkey. A device-bound passkey needs a security key.
- Check the label in Settings before the demo. It says "Synced passkey" or "Device-bound passkey".
- "USDC" in the demo is Test USDC (`tUSDC`). Say so.
- If the demo uses the test identity, the app shows "Test identity. Not a real World ID." Say so.
- The first send of a new root waits for one slot, about 6 seconds. The sidecar bundles every 10
  seconds. So allow about 20 seconds for a transaction.
- A new contract deployment breaks old wallets in the browser (`ACCOUNT_MISMATCH`). Clear the site
  data for the page to recover.

## Prize tracks

### 1. Ethereum Foundation: Best use of the Frame Transaction Alternative Mempool

- **What only the alternative mempool allows:** a `VERIFY` frame that checks a World ID
  zero-knowledge proof, at about 236.8k gas. That is above the public validation gas cap of 100k.
  This needs the budget change on the sidecar. See [the local devnet](#the-local-devnet).
- **EF tools we use:** ERC-8286 frame validators, EIP-8250 keyed nonces, EIP-8272 recent roots and
  the devnet sidecar.
- **Admitted transaction:** the local sidecar admits these transactions, and the local chain mines
  them. Run `npx tsx scripts/e2e.ts` to get hashes and local explorer links.
  **TODO: link on explorer.altmempool.wtf.** No transaction has run on the public devnet.
- **Code that submits it:** `lib/server/send.ts` for the app, and `scripts/e2e.ts` for the tests.
  Both use `sendToSidecar` in `lib/frametx.ts`.
- **Trade-offs:** see the security model and CROPS sections.

We also select the EF CROPS track. EF places each project in at most one EF prize.

### 2. World: Best Use of IDKit

- **Trust moment:** a sensitive action or a change of control.
- **Credential:** Orb Proof of Human, verified onchain inside the account's own validation.
- **Success path and alternative paths:** see "Alternative paths we demo".
- **Integration debrief:** see the end of this README.

### World: World ID Agent Pass — built, not tested

**Status: built, not tested.** No World ID login has completed through this flow.

- **Trust moment:** an agent asks to spend more than the owner allows it to spend alone.
- **Credential:** a fresh Orb-class World ID login, with `max_age=0`, for one exact action.
- **Enforcement:** the backend enforces this check, not the contract. See
  [Human approval with World ID Agent Pass](#human-approval-with-world-id-agent-pass).
- This replaces the earlier AgentKit plan. WAVE has no AgentKit code, no AgentBook and no contract
  for this feature.

### 3. Whitechain: Scale · Payments Nobody Notices (planned, after the core)

**Status: planned.** We build this only after the core works.

A merchant version of the wallet: the payer pays in USDT with Face ID. The payer holds no seed
phrase and no gas, and does not need to know the chain.

- **The catch:** Whitechain (OP Stack, Whitechain Sepolia chain ID 1874) has no EIP-8141, and
  World's verifier contracts are not on it. So this version is an **ERC-4337** smart account with a
  passkey, plus the same rules and delays, from a shared Solidity library.
- **Why not EIP-7702:** a 7702 account keeps the original EOA key, and that key keeps its
  delegation authority. That would bring back the key we want to remove.
- **Gas sponsorship:** our relayer pays the WBT gas. It sponsors only calls to our checkout
  contract, caps gas per account, simulates each call first, and takes the gas cost back from the
  payment in USDT. **These caps reduce exposure. They do not fully protect against failed calls,
  many accounts or failed reimbursement.**
- **Merchant side:** a checkout widget that a demo shop adds in about 20 lines. The demo shows both
  the merchant and the payer.
- **Requirements we will meet:** contracts verified on the Whitechain explorer, at least one
  payment in Whitechain test USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) with the explorer
  link here, and a `WHITECHAIN_FEEDBACK.md`.
- **Why onchain stablecoin settlement:** the payment settles in seconds, both sides can check the
  onchain receipt, and the payer never handles a key.

## Build status

A checked item passed a real test on the local stack. **The test identity** is a local identity
that makes real Groth16 proofs but is not a World ID. **The software authenticator** and **the
virtual authenticator** sign with real P-256 math, but no device, face or finger is involved. See
[Test results](#test-results).

- [x] Measure the gas of the full validation prefix with the World ID validator.
      *Test identity. World ID `VERIFY` uses about 236.8k gas, 253.8k in a first transaction.*
- [ ] An official World ID test credential produces a transaction-bound 3.0 proof that our
      verifier accepts on the devnet. *Not run. No simulator scan and no World App scan yet.*
- [x] Solve the root dependency (choose option 1 or 2). *Option 1 with a root hint. Test identity
      only. A real World root has not gone through this path.*
- [x] The root publisher writes World ID roots to the EIP-8272 contract. *Test identity roots
      only. The publisher has not written a real World root.*
- [x] Get an admitted transaction on the local sidecar, and open it on the local explorer.
      *Test identity and software authenticator.*
- [ ] Get an admitted transaction on the public alternative-mempool explorer. *Not run.*
- [x] Passkey validator with the `BE`/`BS` check. *Software and virtual authenticators only.*
- [ ] Passkeys on a real device: Face ID, Touch ID and a security key. *Not run.*
- [x] Entry-point restriction in validation (allowed selectors only). *Test identity and software
      authenticator.*
- [x] Delay queue: `schedule`, `approveRecovery`, `cancel`, `executeScheduled`. *Test identity and
      software authenticator. Chain runs used demo delays. Forge tests check the real delay values.*
- [x] Configuration version invalidates queued actions and collected approvals. *The chain run
      covers a queued action. A forge test covers collected approvals.*
- [x] Owner-set spending rules: amount tiers, method per tier, delay per tier, period caps.
      *Test identity, software authenticator and virtual authenticator.*
- [x] Period limits are cumulative across methods and transactions. *Test identity and software
      authenticator.*
- [ ] Period limits are cumulative across batches. *Not tested: no test sends two transfers in
      one batch.*
- [x] Stricter rules apply at once; looser rules need World ID and a 48-hour delay. *Test identity
      and software authenticator. The chain run used a demo delay. A forge test checks 48 hours.*
- [x] Attack demos: stolen passkey rejected; World ID change cancelled. *Test identity and virtual
      authenticator, in Chromium.*
- [x] Fallback owner change with two distinct other methods. *Test identity and software
      authenticator, with a demo delay. A forge test checks the distinct-method rule and 7 days.*
- [ ] Fallback root source change with two distinct other methods. *A forge test checks who can
      propose it. No test runs the full change.*
- [ ] Whitechain merchant version
- [x] Local gas sponsor: a wallet with 0 ETH sends transactions, and the gas station pays only with
      the sponsor signature. *Test identity and software authenticator. Local network only. The
      fee cap and the shape check ran in unit tests only.*
- [ ] Agent wallets: the user creates a child wallet with the normal creation flow. *Not tested.
      Compile only: no agent wallet ran on a chain.*
- [ ] Agent wallets: the agent key and the spending tiers are enforced onchain. *Not tested.*
- [ ] Agent wallets: revoke works at once, and only the master can administer the wallet.
      *Not tested.*
- [ ] Agent wallets use the local gas sponsor. *Not tested.*
- [ ] World ID Agent Pass: a fresh login approves one exact agent spend, and every refused path
      leaves it not run. *Not tested. Compile only: no login has completed.*
- [ ] Demo approval success and cancellation with no payment

## Repository layout

```
contracts/                        own package.json. Hardhat with the solc fork, forge for policy tests.
  src/
    WaveAccount.sol               ERC-8286 account, contract-dispatched route, six entry points
    WavePolicy.sol                tiers, period counters, delay queue, recovery, configuration version
    WorldIDFrameValidator.sol     World ID 3.0 proof over sig_hash, root from an EIP-8272 reference
    PasskeyFrameValidator.sol     WebAuthn P-256 assertion over sig_hash, with backup-flag check
    AgentKeyFrameValidator.sol    secp256k1 signature over sig_hash, for agent wallets only
    WaveAccountFactory.sol        CREATE2 clones with initial configuration in code
    WaveGasStation.sol            local gas sponsor: a paymaster that needs the sponsor signature
    SemaphoreVerifier.sol         World's Groth16 verifier
    RecentRootRead.yul            helper that runs RECENTROOTREFLOAD (0xB6)
    TestUSDC.sol                  local test token, open mint
  scripts/deploy.ts               deploys all contracts, writes deployments/local.json
  test/WavePolicy.t.sol           forge tests for the policy
devnet/                           the local stack: ethrex, Lighthouse, sidecar, explorer
lib/                              frame builder, chain client, World ID, policy encoding
lib/server/                       route logic: prepare, send, roots, activity, World ID config,
                                  gas sponsor, agent wallets, Agent Pass
app/                              web app and API route handlers. Pages: /, /settings, /agents
components/                       web app components
scripts/
  e2e.ts                          15 cases on the local stack: real frames, real Groth16
  api-smoke.ts                    runs the API routes the same way the browser does
  unit.ts                         checks that need no chain
  fetch-zk.sh                     downloads the circuit files for the test identity
.wave/                            gitignored. The server keeps agent checkpoint data here.
```

The server publishes roots with a plain transaction, so `RootPublisher.sol` does not exist.
`NfcCardFrameValidator.sol` does not exist yet.

## Running it

You need Node.js, and Docker or OrbStack. These steps assume macOS on Apple silicon, because
`fetch-solc` downloads the macOS arm64 build. The first start of the stack downloads about 2 GB.

1. Run `npm install`.
2. Build the contracts. A stock `solc` does not know the EIP-8141 opcodes, so `fetch-solc` gets
   the fork [v0.8.38-eip8141.0](https://github.com/chiranjeev13/solidity/releases/tag/v0.8.38-eip8141.0).

   ```sh
   cd contracts
   npm install
   npm run fetch-solc
   npm run compile
   cd ..
   ```

3. Run `devnet/up.sh`. A first start takes about 8 minutes. It returns when frame transactions
   work.
4. Run `npm run deploy` in `contracts/`. This writes `contracts/deployments/local.json`.
5. Run `scripts/fetch-zk.sh` once. The test identity needs these circuit files.
6. Run `cp -n .env.example .env.local`. The `-n` flag keeps an existing file. With the World ID
   values blank, the app uses the test identity. See
   [Environment variables](#environment-variables).
7. Run `npx next dev -p 3000`.
8. Open `http://localhost:3000`.

On the local network a new wallet needs no ETH, because the gas sponsor pays. Use Fund to get test
tokens. After a new deployment, clear the site data of the page. Old wallets give
`ACCOUNT_MISMATCH` until you do this.

`next dev` runs one server per folder. A second `next dev` in this folder exits with
`Another next dev server is already running`.

To use the `/agents` page:

1. Run `openssl rand -hex 32`.
2. Add `0x` in front of the result, and set it as `WAVE_AGENT_DEMO_KEY` in `.env.local`. Use a key
   that holds no real value.
3. Restart `next dev`.

To use Agent Pass:

1. Register a client in the World portal. Choose "Client secret (Basic)".
2. Start a tunnel to the web server. The portal accepts HTTPS callbacks only, so
   `http://localhost` does not work.

   ```sh
   cloudflared tunnel --url http://localhost:3000
   ```

3. Set `AGENT_PASS_REDIRECT_URI` to `https://<tunnel host>/api/agent-pass/callback`.
4. Add the same URL to the client in the portal.
5. Set `AGENT_PASS_CLIENT_ID` and `AGENT_PASS_CLIENT_SECRET` in `.env.local`.
6. Restart `next dev`.
7. Check your sandbox identity in the
   [OAuth Playground](https://oauth-playground.toolsforhumanity.dev/) before you use the app.

The server keeps each attempt in memory. So the tunnel must reach the same server process that
started the attempt. A quick tunnel gets a new link at each start, so repeat steps 3 and 4 then.

To stop:

1. Press Ctrl-C in the terminal of the web server.
2. Leave the stack running, or run `devnet/down.sh`. **`down.sh` deletes the chain.** After that,
   run `devnet/up.sh` and `npm run deploy` in `contracts/` again.

After the Mac sleeps, run `devnet/up.sh`. It keeps the chain.

### Environment variables

Put these in `.env.local`. `.env.example` has every value. All values are optional for a local
run with the test identity.

| Variable | Default | What it does |
|---|---|---|
| `WAVE_NETWORK` | `local` | `local` is your own stack, with the gas sponsor. `devnet` is the public devnet, with no sponsor. |
| `WAVE_DEMO_DELAY` | `120` | The delay cap for new wallets, in seconds. `0` means real delays. The address commits to it. |
| `WAVE_SPONSOR_DAILY_TX` | `50` | Sponsored transactions per wallet per day. The server enforces this. Local network only. |
| `WAVE_ALLOW_LAN` | not set | `1` lets a phone on the LAN reach the local-only routes. |
| `WAVE_DEV_KEY` | local dev key | A funded key for `devnet`. The local network does not need it. |
| `WAVE_RPC_URL`, `WAVE_SIDECAR_URL`, `WAVE_EXPLORER_URL` | from `WAVE_NETWORK` | Override the network URLs. |
| `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_RP_ID`, `RP_SIGNING_KEY` | blank | World ID. Set all three for `idkit` mode. See [World ID modes](#world-id-modes). |
| `NEXT_PUBLIC_WORLD_ENV` | `staging` | `staging`, `sandbox` or `production`. |
| `WORLD_CHAIN_RPC_URL` | public RPC | The RPC for World Chain root reads. |
| `AGENT_PASS_ISSUER` | `https://sandbox.auth.world.org` | The Agent Pass issuer. Production is `https://auth.world.org`. |
| `AGENT_PASS_CLIENT_ID`, `AGENT_PASS_CLIENT_SECRET` | blank | With either one blank, the app shows "Agent Pass is not configured", and checkpointed actions stay blocked. |
| `AGENT_PASS_REDIRECT_URI` | `http://localhost:3000/api/agent-pass/callback` | The callback URL. The portal needs HTTPS, so use a tunnel. |
| `AGENT_PASS_ACR` | `https://world.org/oidc/acr/orb,https://world.org/oidc/acr/orb-face` | The accepted `acr` values. |
| `WAVE_AGENT_DEMO_KEY` | blank | The demo agent key. It signs agent spends on the server. |
| `NEXT_PUBLIC_WAVE_MOCK` | not set | `1` selects the mock data layer, for UI work only. It uses no chain and no proofs. |

Keep `RP_SIGNING_KEY`, `AGENT_PASS_CLIENT_SECRET` and `WAVE_AGENT_DEMO_KEY` out of the repo.

### The local devnet

`devnet/` runs ethrex, two Lighthouse beacon nodes, one validator client, the sidecar and the
explorer on one machine. All ports bind to `127.0.0.1`. The chain and all keys are local and hold
no real value. [devnet/README.md](devnet/README.md) has the full detail.

| Service | Address |
|---|---|
| ethrex RPC, chain 1337 | `http://localhost:8545` |
| Sidecar (alternative mempool) | `http://localhost:14337/rpc` |
| Explorer | `http://localhost:5173`, one transaction at `/tx/<hash>?node=http://localhost:14337/rpc` |

We change the stock sidecar in two ways:

1. **Verify gas budget.** A one-line patch reads `MAX_VERIFY_GAS` from an env value. We set it to
   2,500,000. The stock limit is 100k for all senders. This raises a resource limit only, and all
   opcode and storage rules still apply. The alt-mempool team (Alex Forshtat) accepted this change.
2. **Precompile list.** `config/sidecar.json` lists `0x01` to `0x11` and `0x100`. This is a
   configuration value, not a code change. Rule COD-010 rejects a call to an address with no code,
   and the stock list is empty. Rule CALLING-040 of ERC-8421 already allows these precompiles.

A local sidecar is accepted for judging.

### The public devnet

`WAVE_NETWORK=devnet` in `.env.local` selects the public devnet. **We have not run this.**
`contracts/deployments/devnet.json` does not exist yet, and the switch needs a funded `WAVE_DEV_KEY`.

When we last checked, the public chain had stopped at block 408262 and its faucet was empty. The
public sidecars reported an empty precompile list. So they should reject our validators.

### World ID modes

**WAVE can run with no Orb and no phone.** The first two modes below do this. Only the second one
is a World product.

| Mode | How to select it | Who makes the proof | Status |
|---|---|---|---|
| **Test identity** (`dev`) | Leave any of the three World ID values blank | The WAVE server, with the World simulator's circuit files | All tests used this mode |
| **World simulator** (`idkit`, staging) | Set the three values and `NEXT_PUBLIC_WORLD_ENV=staging` | [simulator.worldcoin.org](https://simulator.worldcoin.org). No Orb and no phone. | No scan has run yet |
| **Real World App** (`idkit`, production) | Set the three values and `NEXT_PUBLIC_WORLD_ENV=production` | World App on a phone, with Orb verification | No scan has run yet |

The three values are `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_RP_ID` and `RP_SIGNING_KEY`. They
come from the [World Developer Portal](https://developer.world.org). The action is `wave-approve`.

- **The test identity is not a World ID.** The browser holds random secrets in localStorage. The
  server proves over a one-leaf tree and publishes that root. The proofs are real Groth16, and
  the onchain verifier checks them. The app shows "Test identity. Not a real World ID."
- This proves the pipeline. It does not prove that a World ID works.
- `idkit` mode shows World's QR. The creation scan goes to the Portal, at
  `POST https://developer.world.org/api/v4/verify/{rp_id}`. A transaction scan signs `sig_hash`,
  and the contract verifies it.
- The app also accepts `NEXT_PUBLIC_WORLD_ENV=sandbox`. We do not know where the sandbox root
  lives, so the app reads the staging root. We have not tested it.
- The app ID sets the external nullifier. A new app ID gives each owner a new wallet address.
- The build inlines the two `NEXT_PUBLIC_` values. After a change, restart `next dev`, or run
  `next build` again before `next start`.
- `NEXT_PUBLIC_WAVE_MOCK=1` is a third option, for UI work only. It uses no chain and no proofs.

### Test results

These are the last runs, on 2026-11-06, on the local stack.

| Check | Command | Result |
|---|---|---|
| Policy unit tests | `forge test` in `contracts/` | 35 passed, 0 failed |
| Checks with no chain | `npx tsx scripts/unit.ts` | 22 passed, 0 failed |
| End-to-end cases on the chain | `npx tsx scripts/e2e.ts` | 15 of 15 passed, with the gas sponsor. Test identity, software authenticator. |
| API routes | `SMOKE_FULL=1 npx tsx scripts/api-smoke.ts` | 48 passed, 0 failed, with the gas sponsor |
| Sponsor limits | `SMOKE_BUDGET=1 npx tsx scripts/api-smoke.ts`, server with `WAVE_SPONSOR_DAILY_TX=1` | 8 passed, 0 failed |
| Browser journey, synced passkey | Chromium at 1280 px | 44 of 44 steps, with the gas sponsor. Test identity, virtual authenticator. |
| Browser journey, device-bound passkey | Chromium at 390 px | 55 of 55 steps, before the gas sponsor. Test identity, virtual authenticator. |
| Lint and build | `npm run lint`, `npm run build` | Both exit 0 |

`scripts/e2e.ts` takes about 20 minutes, because it waits for real blocks and delays.
`scripts/api-smoke.ts` takes about 8 minutes. It needs a server in test identity mode with
`WAVE_DEMO_DELAY=20`. Blank values in the shell override `.env.local`, so that file does not change:

```sh
export NEXT_PUBLIC_WORLD_APP_ID= NEXT_PUBLIC_RP_ID= RP_SIGNING_KEY= WAVE_DEMO_DELAY=20
npx next build
npx next start -p 3100
```

In a second terminal, run:

```sh
WAVE_API_URL=http://localhost:3100 SMOKE_FULL=1 npx tsx scripts/api-smoke.ts
```

After the test, stop that server. Then run `npm run build` in a new terminal, because the first
build holds the blank World ID values.

Agent wallets and Agent Pass have no entry in this table. The owner asked for compile checks only,
so no test covers them.

**Not run:**

- a real World ID scan
- a real security key, Face ID or Touch ID
- a real chain restart
- a root republish after 8000 slots
- a transaction that waits past 45 seconds
- a full fallback change of the root source
- any agent wallet flow on a chain: create, spend, limits, pause, revoke, withdraw
- a World ID Agent Pass login, or any refused path of that flow
- the `/agents` page with a wallet in it (the empty page loads in Chromium)
- the UI text for `SponsorLimit` and `SponsorEmpty` (the API returned both codes)
- `SponsorFeeCap` and `SponsorShape` on a live route (unit tests only)
- the 390 px browser journey with the gas sponsor

## Open questions

**Answered:**

1. **What validation gas cap does the devnet use?** The stock sidecar has a flat 100k limit. Stake
   does not change it. Our local sidecar uses 2.5M. See [the local devnet](#the-local-devnet).
2. **ERC-8286 cites `TXPARAM(0x0B)` for `nonce_keys[0]`.** EIP-8250 and ethrex use `0x10`. We use
   `0x10`, and it works on chain 1337.
3. **Can `execute` read `TXPARAM(0x10)` in a `SENDER` frame?** Yes. The local chain ran this.
4. **Are EIP-8272 recent roots live on the devnet we use?** Yes, in an early form. They are an
   envelope field, not a `VERIFY` frame, at `0x…8272`.
5. **Which root will World's prover use, and can we get it before we build the transaction?** No.
   IDKit has no setting that pins a root. We use a root hint and allow one more scan.
6. **How does IDKit encode the signal?** It decodes a `0x` hex string to bytes, then computes
   `keccak256(bytes) >> 8`. We ran this on a 32-byte value, and it matches our Solidity.

**Still open.** We will check these with the alternative-mempool team and the World team:

1. Do World's test credentials at Mumbai produce World ID 3.0 proofs for onchain verification?
   IDKit 4.6.0 has `orbLegacy`, but no scan has run through the simulator or World App.
2. Does World App allow a second 3.0 proof for one action, with a new signal? **The main path
   fails if it refuses**, because each approval is a new proof for `wave-approve`.
3. Does the owner's World App account still give 3.0 proofs? If not, the error is
   `world_id_3_not_available`.
4. Does a World ID nullifier stay the same after World ID recovery or reset?
5. How often does a real scan return a root other than the hint?
6. Does `sandbox` return 3.0 proofs, and where is its root?
7. Do Face ID and Touch ID report `BE=1` on real devices? Does their `clientDataJSON` fit the
   512-byte witness?
8. Will the public sidecars accept the precompile list and a higher budget?
9. Will the public devnet keep this early EIP-8272 form? `verify` also reads `TXPARAM(0x04)` and
   `TXPARAM(0x06)`, and the newer EIP text changes these.

## Prior art

| Project | What it did | What we do differently |
|---|---|---|
| A.S.R. "Anti Social Recovery" (ETHGlobal New York 2023, Worldcoin Best Use) | Tied contract ownership to a World ID, so the human can take over from a new address | World ID is the validator itself, inside native EIP-8141 validation. No separate EOA signing key is required. |
| Cache Coherence (ETHGlobal Sydney, Best World ID Usage 2nd) | An ERC-4337 wallet with World ID as a second factor and for recovery | No ECDSA owner key. Rules per action with a delay queue. |
| ENSignv2 (ETHGlobal Lisbon 2026) | A passkey wallet; guardians recover it with zkEmail proofs after a cancellable delay | No guardians. The owner's own World ID proof approves sensitive actions. |
| ERC-8286 playground | An account owned only by a post-quantum SPHINCS key | We replace the key with a World ID proof, and add more methods and rules. |

## How we used AI

> **Draft.** An AI tool wrote this draft. The team must check it and add what is missing before
> submission.

We used Claude Code (Claude Opus 5.5) for most of the build.

- **Humans:** the team chose the product and the design. That covers the World ID validator, the
  mix-and-match methods, the spending rules, the delay queue and the agent wallet plan. The team
  also made the calls on scope, such as moving NFC to later.
- **Research:** AI agents read the EIPs, the ERC-8286 playground, the sidecar, ethrex and the World
  ID sources. They ran probes on the public devnet and on a local stack. They found the facts in
  [Chain facts](#chain-facts) and the answers in [Open questions](#open-questions).
- **Code:** AI agents wrote the contracts, the web app, the API routes, the local devnet scripts
  and the tests. A written spec recorded the decisions, and the agents logged each change from it.
- **Testing and review:** AI agents ran the forge, end-to-end, API and browser tests. An AI code
  review found defects, and AI agents fixed them.
- **Docs:** AI agents updated this README to match the tests.

**TODO:** name the code that a human reviewed line by line. State any other AI tools that the team
used, and link the prompts or specs if ETHGlobal asks for them.

## World ID integration debrief

**TODO:** fill in at the end of the hackathon.

- Time to first successful proof:
- Friction we hit:
- Missing capability or documentation:
- The one improvement with the greatest impact:

## License

MIT
