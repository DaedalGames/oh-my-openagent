import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { parseWriteScope, runGuard } from "./computer-v3-guards.ts"

// Every guard of the computer-use v3 reimplementation is exercised against a temporary git repository
// with one tree that passes and one that violates it. A violation must exit 1 with one line per
// finding that names the offending path; a pass must exit 0 and print nothing.

const guardScript = fileURLToPath(new URL("./computer-v3-guards.ts", import.meta.url))

type Tree = Record<string, string>

type Repo = {
  readonly root: string
  git(...args: string[]): string
  write(tree: Tree): void
  commit(message: string): void
  remove(): void
}

function createRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "cu-v3-guards-"))
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=guard-test",
        "-c",
        "user.email=guard-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(root, ".no-hooks")}`,
        ...args,
      ],
      { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  git("init", "-q", "-b", "dev")
  return {
    root,
    git,
    write(tree) {
      for (const [path, content] of Object.entries(tree)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), content)
      }
    },
    commit(message) {
      git("add", "-A")
      git("commit", "-q", "--allow-empty", "-m", message)
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function withRepo(body: (repo: Repo) => void): void {
  const repo = createRepo()
  try {
    body(repo)
  } finally {
    repo.remove()
  }
}

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}: ${(index * 7919) % 1013}`).join("\n") + "\n"

const run = (repo: Repo, ...args: string[]) => runGuard(args, { cwd: repo.root })

describe("computer-v3-guards --residue", () => {
  test("#given a tree where the old names survive only in the legacy-name exclusions #when checked #then it passes", () => {
    withRepo((repo) => {
      repo.write({
        "README.md": "the computer module\n",
        "CHANGELOG.md": "- senpi-desktop-engine was removed\n",
        "changes/unreleased/1.md": "senpi-desktop is gone\n",
        "packages/omo-native/changes.md": "SENPI_DESKTOP_BACKEND dropped\n",
        "crates/omo-computer-core/parity/ORACLE-PROVENANCE.tsv": "new\told\ncrates/omo-computer-core/x\tcrates/senpi-desktop-core/x\n",
        "crates/omo-computer-core/src/lib.rs": "//! core\n",
      })
      repo.commit("clean")
      const result = run(repo, "--residue")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given an old directory still present and a doc naming the old engine #when checked #then both are findings and it exits 1", () => {
    withRepo((repo) => {
      repo.write({
        "README.md": "the computer module\n",
        "docs/guide.md": "run Senpi-Desktop-Engine --serve\n",
        "crates/senpi-desktop-core/src/lib.rs": "//! old\n",
        ".github/workflows/desktop-engine.yml": "name: old\n",
      })
      repo.commit("residue")
      const result = run(repo, "--residue")
      expect(result.exitCode).toBe(1)
      expect(result.findings.some((line) => line.includes("docs/guide.md:1"))).toBe(true)
      expect(result.findings.some((line) => line.includes("crates/senpi-desktop-core"))).toBe(true)
      expect(result.findings.some((line) => line.includes(".github/workflows/desktop-engine.yml"))).toBe(true)
    })
  })
})

describe("computer-v3-guards --no-legacy-edge", () => {
  test("#given new directories that never name the old family #when checked #then it passes even though docs outside them do", () => {
    withRepo((repo) => {
      repo.write({
        "docs/guide.md": "senpi-desktop-engine is the old engine\n",
        "crates/omo-computer-core/Cargo.toml": '[package]\nname = "omo-computer-core"\n[dependencies]\nserde = "1"\n',
        "crates/omo-computer-core/src/lib.rs": "//! core\n",
        "crates/omo-computer-core/parity/ORACLE-PROVENANCE.tsv": "new\told\nx\tcrates/senpi-desktop-core/x\n",
        "packages/omo-computer-sdk/package.json": '{ "name": "@oh-my-opencode/omo-computer-sdk", "dependencies": { "@oh-my-opencode/omo-computer-protocol": "workspace:*" } }\n',
      })
      repo.commit("clean")
      const result = run(repo, "--no-legacy-edge")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given a new crate that names an old crate or points a path at an old directory #when checked #then each file is a finding", () => {
    withRepo((repo) => {
      repo.write({
        "crates/omo-computer-core/Cargo.toml": '[package]\nname = "omo-computer-core"\n[dependencies]\nsenpi-desktop-core = { path = "../senpi-desktop-core" }\n',
        "crates/omo-computer-safety/Cargo.toml": '[package]\nname = "omo-computer-safety"\n[dependencies]\ndesktop = { path = "../desktop" }\n',
        "crates/omo-computer-safety/src/lib.rs": "//! safety\n",
        "packages/omo-computer-sdk/src/index.ts": 'export const abi = "Senpi_Desktop/1"\n',
      })
      repo.commit("edges")
      const result = run(repo, "--no-legacy-edge")
      expect(result.exitCode).toBe(1)
      expect(result.findings.some((line) => line.includes("crates/omo-computer-core/Cargo.toml"))).toBe(true)
      expect(result.findings.some((line) => line.includes("crates/omo-computer-safety/Cargo.toml"))).toBe(true)
      expect(result.findings.some((line) => line.includes("packages/omo-computer-sdk/src/index.ts:1"))).toBe(true)
    })
  })
})

describe("computer-v3-guards --copy <ref>", () => {
  const oldSource = lines("old", 40)

  test("#given new sources written fresh, plus copies only into fixtures or under 20 lines #when compared with the base #then it passes", () => {
    withRepo((repo) => {
      repo.write({
        "crates/senpi-desktop-core/src/lib.rs": oldSource,
        "crates/senpi-desktop-core/src/tiny.rs": lines("tiny", 10),
      })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({
        "crates/omo-computer-core/src/lib.rs": lines("fresh", 40),
        "crates/omo-computer-core/fixtures/conformance/data.rs": oldSource,
        "crates/omo-computer-core/src/tiny.rs": lines("tiny", 10),
      })
      repo.commit("new")
      const result = run(repo, "--copy", "base")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given a new source that is a copy of an old one #when compared with the base #then the copy is a finding naming both paths", () => {
    withRepo((repo) => {
      repo.write({ "crates/senpi-desktop-core/src/lib.rs": oldSource })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({ "crates/omo-computer-core/src/lib.rs": oldSource })
      repo.commit("copied")
      const result = run(repo, "--copy", "base")
      expect(result.exitCode).toBe(1)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toContain("crates/omo-computer-core/src/lib.rs")
      expect(result.findings[0]).toContain("crates/senpi-desktop-core/src/lib.rs")
    })
  })
})

describe("computer-v3-guards --scope <row> <ref> --plan <file>", () => {
  const plan = [
    "## Todos",
    "- [ ] 2. Pin the base and ship the guard script",
    "  Write scope: `script/computer-v3-guards.ts`; `crates/omo-computer-core/src/probe/**`; `docs/x-<pr>.md (a note; with a semicolon)`; `$CU_RUN/BASE`; `GitHub issue (tracking)`",
    "- [ ] 80. Remove the old implementation",
    "  Write scope: `every path of the Removal inventory (classes A-D)`; `changes/unreleased/<pr>.md`",
    "",
  ].join("\n")

  test("#given changes inside the row's scope, the shared-append files and a touched unit's wiring files #when checked #then it passes", () => {
    withRepo((repo) => {
      repo.write({ "plan.md": plan, "README.md": "base\n" })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({
        "script/computer-v3-guards.ts": "export {}\n",
        "crates/omo-computer-core/src/probe/a/b.rs": "//! probe\n",
        "crates/omo-computer-core/Cargo.toml": "[package]\n",
        "crates/omo-computer-core/src/lib.rs": "mod probe;\n",
        "crates/omo-computer-core/src/probe/mod.rs": "mod a;\n",
        "crates/omo-computer-engine/src/route.rs": "// one registration line\n",
        "docs/x-123.md": "note\n",
        "changes/unreleased/77.md": "fragment\n",
        "Cargo.toml": "[workspace]\n",
      })
      repo.commit("in scope")
      const result = run(repo, "--scope", "2", "base", "--plan", join(repo.root, "plan.md"))
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given a change outside the row's scope #when checked #then that path is a finding and it exits 1", () => {
    withRepo((repo) => {
      repo.write({ "plan.md": plan, "README.md": "base\n" })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({
        "script/computer-v3-guards.ts": "export {}\n",
        "docs/other.md": "outside\n",
        "crates/omo-computer-core/src/other.rs": "// not a wiring file\n",
      })
      repo.commit("out of scope")
      const result = run(repo, "--scope", "2", "base", "--plan", join(repo.root, "plan.md"))
      expect(result.exitCode).toBe(1)
      expect(result.findings).toHaveLength(2)
      expect(result.findings.some((line) => line.includes("docs/other.md"))).toBe(true)
      expect(result.findings.some((line) => line.includes("crates/omo-computer-core/src/other.rs"))).toBe(true)
    })
  })

  test("#given the removal row's inventory entry #when every class A-D path changes #then it passes", () => {
    withRepo((repo) => {
      repo.write({ "plan.md": plan, "crates/senpi-desktop-core/src/lib.rs": "old\n", ".github/workflows/desktop-engine.yml": "old\n", "knip.jsonc": "{}\n", "Cargo.lock": "\n" })
      repo.commit("base")
      repo.git("branch", "base")
      rmSync(join(repo.root, "crates/senpi-desktop-core"), { recursive: true })
      rmSync(join(repo.root, ".github/workflows/desktop-engine.yml"))
      repo.write({ "knip.jsonc": "{ }\n", "Cargo.lock": "\n\n", "changes/unreleased/80.md": "removed\n" })
      repo.commit("removal")
      const result = run(repo, "--scope", "80", "base", "--plan", join(repo.root, "plan.md"))
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given the write-scope grammar #when a line carries notes, nested backticks and non-repository entries #then only the patterns remain", () => {
    const parsed = parseWriteScope(
      "  Write scope: `Cargo.toml (workspace members, shared-append)`; `package.json (workspaces, `test:computer` script; shared-append)`; `crates/omo-computer-backend-macos/probes/*.{sh,ps1} (helpers the probe script calls, kept)`; `omo-desktop-app repository: `.github/workflows/release.yml`, `x.yml` (three places) - one PR there`; `$CU_RUN/evidence/ (no repository change; each fix is its own PR)`; `<session working directory>/.omo/omo.jsonc (one added key)`; `GitHub issues and PR comments`; `packages/omo-config-core/src/schema/computer.ts (`computer.runtime` removed; the value `legacy` is refused)`",
    )
    expect(parsed).toEqual([
      "Cargo.toml",
      "package.json",
      "crates/omo-computer-backend-macos/probes/*.{sh,ps1}",
      "packages/omo-config-core/src/schema/computer.ts",
    ])
  })
})

describe("computer-v3-guards --old-frozen <ref>", () => {
  test("#given a branch that leaves the old directories untouched #when checked #then it passes", () => {
    withRepo((repo) => {
      repo.write({ "README.md": "base\n", "crates/senpi-desktop-core/src/lib.rs": "old\n" })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({ "README.md": "changed\n", "crates/omo-computer-core/src/lib.rs": "new\n" })
      repo.commit("new")
      const result = run(repo, "--old-frozen", "base")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given a branch that edits a file under an old directory #when checked #then the path is a finding and it exits 1", () => {
    withRepo((repo) => {
      repo.write({ "README.md": "base\n", "crates/senpi-desktop-core/src/lib.rs": "old\n" })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({ "crates/senpi-desktop-core/src/lib.rs": "old\n// one more line\n" })
      repo.commit("touch old")
      const result = run(repo, "--old-frozen", "base")
      expect(result.exitCode).toBe(1)
      expect(result.findings).toEqual(["old-frozen: crates/senpi-desktop-core/src/lib.rs"])
    })
  })
})

describe("computer-v3-guards --parity", () => {
  const manifestPath = "crates/omo-computer-core/parity/test-parity-manifest.tsv"
  const legsPath = "crates/omo-computer-core/parity/DEFERRED-LEGS.tsv"
  const header = "unit\tkind\ttest id\tstatus\tnote\n"
  const legsHeader = "design row\tleg\trecorded by row\towed to row\tstatus\n"

  test("#given every row carrying a status, pending included #when checked #then it passes", () => {
    withRepo((repo) => {
      repo.write({
        [manifestPath]:
          header +
          "senpi-desktop-core\trust\tsenpi-desktop-core::frame::tests::crop\tpending\t\n" +
          "senpi-desktop-core\trust\tsenpi-desktop-core::keys::tests::chord\tported:omo-computer-core::keys::tests::chord\t\n" +
          "senpi-desktop-tool\tvitest\tpackages/senpi-desktop-tool/test/a.test.ts::does x\tsuperseded:AC-12\t\n" +
          "script\tbun\tscript/desktop-engine-release.test.ts::builds\tdropped:Rejected with reasons: osascript canary\tnote\n",
        [legsPath]: legsHeader,
      })
      repo.commit("manifest")
      const result = run(repo, "--parity")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given a row with a blank status and one with an unknown status #when checked #then each row is a finding and it exits 1", () => {
    withRepo((repo) => {
      repo.write({
        [manifestPath]:
          header +
          "senpi-desktop-core\trust\tsenpi-desktop-core::frame::tests::crop\t\t\n" +
          "senpi-desktop-core\trust\tsenpi-desktop-core::keys::tests::chord\tdone\t\n",
        [legsPath]: legsHeader,
      })
      repo.commit("manifest")
      const result = run(repo, "--parity")
      expect(result.exitCode).toBe(1)
      expect(result.findings).toHaveLength(2)
      expect(result.findings[0]).toContain("senpi-desktop-core::frame::tests::crop")
      expect(result.findings[1]).toContain("senpi-desktop-core::keys::tests::chord")
    })
  })

  test("#given --final #when no row is pending and no leg is owed to row 74 or earlier #then it passes", () => {
    withRepo((repo) => {
      repo.write({
        [manifestPath]: header + "u\trust\tu::a\tported:v3::a\t\n",
        [legsPath]: legsHeader + "C17\tthe serve leg\t28\t75\towed\nC18\tthe daemon leg\t28\t29\tpassed:v3-daemon-uds\n",
      })
      repo.commit("final")
      const result = run(repo, "--parity", "--final")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given --final #when a row is pending, a leg is malformed or a leg is still owed to row 74 #then each is a finding", () => {
    withRepo((repo) => {
      repo.write({
        [manifestPath]: header + "u\trust\tu::a\tpending\t\n",
        [legsPath]: legsHeader + "C17\tthe serve leg\t28\t74\towed\nC18\tmalformed\t28\n",
      })
      repo.commit("final")
      const result = run(repo, "--parity", "--final")
      expect(result.exitCode).toBe(1)
      expect(result.findings).toHaveLength(3)
      expect(result.findings.some((line) => line.includes("u::a") && line.includes("pending"))).toBe(true)
      expect(result.findings.some((line) => line.includes("C17") && line.includes("74"))).toBe(true)
      expect(result.findings.some((line) => line.includes("C18"))).toBe(true)
    })
  })
})

describe("computer-v3-guards --oracle", () => {
  const provenancePath = "crates/omo-computer-core/parity/ORACLE-PROVENANCE.tsv"
  const fixture = '{"method":"desktop.observe","abi":"omo-computer/1"}\n'
  const sha = new Bun.CryptoHasher("sha256").update(fixture).digest("hex")
  const header = "new path\told path\tbase sha\told sha256\tnew sha256\tsubstitutions\n"

  test("#given every imported fixture byte-equal to its manifest row and new cases prefixed v3- #when checked #then it passes", () => {
    withRepo((repo) => {
      repo.write({
        [provenancePath]: header + `crates/omo-computer-core/fixtures/conformance/observe.json\tcrates/senpi-desktop-core/fixtures/conformance/observe.json\td79bc6cc\t0000\t${sha}\tsenpi-desktop=1;senpi_desktop=0;SENPI_DESKTOP=0\n`,
        "crates/omo-computer-core/fixtures/conformance/observe.json": fixture,
        "crates/omo-computer-core/fixtures/conformance/v3-settle.json": "{}\n",
        "crates/omo-computer-backend-fake/fixtures/scenarios/v3-busy.json": "{}\n",
      })
      repo.commit("oracle")
      const result = run(repo, "--oracle")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given an edited fixture, a deleted one and an unprefixed new file #when checked #then each is a finding", () => {
    withRepo((repo) => {
      repo.write({
        [provenancePath]:
          header +
          `crates/omo-computer-core/fixtures/conformance/observe.json\tcrates/senpi-desktop-core/fixtures/conformance/observe.json\td79bc6cc\t0000\t${sha}\t1;0;0\n` +
          `crates/omo-computer-core/fixtures/conformance/gone.json\tcrates/senpi-desktop-core/fixtures/conformance/gone.json\td79bc6cc\t0000\t${sha}\t1;0;0\n`,
        "crates/omo-computer-core/fixtures/conformance/observe.json": fixture + " ",
        "crates/omo-computer-core/fixtures/conformance/extra.json": "{}\n",
      })
      repo.commit("oracle")
      const result = run(repo, "--oracle")
      expect(result.exitCode).toBe(1)
      expect(result.findings).toHaveLength(3)
      expect(result.findings.some((line) => line.includes("observe.json"))).toBe(true)
      expect(result.findings.some((line) => line.includes("gone.json"))).toBe(true)
      expect(result.findings.some((line) => line.includes("extra.json"))).toBe(true)
    })
  })
})

describe("computer-v3-guards --stubs", () => {
  test("#given new sources with a live-ignored test and no stub #when checked #then it passes", () => {
    withRepo((repo) => {
      repo.write({
        "crates/omo-computer-core/src/lib.rs": '#[cfg(test)]\nmod tests {\n    #[test]\n    #[ignore = "live: needs a display"]\n    fn capture() {}\n}\n',
        "packages/omo-computer-sdk/test/a.test.ts": 'import { it } from "vitest"\nit("works", () => {})\n',
        "docs/todo.md": "unimplemented!() is forbidden; it.skip( too\n",
      })
      repo.commit("clean")
      const result = run(repo, "--stubs")
      expect(result.findings).toEqual([])
      expect(result.exitCode).toBe(0)
    })
  })

  test("#given unimplemented!, todo!, it.skip, describe.only and a bare #[ignore] #when checked #then each line is a finding", () => {
    withRepo((repo) => {
      repo.write({
        "crates/omo-computer-session/src/lib.rs": "fn a() { unimplemented!() }\nfn b() { todo!(\"later\") }\n#[test]\n#[ignore]\nfn c() {}\n",
        "packages/omo-computer-tool/test/a.test.ts": 'it.skip("a", () => {})\ndescribe.only("b", () => {})\n',
      })
      repo.commit("stubs")
      const result = run(repo, "--stubs")
      expect(result.exitCode).toBe(1)
      expect(result.findings).toHaveLength(5)
      expect(result.findings.filter((line) => line.includes("crates/omo-computer-session/src/lib.rs"))).toHaveLength(3)
      expect(result.findings.filter((line) => line.includes("packages/omo-computer-tool/test/a.test.ts"))).toHaveLength(2)
    })
  })
})

describe("computer-v3-guards command line", () => {
  test("#given a violating tree #when the script runs as a command #then it prints one line per finding and exits 1", () => {
    withRepo((repo) => {
      repo.write({ "crates/senpi-desktop-core/src/lib.rs": "old\n" })
      repo.commit("base")
      repo.git("branch", "base")
      repo.write({ "crates/senpi-desktop-core/src/lib.rs": "old\nmore\n" })
      repo.commit("touch")
      const result = Bun.spawnSync([process.execPath, guardScript, "--old-frozen", "base"], { cwd: repo.root, env: process.env, stdout: "pipe", stderr: "pipe" })
      expect(result.stdout.toString()).toBe("old-frozen: crates/senpi-desktop-core/src/lib.rs\n")
      expect(result.exitCode).toBe(1)
    })
  })

  test("#given an unknown sub-command #when the script runs #then it prints usage and exits 2", () => {
    const result = Bun.spawnSync([process.execPath, guardScript, "--nope"], { cwd: tmpdir(), env: process.env, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("usage")
  })
})
