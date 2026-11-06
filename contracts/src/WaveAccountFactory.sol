// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice Creates WAVE accounts as EIP-1167 clones with their configuration appended to their
/// code (see LibCloneConfig). Creation writes no storage, so a DEFAULT frame can deploy an
/// account inside the state gas budget of the validation prefix.
/// Forked from the ERC-8286 playground factory.
contract WaveAccountFactory {
    event AccountCreated(address indexed account, address indexed implementation, bytes args, bytes32 salt);

    uint256 private constant ARGS_LEN = 123; // 27 header bytes + 96 initData bytes.
    uint256 private constant AGENT_ARGS_LEN = 143; // ARGS_LEN + 20 master bytes.

    modifier wellFormed(address implementation, bytes calldata args) {
        require(implementation.code.length != 0, "no implementation");
        require(args.length == ARGS_LEN || args.length == AGENT_ARGS_LEN, "bad config length");
        require(address(bytes20(args[0:20])) != address(0), "validator required");
        require(uint8(args[20]) == 3, "scopes must be 3");
        require(uint8(args[22]) == 1, "contract route only");
        if (args.length == AGENT_ARGS_LEN) {
            require(address(bytes20(args[123:143])) != address(0), "master required");
            require(uint256(bytes32(args[27:59])) == 0, "agent has no owner");
        }
        _;
    }

    /// @dev The same bytes that OpenZeppelin's cloneDeterministicWithImmutableArgs deploys.
    /// A bare CREATE2, because Create2.deploy uses SELFBALANCE, a banned opcode in the prefix.
    function createAccount(address implementation, bytes calldata args, bytes32 salt)
        external
        wellFormed(implementation, args)
        returns (address account)
    {
        bytes memory code = abi.encodePacked(
            hex"61",
            uint16(args.length + 0x2d),
            hex"3d81600a3d39f3363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            args
        );
        assembly ("memory-safe") {
            account := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(account != address(0), "create2 failed");
        emit AccountCreated(account, implementation, args, salt);
    }

    function predict(address implementation, bytes calldata args, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddressWithImmutableArgs(implementation, args, salt);
    }
}
