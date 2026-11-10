// Guards of the computer-use v3 clean reimplementation (plan row 2).
//
// Every sub-command exits 0 on pass and 1 with one line per finding on fail; nothing here is
// advisory. The name map, the shared-append list, the removal inventory and the legacy-name
// exclusions live in computer-v3-name-map.json beside this file; the plan file is read at run
// time only by --scope, and only for a row's write scope.
//
//   --residue                          after the removal: no old name outside the exclusions, no class A/B path
//   --no-legacy-edge                   no new directory names or links to the old family
//   --copy <ref>                       no new implementation source is a rename/copy of an old one (>= 50 %)
//   --scope <row> <ref> --plan <file>  every changed path is in the row's write scope or the shared-append list
//   --old-frozen <ref>                 no change under the 17 old directories
//   --parity [--final]                 every parity-manifest row has a valid status; --final also gates deferred legs
//   --oracle                           every imported fixture is byte-equal to its provenance row; new cases are v3-*
//   --stubs                            no unimplemented!/todo!/skip/only/bare #[ignore] under the new directories

import { existsSync, readFileSync } from "node:fs"
import { join, posix, resolve } from "node:path"

export type GuardResult = {
  readonly exitCode: 0 | 1 | 2
  readonly findings: readonly string[]
}

type NameMap = {
  readonly oldNameFamily: { readonly pattern: string }
  readonly newDirectories: readonly string[]
  readonly oldDirectories: readonly string[]
  readonly sharedAppend: readonly string[]
  readonly unitWiringFiles: readonly string[]
  readonly engineRouteFile: string
  readonly legacyNameExclusions: readonly string[]
  readonly oracleDirectories: readonly string[]
  readonly parity: { readonly manifest: string; readonly deferredLegs: string; readonly oracleProvenance: string; readonly finalGateRow: number }
  readonly removal: { readonly classA: readonly string[]; readonly classB: readonly { readonly path: string }[]; readonly classC: readonly string[]; readonly classD: readonly string[] }
}

const NAME_MAP_PATH = join(import.meta.dir, "computer-v3-name-map.json")
const nameMap: NameMap = JSON.parse(readFileSync(NAME_MAP_PATH, "utf8"))

const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".mjs", ".js", ".py", ".m", ".swift", ".c", ".h"])
const DATA_SEGMENTS = /(?:^|\/)(?:fixtures|testdata|goldens)\//
const MIN_COPY_LINES = 20

// ---------------------------------------------------------------------------------------------
// path patterns (the write-scope grammar of the plan's Executor contract, item 5)

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern)
  if (!match) return [pattern]
  const head = pattern.slice(0, match.index)
  const tail = pattern.slice(match.index + match[0].length)
  return match[1].split(",").flatMap((option) => expandBraces(`${head}${option}${tail}`))
}

function globToRegExp(pattern: string): RegExp {
  const everythingBelow = pattern.endsWith("/")
  const escaped = pattern
    .replace(/[.+?^$()|[\]\\]/g, "\\$&")
    .replace(/<pr>/g, "\\d+")
    .replace(/\*\*\//g, "\0DEEP\0")
    .replace(/\*\*/g, "\0ANY\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0DEEP\0/g, "(?:.*/)?")
    .replace(/\0ANY\0/g, ".*")
  return new RegExp(`^${escaped}${everythingBelow ? ".*" : ""}$`)
}

function matcher(patterns: readonly string[]): (path: string) => boolean {
  const regexps = patterns.flatMap(expandBraces).map(globToRegExp)
  return (path) => regexps.some((regexp) => regexp.test(path))
}

const isExcludedLegacyName = matcher(nameMap.legacyNameExclusions)
const isUnderNewDirectory = matcher(nameMap.newDirectories)
const isUnder = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`)
const isUnderOldDirectory = (path: string): boolean => nameMap.oldDirectories.some((directory) => isUnder(path, directory))

/** The backtick-quoted patterns of a plan row's `Write scope:` line; notes and non-repository entries are dropped. */
export function parseWriteScope(line: string): readonly string[] {
  const body = line.replace(/^\s*Write scope:\s*/, "")
  const entries: string[] = []
  let depth = 0
  let current = ""
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === "(") depth += 1
    if (char === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && body.startsWith("; ", index)) {
      entries.push(current)
      current = ""
      index += 1
      continue
    }
    current += char
  }
  entries.push(current)
  return entries
    .map((entry) => entry.trim().replace(/^`/, "").replace(/`$/, ""))
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.startsWith("$CU_RUN/") && !entry.startsWith("<session working directory>/") && !entry.startsWith("GitHub") && !entry.includes(" repository: "))
    .map((entry) => (entry.includes(" (") ? entry.slice(0, entry.indexOf(" (")) : entry))
}

// ---------------------------------------------------------------------------------------------
// git

type Git = (...args: string[]) => { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

function gitIn(cwd: string): Git {
  return (...args) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
}

function gitLines(git: Git, args: readonly string[], allowedExitCodes: readonly number[] = [0]): string[] {
  const result = git(...args)
  if (!allowedExitCodes.includes(result.exitCode)) throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`)
  return result.stdout.split("\n").filter((line) => line.length > 0)
}

