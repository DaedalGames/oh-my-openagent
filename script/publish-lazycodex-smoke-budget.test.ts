/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Executes the "Smoke test published lazycodex-ai" step of publish.yml with `npm`, `npx`, and
 * `sleep` stubbed as bash functions, so the propagation budget is asserted rather than assumed.
 *
 * Regression pinned (2026-09-12, 5.0.0-beta.57, #8182): `npm publish` succeeded at 06:08:39Z, the
 * registry exposed the version at 06:12:54Z, and the smoke gave up at 06:12:23Z after 12 x 10 s -
 * a false failure of a successful publish, the same shape the omo-ai readiness loop was cured of
 * in `publish-readiness-budget.test.ts`.
 */

const workflowPath = new URL("../.github/workflows/publish.yml", import.meta.url)
const workflowText = readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n")
const workflow = Bun.YAML.parse(workflowText) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
}

function smokeRunBlock(): string {
  const step = workflow.jobs["post-publish-verify"].steps.find((s) => s.name === "Smoke test published lazycodex-ai")
  if (!step?.run) throw new Error("post-publish-verify has no 'Smoke test published lazycodex-ai' run block")
  return step.run
}

interface Outcome {
  readonly status: number
  readonly output: string
  readonly npmViews: number
  readonly sleptSeconds: number
}

// The release default lives in the run block; the exhausted-budget case runs a few polls through the injected
// LAZYCODEX_SMOKE_READINESS_ATTEMPTS so it does not run all 60 through the stubs (over 30 s on Windows Git Bash, #15444).
function runSmoke(readyAfterViews: number, attempts?: number): Outcome {
  const root = mkdtempSync(join(tmpdir(), "publish-lazycodex-smoke-"))
  try {
    const counter = join(root, "npm-views")
    const sleeps = join(root, "sleeps")
    writeFileSync(counter, "0")
    writeFileSync(sleeps, "")
    const preamble = [
      "npm() {",
      '  local n; n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" > "$COUNTER"',
      '  if [ "$n" -gt "$READY_AFTER" ]; then printf "%s\\n" "$OMO_VERSION"; return 0; fi',
      "  return 1",
      "}",
      "npx() { return 1; }",
      'sleep() { printf "%s\\n" "$1" >> "$SLEEPS"; }',
      "export -f npm npx sleep",
      "",
    ].join("\n")
    const script = join(root, "smoke.sh")
    writeFileSync(script, preamble + smokeRunBlock())
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        COUNTER: counter,
        SLEEPS: sleeps,
        READY_AFTER: String(readyAfterViews),
        OMO_VERSION: "5.0.0-beta.57",
        DIST_TAG: "beta",
        GITHUB_WORKSPACE: root,
        ...(attempts === undefined ? {} : { LAZYCODEX_SMOKE_READINESS_ATTEMPTS: String(attempts) }),
      },
    })
    const sleptSeconds = readFileSync(sleeps, "utf8")
      .split("\n")
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line), 0)
    return {
      status: result.status ?? -1,
      output: result.stdout + result.stderr,
      npmViews: Number(readFileSync(counter, "utf8").trim()),
      sleptSeconds,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("publish.yml post-publish-verify LazyCodex smoke readiness", () => {
  test("#given the registry needs ~5 minutes to expose the version #when the smoke polls #then it reaches the package instead of giving up", () => {
    const outcome = runSmoke(20)
    expect(outcome.npmViews).toBe(21)
    expect(outcome.output).toContain("became visible")
  })

  test("#given the registry never exposes the version #when the budget is exhausted #then it fails and names propagation, not the package", () => {
    const outcome = runSmoke(Number.MAX_SAFE_INTEGER, 3)
    expect(outcome.status).not.toBe(0)
    expect(outcome.output).toContain("registry propagation")
    expect(outcome.npmViews).toBe(3)
    expect(outcome.output).toContain("within 45 s")
  })

  // Release contract: the default budget a real run uses (no override) covers npm's observed 4-5 minute exposure
  // lag with margin (#8182): at least 15 minutes of polling.
  test("#given no override #then the release polls for at least 15 minutes", () => {
    const run = smokeRunBlock()
    const attempts = Number(/SMOKE_READINESS_ATTEMPTS="\$\{LAZYCODEX_SMOKE_READINESS_ATTEMPTS:-(\d+)\}"/.exec(run)?.[1])
    const interval = Number(/SMOKE_READINESS_INTERVAL_SECONDS=(\d+)/.exec(run)?.[1])
    expect(attempts * interval).toBeGreaterThanOrEqual(15 * 60)
  })

  test("#given a malformed override #then it falls back to the release default instead of polling zero times", () => {
    const outcome = runSmoke(20, 0)
    expect(outcome.output).toContain("is not a positive integer")
    expect(outcome.npmViews).toBe(21)
  })
})
