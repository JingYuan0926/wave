// Reads one field of one EIP-8272 recent-root reference with RECENTROOTREFLOAD (0xB6).
// The solc fork has no builtin for this opcode, so a helper contract runs it.
// Calldata: index (32) || field (32). The operand order is field on top, index second.
// Build: solc --strict-assembly --bin src/RecentRootRead.yul
// contracts/scripts/deploy.ts holds the resulting creation code.
object "RecentRootRead" {
  code {
    datacopy(0, dataoffset("runtime"), datasize("runtime"))
    return(0, datasize("runtime"))
  }
  object "runtime" {
    code {
      mstore(0, verbatim_2i_1o(hex"b6", calldataload(32), calldataload(0)))
      return(0, 32)
    }
  }
}