/** Tracked plus untracked-not-ignored files under the given pathspecs (the working tree as a reviewer sees it). */
const listFiles = (git: Git, pathspecs: readonly string[]): string[] => gitLines(git, ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs])

const grepOldName = (git: Git, pathspecs: readonly string[]): string[] =>
  gitLines(git, ["grep", "-n", "-I", "-i", "--untracked", "-E", nameMap.oldNameFamily.pattern, "--", ...pathspecs], [0, 1])

const changedPaths = (git: Git, ref: string): string[] => gitLines(git, ["diff", "--name-only", `${ref}...HEAD`])

const newDirectoryPathspecs = nameMap.newDirectories.map((directory) => directory.replace(/\/$/, ""))

// ---------------------------------------------------------------------------------------------
// guards

function residue(git: Git): string[] {
  const findings = grepOldName(git, ["."])
    .filter((line) => !isExcludedLegacyName(line.slice(0, line.indexOf(":"))))
    .map((line) => `residue: ${line}`)
  for (const path of [...nameMap.removal.classA, ...nameMap.removal.classB.map((entry) => entry.path)]) {
    if (listFiles(git, [path]).length > 0) findings.push(`residue: ${path} still exists`)
  }
  return findings
}

function noLegacyEdge(git: Git, cwd: string): string[] {
  const findings = grepOldName(git, newDirectoryPathspecs)
    .filter((line) => !isExcludedLegacyName(line.slice(0, line.indexOf(":"))))
    .map((line) => `no-legacy-edge: ${line}`)
  for (const file of listFiles(git, newDirectoryPathspecs).filter((path) => posix.basename(path) === "Cargo.toml")) {
    const content = readFileSync(join(cwd, file), "utf8")
    for (const match of content.matchAll(/path\s*=\s*"([^"]+)"/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1]))
      if (isUnderOldDirectory(target)) findings.push(`no-legacy-edge: ${file} points path = "${match[1]}" into ${target}`)
    }
  }
  return findings
}

function copy(git: Git, ref: string): string[] {
  const mergeBase = gitLines(git, ["merge-base", ref, "HEAD"])[0]
  if (!mergeBase) throw new Error(`no merge base between ${ref} and HEAD`)
  const diff = gitLines(
    git,
    ["diff", "-l0", "-M50%", "-C50%", "--find-copies-harder", "--diff-filter=RC", "--name-status", mergeBase, "HEAD", "--", ...nameMap.oldDirectories, ...newDirectoryPathspecs],
  )
  const findings: string[] = []
  for (const line of diff) {
    const match = /^([RC])(\d+)\t([^\t]+)\t([^\t]+)$/.exec(line)
    if (!match) continue
    const [, kind, score, source, destination] = match
    if (!isUnderOldDirectory(source) || !isUnderNewDirectory(destination)) continue
    if (!SOURCE_EXTENSIONS.has(posix.extname(destination)) || destination.endsWith(".config.ts") || DATA_SEGMENTS.test(destination)) continue
    const lineCount = gitLines(git, ["show", `HEAD:${destination}`]).length
    if (lineCount < MIN_COPY_LINES) continue
    findings.push(`copy: ${destination} is a ${kind === "R" ? "rename" : "copy"} (${score}%) of ${source}`)
  }
  return findings
}

