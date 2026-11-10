// Guards of the computer-use v3 clean reimplementation (plan row 2). RED commit: signature stubs only.

export type GuardResult = {
  readonly exitCode: 0 | 1 | 2
  readonly findings: readonly string[]
}

export function parseWriteScope(_line: string): readonly string[] {
  return []
}

export function runGuard(_args: readonly string[], _options: { readonly cwd: string }): GuardResult {
  return { exitCode: 0, findings: [] }
}

if (import.meta.main) {
  const result = runGuard(process.argv.slice(2), { cwd: process.cwd() })
  for (const finding of result.findings) console.log(finding)
  process.exit(result.exitCode)
}
