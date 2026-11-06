// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {WaveTier} from "./IWaveConfig.sol";

/// One extra method of a new wallet: the validator and its install data.
struct SetupMethod {
    address validator;
    bytes initData;
}

/// One token, its tiers and its hard daily total. A `dailyLimit` of 0 means no limit.
struct SetupRule {
    address token;
    WaveTier[] tiers;
    uint96 dailyLimit;
}

/// @notice The first extra methods and rules of a new wallet. The factory calls this in the deploy call.
interface IWaveSetup {
    function setup(SetupMethod[] calldata methods, SetupRule[] calldata rules) external;
}
