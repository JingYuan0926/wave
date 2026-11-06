// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {IERC8286FrameAccount} from "./interfaces/IERC8286FrameAccount.sol";
import {IWaveMethod} from "./interfaces/IWaveMethod.sol";
import {IWaveConfig, WaveTier} from "./interfaces/IWaveConfig.sol";
import {IWaveAgent, AgentRule} from "./interfaces/IWaveAgent.sol";
import {IERC7579Module, IERC7579ModuleConfig, IERC7579Execution, Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC7579Utils} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibCloneConfig} from "./lib/LibCloneConfig.sol";
import {LibWaveIdentity} from "./lib/LibWaveIdentity.sol";
import {LibWaveAgent} from "./lib/LibWaveAgent.sol";
import {WavePolicy} from "./WavePolicy.sol";

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice The WAVE account. Forked from the ERC-8286 playground account, contract route only.
/// `nonce_keys[0]` names the validator. Validators run by DELEGATECALL in a VERIFY frame.
/// Six selectors can start a SENDER frame. Configuration runs only from executeScheduled.
/// An agent wallet is the same contract with a nonzero `master` clone arg. It has no World ID owner.
/// Its master administers it through IWaveAgent, and its agent key acts through the spending tiers.
contract WaveAccount is WavePolicy, IERC8286FrameAccount, IERC7579Execution, IWaveConfig, IWaveAgent {
    bytes32 internal constant MODE_SINGLE = bytes32(0);
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));

    /// @dev The signer sets the fee, and gas fees pass no spending rule. So these limits stop a
    /// method with no ETH rights from sending the balance to the block producer as fees.
    /// The app signs 5 gwei and at most about 5M gas.
    uint256 public constant MAX_FEE_PER_GAS = 50 gwei;
    uint256 public constant MAX_TX_COST = 0.05 ether;

    /// @dev A listed token before the owner sets rules. Not storage: the prefix must not need it
    /// and every clone shares it.
    address private immutable DEFAULT_TOKEN;

    /// @dev The only method of an agent wallet. Immutable, so an agent wallet never runs
    /// other validator code.
    address private immutable AGENT_VALIDATOR;

    /// @dev A clone runs this code, so `address(this)` in the constructor names the implementation.
    address private immutable IMPLEMENTATION = address(this);

    mapping(address => bool) private _installed;

    /// @dev Set only inside executeScheduled. TSTORE is legal here: this is not the prefix.
    bool private transient _inScheduled;

    error Unauthorized();
    error NotVerifyFrame();
    error NotScheduled();
    error NoValidator();
    error ValidatorNotInstalled(address validator);
    error ValidatorReverted();
    error ValidationFailed();
    error FeeTooHigh(uint256 maxFeePerGas, uint256 maxCost);
    error SenderFrameNotAllowed(uint256 frameIndex);
    error UnsupportedMode();
    error UnsupportedModuleType();
    error AlreadyInstalled(address module);
    error NotInstalled(address module);
    error ModuleCallFailed(address module);
    error CannotRemoveWorldId();
    error ZeroValue();
    error NoExecutors();
    error NotMaster();
    error AlreadySetUp();
    error AgentPaused();
    error WithdrawFailed();

    event OwnerChanged(uint256 ownerNullifierHash);
    event RootSourceChanged(bytes32 sourceId);
    event AgentKeyChanged(address signer);
    event AgentPauseChanged(bool paused);
    event AgentWithdrawn(address indexed token, uint256 amount);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    /// @dev A DEFAULT frame can also reach `verify`, so the mode must be checked.
    modifier onlyVerifyFrame() {
        if (LibERC8286.frameModeOf(LibERC8286.currentFrameIndex()) != LibERC8286.MODE_VERIFY) {
            revert NotVerifyFrame();
        }
        _;
    }

    /// @dev Configuration runs only as a self-call from inside executeScheduled.
    modifier onlyScheduled() {
        if (msg.sender != address(this) || !_inScheduled) revert NotScheduled();
        _;
    }

    /// @dev A main wallet has no master, so this rejects every caller there.
    modifier onlyMaster() {
        address m = _master();
        if (m == address(0) || msg.sender != m) revert NotMaster();
        _;
    }

    modifier onlyFrameValidator(uint256 moduleTypeId) {
        if (moduleTypeId != LibERC8286.MODULE_TYPE_FRAME_VALIDATOR) revert UnsupportedModuleType();
        _;
    }

    constructor(address defaultToken_, address agentValidator_) {
        DEFAULT_TOKEN = defaultToken_;
        AGENT_VALIDATOR = agentValidator_;
    }

    /// @dev The account holds ETH, and on the devnet it pays its own gas from this balance.
    receive() external payable {}

    // ---------------------------------------------------------------------
    // WavePolicy hooks
    // ---------------------------------------------------------------------

    function _approver() internal view override returns (address) {
        return LibERC8286.validatorFromNonceKey();
    }

    function _worldId() internal view override returns (address) {
        return LibCloneConfig.validator(LibCloneConfig.args());
    }

    function _demoDelay() internal view override returns (uint32) {
        return LibCloneConfig.demoDelay(LibCloneConfig.args());
    }

    function _defaultToken() internal view override returns (address) {
        return DEFAULT_TOKEN;
    }

    function _master() internal view override returns (address) {
        return LibCloneConfig.master(LibCloneConfig.args());
    }

    /// @dev An agent wallet has no agent wallets. So the agent exceptions apply only to a main wallet.
    function _isOwnAgent(address target) internal view override returns (bool) {
        return _master() == address(0) && LibCloneConfig.isAgentClone(target, IMPLEMENTATION, address(this));
    }

    // ---------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------

    /// @dev World ID is always a method of a main wallet, and never a method of an agent wallet.
    function isValidatorInstalled(address module) public view returns (bool) {
        if (_installed[module]) return true;
        bytes memory a = LibCloneConfig.args();
        return module == LibCloneConfig.validator(a) && LibCloneConfig.master(a) == address(0);
    }

    function verify(bytes calldata data) external override onlyVerifyFrame returns (uint8 approvalMode) {
        (uint256 feePerGas, uint256 cost) = (LibERC8286.maxFeePerGas(), LibERC8286.maxCost());
        if (feePerGas > MAX_FEE_PER_GAS || cost > MAX_TX_COST) revert FeeTooHigh(feePerGas, cost);

        address validator = LibERC8286.validatorFromNonceKey();
        if (validator == address(0)) revert NoValidator();
        if (!isValidatorInstalled(validator)) revert ValidatorNotInstalled(validator);

        uint8 allowedScope = LibERC8286.allowedScope(LibERC8286.currentFrameIndex());
        (bool ok, bytes memory ret) = validator.delegatecall(abi.encodeCall(IFrameValidator.validateFrame, (data)));
        if (!ok) revert ValidatorReverted();

        uint8 granted = abi.decode(ret, (uint8)) & allowedScope;
        if (granted == LibERC8286.APPROVE_NONE) revert ValidationFailed();
        if (granted & LibERC8286.APPROVE_EXECUTION != 0) _requireAllowedSenderFrames();
        LibERC8286.approveScope(granted); // Exits the frame.
    }

    /// @dev ERC-8286 verify step 5, plus the entry-point allow-list. ERC-8286 says to clear the
    /// execution bit. This code reverts with a reason instead, which has the same effect:
    /// APPROVE with payment alone also reverts while the sender is not approved.
    /// Every frame that is not DEFAULT or VERIFY is checked, so a new mode fails closed.
    /// No SLOAD. FRAMEPARAM and FRAMEDATALOAD read only the envelope.
    function _requireAllowedSenderFrames() private view {
        uint256 n = LibERC8286.frameCount();
        for (uint256 i; i < n; i++) {
            uint256 mode = LibERC8286.frameModeOf(i);
            if (mode == LibERC8286.MODE_DEFAULT || mode == LibERC8286.MODE_VERIFY) continue;
            if (mode != LibERC8286.MODE_SENDER || LibERC8286.frameTarget(i) != address(this)) {
                revert SenderFrameNotAllowed(i);
            }
            bytes4 s;
            assembly ("memory-safe") {
                s := shl(224, shr(224, framedataload(0, i)))
            }
            if (
                s != this.execute.selector && s != this.schedule.selector && s != this.approveRecovery.selector
                    && s != this.cancel.selector && s != this.executeScheduled.selector && s != this.tighten.selector
            ) revert SenderFrameNotAllowed(i);
        }
    }

    function supportsApprovalMode(uint8 approvalMode) public view override returns (bool) {
        uint8 scopes = LibCloneConfig.approvalScopes(LibCloneConfig.args());
        return approvalMode != LibERC8286.APPROVE_NONE && approvalMode & ~scopes == 0;
    }

    function executionRoute() public pure override returns (uint8) {
        return LibERC8286.EXECUTION_ROUTE_CONTRACT;
    }

    // ---------------------------------------------------------------------
    // SENDER entry points
    // ---------------------------------------------------------------------

    function execute(bytes32 mode, bytes calldata executionCalldata) external payable override onlySelf {
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

    /// @dev Takes the batch itself and classifies it onchain. See WavePolicy._classify.
    function schedule(uint8 kind, bytes calldata batch, bytes32 salt) external onlySelf returns (bytes32) {
        return _schedule(kind, batch, salt);
    }

    function approveRecovery(bytes32 id) external onlySelf {
        _approveRecovery(id);
    }

    function cancel(bytes32 id) external onlySelf {
        _cancel(id);
    }

    function tighten(address token, WaveTier[] calldata tiers) external onlySelf {
        _tighten(token, tiers);
    }

    /// @dev Anyone can call this, also from a plain transaction. The stored hash, the delay
    /// and the version gate it. A pause also stops a transfer that the agent queued earlier.
    function executeScheduled(bytes32 id, bytes calldata batch) external {
        if (LibWaveAgent.layout().paused) revert AgentPaused();
        _consume(id, batch);
        _inScheduled = true;
        ERC7579Utils.execBatch(batch, ERC7579Utils.EXECTYPE_DEFAULT);
        _inScheduled = false;
    }

    // ---------------------------------------------------------------------
    // Configuration: only from executeScheduled
    // ---------------------------------------------------------------------

    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        override(IERC7579ModuleConfig, IWaveConfig)
        onlyScheduled
        onlyFrameValidator(moduleTypeId)
    {
        if (isValidatorInstalled(module)) revert AlreadyInstalled(module);
        _installed[module] = true;
        (bool ok,) = module.delegatecall(abi.encodeCall(IERC7579Module.onInstall, (initData)));
        if (!ok) revert ModuleCallFailed(module);
        _enroll(module, IWaveMethod(module).methodBit(), IWaveMethod(module).isSynced(initData));
        _bumpConfigVersion();
        emit ModuleInstalled(moduleTypeId, module);
    }

    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        override(IERC7579ModuleConfig, IWaveConfig)
        onlyScheduled
        onlyFrameValidator(moduleTypeId)
    {
        if (module == _worldId()) revert CannotRemoveWorldId();
        if (!_installed[module]) revert NotInstalled(module);
        _installed[module] = false;
        (bool ok,) = module.delegatecall(abi.encodeCall(IERC7579Module.onUninstall, (deInitData)));
        if (!ok) revert ModuleCallFailed(module);
        _unenroll(module);
        _bumpConfigVersion();
        emit ModuleUninstalled(moduleTypeId, module);
    }

    function setTiers(address token, WaveTier[] calldata tiers) external onlyScheduled {
        _setTiers(token, tiers);
        _bumpConfigVersion();
    }

    function setOwner(uint256 ownerNullifierHash) external onlyScheduled {
        if (ownerNullifierHash == 0) revert ZeroValue();
        LibWaveIdentity.layout().ownerNullifier = ownerNullifierHash;
        _bumpConfigVersion();
        emit OwnerChanged(ownerNullifierHash);
    }

    function setRootSource(bytes32 sourceId) external onlyScheduled {
        if (sourceId == 0) revert ZeroValue();
        LibWaveIdentity.layout().rootSource = sourceId;
        _bumpConfigVersion();
        emit RootSourceChanged(sourceId);
    }

    // ---------------------------------------------------------------------
    // Agent administration: only from the master
    // ---------------------------------------------------------------------

    /// @dev The first rules name the agent method, which no tighten can add. So they come here.
    function agentSetup(address signer, AgentRule[] calldata rules) external onlyMaster {
        LibWaveAgent.Layout storage a = LibWaveAgent.layout();
        if (a.setUp) revert AlreadySetUp();
        a.setUp = true;
        _setAgentKey(signer);
        for (uint256 i; i < rules.length; i++) _setTiers(rules[i].token, rules[i].tiers);
    }

    /// @dev The version bump also stops each transfer that the agent queued earlier.
    function agentRevoke() external onlyMaster {
        if (!_installed[AGENT_VALIDATOR]) revert NotInstalled(AGENT_VALIDATOR);
        _installed[AGENT_VALIDATOR] = false;
        _unenroll(AGENT_VALIDATOR);
        LibWaveAgent.layout().signer = address(0);
        _bumpConfigVersion();
        emit AgentKeyChanged(address(0));
    }

    function agentPause() external onlyMaster {
        LibWaveAgent.layout().paused = true;
        emit AgentPauseChanged(true);
    }

    function agentUnpause() external onlyMaster {
        LibWaveAgent.layout().paused = false;
        emit AgentPauseChanged(false);
    }

    function agentTighten(address token, WaveTier[] calldata tiers) external onlyMaster {
        _tightenRules(token, tiers);
    }

    function agentSetTiers(address token, WaveTier[] calldata tiers) external onlyMaster {
        _setTiers(token, tiers);
        _bumpConfigVersion();
    }

    /// @dev This also restores the agent after a revoke.
    function agentSetKey(address signer) external onlyMaster {
        _setAgentKey(signer);
    }

    /// @dev The funds can go only to the master. Token address(0) means ETH.
    function agentWithdraw(address token, uint256 amount) external onlyMaster {
        address to = msg.sender;
        (bool ok, bytes memory ret) = token == address(0)
            ? to.call{value: amount}("")
            : token.call(abi.encodeWithSelector(IERC20Transfer.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert WithdrawFailed();
        emit AgentWithdrawn(token, amount);
    }

    function _setAgentKey(address signer) private {
        if (signer == address(0)) revert ZeroValue();
        if (_installed[AGENT_VALIDATOR]) _unenroll(AGENT_VALIDATOR);
        _installed[AGENT_VALIDATOR] = true;
        _enroll(AGENT_VALIDATOR, IWaveMethod(AGENT_VALIDATOR).methodBit(), false);
        LibWaveAgent.layout().signer = signer;
        _bumpConfigVersion();
        emit AgentKeyChanged(signer);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function master() external view returns (address) {
        return _master();
    }

    function agentValidator() external view returns (address) {
        return AGENT_VALIDATOR;
    }

    function agentKey() external view returns (address) {
        return LibWaveAgent.layout().signer;
    }

    function agentPaused() external view returns (bool) {
        return LibWaveAgent.layout().paused;
    }

    /// @dev True if `target` is an agent wallet that names this main wallet as master.
    /// Anyone can deploy such a wallet. The AgentLinked events list the wallets of the owner.
    function isOwnAgent(address target) external view returns (bool) {
        return _isOwnAgent(target);
    }

    function worldIdValidator() external view returns (address) {
        return _worldId();
    }

    function defaultToken() external view returns (address) {
        return DEFAULT_TOKEN;
    }

    function demoDelay() external view returns (uint32) {
        return _demoDelay();
    }

    function ownerNullifier() external view returns (uint256 owner) {
        (owner,,) = LibWaveIdentity.read();
    }

    function externalNullifier() external view returns (uint256 ext) {
        (, ext,) = LibWaveIdentity.read();
    }

    function rootSource() external view returns (bytes32 source) {
        (,, source) = LibWaveIdentity.read();
    }

    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata)
        external
        view
        override
        returns (bool)
    {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR && isValidatorInstalled(module);
    }

    function executeFromExecutor(bytes32, bytes calldata) external payable override returns (bytes[] memory) {
        revert NoExecutors();
    }

    function accountId() external pure override returns (string memory) {
        return "wave.account.0.1.0";
    }

    function supportsExecutionMode(bytes32 mode) public view override returns (bool) {
        if (mode == MODE_SINGLE || mode == MODE_BATCH) return true;
        return LibCloneConfig.modeBits(LibCloneConfig.args()) & LibERC8286.modeBit(mode) != 0;
    }

    function supportsModule(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }
}
