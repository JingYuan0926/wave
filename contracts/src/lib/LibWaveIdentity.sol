// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {LibCloneConfig} from "./LibCloneConfig.sol";

/// @notice The owner identity and the root source of an account.
/// The clone args hold the initial values. Storage overrides them. Zero in storage means
/// "use the clone args". The account writes here. The World ID validator reads here by
/// DELEGATECALL, so every read stays in the sender's storage.
library LibWaveIdentity {
    /// @custom:storage-location erc7201:wave.account.identity
    struct Layout {
        uint256 ownerNullifier;
        bytes32 rootSource;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("wave.account.identity")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SLOT = 0x984e82f125c9306bb46356de67e8f10f452ee1efd94a518e779ddea247912700;

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := SLOT
        }
    }

    /// @dev Reads storage first and the clone args after that.
    function read() internal view returns (uint256 owner, uint256 ext, bytes32 source) {
        (owner, ext, source) = LibCloneConfig.initWords(LibCloneConfig.args());
        Layout storage l = layout();
        uint256 storedOwner = l.ownerNullifier;
        bytes32 storedSource = l.rootSource;
        if (storedOwner != 0) owner = storedOwner;
        if (storedSource != 0) source = storedSource;
    }
}
