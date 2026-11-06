// A software WebAuthn authenticator with a P-256 key. Test use only.
// It follows the assertion format of a browser: real P-256, real clientDataJSON, real authData.
import { P256 } from 'ox'
import { bytesToHex, concat, encodePacked, hexToBytes, pad, sha256, size, stringToHex, type Hex } from 'viem'

const WITNESS_LEN = 512
const RP_ID = 'localhost'

const b64url = (hex: Hex) => Buffer.from(hexToBytes(hex)).toString('base64url')

export class SoftPasskey {
  readonly privateKey: Hex = P256.randomPrivateKey()
  readonly x: Hex
  readonly y: Hex
  /** True for a synced passkey (BE = 1, BS = 1). */
  constructor(readonly backupEligible = false) {
    const pub = P256.getPublicKey({ privateKey: this.privateKey })
    this.x = pad(pub.x as Hex, { size: 32 })
    this.y = pad(pub.y as Hex, { size: 32 })
  }

  /** The padded witness for the ARBITRARY entry. */
  sign(sigHash: Hex): Hex {
    // UP | UV, and BE | BS for a synced passkey.
    const flags = this.backupEligible ? 0x1d : 0x05
    const authData = concat([sha256(stringToHex(RP_ID)), bytesToHex(new Uint8Array([flags, 0, 0, 0, 1]))])
    const clientData =
      `{"type":"webauthn.get","challenge":"${b64url(sigHash)}",` + `"origin":"http://${RP_ID}:3000","crossOrigin":false}`
    const digest = sha256(concat([authData, sha256(stringToHex(clientData))]))
    const { r, s } = P256.sign({ payload: digest, privateKey: this.privateKey, hash: false })
    const compact = encodePacked(
      ['uint16', 'bytes', 'bytes', 'uint16', 'uint16', 'bytes32', 'bytes32'],
      [
        size(authData),
        authData,
        stringToHex(clientData),
        clientData.indexOf('"challenge"'),
        clientData.indexOf('"type"'),
        pad(r as Hex, { size: 32 }),
        pad(s as Hex, { size: 32 }),
      ],
    )
    return pad(encodePacked(['uint16', 'bytes'], [size(compact), compact]), { dir: 'right', size: WITNESS_LEN })
  }
}
