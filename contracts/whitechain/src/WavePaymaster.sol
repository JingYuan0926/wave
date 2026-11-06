// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {VerifyingPaymaster} from "@account-abstraction/contracts/samples/VerifyingPaymaster.sol";

/// @notice WAVE's gas sponsor on Whitechain: the EntryPoint v0.7 verifying paymaster.
/// It pays the WBT gas only for user operations that the WAVE relayer signed. The relayer
/// checks the operation offchain first (sender, calls, gas caps, daily budget), so a
/// wallet needs no WBT. The owner can withdraw the deposit and the stake.
contract WavePaymaster is VerifyingPaymaster {
    constructor(IEntryPoint entryPoint_, address relayer) VerifyingPaymaster(entryPoint_, relayer) {}
}