function removalInventoryPaths(): string[] {
  const { classA, classB, classC, classD } = nameMap.removal
  return [...classA.map((directory) => `${directory}/`), ...classB.map((entry) => entry.path), ...classC, ...classD]
}

function unitRoots(patterns: readonly string[]): string[] {
  const roots = new Set<string>()
  for (const pattern of patterns.flatMap(expandBraces)) {
    const match = /^((?:crates|packages)\/omo-computer-[^/]+\/)/.exec(pattern)
    if (match) roots.add(match[1])
  }
  return [...roots]
}

function scopePatterns(row: string, planFile: string): string[] {
  const lines = readFileSync(planFile, "utf8").split("\n")
  const start = lines.findIndex((line) => new RegExp(`^- \\[[ x~]\\] ${row}\\. `).test(line))
  if (start < 0) throw new Error(`row ${row} not found in ${planFile}`)
  let scopeLine: string | undefined
  for (let index = start + 1; index < lines.length && !/^- \[|^## /.test(lines[index]); index += 1) {
    if (lines[index].startsWith("  Write scope: ")) scopeLine = lines[index]
  }
  if (scopeLine === undefined) throw new Error(`row ${row} has no 'Write scope:' line in ${planFile}`)
  // The plan writes this entry as `every path of the Removal inventory (classes A-D)`; parseWriteScope drops the note.
  const patterns = parseWriteScope(scopeLine).flatMap((entry) => (entry === "every path of the Removal inventory" ? removalInventoryPaths() : [entry]))
  const roots = unitRoots(patterns)
  const wiring = roots.flatMap((root) => nameMap.unitWiringFiles.map((file) => `${root}${file}`))
  if (roots.some((root) => root.startsWith("crates/"))) wiring.push(nameMap.engineRouteFile)
  return [...patterns, ...nameMap.sharedAppend, ...wiring]
}

function scope(git: Git, row: string, ref: string, planFile: string): string[] {
  const allowed = matcher(scopePatterns(row, planFile))
  return changedPaths(git, ref)
    .filter((path) => !allowed(path))
    .map((path) => `scope: ${path} is outside row ${row}'s write scope and the shared-append list`)
}

const oldFrozen = (git: Git, ref: string): string[] => changedPaths(git, ref).filter(isUnderOldDirectory).map((path) => `old-frozen: ${path}`)

function readTsv(cwd: string, path: string): { readonly rows: readonly string[][]; readonly missing: boolean } {
  const absolute = join(cwd, path)
  if (!existsSync(absolute)) return { rows: [], missing: true }
  const rows = readFileSync(absolute, "utf8")
    .split("\n")
    .slice(1)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"))
  return { rows, missing: false }
}

const PARITY_STATUS = /^(?:pending|ported:.+|superseded:AC-\d+|dropped:.+)$/

function parity(cwd: string, final: boolean): string[] {
  const findings: string[] = []
  const manifest = readTsv(cwd, nameMap.parity.manifest)
  if (manifest.missing) findings.push(`parity: ${nameMap.parity.manifest} is missing`)
  manifest.rows.forEach((columns, index) => {
    const status = columns[3] ?? ""
    const testId = columns[2] ?? `line ${index + 2}`
    if (!PARITY_STATUS.test(status)) findings.push(`parity: ${testId} has status "${status}" (line ${index + 2})`)
    else if (final && status === "pending") findings.push(`parity: ${testId} is still pending (line ${index + 2})`)
  })
  if (!final) return findings
  const legs = readTsv(cwd, nameMap.parity.deferredLegs)
  if (legs.missing) findings.push(`parity: ${nameMap.parity.deferredLegs} is missing`)
  legs.rows.forEach((columns, index) => {
    const [designRow, , recordedBy, owedTo, status] = columns
    if (columns.length !== 5 || !/^\d+$/.test(recordedBy ?? "") || !/^\d+$/.test(owedTo ?? "") || !/^(?:owed|passed:.+)$/.test(status ?? "")) {
      findings.push(`parity: DEFERRED-LEGS line ${index + 2} (${designRow ?? ""}) is malformed`)
      return
    }
    if (status === "owed" && Number(owedTo) <= nameMap.parity.finalGateRow) findings.push(`parity: DEFERRED-LEGS ${designRow} is still owed to row ${owedTo}`)
  })
  return findings
}

function oracle(git: Git, cwd: string): string[] {
  const findings: string[] = []
  const provenance = readTsv(cwd, nameMap.parity.oracleProvenance)
  if (provenance.missing) return [`oracle: ${nameMap.parity.oracleProvenance} is missing`]
  const listed = new Set<string>()
  for (const columns of provenance.rows) {
    const [newPath, , , , expectedSha] = columns
    if (!newPath || !expectedSha) continue
    listed.add(newPath)
    const absolute = join(cwd, newPath)
    if (!existsSync(absolute)) {
      findings.push(`oracle: ${newPath} is listed but missing`)
      continue
    }
    const actualSha = new Bun.CryptoHasher("sha256").update(readFileSync(absolute)).digest("hex")
    if (actualSha !== expectedSha) findings.push(`oracle: ${newPath} differs from its provenance row (${actualSha} != ${expectedSha})`)
  }
  const directories = new Set([...nameMap.oracleDirectories.map((directory) => directory.replace(/\/$/, "")), ...[...listed].map((path) => posix.dirname(path))])
  for (const file of listFiles(git, [...directories])) {
    if (listed.has(file) || file === nameMap.parity.oracleProvenance) continue
    if (!posix.basename(file).startsWith("v3-")) findings.push(`oracle: ${file} is not in the provenance manifest and is not a v3- case`)
  }
  return findings
}

const STUB_PATTERNS: readonly { readonly name: string; readonly regexp: RegExp }[] = [
  { name: "unimplemented!", regexp: /unimplemented!/ },
  { name: "todo!(", regexp: /todo!\(/ },
  { name: "skipped or exclusive test", regexp: /\b(?:it|test|describe)\.(?:skip|only)\(/ },
  { name: "bare #[ignore] (a live test is written #[ignore = \"live: <what it needs>\"])", regexp: /#\[ignore(?:\]|\s*=\s*"(?!live: ))/ },
]

function stubs(git: Git, cwd: string): string[] {
  const findings: string[] = []
  for (const file of listFiles(git, newDirectoryPathspecs).filter((path) => SOURCE_EXTENSIONS.has(posix.extname(path)))) {
    readFileSync(join(cwd, file), "utf8").split("\n").forEach((line, index) => {
      for (const { name, regexp } of STUB_PATTERNS) if (regexp.test(line)) findings.push(`stubs: ${file}:${index + 1}: ${name}`)
    })
  }
  return findings
}

// ---------------------------------------------------------------------------------------------
// entry

const USAGE = [
  "usage: bun script/computer-v3-guards.ts <sub-command>",
  "  --residue | --no-legacy-edge | --copy <ref> | --scope <row> <ref> --plan <file> | --old-frozen <ref> | --parity [--final] | --oracle | --stubs",
].join("\n")

function dispatch(args: readonly string[], cwd: string): string[] | undefined {
  const git = gitIn(cwd)
  const [command, ...rest] = args
  switch (command) {
    case "--residue":
      return residue(git)
    case "--no-legacy-edge":
      return noLegacyEdge(git, cwd)
    case "--copy":
      return rest[0] ? copy(git, rest[0]) : undefined
    case "--scope": {
      const [row, ref, planFlag, planFile] = rest
      return row && ref && planFlag === "--plan" && planFile ? scope(git, row, ref, resolve(cwd, planFile)) : undefined
    }
    case "--old-frozen":
      return rest[0] ? oldFrozen(git, rest[0]) : undefined
    case "--parity":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "--final") ? parity(cwd, rest[0] === "--final") : undefined
    case "--oracle":
      return oracle(git, cwd)
    case "--stubs":
      return stubs(git, cwd)
    default:
      return undefined
  }
}

export function runGuard(args: readonly string[], options: { readonly cwd: string }): GuardResult {
  const findings = dispatch(args, options.cwd)
  if (findings === undefined) return { exitCode: 2, findings: [] }
  return { exitCode: findings.length === 0 ? 0 : 1, findings }
}

if (import.meta.main) {
  const result = runGuard(process.argv.slice(2), { cwd: process.cwd() })
  if (result.exitCode === 2) console.error(USAGE)
  for (const finding of result.findings) console.log(finding)
  process.exit(result.exitCode)
}

