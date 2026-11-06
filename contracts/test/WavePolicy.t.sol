// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {WavePolicy} from "../src/WavePolicy.sol";
import {IWaveConfig, WaveTier} from "../src/interfaces/IWaveConfig.sol";

contract Harness is WavePolicy {
    address public approver;
    address public immutable world;
    address public immutable token;
    uint32 public demo;

    constructor(address w, address t) {
        world = w;
        token = t;
    }

    function _approver() internal view override returns (address) {
        return approver;
    }

    function _worldId() internal view override returns (address) {
        return world;
    }

    function _demoDelay() internal view override returns (uint32) {
        return demo;
    }

    function _defaultToken() internal view override returns (address) {
        return token;
    }

    function setApprover(address a) external {
        approver = a;
    }

    function setDemo(uint32 d) external {
        demo = d;
    }

    function enroll(address v, uint8 bit, bool synced) external {
        _enroll(v, bit, synced);
    }

    function unenroll(address v) external {
        _unenroll(v);
    }

    function setTiers(address t, WaveTier[] calldata x) external {
        _setTiers(t, x);
    }

    function tighten(address t, WaveTier[] calldata x) external {
        _tighten(t, x);
    }

    function enforce(address target, uint256 value, bytes calldata data) external {
        _enforce(target, value, data);
    }

    function schedule(uint8 k, bytes calldata batch, bytes32 s) external returns (bytes32) {
        return _schedule(k, batch, s);
    }

    function approveRecovery(bytes32 id) external {
        _approveRecovery(id);
    }

    function cancel(bytes32 id) external {
        _cancel(id);
    }

    function consume(bytes32 id, bytes calldata batch) external {
        _consume(id, batch);
    }

    function bump() external {
        _bumpConfigVersion();
    }
}

