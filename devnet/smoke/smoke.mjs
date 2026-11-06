// Proves the two sidecar changes on the running stack:
// 1. pairing test: a VERIFY frame above 100k gas that calls precompile 0x08.
// 2. P-256 test: a VERIFY frame that calls precompile 0x100.
// Both frame transactions go through the sidecar and must be mined.
// The test wallets approve every transaction. Use them only on this local chain.
import { privateKeyToAccount } from 'viem/accounts';
import { getProfile } from '@forshtat/hegota-support/profiles';
import * as lib from '@forshtat/hegota-support/tx';
import { toWire } from '@forshtat/hegota-support/rpc';

const EL = process.env.EL ?? 'http://localhost:8545';
const SC = process.env.SC ?? 'http://localhost:14337/rpc';
const EXPLORER = process.env.EXPLORER ?? 'http://localhost:5173';

// The public genesis key of the local devnet. It holds no real value.
const GENESIS_KEY = '0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15';
const RECEIVER = '0x8943545177806ED17B9F23F0a21ee5948eCaa776';
const CHAIN_ID = 1337;
const PUBLIC_MEMPOOL_VERIFY_GAS = 100_000;
const profile = getProfile('ethrex-eip8141-tracer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json();
}

async function waitForReceipt(hash, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const { result } = await rpc(EL, 'eth_getTransactionReceipt', [hash]);
    if (result) return result;
    await sleep(2000);
  }
  throw new Error(`no receipt for ${hash}`);
}

async function nonceOf(address) {
  return BigInt((await rpc(EL, 'eth_getTransactionCount', [address, 'latest'])).result);
}

// Deploys a contract with a legacy transaction. 5 gwei is above the base fee.
async function deploy(runtime) {
  const length = (runtime.length / 2).toString(16).padStart(2, '0');
  const data = `0x60${length}600c60003960${length}6000f3${runtime}`;
  const account = privateKeyToAccount(GENESIS_KEY);
  const raw = await account.signTransaction({
    chainId: CHAIN_ID,
    nonce: Number(await nonceOf(account.address)),
    to: null,
    value: 10n ** 18n,
    data,
    gas: 1_000_000n,
    gasPrice: 5_000_000_000n,
    type: 'legacy',
  });
  const sent = await rpc(EL, 'eth_sendRawTransaction', [raw]);
  if (sent.error) throw new Error(`deploy: ${JSON.stringify(sent.error)}`);
  const receipt = await waitForReceipt(sent.result);
  if (receipt.status !== '0x1') throw new Error(`deploy reverted: ${sent.result}`);
  return receipt.contractAddress;
}

async function sendFrameTx(label, wallet, { execution, data = '0x', minGas = 0 }) {
  const tx = lib.newTx({
    chainId: CHAIN_ID,
    sender: wallet,
    nonceSeq: await nonceOf(wallet),
    frames: [
      lib.frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution, data }),
      lib.frame(profile, 'SENDER', { target: RECEIVER, execution: 50_000n, state: 200_000n, value: 1_000_000_000n }),
    ],
    signatures: [],
    fees: { maxFeePerGas: 20_000_000_000n },
  });

  const sent = await rpc(SC, 'eth_sendFrameTransaction', [toWire(tx)]);
  if (sent.error) throw new Error(`${label}: sidecar rejected: ${JSON.stringify(sent.error)}`);

  const receipt = await waitForReceipt(sent.result);
  const frames = receipt.frameReceipts.map((frame) => [frame.status, parseInt(frame.gasUsed, 16)]);
  const sidecar = (await rpc(SC, 'skandha_frameTransactionStatus', [sent.result])).result?.status;
  const verifyGas = frames[0][1];
  const passed = receipt.status === '0x1' && frames.every(([status]) => status === '0x1') && verifyGas >= minGas;

  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
  console.log(`  tx ${sent.result}`);
  console.log(`  block ${parseInt(receipt.blockNumber, 16)}, frames ${JSON.stringify(frames)}, sidecar ${sidecar}`);
  console.log(`  ${EXPLORER}/tx/${sent.result}?node=${encodeURIComponent(SC)}`);
  if (!passed) process.exitCode = 1;
}

// Runtime: copy calldata, call precompile 0x08 with it, require a result of 1, APPROVE(3).
const PAIRING_WALLET = '3660006000376020600036600060085afa60005116601d5760006000fd5b600360006000aa';
// Runtime: STATICCALL 0x100 with literal gas, ignore the result, APPROVE(3).
const P256_WALLET = '60206000600060006101006200fffffa50600360006000aa';

// A valid 4-pair BN254 pairing: e(P,Q) * e(-P,Q) = 1, two times.
const FIELD = '30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd45';
const G2 =
  '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2' +
  '1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed' +
  '090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b' +
  '12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa';
const G1 = `${'0'.repeat(63)}1${'0'.repeat(63)}2`;
const MINUS_G1 = `${'0'.repeat(63)}1${FIELD}`;
const PAIRING_INPUT = `0x${`${G1}${G2}${MINUS_G1}${G2}`.repeat(2)}`;

await sendFrameTx('verify frame above 100k gas with 4-pair pairing on 0x08', await deploy(PAIRING_WALLET), {
  execution: 400_000n,
  data: PAIRING_INPUT,
  minGas: PUBLIC_MEMPOOL_VERIFY_GAS,
});
await sendFrameTx('verify frame that calls P-256 on 0x100', await deploy(P256_WALLET), {
  execution: 80_000n,
});
