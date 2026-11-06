// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7579Utils, Execution} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {WaveTier} from "../../src/interfaces/IWaveConfig.sol";
import {AgentRule} from "../../src/interfaces/IWaveAgent.sol";
import {WavePolicy} from "../../src/WavePolicy.sol";
import {WavePasskeyValidator} from "../src/WavePasskeyValidator.sol";
import {WaveAccount4337} from "../src/WaveAccount4337.sol";
import {WaveAccount4337Factory} from "../src/WaveAccount4337Factory.sol";
import {WavePaymaster} from "../src/WavePaymaster.sol";
import {WaveTestToken} from "../src/WaveTestToken.sol";

contract WaveAccount4337Test is Test {
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 constant PASSKEY_PK = 0x1b3c5a6e7f80912a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809123;
    uint256 constant OTHER_PK = 0x2c4d6e8fa0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b;
    uint256 constant RELAYER_PK = 0xa11ce;
    uint8 constant OWNER = 1; // WORLD_ID_BIT: the owner passkey has this role on Whitechain.
    uint256 constant USD = 1e6;

    EntryPoint ep;
    WavePasskeyValidator validator;
    WaveAccount4337Factory factory;
    WavePaymaster paymaster;
    WaveTestToken usdt;
    address relayer;
    address payable beneficiary = payable(address(0xbeef));
    address merchant = address(0xc0ffee);

    bytes32 x;
    bytes32 y;
    AgentRule[] rules;

    function setUp() public {
        vm.warp(1_800_000_000);
        ep = new EntryPoint();
        validator = new WavePasskeyValidator();
        usdt = new WaveTestToken("Test USDT", "tUSDT");
        WaveAccount4337 impl = new WaveAccount4337(IEntryPoint(address(ep)), address(validator), address(usdt), 0);
        factory = new WaveAccount4337Factory(address(impl));
        relayer = vm.addr(RELAYER_PK);
        paymaster = new WavePaymaster(IEntryPoint(address(ep)), relayer);
        paymaster.deposit{value: 10 ether}();

        (uint256 px, uint256 py) = vm.publicKeyP256(PASSKEY_PK);
        (x, y) = (bytes32(px), bytes32(py));

        AgentRule storage r = rules.push();
        r.token = address(usdt);
        r.tiers.push(WaveTier({upTo: uint96(100 * USD), cap: uint96(300 * USD), delay: 0, period: 1 days, methods: OWNER}));
        r.tiers.push(WaveTier({upTo: uint96(1000 * USD), cap: uint96(2000 * USD), delay: 0, period: 7 days, methods: OWNER}));
        r.tiers.push(WaveTier({upTo: type(uint96).max, cap: 0, delay: 24 hours, period: 0, methods: OWNER}));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _account() internal view returns (address) {
        return factory.getAddress(x, y, false, true, rules);
    }

    function _initCode() internal view returns (bytes memory) {
        return abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (x, y, false, true, rules)));
    }

    /// ERC-7579 single mode: target || value || callData, with the test token as target.
    function _single(bytes memory data) internal view returns (bytes memory) {
        return abi.encodePacked(address(usdt), uint256(0), data);
    }

    function _transfer(address to, uint256 amount) internal view returns (bytes memory) {
        bytes memory exec = _single(abi.encodeCall(usdt.transfer, (to, amount)));
        return abi.encodeCall(WaveAccount4337.execute, (bytes32(0), exec));
    }

    function _op(bytes memory inner, bool withInit) internal view returns (PackedUserOperation memory op) {
        address sender = _account();
        op.sender = sender;
        op.nonce = ep.getNonce(sender, 0);
        op.initCode = withInit ? _initCode() : bytes("");
        op.callData = abi.encodePacked(WaveAccount4337.executeUserOp.selector, inner);
        op.accountGasLimits = bytes32((uint256(1_500_000) << 128) | 500_000);
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
    }

    function _sponsor(PackedUserOperation memory op) internal view {
        uint48 validUntil = uint48(block.timestamp + 600);
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(200_000), uint128(50_000), abi.encode(validUntil, uint48(0)));
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, validUntil, 0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELAYER_PK, h);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);
    }

    function _webauthn(uint256 pk, bytes32 challenge, uint8 flags) internal pure returns (bytes memory) {
        bytes memory authData = abi.encodePacked(sha256("wave.local"), flags, uint32(1));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encode(abi.encodePacked(challenge), true, true),
            '","origin":"chrome-extension://wave","crossOrigin":false}'
        );
        bytes32 digest = sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s)); // Low-s, as Solady requires.
        return abi.encodePacked(uint16(authData.length), authData, clientDataJSON, uint16(23), uint16(1), r, s);
    }

    function _sign(PackedUserOperation memory op, uint256 pk, uint8 flags) internal view {
        op.signature = abi.encode(address(validator), _webauthn(pk, ep.getUserOpHash(op), flags));
    }

    function _send(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ep.handleOps(ops, beneficiary);
    }

    /// handleOps does not revert when the inner call reverts. It emits UserOperationEvent.
    function _sendExpectInnerFail(PackedUserOperation memory op) internal {
        uint256 before = usdt.balanceOf(merchant);
        _send(op);
        assertEq(usdt.balanceOf(merchant), before, "inner call should have reverted");
    }

    function _fund(uint256 amount) internal {
        usdt.mint(_account(), amount);
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    function test_firstSendDeploysAndPays() public {
        _fund(500 * USD);
        assertEq(_account().code.length, 0);
        PackedUserOperation memory op = _op(_transfer(merchant, 25 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        assertGt(_account().code.length, 0);
        assertEq(usdt.balanceOf(merchant), 25 * USD);
        assertEq(_account().balance, 0, "wallet needs no WBT");
        assertEq(WaveAccount4337(payable(_account())).spentOf(address(usdt), 0), 25 * USD);
    }

    function test_secondSendWithoutInitCode() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        op = _op(_transfer(merchant, 15 * USD), false);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        assertEq(usdt.balanceOf(merchant), 25 * USD);
    }

    function test_wrongPasskeyRejected() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        _sign(op, OTHER_PK, 0x05);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _send(op);
    }

    function test_tamperedCallDataRejected() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        op.callData = abi.encodePacked(WaveAccount4337.executeUserOp.selector, _transfer(address(0xbad), 10 * USD));
        // The paymaster signature no longer matches either, and it is checked after the account.
        vm.expectRevert();
        _send(op);
    }

    function test_unsponsoredOpRejected() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        // Sign the paymaster part with a key that is not the relayer.
        uint48 validUntil = uint48(block.timestamp + 600);
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(200_000), uint128(50_000), abi.encode(validUntil, uint48(0)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xbad, MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, validUntil, 0)));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);
        _sign(op, PASSKEY_PK, 0x05);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA34 signature error"));
        _send(op);
    }

    function test_backupStateMismatchRejected() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05 | 0x08); // BE set, but the key was enrolled with BE = 0.
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _send(op);
    }

    function test_userVerificationRequired() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x01); // UP only, but requireUV = true.
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _send(op);
    }

    function test_unknownValidatorRejected() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 10 * USD), true);
        _sponsor(op);
        WavePasskeyValidator other = new WavePasskeyValidator();
        op.signature = abi.encode(address(other), _webauthn(PASSKEY_PK, ep.getUserOpHash(op), 0x05));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _send(op);
    }

    function test_dailyCapMovesToNextTier() public {
        _fund(2000 * USD);
        uint256[4] memory amounts = [uint256(100), 100, 100, 50];
        for (uint256 i; i < amounts.length; i++) {
            PackedUserOperation memory op = _op(_transfer(merchant, amounts[i] * USD), i == 0);
            _sponsor(op);
            _sign(op, PASSKEY_PK, 0x05);
            _send(op);
        }
        WaveAccount4337 acct = WaveAccount4337(payable(_account()));
        // 300 used the small tier's daily cap. The 50 then counted in the second tier.
        assertEq(acct.spentOf(address(usdt), 0), 300 * USD);
        assertEq(acct.spentOf(address(usdt), 1), 50 * USD);
        assertEq(usdt.balanceOf(merchant), 350 * USD);
    }

    function test_largeTransferMustBeScheduled() public {
        _fund(5000 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 1500 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _sendExpectInnerFail(op); // NeedsSchedule(24 hours): runs, but the transfer reverts.
        assertGt(_account().code.length, 0, "the wallet still deployed");
    }

    function test_scheduleThenExecuteAfterDelay() public {
        _fund(5000 * USD);
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(address(usdt), 0, abi.encodeCall(usdt.transfer, (merchant, 1500 * USD)));
        bytes memory batch = abi.encode(calls);
        bytes32 salt = keccak256("order-1");
        PackedUserOperation memory op =
            _op(abi.encodeCall(WaveAccount4337.schedule, (uint8(0), batch, salt)), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        vm.recordLogs();
        _send(op);

        WaveAccount4337 acct = WaveAccount4337(payable(_account()));
        bytes32 id = keccak256(abi.encode(block.chainid, address(acct), uint8(0), keccak256(batch), salt, uint32(0)));
        WavePolicy.Pending memory p = acct.pendingOf(id);
        assertEq(p.status, 2, "queued");
        assertEq(p.notBefore, block.timestamp + 24 hours);

        vm.expectRevert(abi.encodeWithSelector(WavePolicy.TooEarly.selector, p.notBefore));
        acct.executeScheduled(id, batch);

        vm.warp(block.timestamp + 24 hours);
        acct.executeScheduled(id, batch); // Anyone can run it once the delay has passed.
        assertEq(usdt.balanceOf(merchant), 1500 * USD);
    }

    function test_cancelScheduled() public {
        _fund(5000 * USD);
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(address(usdt), 0, abi.encodeCall(usdt.transfer, (merchant, 1500 * USD)));
        bytes memory batch = abi.encode(calls);
        PackedUserOperation memory op =
            _op(abi.encodeCall(WaveAccount4337.schedule, (uint8(0), batch, bytes32(0))), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        WaveAccount4337 acct = WaveAccount4337(payable(_account()));
        bytes32 id = keccak256(abi.encode(block.chainid, address(acct), uint8(0), keccak256(batch), bytes32(0), uint32(0)));

        op = _op(abi.encodeCall(WaveAccount4337.cancel, (id)), false);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        assertEq(acct.pendingOf(id).status, 4, "cancelled");

        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(WavePolicy.BadStatus.selector, id, uint8(4)));
        acct.executeScheduled(id, batch);
    }

    function test_cannotCallAccountDirectly() public {
        _fund(500 * USD);
        PackedUserOperation memory op = _op(_transfer(merchant, 1 * USD), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        WaveAccount4337 acct = WaveAccount4337(payable(_account()));
        vm.expectRevert(WaveAccount4337.Unauthorized.selector);
        acct.execute(bytes32(0), _single(abi.encodeCall(usdt.transfer, (merchant, 1))));
        vm.expectRevert(WaveAccount4337.AlreadyInitialized.selector);
        acct.initialize(x, y, false, true, rules);
    }

    function test_otherCallsNeedTheQueue() public {
        _fund(500 * USD);
        // An approve is not a plain transfer, so it cannot run at once.
        bytes memory exec = _single(abi.encodeCall(usdt.approve, (merchant, 1)));
        PackedUserOperation memory op = _op(abi.encodeCall(WaveAccount4337.execute, (bytes32(0), exec)), true);
        _sponsor(op);
        _sign(op, PASSKEY_PK, 0x05);
        _send(op);
        assertEq(usdt.allowance(_account(), merchant), 0);
    }

    function test_addressCommitsToKeyAndRules() public view {
        AgentRule[] memory none = new AgentRule[](0);
        assertTrue(factory.getAddress(x, y, false, true, none) != _account());
        assertTrue(factory.getAddress(x, y, true, true, rules) != _account());
    }
}
