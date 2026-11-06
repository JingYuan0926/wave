// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {WaveTier} from "./IWaveConfig.sol";

/// One token and its tiers, for the first rules of a new wallet.
struct AgentRule {
    address token;
    WaveTier[] tiers;
}

/// @notice The administration of an agent wallet. Each function accepts only `msg.sender == master`.
/// The master wallet classifies these calls by selector in WavePolicy._agentClass.
interface IWaveAgent {
    // The master wallet sends this with its owner method and no delay. It works once.
    function agentSetup(address signer, AgentRule[] calldata rules) external;

    // The master wallet sends these with any enrolled method and no delay.
    function agentRevoke() external;
    function agentPause() external;
    function agentTighten(address token, WaveTier[] calldata tiers) external;
    function agentWithdraw(address token, uint256 amount) external;

    // The master wallet queues these with its owner method and the 48 hour delay.
    function agentUnpause() external;
    function agentSetTiers(address token, WaveTier[] calldata tiers) external;
    function agentSetKey(address signer) external;
}
