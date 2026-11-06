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
> A claim is proven only when its item in [Build status](#build-status) is checked. Not audited.

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

- **In validation:** the account's `verify` clears the execution approval unless every `SENDER`
  frame targets the account itself (ERC-8286 verify step 5).
- **Targeting the account is not enough.** A frame that targets the account could still call
  `installModule` or another exposed function directly. Such a call arrives as a self-call, so a
  "self-call only" check does not stop it.
- **So validation also restricts entry points.** `verify` reads each `SENDER` frame's function
  selector. It allows only `execute`, `schedule`, `approveRecovery`, `cancel` and
  `executeScheduled`.
- **Configuration functions are not entry points.** Module changes, limit changes, owner changes
  and root source changes run only from inside `executeScheduled`, after the delay.
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

**Period limits are cumulative.** Each limit (for example, per day or per week) is one counter
across all methods, all transactions and all batches. It is not checked separately for each
method.

| Action | Who can approve | Delay |
|---|---|---|
| Plain transfer of ETH or a listed token | The method that the owner's spending rule names for that amount | The delay that the rule names |
| Token approval, operator permission, unknown contract call | World ID | 24 hours, cancellable |
| Make the spending rules stricter (lower amount, stronger method, longer delay) | Any enrolled method | None |
| Add or remove a method, loosen the spending rules, change the root source | World ID | 48 hours, cancellable |
| Fallback owner change (World ID lost) | Two distinct other enrolled methods | 7 days, only World ID can cancel |
| Root source change (publisher stopped) | Two distinct other enrolled methods | 7 days, only World ID can cancel |

### Owner-set spending rules

The owner sets the spending rules in Settings. Each rule has amount tiers, and each tier names:

1. **An upper amount** per transfer.
2. **The methods** that may approve it.
3. **A delay** before the transfer runs. Zero means "at once".
4. **A period cap** (optional): a total per day or per week for that tier. When the cap is used
   up, the next tier's rule applies.

**Example rule for USDC:**

| Amount per transfer | Method | Delay | Period cap |
|---|---|---|---|
| Under 100 USDC | Face ID (passkey) | None | 300 USDC per day |
| 100 to 1,000 USDC | World ID | None | 2,000 USDC per week |
| Over 1,000 USDC | World ID | 24 hours, cancellable | None |

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
  cannot move funds.

**Limits of the prototype:**

- Rules are set per token, in that token's own units, because the prototype uses no price oracle.
  A rule for ETH is set in ETH.
- Synced (backup-eligible) passkeys can approve only tiers that the owner marks as small.

**The delay queue** has separate onchain operations:

1. `schedule`: stores the exact action (a hash of its calls), the validator that proposed it,
   the configuration version, the earliest execution time and a status.
2. `approveRecovery`: for actions that need two methods. Each method approves the **same action
   hash** in its own transaction, because each transaction names one validator. The account
   counts **distinct validators**. A second approval from the same validator does not count. The
   delay starts when the second distinct approval arrives.
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

**Independence:** two methods on one compromised phone are not independent. The chain cannot check
this. The app recommends methods on different devices, for example a passkey on the phone and an
NFC card.

Scheduled actions emit events, and the app shows them. This **creates a cancellation window**.
It does not guarantee that the owner sees the action in time. Spending under the daily limit is
still immediate.

**An account with World ID only has no fallback.** If the owner loses World ID access for good,
the funds are lost. The app asks the owner to enroll at least two more methods.

### Why this may need the alternative mempool

The EF track names two cases that only the alternative mempool allows. We expect case (a):

- **(a) Verification above 100k gas.** The public mempool caps validation gas. We expect our
  World ID check to cost more. The alternative mempool gives staked accounts a larger budget.
- **(b) Flexible state access.** We avoid this case on purpose. EIP-8272 brings the root in
  without an external storage read.

**This is provisional.** We will confirm it only after we measure the full validation prefix and
get an admitted transaction. For comparison, the playground's SPHINCS validator uses about
389k–416k gas in its `VERIFY` frame.

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

| Path | What happens |
|---|---|
| The owner cancels in World App | No proof. The app sends nothing. |
| A different human proves | The nullifier does not match. `validateFrame` returns `APPROVE_NONE`. The transaction is invalid. |
| The root reference is too old | The EIP-8272 frame fails. The mempool evicts the transaction. |
| A stolen passkey tries to install a module | Rejected at once. The rules need World ID for module changes. |
| Face ID tries a 150 USDC transfer | Rejected. The owner's rule needs World ID for 100 USDC or more. |
| A World ID-approved sensitive change | It waits in the delay queue. Another enrolled method cancels it. |

## Security model

We remove one risk: **no seed phrase and no separate EOA signing key is required**, so there is no
such key to steal, leak, export or phish. Optional passkeys and NFC cards are still signing keys.
The other risks move. This table lists them.

| Threat | Result | Our defense | Remaining risk |
|---|---|---|---|
| A malicious frontend shows one transaction and asks for a proof for another. World App does not decode transactions. | An attacker gets a proof for their own transaction. | Caps. The delay queue for every sensitive action. | **Remains.** A trusted approval surface that decodes the transaction independently would fix it. |
| Someone controls the owner's phone and World App | They can make valid World ID proofs. | Daily limits. Delays. Other methods can cancel. | Immediate spending under the daily limit. |
| World ID recovery or reset | If recovery keeps the nullifier, whoever passes World's recovery can approve. If a reset changes the nullifier, World ID stops working for this account. | The fallback owner change with two distinct other methods and a 7-day delay. | An account with World ID only has no fallback. |
| A downgrade attack with a weaker method | A stolen method tries to remove the stronger ones. | Module and rule changes need World ID and a delay. Configuration functions are not entry points. | Policy enforcement and bypass resistance remain unverified. |
| A removed credential leaves a queued action behind | The action could run after the credential is gone. | The configuration version invalidates every queued action and collected approval. | Unverified until built. |
| An inauthentic or stale root from the publisher | A fabricated root alone does not give the owner's credential. | A pinned source. | **We trust the publisher** for authenticity, freshness and revocation. |
| The root publisher stops | World ID approvals stop. | Source change with two distinct other methods and a 7-day delay. | An account with World ID only freezes. |
| The alternative mempool is not available | Transactions that need the larger budget cannot be sent. | Passkey transfers aim to stay under the public mempool cap. | Not measured yet. |
| A bad or buggy validator module | A module runs with full control of the account (`DELEGATECALL`). | Install only reviewed modules. Changes need World ID and a delay. | Module bugs. |
| Dapps that ask for offchain signatures (ERC-1271, permits, sign-in) | The prototype cannot sign them. | None yet. | Some dapps will not work. |
| Coercion | The owner is forced to approve. | Delays on sensitive actions. | Immediate spending under the daily limit. |

## CROPS

- **C (censorship resistance):** The wallet depends on a World ID root publisher and on
  alternative-mempool nodes. If our publisher stops, roots expire after 8191 slots. The owner can
  move to another publisher with two distinct other methods, after a 7-day delay. Anyone can run a
  publisher.
- **O (open source):** The code is under the MIT license. A user can build and run everything from
  this repo.
- **P (privacy):** A World ID proof reveals no name and no biometric data. The nullifier is
  specific to our app and action, so it does not link the owner across apps. Our servers see no
  identity. RPC reads go through **TODO** (we plan to test Anon-RPC).
- **S (security):** No seed phrase and no separate EOA signing key is required. Optional passkeys
  and NFC cards are signing keys. Each proof signs one exact transaction. We trust the World ID protocol, the configured root publisher and the verifier
  contract. See the security model.

## Demo (3 minutes)

> **Demo-only settings:** adding a method takes 48 hours, so the demo uses an account whose
> passkey was enrolled before the demo. The demo account also uses shortened delays of 2 minutes.
> The real delays are 24 hours to 7 days.

1. Show an account created with World ID only. Show that no seed phrase and no EOA key exist.
2. Send a small transfer, approved in World App.
3. Switch to the account with the pre-enrolled device-bound passkey. Show its rule: Face ID under
   100 USDC, World ID from 100 USDC.
4. Send 50 USDC with Face ID. It goes through at once.
5. Try 150 USDC with Face ID. **It is rejected.** Approve the same transfer with World ID.
6. Use a "stolen" passkey to call `installModule` directly. **It is rejected at once.**
7. Approve a sensitive change with World ID. It enters the delay queue.
8. Cancel it with the passkey.
9. Open the admitted transaction on the devnet explorer.

## Prize tracks

### 1. Ethereum Foundation: Best use of the Frame Transaction Alternative Mempool

- **What we expect only the alternative mempool allows:** a `VERIFY` frame that checks a World ID
  zero-knowledge proof, above the public validation gas cap. Provisional until measured.
- **EF tools we use:** ERC-8286 frame validators, EIP-8250 keyed nonces, EIP-8272 recent roots and
  the devnet sidecar.
- **Admitted transaction:** **TODO: link on explorer.altmempool.wtf**
- **Code that submits it:** `scripts/send-worldid-frame-tx.ts` (TODO)
- **Trade-offs:** see the security model and CROPS sections.

We also select the EF CROPS track. EF places each project in at most one EF prize.

### 2. World: Best Use of IDKit

- **Trust moment:** a sensitive action or a change of control.
- **Credential:** Orb Proof of Human, verified onchain inside the account's own validation.
- **Success path and alternative paths:** see "Alternative paths we demo".
- **Integration debrief:** see the end of this README.

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

- [ ] Measure the gas of the full validation prefix with the World ID validator
- [ ] An official World ID test credential produces a transaction-bound 3.0 proof that our
      verifier accepts on the devnet
- [ ] Solve the root dependency (choose option 1 or 2)
- [ ] The root publisher writes World ID roots to the EIP-8272 contract
- [ ] Get an admitted transaction on the alternative-mempool explorer
- [ ] Passkey validator with the `BE`/`BS` check
- [ ] Entry-point restriction in validation (allowed selectors only)
- [ ] Delay queue: `schedule`, `approveRecovery`, `cancel`, `executeScheduled`
- [ ] Configuration version invalidates queued actions and collected approvals
- [ ] Owner-set spending rules: amount tiers, method per tier, delay per tier, period caps
- [ ] Period limits are cumulative across methods, transactions and batches
- [ ] Stricter rules apply at once; looser rules need World ID and a 48-hour delay
- [ ] Attack demos: stolen passkey rejected; World ID change cancelled
- [ ] Fallback owner change and root source change with two distinct other methods
- [ ] Whitechain merchant version

## Repository layout (planned)

```
src/
  WaveAccount.sol              ERC-8286 account, contract-dispatched route, rules and delay queue in execute
  WorldIDFrameValidator.sol     World ID 3.0 proof over sig_hash, root from EIP-8272
  PasskeyFrameValidator.sol     WebAuthn P-256 assertion over sig_hash, with backup-flag check
  NfcCardFrameValidator.sol     stretch goal
  WaveAccountFactory.sol       CREATE2 clones with initial configuration in code
  RootPublisher.sol             writes World ID roots to the EIP-8272 contract
scripts/
  send-worldid-frame-tx.ts      builds, proves, simulates and submits a frame transaction
app/                            web app: create account, approve, settings, pending actions
```

## Running it

1. Install the EIP-8141 Solidity fork
   [v0.8.36-eip8141.1](https://github.com/chiranjeev13/solidity/releases/tag/v0.8.36-eip8141.1).
   A stock `solc` does not know the EIP-8141 opcodes.
2. Run `npm install`.
3. Set the devnet values in `.env`:
   - execution RPC `https://altmempool.forshtat.com`
   - mempool RPC `https://altmempool.forshtat.com/rpc`
   - chain ID `1337`
4. Run `npm run deploy` to deploy the verifier, the validators, the account and the factory.
5. Run `npm run send` to simulate a frame transaction. Set `submit` to send it.

**TODO:** update these steps when the code is final.

## Open questions

We will check these with the alternative-mempool team and the World team at the event:

1. What validation gas cap does the devnet use? The EIP-8141 text says 100k for the public
   mempool. The playground measured against a 500k cap on its own testnet.
2. ERC-8286 cites `TXPARAM(0x0B)` for `nonce_keys[0]`. EIP-8250 and ethrex use `0x10`. We use `0x10`.
3. Can `execute` read `TXPARAM(0x10)` in a `SENDER` frame?
4. Are EIP-8272 recent roots live on the devnet we use?
5. Which root will World's prover use, and can we get it before we build the transaction?
6. Do World's test credentials at Mumbai produce World ID 3.0 proofs for onchain verification?
7. How does IDKit encode the signal, so that our `hashToField` matches?
8. Does a World ID nullifier stay the same after World ID recovery or reset?

## Prior art

| Project | What it did | What we do differently |
|---|---|---|
| A.S.R. "Anti Social Recovery" (ETHGlobal New York 2023, Worldcoin Best Use) | Tied contract ownership to a World ID, so the human can take over from a new address | World ID is the validator itself, inside native EIP-8141 validation. No separate EOA signing key is required. |
| Cache Coherence (ETHGlobal Sydney, Best World ID Usage 2nd) | An ERC-4337 wallet with World ID as a second factor and for recovery | No ECDSA owner key. Rules per action with a delay queue. |
| ENSignv2 (ETHGlobal Lisbon 2026) | A passkey wallet; guardians recover it with zkEmail proofs after a cancellable delay | No guardians. The owner's own World ID proof approves sensitive actions. |
| ERC-8286 playground | An account owned only by a post-quantum SPHINCS key | We replace the key with a World ID proof, and add more methods and rules. |

## How we used AI

**TODO:** describe how the team used AI tools, as ETHGlobal's rules require.

## World ID integration debrief

**TODO:** fill in at the end of the hackathon.

- Time to first successful proof:
- Friction we hit:
- Missing capability or documentation:
- The one improvement with the greatest impact:

## License

MIT
