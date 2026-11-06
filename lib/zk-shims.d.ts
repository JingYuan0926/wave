declare module 'circomlibjs' {
  type Poseidon = ((inputs: bigint[]) => Uint8Array) & { F: { toObject(value: Uint8Array): bigint } }
  export function buildPoseidon(): Promise<Poseidon>
}
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string,
      zkey: string,
      logger?: unknown,
      wtnsOptions?: unknown,
      proverOptions?: unknown,
    ): Promise<{
      proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }
      publicSignals: string[]
    }>
  }
}
