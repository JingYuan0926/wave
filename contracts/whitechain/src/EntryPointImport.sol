// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";

/// @notice LOCAL RUNS ONLY. EntryPoint v0.7 itself, so the Solidity tests and a local node can
/// deploy a copy. On Whitechain the canonical EntryPoint v0.7 at
/// 0x0000000071727De22E5E9d8BAf0edAc6f37da032 is used. Never deploy this to a public network.
contract LocalEntryPoint is EntryPoint {}
