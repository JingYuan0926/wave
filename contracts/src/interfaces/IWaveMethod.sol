// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @notice A frame validator that can tell the account how a credential is stored.
interface IWaveMethod {
    /// @dev True if the credential in `initData` can sync to other devices (WebAuthn BE = 1).
    function isSynced(bytes calldata initData) external pure returns (bool);

    /// @dev The tier method bit of this validator. Passkey slot N has bit N.
    function methodBit() external view returns (uint8);
}
