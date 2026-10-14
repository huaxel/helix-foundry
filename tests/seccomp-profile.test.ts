// Regression guard for the bundled streaming-executor seccomp profile
// (seccomp-stream.json, used by compose.stream.yaml). The profile is Docker's
// default allow-list plus `unshare` (restricted to user+mount namespaces) and
// `mount`. These tests pin the SAFETY properties so a future edit can't silently
// loosen the profile (e.g. back to unconfined, or by widening the unshare filter).
//
// The profile is validated end-to-end in a real container separately (see
// docs/VALIDATION.md, "Inside the Docker container"); this suite checks the
// static shape of the shipped file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const profilePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "seccomp-stream.json",
);

type SeccompArg = { index: number; value: number; valueTwo?: number; op: string };
type SeccompRule = { names: string[]; action: string; args?: SeccompArg[] };
type SeccompProfile = {
  defaultAction: string;
  architectures: string[];
  syscalls: SeccompRule[];
};

// CLONE_* namespace flags (linux/sched.h).
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWNS = 0x20000;

const profile = JSON.parse(readFileSync(profilePath, "utf8")) as SeccompProfile;

// Every syscall name the profile allows.
function allowedNames(): Set<string> {
  const s = new Set<string>();
  for (const rule of profile.syscalls)
    if (rule.action === "SCMP_ACT_ALLOW") for (const n of rule.names) s.add(n);
  return s;
}
function ruleFor(name: string): SeccompRule | undefined {
  return profile.syscalls.find((r) => r.names.includes(name));
}

describe("seccomp-stream.json — streaming executor profile", () => {
  it("is a deny-by-default allow-list (not unconfined)", () => {
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(profile.syscalls.length).toBeGreaterThan(0);
  });

  // x86_64 hosts and ARM hosts (Apple Silicon, ARM Linux): an arch missing
  // from this list doesn't get the unshare/mount restrictions, so every
  // supported ABI must be listed.
  it("covers the x86_64 + x86 + x32 + ARM ABIs", () => {
    for (const arch of [
      "SCMP_ARCH_X86_64",
      "SCMP_ARCH_X86",
      "SCMP_ARCH_X32",
      "SCMP_ARCH_AARCH64",
      "SCMP_ARCH_ARM",
    ])
      expect(profile.architectures).toContain(arch);
  });

  it("allows mount (needed for per-job `mount --bind`)", () => {
    expect(allowedNames().has("mount")).toBe(true);
  });

  it("allows unshare ONLY for flags that are a subset of {CLONE_NEWUSER, CLONE_NEWNS}", () => {
    const rule = ruleFor("unshare");
    expect(rule, "unshare must be explicitly allowed").toBeDefined();
    expect(rule!.action).toBe("SCMP_ACT_ALLOW");
    const arg = rule!.args?.[0];
    expect(arg, "unshare must carry an arg filter").toBeDefined();
    expect(arg!.op).toBe("SCMP_CMP_MASKED_EQ");
    expect(arg!.index).toBe(0);
    // (flags & value) == (valueTwo & value)  with valueTwo = 0
    //  => (flags & value) == 0  => flags must be a subset of ~value (within 32 bits).
    expect(arg!.valueTwo ?? 0).toBe(0);
    const allowedNamespaceBits = 0xffffffff ^ (arg!.value & 0xffffffff);
    expect(allowedNamespaceBits).toBe(CLONE_NEWUSER | CLONE_NEWNS);
  });

  it("still blocks namespace-creating clone (default profile keeps its clone filter)", () => {
    const rule = ruleFor("clone");
    expect(rule, "clone should be present (it is in the default allow-list)").toBeDefined();
    const arg = rule!.args?.[0];
    if (arg && arg.op === "SCMP_CMP_MASKED_EQ") {
      const blockedBits = arg.value & 0xffffffff;
      // CLONE_NEWUSER must be among the masked (blocked) bits.
      expect(blockedBits & CLONE_NEWUSER).toBe(CLONE_NEWUSER);
    }
  });

  it("does NOT allow the high-risk syscalls the default profile blocks", () => {
    const allowed = allowedNames();
    for (const dangerous of [
      "bpf",
      "keyctl",
      "add_key",
      "request_key",
      "init_module",
      "finit_module",
      "delete_module",
      "create_module",
      "query_module",
      "kexec_file_load",
      "kexec_load",
      "reboot",
      "swapon",
      "swapoff",
      "setns",
      "pivot_root",
      "userfaultfd",
      "perf_event_open",
      "umount2",
    ])
      expect(allowed.has(dangerous), `${dangerous} must stay blocked`).toBe(false);
  });
});
