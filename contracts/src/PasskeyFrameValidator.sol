// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {IWaveMethod} from "./interfaces/IWaveMethod.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibWitness} from "./lib/LibWitness.sol";
import {WebAuthn} from "solady/src/utils/WebAuthn.sol";

/// @notice Approves a frame transaction with a WebAuthn P-256 assertion over sig_hash.
/// Runs by DELEGATECALL inside a VERIFY frame. Deploy one instance per method slot, 1 to 3:
/// `nonce_keys[0]` names the instance, and each instance keeps its own storage namespace.
contract PasskeyFrameValidator is IFrameValidator, IWaveMethod {
    struct Key {
        bytes32 x;
        bytes32 y;
        bool backupEligible; // BE seen at enrolment. It cannot change for one credential.
        bool requireUV;
    }

    /// Witness in the ARBITRARY entry, fixed length, zero padded:
    /// uint16 n || Solady compact auth (n bytes) || zeros.
    uint256 public constant WITNESS_LEN = 512;

    uint8 private constant BE = 0x08;
    uint8 private constant BS = 0x10;

    /// The namespace mixes in this deployment's address, so two instances share no key.
    bytes32 private immutable SLOT;
    /// Slot N has bit N in the tier method mask.
    uint8 private immutable METHOD_BIT;

    constructor(uint8 methodSlot) {
        require(methodSlot >= 1 && methodSlot <= 6, "bad slot");
        METHOD_BIT = uint8(1) << methodSlot;
        SLOT = keccak256(abi.encode(keccak256("wave.module.passkey-frame-validator"), address(this)));
    }

    function _key() private view returns (Key storage k) {
        bytes32 s = SLOT;
        assembly ("memory-safe") {
            k.slot := s
        }
    }

    /// @dev `data` = abi.encode(x, y, backupEligible, requireUV).
    function onInstall(bytes calldata data) external override {
        (bytes32 x, bytes32 y, bool be, bool uv) = abi.decode(data, (bytes32, bytes32, bool, bool));
        require(x != 0 || y != 0, "no key");
        Key storage k = _key();
        (k.x, k.y, k.backupEligible, k.requireUV) = (x, y, be, uv);
    }

    function onUninstall(bytes calldata) external override {
        Key storage k = _key();
        delete k.x;
        delete k.y;
        delete k.backupEligible;
        delete k.requireUV;
    }

    function isModuleType(uint256 id) external pure override returns (bool) {
        return id == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    function isSynced(bytes calldata initData) external pure override returns (bool be) {
        (,, be,) = abi.decode(initData, (bytes32, bytes32, bool, bool));
    }

    function methodBit() external view override returns (uint8) {
        return METHOD_BIT;
    }

    function validateFrame(bytes calldata data) external view returns (uint8) {
        if (!LibERC8286.isTargetedFrame()) return LibERC8286.APPROVE_NONE;

        bytes memory w = LibWitness.witness(data);
        if (w.length != WITNESS_LEN) return LibERC8286.APPROVE_NONE;

        uint256 n = (uint256(uint8(w[0])) << 8) | uint256(uint8(w[1]));
        if (n + 2 > WITNESS_LEN) return LibERC8286.APPROVE_NONE;
        bytes memory compact;
        assembly ("memory-safe") {
            compact := add(w, 2) // Reuse the bytes in place. The word before them becomes the length.
            mstore(compact, n)
        }
        WebAuthn.WebAuthnAuth memory auth = WebAuthn.tryDecodeAuthCompact(compact);
        if (auth.authenticatorData.length < 37) return LibERC8286.APPROVE_NONE;

        Key storage k = _key();
        (bytes32 x, bytes32 y, bool wantBE, bool wantUV) = (k.x, k.y, k.backupEligible, k.requireUV);
        if (x == 0 && y == 0) return LibERC8286.APPROVE_NONE;

        // Solady checks UP and UV. It does not read BE or BS, so this code does.
        uint8 flags = uint8(auth.authenticatorData[32]);
        bool be = flags & BE != 0;
        if (be != wantBE) return LibERC8286.APPROVE_NONE;
        if (!be && flags & BS != 0) return LibERC8286.APPROVE_NONE;

        // Solady checks type == webauthn.get, the challenge and low-s, then calls 0x02 and 0x100.
        if (!WebAuthn.verify(abi.encodePacked(LibERC8286.sigHash()), wantUV, auth, x, y)) {
            return LibERC8286.APPROVE_NONE;
        }
        return LibERC8286.allowedScope(LibERC8286.currentFrameIndex());
    }
}
