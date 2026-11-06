// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice The initial configuration of an account, read from its own bytecode.
/// The account is an EIP-1167 clone. The configuration follows the runtime code, so the
/// address commits to it and creation writes no storage.
///
/// Layout of the appended bytes:
///   validator (20) || scopes (1) || modeBits (1) || route (1) || demoDelay (4) || initData
///
/// `validator` is the owner method of the account. initData belongs to that validator:
///   World ID: ownerNullifierHash (32) || externalNullifierHash (32) || rootSourceId (32).
///   Passkey:  x (32) || y (32) || flags (32). Flag bit 0 is BE and flag bit 1 is requireUV.
/// A main wallet with extra methods appends setupHash (32). See WaveAccount.setup.
/// An agent wallet appends master (20). Other wallets have no such bytes, so master reads as zero.
/// Forked from the ERC-8286 playground. WAVE adds demoDelay, setupHash and master.
library LibCloneConfig {
    uint256 private constant CLONE_PREFIX_LEN = 10;
    bytes10 private constant CLONE_PREFIX = hex"363d3d373d3d3d363d73";
    bytes15 private constant CLONE_SUFFIX = hex"5af43d82803e903d91602b57fd5bf3";
    uint256 private constant CLONE_CODE_LEN = 0x2d;
    uint256 internal constant HEADER_LEN = 27;
    uint256 internal constant INIT_LEN = 96;
    uint256 internal constant AGENT_ARGS_LEN = HEADER_LEN + INIT_LEN + 20;
    uint256 internal constant SETUP_ARGS_LEN = HEADER_LEN + INIT_LEN + 32;
    uint256 private constant FLAG_BE = 1;
    uint256 private constant FLAG_UV = 2;

    /// @dev True if `address(this)` is a clone that carries a configuration.
    function isClone() internal view returns (bool) {
        address self = address(this);
        uint256 size;
        assembly {
            size := extcodesize(self)
        }
        if (size < CLONE_CODE_LEN + HEADER_LEN) return false;
        bytes10 prefix;
        assembly {
            let p := mload(0x40)
            extcodecopy(self, p, 0, CLONE_PREFIX_LEN)
            prefix := mload(p)
        }
        return prefix == CLONE_PREFIX;
    }

    /// @dev The appended bytes. Empty for a non-clone.
    function args() internal view returns (bytes memory) {
        if (!isClone()) return "";
        return Clones.fetchCloneArgs(address(this));
    }

    function validator(bytes memory a) internal pure returns (address v) {
        if (a.length < HEADER_LEN) return address(0);
        assembly {
            v := shr(96, mload(add(a, 0x20)))
        }
    }

    function approvalScopes(bytes memory a) internal pure returns (uint8) {
        return a.length < HEADER_LEN ? 0 : uint8(a[20]);
    }

    function modeBits(bytes memory a) internal pure returns (uint8) {
        return a.length < HEADER_LEN ? 0 : uint8(a[21]);
    }

    function executionRoute(bytes memory a) internal pure returns (uint8) {
        return a.length < HEADER_LEN ? 0 : uint8(a[22]);
    }

    /// @dev Zero means real delays.
    function demoDelay(bytes memory a) internal pure returns (uint32 d) {
        if (a.length < HEADER_LEN) return 0;
        assembly {
            d := shr(224, mload(add(a, 0x37))) // 0x20 for the length word, 23 for the header bytes.
        }
    }

    /// @dev Returns zero values if the args hold no full initData.
    function initWords(bytes memory a) internal pure returns (uint256 owner, uint256 ext, bytes32 source) {
        if (a.length < HEADER_LEN + INIT_LEN) return (0, 0, 0);
        assembly {
            owner := mload(add(a, 0x3b)) // 0x20 + 27
            ext := mload(add(a, 0x5b))
            source := mload(add(a, 0x7b))
        }
    }

    /// @dev The initData words of an owner passkey, as the validator reads them.
    function ownerKey(bytes memory a) internal pure returns (bytes32 x, bytes32 y, bool be, bool uv) {
        (uint256 first, uint256 second, bytes32 flags) = initWords(a);
        return (bytes32(first), bytes32(second), uint256(flags) & FLAG_BE != 0, uint256(flags) & FLAG_UV != 0);
    }

    /// @dev The hash of the first extra methods and rules. Zero if the account has no setup.
    function setupHash(bytes memory a) internal pure returns (bytes32 h) {
        if (a.length != SETUP_ARGS_LEN) return bytes32(0);
        assembly {
            h := mload(add(a, 0x9b)) // 0x20 + 123
        }
    }

    /// @dev The main wallet that administers this account. Zero for a main wallet.
    function master(bytes memory a) internal pure returns (address m) {
        if (a.length != AGENT_ARGS_LEN) return address(0);
        assembly {
            m := shr(96, mload(add(a, 0x9b))) // 0x20 + 123
        }
    }

    /// @dev True if `target` holds the exact clone code of `implementation`, with agent args that
    /// name `owner` as master. A contract cannot fake this, because the check reads its code.
    function isAgentClone(address target, address implementation, address owner) internal view returns (bool) {
        if (target.code.length != CLONE_CODE_LEN + AGENT_ARGS_LEN) return false;
        bytes memory code = target.code;
        bytes32 expected = keccak256(abi.encodePacked(CLONE_PREFIX, implementation, CLONE_SUFFIX));
        bytes32 found;
        address named;
        assembly {
            found := keccak256(add(code, 0x20), CLONE_CODE_LEN)
            named := shr(96, mload(add(add(code, 0x20), sub(mload(code), 20))))
        }
        return found == expected && named == owner;
    }
}
