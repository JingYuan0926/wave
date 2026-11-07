// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {IAccountExecute} from "@account-abstraction/contracts/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC7579Utils} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {WavePolicy} from "../../src/WavePolicy.sol";
import {WaveTier} from "../../src/interfaces/IWaveConfig.sol";
import {AgentRule} from "../../src/interfaces/IWaveAgent.sol";
import {WavePasskeyValidator} from "./WavePasskeyValidator.sol";

/// @notice WAVE as an ERC-4337 (EntryPoint v0.7) account, for chains without EIP-8141, such as
/// Whitechain. A passkey owns it: no seed phrase and no EOA key. The spending rules, period
/// caps and delay queue are the same WavePolicy code as the frame-transaction account.
///
/// Whitechain has no World ID, so the owner passkey is the owner method in WavePolicy:
/// `_ownerValidator()` returns the passkey validator. Looser rules still need the owner and 48 hours.
///
/// A user operation calls `executeUserOp`. Its `signature` is abi.encode(validator, webauthnSig),
/// and its callData is executeUserOp.selector followed by one call to this account:
/// execute, schedule, cancel, tighten or executeScheduled.
contract WaveAccount4337 is WavePolicy, IAccount, IAccountExecute {
    bytes32 internal constant MODE_SINGLE = bytes32(0);
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));

    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    IEntryPoint public immutable entryPoint;
    /// The owner method. Shared by all accounts; it keys passkeys by account address.
    address public immutable passkeyValidator;
    address private immutable DEFAULT_TOKEN;
    /// Zero on a real deployment. A demo deployment shortens every delay to this value.
    uint32 private immutable DEMO_DELAY;

    bool private _initialized;
    address private transient _currentApprover;
    bool private transient _inScheduled;

    error Unauthorized();
    error NotScheduled();
    error AlreadyInitialized();
    error UnsupportedMode();
    error CallNotAllowed(bytes4 selector);

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert Unauthorized();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    modifier onlyScheduled() {
        if (msg.sender != address(this) || !_inScheduled) revert NotScheduled();
        _;
    }

    constructor(IEntryPoint entryPoint_, address passkeyValidator_, address defaultToken_, uint32 demoDelay_) {
        entryPoint = entryPoint_;
        passkeyValidator = passkeyValidator_;
        DEFAULT_TOKEN = defaultToken_;
        DEMO_DELAY = demoDelay_;
        _initialized = true; // The implementation itself can never be set up.
    }

    receive() external payable {}

    /// @dev The factory calls this in the same transaction as the clone. The factory salt
    /// commits to every argument, so nobody can set up the address with other values.
    function initialize(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] calldata rules)
        external
    {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        WavePasskeyValidator(passkeyValidator).setKey(x, y, backupEligible, requireUV);
        for (uint256 i; i < rules.length; i++) {
            _validateTiers(rules[i].tiers);
            _writeTiers(rules[i].token, rules[i].tiers);
            emit TiersChanged(rules[i].token, false);
        }
    }

    // ---------------------------------------------------------------------
    // ERC-4337
    // ---------------------------------------------------------------------

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        validationData = _validateSignature(userOp, userOpHash);
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok); // The EntryPoint checks the deposit itself.
        }
    }

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        private
        view
        returns (uint256)
    {
        // Every operation must run through executeUserOp, which sets the approver.
        if (userOp.callData.length < 8 || bytes4(userOp.callData[:4]) != this.executeUserOp.selector) {
            return SIG_VALIDATION_FAILED;
        }
        if (!_allowedInner(bytes4(userOp.callData[4:8]))) return SIG_VALIDATION_FAILED;
        (address validator, bytes memory sig) = abi.decode(userOp.signature, (address, bytes));
        if (!isValidatorInstalled(validator)) return SIG_VALIDATION_FAILED;
        if (!WavePasskeyValidator(validator).isValidSignature(address(this), userOpHash, sig)) {
            return SIG_VALIDATION_FAILED;
        }
        return SIG_VALIDATION_SUCCESS;
    }

    /// @dev The approver is the validator from the signature, which validateUserOp checked.
    function executeUserOp(PackedUserOperation calldata userOp, bytes32) external onlyEntryPoint {
        (address validator,) = abi.decode(userOp.signature, (address, bytes));
        _currentApprover = validator;
        (bool ok, bytes memory ret) = address(this).call(userOp.callData[4:]);
        _currentApprover = address(0);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _allowedInner(bytes4 s) private pure returns (bool) {
        return s == this.execute.selector || s == this.schedule.selector || s == this.cancel.selector
            || s == this.tighten.selector || s == this.executeScheduled.selector;
    }

    // ---------------------------------------------------------------------
    // Entry points (self-calls from executeUserOp)
    // ---------------------------------------------------------------------

    /// @dev ERC-7579 single or batch mode. Each call must be a transfer that its tier allows now.
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable onlySelf {
        if (mode == MODE_SINGLE) {
            (address target, uint256 value, bytes calldata data) = ERC7579Utils.decodeSingle(executionCalldata);
            _enforce(target, value, data);
            ERC7579Utils.execSingle(executionCalldata, ERC7579Utils.EXECTYPE_DEFAULT);
        } else if (mode == MODE_BATCH) {
            Execution[] calldata calls = ERC7579Utils.decodeBatch(executionCalldata);
            for (uint256 i; i < calls.length; i++) _enforce(calls[i].target, calls[i].value, calls[i].callData);
            ERC7579Utils.execBatch(executionCalldata, ERC7579Utils.EXECTYPE_DEFAULT);
        } else {
            revert UnsupportedMode();
        }
    }

    /// @dev Queues a batch that needs a delay. Only normal batches: this account has no recovery.
    function schedule(uint8 kind, bytes calldata batch, bytes32 salt) external onlySelf returns (bytes32) {
        if (kind != KIND_NORMAL) revert BadRecovery();
        return _schedule(kind, batch, salt);
    }

    function cancel(bytes32 id) external onlySelf {
        _cancel(id);
    }

    function tighten(address token, WaveTier[] calldata tiers, uint96 dailyLimit) external onlySelf {
        _tighten(token, tiers, dailyLimit);
    }

    /// @dev Anyone can call this, also from a plain transaction. The stored hash, the delay and
    /// the configuration version gate it.
    function executeScheduled(bytes32 id, bytes calldata batch) external {
        _consume(id, batch);
        _inScheduled = true;
        ERC7579Utils.execBatch(batch, ERC7579Utils.EXECTYPE_DEFAULT);
        _inScheduled = false;
    }

    /// @dev The looser path: owner passkey, then the 48 hour configuration delay.
    function setTiers(address token, WaveTier[] calldata tiers, uint96 dailyLimit) external onlyScheduled {
        _setRules(token, tiers, dailyLimit);
        _bumpConfigVersion();
    }

    // ---------------------------------------------------------------------
    // Views and WavePolicy hooks
    // ---------------------------------------------------------------------

    function isValidatorInstalled(address validator) public view returns (bool) {
        return validator == passkeyValidator;
    }

    function defaultToken() external view returns (address) {
        return DEFAULT_TOKEN;
    }

    function demoDelay() external view returns (uint32) {
        return DEMO_DELAY;
    }

    function getNonce() external view returns (uint256) {
        return entryPoint.getNonce(address(this), 0);
    }

    function _approver() internal view override returns (address) {
        return _currentApprover;
    }

    function _ownerValidator() internal view override returns (address) {
        return passkeyValidator;
    }

    function _demoDelay() internal view override returns (uint32) {
        return DEMO_DELAY;
    }

    function _defaultToken() internal view override returns (address) {
        return DEFAULT_TOKEN;
    }
}
