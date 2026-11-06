// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {IWaveMethod} from "./interfaces/IWaveMethod.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibWaveAgent} from "./lib/LibWaveAgent.sol";
import {LibWitness} from "./lib/LibWitness.sol";

/// @notice Approves a frame transaction of an agent wallet with a secp256k1 signature over sig_hash.
/// Runs by DELEGATECALL in the account's context, inside a VERIFY frame. It reads only the
/// account's storage and the envelope. A pause or a revoke stops it.
contract AgentKeyFrameValidator is IFrameValidator, IWaveMethod {
    /// Witness in the ARBITRARY entry: r (32) || s (32) || v (1).
    uint256 public constant WITNESS_LEN = 65;

    /// Bit 6 of the tier method mask. Passkey slots use bits 1 to 3.
    uint8 private constant METHOD_BIT = 0x40;

    error OnlyAgentSetup();

    /// @dev WaveAccount installs this validator itself on an agent wallet. This revert stops
    /// `installModule`, so a main wallet can never hold a secp256k1 method.
    function onInstall(bytes calldata) external pure override {
        revert OnlyAgentSetup();
    }

    function onUninstall(bytes calldata) external pure override {
        revert OnlyAgentSetup();
    }

    function isModuleType(uint256 id) external pure override returns (bool) {
        return id == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    function isSynced(bytes calldata) external pure override returns (bool) {
        return false;
    }

    function methodBit() external pure override returns (uint8) {
        return METHOD_BIT;
    }

    function validateFrame(bytes calldata data) external view returns (uint8) {
        if (!LibERC8286.isTargetedFrame()) return LibERC8286.APPROVE_NONE;

        LibWaveAgent.Layout storage a = LibWaveAgent.layout();
        (address signer, bool paused) = (a.signer, a.paused);
        if (signer == address(0) || paused) return LibERC8286.APPROVE_NONE;

        bytes memory w = LibWitness.witness(data);
        if (w.length != WITNESS_LEN) return LibERC8286.APPROVE_NONE;

        // tryRecover rejects a high s value.
        (address found, ECDSA.RecoverError err,) = ECDSA.tryRecover(LibERC8286.sigHash(), w);
        if (err != ECDSA.RecoverError.NoError || found != signer) return LibERC8286.APPROVE_NONE;
        return LibERC8286.allowedScope(LibERC8286.currentFrameIndex());
    }
}
