// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibERC8286} from "./lib/LibERC8286.sol";

/// @notice The gas sponsor of the local network. An EIP-8141 paymaster: it pays the gas of a frame
/// transaction when the sponsor key signed that transaction.
/// Frame order: [VERIFY account with execution scope, VERIFY station with payment scope, SENDER...].
/// @dev `pay` reads no storage and no foreign state, so it passes the mempool rules. The server
/// holds the sponsor key and enforces the budgets before it signs. The chain cannot see them.
contract WaveGasStation {
    /// @dev Entry 0 belongs to the account's method. EIP-8141 also uses index 1 for a payer.
    uint256 private constant SPONSOR_ENTRY = 1;

    /// The address that must sign each sponsored transaction.
    address public immutable SPONSOR;
    /// The address that can take the balance back.
    address public immutable OWNER;

    error NotVerifyFrame();
    error NotPaymentScope();
    error NotSponsored();
    error NotOwner();
    error WithdrawFailed();

    event Withdrawn(address indexed to, uint256 amount);

    constructor(address sponsor, address owner) {
        SPONSOR = sponsor;
        OWNER = owner;
    }

    receive() external payable {}

    /// @dev The protocol checks a SECP256K1 entry before any frame runs. An empty `msg` makes
    /// that entry sign sig_hash, which commits every frame, the fees and the nonce. So this
    /// needs only to compare the signer. The order of the checks matters: SIGPARAM halts on an
    /// index out of range, and on the signer of an ARBITRARY entry.
    function pay() external {
        uint256 frame = LibERC8286.currentFrameIndex();
        if (LibERC8286.frameModeOf(frame) != LibERC8286.MODE_VERIFY) revert NotVerifyFrame();
        if (LibERC8286.allowedScope(frame) != LibERC8286.APPROVE_PAYMENT) revert NotPaymentScope();
        if (
            LibERC8286.signatureCount() <= SPONSOR_ENTRY
                || LibERC8286.signatureScheme(SPONSOR_ENTRY) != LibERC8286.SIG_SCHEME_SECP256K1
                || LibERC8286.signatureMsg(SPONSOR_ENTRY) != 0 || LibERC8286.signatureSigner(SPONSOR_ENTRY) != SPONSOR
        ) revert NotSponsored();
        LibERC8286.approveScope(LibERC8286.APPROVE_PAYMENT); // Exits the frame.
    }

    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != OWNER) revert NotOwner();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }
}
