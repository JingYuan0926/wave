// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice LOCAL TEST TOKEN. NOT REAL USDC. It has 6 decimals and an open mint, so anyone can
/// mint any amount. It holds no value. Deploy it only on the local devnet.
contract TestUSDC is ERC20 {
    constructor() ERC20("WAVE Test USDC (local only)", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
