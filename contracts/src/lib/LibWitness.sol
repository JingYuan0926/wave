// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {LibERC8286} from "./LibERC8286.sol";

/// @notice Finds the witness of a VERIFY frame. The frame data is abi.encode(uint256 index)
/// into tx.signatures, and that entry must be ARBITRARY with empty msg. EIP-8141 elides those
/// bytes from sig_hash, so the witness can sign over sig_hash.
library LibWitness {
    /// @dev Empty for anything else.
    function witness(bytes calldata data) internal view returns (bytes memory) {
        if (data.length != 32) return "";
        return LibERC8286.arbitrarySignature(abi.decode(data, (uint256)));
    }
}
