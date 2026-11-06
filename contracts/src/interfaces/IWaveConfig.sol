// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// One rule for one amount band. One storage slot (96 + 96 + 32 + 24 + 8 = 256 bits).
/// `methods`: bit 7 marks a small tier. Bits 0 to 6 are method bits. World ID is bit 0.
struct WaveTier {
    uint96 upTo;
    uint96 cap;
    uint32 delay;
    uint24 period;
    uint8 methods;
}

/// @notice The configuration functions of a WAVE account. They run only from inside
/// executeScheduled, after the delay. `schedule` classifies a batch by these selectors.
interface IWaveConfig {
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external;
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData) external;
    function setTiers(address token, WaveTier[] calldata tiers) external;
    function setRootSource(bytes32 sourceId) external;
    function setOwner(uint256 ownerNullifierHash) external;
}
