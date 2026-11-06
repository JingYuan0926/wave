// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC7579Utils} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {IWaveConfig, WaveTier} from "./interfaces/IWaveConfig.sol";
import {IWaveAgent} from "./interfaces/IWaveAgent.sol";

/// @notice Spending tiers, period counters, delay queue, recovery and configuration version.
/// Uses no EIP-8141 opcode, so stock solc and forge can test it.
/// All this logic runs in SENDER frames. Nothing here runs in the validation prefix.
abstract contract WavePolicy {
    /// One storage slot. A fixed window that starts again when `period` has passed.
    struct Period {
        uint40 start;
        uint96 spent;
    }

    /// Two storage slots.
    struct Pending {
        bytes32 callsHash;
        uint40 notBefore;
        uint40 createdAt;
        uint32 version;
        uint8 status;
        uint8 kind;
        uint8 approvals; // Bit mask of the methods that approved a recovery.
        uint8 proposerBit;
    }

    /// @custom:storage-location erc7201:wave.account.policy
    struct Layout {
        uint32 configVersion;
        uint8 enrolledMask; // Method bits of the enrolled methods other than World ID.
        uint8 syncedMask; // The enrolled methods that are synced passkeys.
        mapping(address validator => uint8 bit) methodBit;
        mapping(address token => WaveTier[]) tiers;
        mapping(bytes32 key => Period) periods;
        mapping(bytes32 id => Pending) pending;
        mapping(address token => uint40) tightenedAt;
    }

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_COLLECTING = 1;
    uint8 public constant STATUS_QUEUED = 2;
    uint8 public constant STATUS_DONE = 3;
    uint8 public constant STATUS_CANCELLED = 4;
    uint8 public constant KIND_NORMAL = 0;
    uint8 public constant KIND_RECOVERY = 1;

    uint8 public constant WORLD_ID_BIT = 1;
    uint8 public constant SMALL_TIER = 0x80;

    uint32 public constant OTHER_CALL_DELAY = 24 hours;
    uint32 public constant CONFIG_DELAY = 48 hours;
    uint32 public constant RECOVERY_DELAY = 7 days;

    bytes4 private constant ERC20_TRANSFER = 0xa9059cbb;

    /// Classes of a call from a main wallet to its own agent wallet.
    uint8 private constant AGENT_NONE = 0;
    uint8 private constant AGENT_ANY_METHOD = 1; // Any enrolled method, no delay.
    uint8 private constant AGENT_WORLD_ID = 2; // World ID, no delay.
    uint8 private constant AGENT_LOOSEN = 3; // World ID, 48 hours.

    /// @dev keccak256(abi.encode(uint256(keccak256("wave.account.policy")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SLOT = 0x53224122d2a8b23658e8a1b8823e5e85ffcbf5d30e66c1092815ce1714f78c00;

    error NoTier(address token, uint256 amount);
    error MethodNotAllowed(address validator);
    error SyncedNotAllowed(address validator);
    error NeedsSchedule(uint32 delay);
    error NeedsQueue();
    error NoDelayNeeded();
    error SelfCall();
    error NotSchedulable(address target, bytes4 selector);
    error BadRecovery();
    error BadStatus(bytes32 id, uint8 status);
    error TooEarly(uint40 notBefore);
    error StaleVersion(uint32 stored, uint32 current);
    error RuleChanged(address token);
    error WrongCalls(bytes32 id);
    error OnlyWorldId();
    error NotEnrolled(address validator);
    error NotStricter(uint256 index);
    error BadTiers();
    error BadMethodBit(uint8 bit);

    event Scheduled(
        bytes32 indexed id, uint8 kind, address proposer, uint40 notBefore, uint32 version, bytes batch
    );
    event RecoveryApproved(bytes32 indexed id, address validator, uint8 approvals, uint40 notBefore);
    event Cancelled(bytes32 indexed id, address validator);
    event Executed(bytes32 indexed id);
    event ConfigVersionBumped(uint32 version);
    event TiersChanged(address indexed token, bool tightened);
    /// The list of agent wallets of a main wallet. Only that wallet can emit this.
    event AgentLinked(address indexed agent);

    /// @dev The validator that approved this transaction. TXPARAM(0x10) in the account.
    function _approver() internal view virtual returns (address);

    /// @dev The World ID validator. The clone args hold it in the account.
    function _worldId() internal view virtual returns (address);

    /// @dev Zero means real delays. When nonzero, every delay is min(real, this value).
    function _demoDelay() internal view virtual returns (uint32);

    /// @dev One token that counts as listed before it has tiers. Zero if none.
    function _defaultToken() internal view virtual returns (address);

    /// @dev The main wallet that administers this account. Zero for a main wallet.
    function _master() internal view virtual returns (address) {
        return address(0);
    }

    /// @dev True if `target` is an agent wallet of this main wallet.
    function _isOwnAgent(address) internal view virtual returns (bool) {
        return false;
    }

    function _l() internal pure returns (Layout storage l) {
        assembly {
            l.slot := SLOT
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function configVersion() public view returns (uint32) {
        return _l().configVersion;
    }

    function tiersOf(address token) external view returns (WaveTier[] memory) {
        return _l().tiers[token];
    }

    /// @dev Returns the bit of the method. Zero if the method is not enrolled.
    function methodBitOf(address validator) public view returns (uint8) {
        if (validator == _worldId()) return WORLD_ID_BIT;
        uint8 bit = _l().methodBit[validator];
        return _l().enrolledMask & bit;
    }

    function enrolledMask() external view returns (uint8) {
        return _l().enrolledMask;
    }

    function syncedMask() external view returns (uint8) {
        return _l().syncedMask;
    }

    function pendingOf(bytes32 id) external view returns (Pending memory) {
        return _l().pending[id];
    }

    /// @dev The amount used in the current window of one tier.
    function spentOf(address token, uint256 tierIndex) external view returns (uint96) {
        WaveTier[] storage ts = _l().tiers[token];
        if (tierIndex >= ts.length) return 0;
        return _used(_l().periods[_periodKey(token, tierIndex)], ts[tierIndex].period);
    }

    function tightenedAt(address token) external view returns (uint40) {
        return _l().tightenedAt[token];
    }

    function isListed(address token) public view returns (bool) {
        return token == address(0) || token == _defaultToken() || _l().tiers[token].length != 0;
    }

    /// @dev The real delay after the demo limit.
    function effectiveDelay(uint32 real) public view returns (uint32) {
        uint32 d = _demoDelay();
        return d != 0 && d < real ? d : real;
    }

    // ---------------------------------------------------------------------
    // Methods
    // ---------------------------------------------------------------------

    function _bitOf(address validator) internal view returns (uint8 bit) {
        bit = methodBitOf(validator);
        if (bit == 0) revert NotEnrolled(validator);
    }

    /// @dev The validator names its own bit, so slot N is always bit N and tiers can name a
    /// slot before it is enrolled. Bit 0 is World ID and bit 7 is the small flag.
    function _enroll(address validator, uint8 bit, bool synced) internal {
        Layout storage l = _l();
        if (bit < 2 || bit > 0x40 || bit & (bit - 1) != 0 || l.enrolledMask & bit != 0) revert BadMethodBit(bit);
        l.methodBit[validator] = bit;
        l.enrolledMask |= bit;
        if (synced) l.syncedMask |= bit;
        else l.syncedMask &= ~bit;
    }

    function _unenroll(address validator) internal {
        Layout storage l = _l();
        uint8 bit = l.methodBit[validator];
        l.enrolledMask &= ~bit;
        l.syncedMask &= ~bit;
    }

    // ---------------------------------------------------------------------
    // Transfers
    // ---------------------------------------------------------------------

    function _periodKey(address token, uint256 tierIndex) internal pure returns (bytes32) {
        return keccak256(abi.encode(token, tierIndex));
    }

    function _used(Period storage p, uint24 period) internal view returns (uint96) {
        return block.timestamp >= uint256(p.start) + period ? 0 : p.spent;
    }

    /// @dev The first tier whose `upTo` covers `amount` and whose cap still has room.
    /// A used-up cap moves the transfer to the next tier.
    function _selectTier(address token, uint256 amount) internal view returns (uint256 index, WaveTier memory t) {
        WaveTier[] storage ts = _l().tiers[token];
        for (uint256 i; i < ts.length; i++) {
            t = ts[i];
            if (amount > t.upTo) continue;
            if (t.cap != 0 && amount + _used(_l().periods[_periodKey(token, i)], t.period) > t.cap) continue;
            return (i, t);
        }
        revert NoTier(token, amount);
    }

    /// @dev Checks the rule for one transfer. Returns a tier index of type(uint256).max for
    /// the default rule, which has no counter.
    function _checkTransfer(address v, address token, uint256 amount)
        internal
        view
        returns (uint256 index, WaveTier memory t)
    {
        if (_l().tiers[token].length == 0) {
            if (v != _worldId()) revert MethodNotAllowed(v); // Default rule: World ID only.
            return (type(uint256).max, t);
        }
        (index, t) = _selectTier(token, amount);
        uint8 bit = methodBitOf(v);
        if (t.methods & bit == 0) revert MethodNotAllowed(v);
        if (bit & _l().syncedMask != 0 && t.methods & SMALL_TIER == 0) revert SyncedNotAllowed(v);
    }

    /// @dev Checks the rule and adds to the shared counter. Returns the tier delay. The counter
    /// key holds no validator, so all methods share one total. The caller reverts if the
    /// delay is not allowed in its path, which undoes the count.
    function _authorizeTransfer(address token, uint256 amount) internal returns (uint32) {
        (uint256 i, WaveTier memory t) = _checkTransfer(_approver(), token, amount);
        if (t.cap != 0) {
            Period storage p = _l().periods[_periodKey(token, i)];
            if (block.timestamp >= uint256(p.start) + t.period) {
                p.start = uint40(block.timestamp);
                p.spent = 0;
            }
            p.spent += uint96(amount);
        }
        return t.delay;
    }

    /// @dev A preview for the app. It reverts with the same custom error as a real transfer.
    /// The return value is the real tier delay. A SENDER frame revert exposes no error data
    /// in the simulator, so the app calls this with eth_call.
    function checkTransfer(address validator, address token, uint256 amount) external view returns (uint32) {
        (, WaveTier memory t) = _checkTransfer(validator, token, amount);
        return t.delay;
    }

    /// @dev ERC7579Utils runs a call with target 0 as a call to address(this). So target 0 is a
    /// self-call, and each check must treat it as one.
    function _isSelfCall(address target) internal view returns (bool) {
        return target == address(this) || target == address(0);
    }

    /// @dev Returns true if a call is a plain transfer of ETH or of a listed token.
    function _asTransfer(address target, uint256 value, bytes calldata data)
        internal
        view
        returns (bool isTransfer, address token, uint256 amount)
    {
        if (_isSelfCall(target)) return (false, address(0), 0);
        if (data.length == 0) return (true, address(0), value);
        if (value == 0 && data.length == 68 && bytes4(data) == ERC20_TRANSFER && isListed(target)) {
            return (true, target, uint256(bytes32(data[36:68])));
        }
        return (false, address(0), 0);
    }

    /// @dev The selector picks the class. The code of the target must then prove that it is an
    /// agent wallet of this wallet. So the exception cannot reach any other contract.
    function _agentClass(address target, uint256 value, bytes calldata data) private view returns (uint8 class) {
        if (value != 0 || data.length < 4) return AGENT_NONE;
        bytes4 s = bytes4(data);
        if (
            s == IWaveAgent.agentRevoke.selector || s == IWaveAgent.agentPause.selector
                || s == IWaveAgent.agentTighten.selector || s == IWaveAgent.agentWithdraw.selector
        ) {
            class = AGENT_ANY_METHOD;
        } else if (s == IWaveAgent.agentSetup.selector) {
            class = AGENT_WORLD_ID;
        } else if (
            s == IWaveAgent.agentUnpause.selector || s == IWaveAgent.agentSetTiers.selector
                || s == IWaveAgent.agentSetKey.selector
        ) {
            class = AGENT_LOOSEN;
        } else {
            return AGENT_NONE;
        }
        if (!_isOwnAgent(target)) return AGENT_NONE;
    }

    /// @dev Default deny. A self-call reverts, so a batch cannot reach a configuration function.
    /// The only other calls that run with no delay are the agent classes above.
    function _enforce(address target, uint256 value, bytes calldata data) internal {
        if (_isSelfCall(target)) revert SelfCall();
        uint8 class = _agentClass(target, value, data);
        if (class == AGENT_ANY_METHOD) {
            _bitOf(_approver());
            return;
        }
        if (class == AGENT_WORLD_ID) {
            _requireWorldId();
            emit AgentLinked(target);
            return;
        }
        (bool isTransfer, address token, uint256 amount) = _asTransfer(target, value, data);
        if (!isTransfer) revert NeedsQueue();
        uint32 delay = _authorizeTransfer(token, amount);
        if (delay != 0) revert NeedsSchedule(delay);
    }

    // ---------------------------------------------------------------------
    // Queue
    // ---------------------------------------------------------------------

    function _isConfigSelector(bytes4 s) internal pure returns (bool) {
        return s == IWaveConfig.installModule.selector || s == IWaveConfig.uninstallModule.selector
            || s == IWaveConfig.setTiers.selector || s == IWaveConfig.setRootSource.selector
            || s == IWaveConfig.setOwner.selector;
    }

    function _requireWorldId() private view {
        address v = _approver();
        if (v != _worldId()) revert MethodNotAllowed(v);
    }

    function _max(uint32 a, uint32 b) private pure returns (uint32) {
        return a > b ? a : b;
    }

    /// @dev Finds the delay of a normal batch and checks that the approver may propose it.
    /// Plain transfers count against the period caps here, not at execution.
    function _classify(Execution[] calldata calls) internal returns (uint32 delay) {
        for (uint256 i; i < calls.length; i++) {
            (address target, uint256 value, bytes calldata data) =
                (calls[i].target, calls[i].value, calls[i].callData);
            if (_isSelfCall(target)) {
                bytes4 s = data.length >= 4 ? bytes4(data) : bytes4(0);
                // Target 0 has one spelling only: a configuration call names address(this).
                if (target == address(0) || value != 0 || !_isConfigSelector(s)) revert NotSchedulable(target, s);
                _requireWorldId();
                delay = _max(delay, CONFIG_DELAY);
                continue;
            }
            (bool isTransfer, address token, uint256 amount) = _asTransfer(target, value, data);
            if (isTransfer) {
                delay = _max(delay, _authorizeTransfer(token, amount));
            } else {
                _requireWorldId();
                delay = _max(delay, _agentClass(target, value, data) == AGENT_LOOSEN ? CONFIG_DELAY : OTHER_CALL_DELAY);
            }
        }
        if (delay == 0) revert NoDelayNeeded();
    }

    /// @dev A recovery action is one call to setOwner or setRootSource. A non-World method
    /// that is not synced proposes it. The proposal counts as the first approval.
    /// An agent wallet has no recovery. Its master administers it.
    function _checkRecovery(Execution[] calldata calls) internal view returns (uint8 bit) {
        if (_master() != address(0)) revert BadRecovery();
        if (calls.length != 1 || calls[0].target != address(this) || calls[0].value != 0) revert BadRecovery();
        bytes calldata data = calls[0].callData;
        bytes4 s = data.length >= 4 ? bytes4(data) : bytes4(0);
        if (s != IWaveConfig.setOwner.selector && s != IWaveConfig.setRootSource.selector) revert BadRecovery();
        bit = _recoveryBit();
    }

    function _recoveryBit() private view returns (uint8 bit) {
        address v = _approver();
        if (v == _worldId()) revert MethodNotAllowed(v);
        bit = _bitOf(v);
        if (bit & _l().syncedMask != 0) revert SyncedNotAllowed(v);
    }

    /// @dev `batch` is abi.encode(Execution[]), the ERC-7579 batch format.
    function _schedule(uint8 kind, bytes calldata batch, bytes32 salt) internal returns (bytes32 id) {
        Execution[] calldata calls = ERC7579Utils.decodeBatch(batch);
        Layout storage l = _l();
        bytes32 callsHash = keccak256(batch);
        id = keccak256(abi.encode(block.chainid, address(this), kind, callsHash, salt, l.configVersion));
        Pending storage p = l.pending[id];
        if (p.status != STATUS_NONE) revert BadStatus(id, p.status);

        p.callsHash = callsHash;
        p.createdAt = uint40(block.timestamp);
        p.version = l.configVersion;
        p.kind = kind;
        if (kind == KIND_NORMAL) {
            uint32 delay = _classify(calls);
            p.status = STATUS_QUEUED;
            p.notBefore = uint40(block.timestamp + effectiveDelay(delay));
            p.proposerBit = methodBitOf(_approver());
        } else if (kind == KIND_RECOVERY) {
            uint8 bit = _checkRecovery(calls);
            p.status = STATUS_COLLECTING;
            p.approvals = bit;
            p.proposerBit = bit;
        } else {
            revert BadRecovery();
        }
        emit Scheduled(id, kind, _approver(), p.notBefore, p.version, batch);
    }

    /// @dev Each distinct method sets one bit. The delay starts at the second distinct bit.
    function _approveRecovery(bytes32 id) internal {
        Layout storage l = _l();
        Pending storage p = l.pending[id];
        if (p.status != STATUS_COLLECTING) revert BadStatus(id, p.status);
        if (p.version != l.configVersion) revert StaleVersion(p.version, l.configVersion);
        uint8 mask = p.approvals | _recoveryBit();
        p.approvals = mask;
        if (mask & (mask - 1) != 0) {
            p.status = STATUS_QUEUED;
            p.notBefore = uint40(block.timestamp + effectiveDelay(RECOVERY_DELAY));
        }
        emit RecoveryApproved(id, _approver(), mask, p.notBefore);
    }

    function _cancel(bytes32 id) internal {
        Pending storage p = _l().pending[id];
        if (p.status != STATUS_QUEUED && p.status != STATUS_COLLECTING) revert BadStatus(id, p.status);
        address v = _approver();
        _bitOf(v);
        if (p.kind == KIND_RECOVERY && v != _worldId()) revert OnlyWorldId();
        p.status = STATUS_CANCELLED;
        emit Cancelled(id, v);
    }

    /// @dev Marks the action done, once, or reverts. Reads no frame data: anyone may reach
    /// this, also from a plain transaction.
    /// A tighten does not change the configuration version. But a queued transfer of a token
    /// fails if the rules of that token became stricter after it was queued.
    function _consume(bytes32 id, bytes calldata batch) internal {
        Layout storage l = _l();
        Pending storage p = l.pending[id];
        if (p.status != STATUS_QUEUED) revert BadStatus(id, p.status);
        if (p.version != l.configVersion) revert StaleVersion(p.version, l.configVersion);
        if (block.timestamp < p.notBefore) revert TooEarly(p.notBefore);
        if (p.callsHash != keccak256(batch)) revert WrongCalls(id);
        Execution[] calldata calls = ERC7579Utils.decodeBatch(batch);
        for (uint256 i; i < calls.length; i++) {
            (bool isTransfer, address token,) = _asTransfer(calls[i].target, calls[i].value, calls[i].callData);
            if (isTransfer && l.tightenedAt[token] >= p.createdAt) revert RuleChanged(token);
        }
        p.status = STATUS_DONE;
        emit Executed(id);
    }

    function _bumpConfigVersion() internal {
        emit ConfigVersionBumped(++_l().configVersion);
    }

    // ---------------------------------------------------------------------
    // Rules
    // ---------------------------------------------------------------------

    function _validateTiers(WaveTier[] calldata next) internal pure {
        for (uint256 i; i < next.length; i++) {
            if (next[i].cap != 0 && next[i].period == 0) revert BadTiers();
            if (i != 0 && next[i].upTo < next[i - 1].upTo) revert BadTiers();
        }
    }

    function _writeTiers(address token, WaveTier[] calldata next) internal {
        delete _l().tiers[token];
        for (uint256 i; i < next.length; i++) _l().tiers[token].push(next[i]);
    }

    /// @dev The looser path. It runs from inside executeScheduled, so World ID and the delay
    /// are already behind it.
    function _setTiers(address token, WaveTier[] calldata next) internal {
        _validateTiers(next);
        _writeTiers(token, next);
        emit TiersChanged(token, false);
    }

    /// @dev Any enrolled method can do this, at once. Each new tier must be stricter than the
    /// old tier at the same index. A shorter list is stricter, because large amounts then
    /// have no tier. An empty list is rejected, because no tiers means the default rule.
    /// For a listed token with no tiers, the old rule is one tier: any amount, World ID.
    function _tighten(address token, WaveTier[] calldata next) internal {
        _bitOf(_approver());
        _tightenRules(token, next);
    }

    /// @dev The check and the write of `_tighten`. A master call has no approver in this account.
    function _tightenRules(address token, WaveTier[] calldata next) internal {
        Layout storage l = _l();
        WaveTier[] storage cur = l.tiers[token];
        uint256 n = cur.length;
        if (n == 0) {
            if (!isListed(token)) revert NotStricter(0);
            n = 1;
        }
        if (next.length == 0 || next.length > n) revert NotStricter(next.length);
        for (uint256 i; i < next.length; i++) {
            WaveTier memory old = cur.length == 0
                ? WaveTier({upTo: type(uint96).max, cap: 0, delay: 0, period: 0, methods: WORLD_ID_BIT})
                : cur[i];
            if (!_stricter(old, next[i])) revert NotStricter(i);
        }
        _validateTiers(next);
        _writeTiers(token, next);
        l.tightenedAt[token] = uint40(block.timestamp);
        emit TiersChanged(token, true);
    }

    function _stricter(WaveTier memory old, WaveTier calldata t) private pure returns (bool) {
        if (t.upTo > old.upTo || t.delay < old.delay || t.period < old.period) return false;
        if (old.cap != 0 && (t.cap == 0 || t.cap > old.cap)) return false;
        return t.methods & ~old.methods == 0;
    }
}
