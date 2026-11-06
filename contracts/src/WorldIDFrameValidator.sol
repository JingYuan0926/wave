// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {IWaveMethod} from "./interfaces/IWaveMethod.sol";
import {ISemaphoreVerifier} from "./interfaces/ISemaphoreVerifier.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibWaveIdentity} from "./lib/LibWaveIdentity.sol";
import {LibWitness} from "./lib/LibWitness.sol";

/// @notice Approves a frame transaction with a World ID 3.0 proof over sig_hash.
/// Runs by DELEGATECALL in the account's context, inside a VERIFY frame. It reads only the
/// account's storage, the account's code, the envelope and two stateless contracts.
contract WorldIDFrameValidator is IFrameValidator, IWaveMethod {
    /// Witness in the ARBITRARY entry: root (32) || nullifierHash (32) || proof (8 * 32).
    uint256 public constant WITNESS_LEN = 320;

    ISemaphoreVerifier public immutable VERIFIER;
    /// The helper that runs RECENTROOTREFLOAD (0xB6). The solc fork has no builtin for it.
    address public immutable ROOT_READER;

    constructor(ISemaphoreVerifier verifier, address rootReader) {
        VERIFIER = verifier;
        ROOT_READER = rootReader;
    }

    /// @dev The clone args configure this validator. It keeps no storage of its own.
    function onInstall(bytes calldata) external override {}

    function onUninstall(bytes calldata) external override {}

    function isModuleType(uint256 id) external pure override returns (bool) {
        return id == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    function isSynced(bytes calldata) external pure override returns (bool) {
        return false;
    }

    function methodBit() external pure override returns (uint8) {
        return 1;
    }

    function validateFrame(bytes calldata data) external view returns (uint8) {
        if (!LibERC8286.isTargetedFrame()) return LibERC8286.APPROVE_NONE;

        (uint256 owner, uint256 ext, bytes32 source) = LibWaveIdentity.read();
        if (owner == 0) return LibERC8286.APPROVE_NONE;

        bytes memory w = LibWitness.witness(data);
        if (w.length != WITNESS_LEN) return LibERC8286.APPROVE_NONE;
        (uint256 root, uint256 nullifier, uint256[8] memory proof) = abi.decode(w, (uint256, uint256, uint256[8]));

        if (nullifier != owner) return LibERC8286.APPROVE_NONE;
        if (!_rootReferenced(source, root)) return LibERC8286.APPROVE_NONE;

        uint256 signalHash = uint256(keccak256(abi.encodePacked(LibERC8286.sigHash()))) >> 8;
        try VERIFIER.verifyProof(proof, [root, nullifier, signalHash, ext]) {}
        catch {
            return LibERC8286.APPROVE_NONE;
        }
        return LibERC8286.allowedScope(LibERC8286.currentFrameIndex());
    }

    /// @dev True if the envelope holds a reference with this source and root. The protocol
    /// already checked that each reference is committed and recent.
    function _rootReferenced(bytes32 source, uint256 root) private view returns (bool) {
        uint256 n;
        assembly ("memory-safe") {
            n := txparam(0x11)
        }
        for (uint256 i; i < n; i++) {
            if (_rootRef(i, 0) == uint256(source) && _rootRef(i, 2) == root) return true;
        }
        return false;
    }

    /// @dev field: 0 source_id, 1 slot, 2 root.
    function _rootRef(uint256 index, uint256 field) private view returns (uint256 value) {
        address reader = ROOT_READER;
        assembly ("memory-safe") {
            mstore(0x00, index)
            mstore(0x20, field)
            if iszero(staticcall(gas(), reader, 0x00, 0x40, 0x00, 0x20)) { revert(0, 0) }
            value := mload(0x00)
        }
    }
}