contract WavePolicyTest is Test {
    address constant WORLD = address(0xA1);
    address constant PASSKEY = address(0xA2);
    address constant CARD = address(0xA3);
    address constant SYNCED = address(0xA4);
    address constant STRANGER = address(0xA5);
    address constant USDC = address(0xC0);
    address constant OTHER_TOKEN = address(0xC1);
    address constant TO = address(0xD0);
    uint8 constant W = 1;
    uint8 constant P = 2;
    uint8 constant C = 4;
    uint8 constant S = 8;
    uint8 constant SMALL = 0x80;
    uint96 constant NO_LIMIT = type(uint96).max;
    Harness h;

    function setUp() public {
        vm.warp(1_000_000);
        h = new Harness(WORLD, USDC);
        h.enroll(PASSKEY, P, false);
        h.enroll(CARD, C, false);
        h.enroll(SYNCED, S, true);
        // README example: under 100 passkey, 300 per day; to 1000 World ID, 2000 per week;
        // above that World ID with a 24 hour delay.
        h.setTiers(USDC, _tiers());
    }

    function _tiers() internal pure returns (WaveTier[] memory t) {
        t = new WaveTier[](3);
        t[0] = WaveTier(99e6, 300e6, 0, 1 days, P);
        t[1] = WaveTier(1000e6, 2000e6, 0, 7 days, W);
        t[2] = WaveTier(NO_LIMIT, 0, 24 hours, 0, W);
    }

    function _one(WaveTier memory x) internal pure returns (WaveTier[] memory t) {
        t = new WaveTier[](1);
        t[0] = x;
    }

    function _transfer(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(0xa9059cbb, TO, amount);
    }

    function _spend(uint256 amount) internal {
        h.enforce(USDC, 0, _transfer(amount));
    }

    function _batch(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(target, value, data);
        return abi.encode(calls);
    }

    function _config(bytes4 selector) internal view returns (bytes memory) {
        return _batch(address(h), 0, abi.encodeWithSelector(selector, uint256(1)));
    }

    function _approveToken() internal pure returns (bytes memory) {
        return _batch(USDC, 0, abi.encodeWithSelector(0x095ea7b3, TO, uint256(1)));
    }

    function _notBefore(bytes32 id) internal view returns (uint40) {
        return h.pendingOf(id).notBefore;
    }

    // Spending -----------------------------------------------------------

    function test_passkeyUnderLimit() public {
        h.setApprover(PASSKEY);
        _spend(50e6);
        assertEq(h.spentOf(USDC, 0), 50e6);
    }

    function test_passkeyOverLimitRejected_thenWorldIdAccepted() public {
        h.setApprover(PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
        _spend(150e6);
        h.setApprover(WORLD);
        _spend(150e6);
    }

    function test_capUsedUpMovesToNextTier_acrossMethods() public {
        WaveTier[] memory t = _tiers();
        t[0].methods = P | C;
        h.setTiers(USDC, t);
        h.setApprover(PASSKEY);
        _spend(99e6);
        _spend(99e6);
        h.setApprover(CARD);
        _spend(99e6);
        assertEq(h.spentOf(USDC, 0), 297e6);
        // 297 used of 300. A 50 transfer no longer fits tier 0, so tier 1 applies: World ID.
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, CARD));
        _spend(50e6);
        h.setApprover(PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
        _spend(50e6);
        _spend(3e6);
        h.setApprover(WORLD);
        _spend(50e6);
    }

    function test_periodResets() public {
        h.setApprover(PASSKEY);
        _spend(99e6);
        _spend(99e6);
        _spend(99e6);
        _spend(3e6);
        vm.warp(block.timestamp + 1 days);
        assertEq(h.spentOf(USDC, 0), 0);
        _spend(99e6);
    }

    function test_delayedTierNeedsSchedule() public {
        h.setApprover(WORLD);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NeedsSchedule.selector, uint32(24 hours)));
        _spend(5000e6);
    }

    function test_defaultRule_worldIdOnly_ethAndDefaultToken() public {
        Harness fresh = new Harness(WORLD, USDC);
        fresh.enroll(PASSKEY, P, false);
        fresh.setApprover(WORLD);
        fresh.enforce(TO, 1 ether, "");
        fresh.enforce(USDC, 0, _transfer(1e12));
        fresh.setApprover(PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
        fresh.enforce(TO, 1 ether, "");
    }

    function test_defaultDeny() public {
        h.setApprover(WORLD);
        vm.expectRevert(WavePolicy.NeedsQueue.selector);
        h.enforce(OTHER_TOKEN, 0, _transfer(1));
        vm.expectRevert(WavePolicy.NeedsQueue.selector);
        h.enforce(USDC, 0, abi.encodeWithSelector(0x095ea7b3, TO, uint256(1)));
        vm.expectRevert(WavePolicy.NeedsQueue.selector);
        h.enforce(TO, 1, hex"01");
        vm.expectRevert(WavePolicy.NeedsQueue.selector);
        h.enforce(USDC, 1, _transfer(1));
        vm.expectRevert(WavePolicy.SelfCall.selector);
        h.enforce(address(h), 0, abi.encodeWithSelector(IWaveConfig.setOwner.selector, uint256(1)));
    }

    function test_amountAboveEveryTier() public {
        h.setTiers(USDC, _one(WaveTier(10e6, 0, 0, 0, W)));
        h.setApprover(WORLD);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NoTier.selector, USDC, uint256(11e6)));
        _spend(11e6);
    }

    function test_syncedOnlySmallTier() public {
        WaveTier[] memory t = new WaveTier[](2);
        t[0] = WaveTier(10e6, 0, 0, 0, S | SMALL);
        t[1] = WaveTier(100e6, 0, 0, 0, S | P);
        h.setTiers(USDC, t);
        h.setApprover(SYNCED);
        _spend(5e6);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.SyncedNotAllowed.selector, SYNCED));
        _spend(50e6);
        h.setApprover(PASSKEY);
        _spend(50e6);
    }

    function test_checkTransferMatchesTheRule() public {
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
        h.checkTransfer(PASSKEY, USDC, 150e6);
        assertEq(h.checkTransfer(PASSKEY, USDC, 50e6), 0);
        assertEq(h.checkTransfer(WORLD, USDC, 5000e6), 24 hours);
    }

    // Schedule classification --------------------------------------------

    function test_delayedTransfer_tierMethodProposes_countsAtSchedule() public {
        WaveTier[] memory t = new WaveTier[](1);
        t[0] = WaveTier(100e6, 150e6, 1 hours, 1 days, P);
        h.setTiers(USDC, t);
        h.setApprover(PASSKEY);
        bytes32 id = h.schedule(0, _batch(USDC, 0, _transfer(100e6)), 0);
        assertEq(_notBefore(id), block.timestamp + 1 hours);
        assertEq(h.spentOf(USDC, 0), 100e6);
    }

    function test_immediateTierCannotSchedule() public {
        h.setApprover(PASSKEY);
        vm.expectRevert(WavePolicy.NoDelayNeeded.selector);
        h.schedule(0, _batch(USDC, 0, _transfer(1e6)), 0);
    }

    function test_configIs48h_worldIdOnly() public {
        bytes4[5] memory all = [
            IWaveConfig.installModule.selector,
            IWaveConfig.uninstallModule.selector,
            IWaveConfig.setTiers.selector,
            IWaveConfig.setRootSource.selector,
            IWaveConfig.setOwner.selector
        ];
        for (uint256 i; i < all.length; i++) {
            h.setApprover(PASSKEY);
            vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
            h.schedule(0, _config(all[i]), 0);
            h.setApprover(WORLD);
            bytes32 id = h.schedule(0, _config(all[i]), 0);
            assertEq(_notBefore(id), block.timestamp + 48 hours);
        }
    }

    function test_otherCallsAre24h_worldIdOnly() public {
        h.setApprover(PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
        h.schedule(0, _approveToken(), 0);
        h.setApprover(WORLD);
        bytes32 id = h.schedule(0, _approveToken(), 0);
        assertEq(_notBefore(id), block.timestamp + 24 hours);
    }

    function test_mixedBatchTakesTheLongestDelay() public {
        Execution[] memory calls = new Execution[](2);
        calls[0] = Execution(USDC, 0, abi.encodeWithSelector(0x095ea7b3, TO, uint256(1)));
        calls[1] = Execution(address(h), 0, abi.encodeWithSelector(IWaveConfig.setOwner.selector, uint256(1)));
        h.setApprover(WORLD);
        bytes32 id = h.schedule(0, abi.encode(calls), 0);
        assertEq(_notBefore(id), block.timestamp + 48 hours);
    }

    function test_selfCallWithOtherSelectorCannotBeScheduled() public {
        h.setApprover(WORLD);
        bytes4 s = h.tighten.selector;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotSchedulable.selector, address(h), s));
        h.schedule(0, _batch(address(h), 0, abi.encodeWithSelector(s, address(0))), 0);
    }

    function test_targetZeroIsASelfCall() public {
        // ERC7579Utils runs target 0 as a call to the account. It must not pass as another call.
        bytes memory setOwner = abi.encodeCall(IWaveConfig.setOwner, (42));
        h.setApprover(WORLD);
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(address(0), 0, setOwner);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotSchedulable.selector, address(0), IWaveConfig.setOwner.selector));
        h.schedule(0, abi.encode(calls), bytes32(uint256(1)));

        calls[0] = Execution(address(0), 0, hex"12345678");
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotSchedulable.selector, address(0), bytes4(0x12345678)));
        h.schedule(0, abi.encode(calls), bytes32(uint256(2)));

        // A transfer-shaped call to target 0 is not a transfer.
        calls[0] = Execution(address(0), 1 ether, "");
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotSchedulable.selector, address(0), bytes4(0)));
        h.schedule(0, abi.encode(calls), bytes32(uint256(3)));

        vm.expectRevert(WavePolicy.SelfCall.selector);
        h.enforce(address(0), 1 ether, "");
        vm.expectRevert(WavePolicy.SelfCall.selector);
        h.enforce(address(0), 0, setOwner);

        h.setApprover(PASSKEY);
        calls[0] = Execution(address(0), 0, setOwner);
        vm.expectRevert(WavePolicy.BadRecovery.selector);
        h.schedule(1, abi.encode(calls), bytes32(uint256(4)));
    }

    function test_demoDelayCapsEveryDelay() public {
        h.setDemo(120);
        h.setApprover(WORLD);
        bytes32 id = h.schedule(0, _config(IWaveConfig.setOwner.selector), 0);
        assertEq(_notBefore(id), block.timestamp + 120);
        assertEq(h.effectiveDelay(60), 60);
        assertEq(h.effectiveDelay(7 days), 120);
    }

    // Queue ---------------------------------------------------------------

    function test_queue_tooEarly_wrongCalls_thenOnce() public {
        h.setApprover(WORLD);
        bytes memory a = _approveToken();
        bytes32 id = h.schedule(0, a, 0);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.TooEarly.selector, _notBefore(id)));
        h.consume(id, a);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.WrongCalls.selector, id));
        h.consume(id, _config(IWaveConfig.setOwner.selector));
        h.consume(id, a);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadStatus.selector, id, uint8(3)));
        h.consume(id, a);
    }

    function test_versionBumpInvalidatesQueued() public {
        h.setApprover(WORLD);
        bytes memory a = _approveToken();
        bytes32 id = h.schedule(0, a, 0);
        uint32 v = h.configVersion();
        h.bump();
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.StaleVersion.selector, v, v + 1));
        h.consume(id, a);
    }

    function test_versionBumpInvalidatesCollectedApprovals() public {
        h.setApprover(PASSKEY);
        bytes32 id = h.schedule(1, _config(IWaveConfig.setOwner.selector), 0);
        uint32 v = h.configVersion();
        h.bump();
        h.setApprover(CARD);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.StaleVersion.selector, v, v + 1));
        h.approveRecovery(id);
    }

    function test_anyEnrolledMethodCancelsNormal_strangerCannot() public {
        h.setApprover(WORLD);
        bytes32 id = h.schedule(0, _approveToken(), 0);
        h.setApprover(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotEnrolled.selector, STRANGER));
        h.cancel(id);
        h.setApprover(SYNCED);
        h.cancel(id);
        assertEq(h.pendingOf(id).status, h.STATUS_CANCELLED());
    }

    // Recovery ------------------------------------------------------------

    function test_recoveryNeedsTwoDistinctMethods() public {
        bytes memory r = _config(IWaveConfig.setOwner.selector);
        h.setApprover(PASSKEY);
        bytes32 id = h.schedule(1, r, 0);
        h.approveRecovery(id); // Same method again: it does not count.
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadStatus.selector, id, uint8(1)));
        h.consume(id, r);
        h.setApprover(CARD);
        h.approveRecovery(id);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.TooEarly.selector, _notBefore(id)));
        h.consume(id, r);
        vm.warp(block.timestamp + 7 days);
        h.consume(id, r);
    }

    function test_recoveryShape() public {
        h.setApprover(WORLD);
        bytes memory r = _config(IWaveConfig.setRootSource.selector);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, WORLD));
        h.schedule(1, r, 0);
        h.setApprover(PASSKEY);
        vm.expectRevert(WavePolicy.BadRecovery.selector);
        h.schedule(1, _config(IWaveConfig.setTiers.selector), 0);
        vm.expectRevert(WavePolicy.BadRecovery.selector);
        h.schedule(1, _approveToken(), 0);
        Execution[] memory two = new Execution[](2);
        two[0] = Execution(address(h), 0, abi.encodeWithSelector(IWaveConfig.setOwner.selector, uint256(1)));
        two[1] = two[0];
        vm.expectRevert(WavePolicy.BadRecovery.selector);
        h.schedule(1, abi.encode(two), 0);
        h.setApprover(SYNCED);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.SyncedNotAllowed.selector, SYNCED));
        h.schedule(1, r, 0);
    }

    function test_onlyWorldIdCancelsRecovery() public {
        h.setApprover(PASSKEY);
        bytes32 id = h.schedule(1, _config(IWaveConfig.setOwner.selector), 0);
        vm.expectRevert(WavePolicy.OnlyWorldId.selector);
        h.cancel(id);
        h.setApprover(WORLD);
        h.cancel(id);
    }

    function test_worldIdCannotApproveRecovery() public {
        h.setApprover(PASSKEY);
        bytes32 id = h.schedule(1, _config(IWaveConfig.setOwner.selector), 0);
        h.setApprover(WORLD);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, WORLD));
        h.approveRecovery(id);
    }

    // Tighten -------------------------------------------------------------

    function test_tighten_anyMethod_noVersionBump() public {
        WaveTier[] memory t = _tiers();
        t[0].upTo = 50e6;
        t[0].cap = 100e6;
        t[1].delay = 1 hours;
        t[1].period = 8 days;
        uint32 v = h.configVersion();
        h.setApprover(PASSKEY);
        h.tighten(USDC, t);
        assertEq(h.tiersOf(USDC)[0].upTo, 50e6);
        assertEq(h.configVersion(), v);
    }

    function test_tighten_rejectsEachLooserField() public {
        h.setApprover(WORLD);
        WaveTier[] memory t = _tiers();
        t[0].upTo = 100e6;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, t);
        t = _tiers();
        t[0].cap = 301e6;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, t);
        t = _tiers();
        t[0].cap = 0;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, t);
        t = _tiers();
        t[2].delay = 1 hours;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(2)));
        h.tighten(USDC, t);
        t = _tiers();
        t[0].period = 1 hours;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, t);
        t = _tiers();
        t[0].methods = P | W;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, t);
        t = _tiers();
        t[0].methods = P | SMALL;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, t);
    }

    function test_tighten_shorterList_emptyListRejected_longerListRejected() public {
        h.setApprover(PASSKEY);
        WaveTier[] memory t = _tiers();
        WaveTier[] memory shorter = new WaveTier[](2);
        shorter[0] = t[0];
        shorter[1] = t[1];
        h.tighten(USDC, shorter);
        assertEq(h.tiersOf(USDC).length, 2);
        WaveTier[] memory none = new WaveTier[](0);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        h.tighten(USDC, none);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(3)));
        h.tighten(USDC, t);
    }

    function test_tighten_defaultRule() public {
        Harness fresh = new Harness(WORLD, USDC);
        fresh.enroll(PASSKEY, P, false);
        fresh.setApprover(PASSKEY);
        WaveTier[] memory t = _one(WaveTier(1 ether, 2 ether, 0, 1 days, W));
        fresh.tighten(address(0), t);
        assertEq(fresh.tiersOf(address(0)).length, 1);
        t[0].methods = W | P;
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        fresh.tighten(USDC, t);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotStricter.selector, uint256(0)));
        fresh.tighten(OTHER_TOKEN, _one(WaveTier(1, 0, 0, 0, W)));
    }

    function test_tighten_strangerRejected() public {
        h.setApprover(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.NotEnrolled.selector, STRANGER));
        h.tighten(USDC, _tiers());
    }

    function test_tighten_blocksQueuedTransferOfThatToken_notOthers() public {
        h.setTiers(USDC, _one(WaveTier(100e6, 0, 1 hours, 0, P)));
        h.setApprover(PASSKEY);
        bytes memory transfer = _batch(USDC, 0, _transfer(1e6));
        bytes32 queuedTransfer = h.schedule(0, transfer, 0);
        h.setApprover(WORLD);
        bytes memory other = _approveToken();
        bytes32 queuedOther = h.schedule(0, other, 0);
        vm.warp(block.timestamp + 1);
        h.setApprover(PASSKEY);
        h.tighten(USDC, _one(WaveTier(50e6, 0, 1 hours, 0, P)));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.RuleChanged.selector, USDC));
        h.consume(queuedTransfer, transfer);
        h.consume(queuedOther, other);
    }

    function test_badTiersRejected() public {
        vm.expectRevert(WavePolicy.BadTiers.selector);
        h.setTiers(USDC, _one(WaveTier(1, 1, 0, 0, W)));
        WaveTier[] memory t = new WaveTier[](2);
        t[0] = WaveTier(2, 0, 0, 0, W);
        t[1] = WaveTier(1, 0, 0, 0, W);
        vm.expectRevert(WavePolicy.BadTiers.selector);
        h.setTiers(USDC, t);
    }

    // Methods -------------------------------------------------------------

    function test_removedMethodLosesItsBit() public {
        h.unenroll(PASSKEY);
        assertEq(h.methodBitOf(PASSKEY), 0);
        h.setApprover(PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.MethodNotAllowed.selector, PASSKEY));
        _spend(50e6);
    }

    function test_enrollRejectsBadBits() public {
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadMethodBit.selector, uint8(0)));
        h.enroll(STRANGER, 0, false);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadMethodBit.selector, uint8(1)));
        h.enroll(STRANGER, 1, false);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadMethodBit.selector, uint8(0x80)));
        h.enroll(STRANGER, 0x80, false);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadMethodBit.selector, uint8(6)));
        h.enroll(STRANGER, 6, false);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadMethodBit.selector, P));
        h.enroll(STRANGER, P, false);
    }
}
