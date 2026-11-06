// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibClone} from "solady/src/utils/LibClone.sol";
import {AgentRule} from "../../src/interfaces/IWaveAgent.sol";
import {WaveAccount4337} from "./WaveAccount4337.sol";

/// @notice Deploys WaveAccount4337 clones at addresses that depend on every setup value.
/// The EntryPoint calls `createAccount` through the user operation's initCode, so a wallet can
/// receive tokens at its address before its first transaction.
contract WaveAccount4337Factory {
    address public immutable implementation;

    event AccountCreated(address indexed account, bytes32 x, bytes32 y);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function createAccount(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] calldata rules)
        external
        returns (address account)
    {
        bytes32 salt = saltOf(x, y, backupEligible, requireUV, rules);
        account = LibClone.predictDeterministicAddress(implementation, salt, address(this));
        if (account.code.length != 0) return account;
        LibClone.cloneDeterministic(implementation, salt);
        WaveAccount4337(payable(account)).initialize(x, y, backupEligible, requireUV, rules);
        emit AccountCreated(account, x, y);
    }

    function getAddress(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] calldata rules)
        external
        view
        returns (address)
    {
        return LibClone.predictDeterministicAddress(
            implementation, saltOf(x, y, backupEligible, requireUV, rules), address(this)
        );
    }

    function saltOf(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] calldata rules)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(x, y, backupEligible, requireUV, rules));
    }
}
