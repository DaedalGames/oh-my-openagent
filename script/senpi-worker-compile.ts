import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, sep } from "node:path"

// Each entry is the file the engine's exported subpath resolves to, never a path into its per-file tree.
const SENPI_COMPILE_ENTRIES = [
  // The shared-session worker.
  { define: "SENPI_RPC_SESSION_WORKER_ENTRY", specifier: "@code-yeongyu/senpi/session-worker" },
  // The kill guard's judge, imported by URL from codemode kernels (senpi#5358).
  { define: "SENPI_KILL_GUARD_ENTRY", specifier: "@code-yeongyu/senpi/kill-guard" },
] as const

function resolveEntry(specifier: string, repoRoot: string): string | undefined {
  try {
    const resolved = Bun.resolveSync(specifier, repoRoot)
    return existsSync(resolved) ? realpathSync(resolved) : undefined
  } catch {
    // An engine without the export (or no engine) compiles without that entry, as before.
    return undefined
  }
}

/** Bun entry names are relative to --root, not to the relocated executable's cwd. */
export function senpiWorkerCompileArgs(repoRoot: string): string[] {
  const entries = SENPI_COMPILE_ENTRIES.flatMap(({ define, specifier }) => {
    const entry = resolveEntry(specifier, repoRoot)
    return entry === undefined ? [] : [{ define, entry }]
  })
  if (entries.length === 0) return []
  let root = realpathSync(repoRoot)
  // Bun embeds the physical entry name, including .bun store paths. Linked
  // development engines outside the repo need a root containing every entry.
  const escapesRoot = (): boolean => entries.some(({ entry }) => relative(root, entry).startsWith(`..${sep}`))
  while (escapesRoot()) root = dirname(root)
  const args = [`--root=${root}`]
  for (const { define, entry } of entries) {
    const name = relative(root, entry)
    if (isAbsolute(name)) throw new Error("The wrapper and engine entries must share a filesystem root")
    args.push(`--define=${define}=${JSON.stringify(`./${name.split(sep).join("/")}`)}`)
  }
  return [...args, ...entries.map(({ entry }) => entry)]
}
