// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WebAuthn} from "solady/src/utils/WebAuthn.sol";

/// @notice Checks WebAuthn P-256 assertions for WAVE ERC-4337 accounts on chains without
/// EIP-8141. One shared instance holds one key per account, keyed by the account address.
/// It is the 4337 version of PasskeyFrameValidator: the same BE/BS rules, over the
/// userOpHash instead of the frame sig_hash.
contract WavePasskeyValidator {
    struct Key {
        bytes32 x;
        bytes32 y;
        bool backupEligible; // BE seen at enrolment. It cannot change for one credential.
        bool requireUV;
    }

    uint8 private constant BE = 0x08;
    uint8 private constant BS = 0x10;

    mapping(address account => Key) private _keys;

    event KeySet(address indexed account, bytes32 x, bytes32 y, bool backupEligible, bool requireUV);

    error KeyAlreadySet(address account);
    error NoKey();

    /// @dev The account calls this once, from its initializer. Only the account can set its key.
    function setKey(bytes32 x, bytes32 y, bool backupEligible, bool requireUV) external {
        if (x == 0 && y == 0) revert NoKey();
        Key storage k = _keys[msg.sender];
        if (k.x != 0 || k.y != 0) revert KeyAlreadySet(msg.sender);
        (k.x, k.y, k.backupEligible, k.requireUV) = (x, y, backupEligible, requireUV);
        emit KeySet(msg.sender, x, y, backupEligible, requireUV);
    }

    function keyOf(address account) external view returns (Key memory) {
        return _keys[account];
    }

    /// @dev `sig` is Solady's compact WebAuthn encoding:
    /// uint16 authDataLen || authenticatorData || clientDataJSON || uint16 challengeIndex
    /// || uint16 typeIndex || r || s. The challenge must be `hash`.
    function isValidSignature(address account, bytes32 hash, bytes calldata sig) external view returns (bool) {
        Key storage k = _keys[account];
        (bytes32 x, bytes32 y, bool wantBE, bool wantUV) = (k.x, k.y, k.backupEligible, k.requireUV);
        if (x == 0 && y == 0) return false;

        WebAuthn.WebAuthnAuth memory auth = WebAuthn.tryDecodeAuthCompactCalldata(sig);
        if (auth.authenticatorData.length < 37) return false;

        // Solady checks UP and UV. It does not read BE or BS, so this code does.
        uint8 flags = uint8(auth.authenticatorData[32]);
        bool be = flags & BE != 0;
        if (be != wantBE) return false;
        if (!be && flags & BS != 0) return false;

        // Solady checks type == webauthn.get, the challenge and low-s, then calls 0x02 and 0x100.
        return WebAuthn.verify(abi.encodePacked(hash), wantUV, auth, x, y);
    }
}
