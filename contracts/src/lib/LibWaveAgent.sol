// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @notice The agent state of an agent wallet. One storage slot.
/// The account writes here. AgentKeyFrameValidator reads here by DELEGATECALL, so every read stays
/// in the sender's storage.
library LibWaveAgent {
    /// @custom:storage-location erc7201:wave.account.agent
    struct Layout {
        address signer; // The agent's secp256k1 address. Zero after a revoke.
        bool paused;
        bool setUp; // agentSetup ran. It stays true after a revoke.
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("wave.account.agent")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SLOT = 0x3bb0150e4f28b8c3b73385567985a7d07e6c522e9b0d7b161799e49145cce300;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := SLOT
        }
    }
}
