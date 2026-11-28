import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { resolveSenpi, updateTarget } from "../bin/lib/package-paths.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

type EngineFixtureOptions = {
  cli?: boolean
  manifest?: boolean
}

/**
 * A minimal on-disk engine install shaped like the published package: the resolver hands the
 * launcher the exported `runtime-manifest.json` (in `dist/bundle/`), and the launcher takes the
 * bundle CLI beside it. The corrupted variants mirror real partially-reified npm trees seen in the
 * wild, where an interrupted upgrade keeps some dist files and loses others.
 */
function createEngineFixture(options: EngineFixtureOptions = {}): { manifestPath: string; senpiRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "omo-engine-integrity-"))
  roots.push(root)
  const senpiRoot = join(root, "node_modules", "@code-yeongyu", "senpi")
  writeFile(join(senpiRoot, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.8.25" }))
  const manifestPath = join(senpiRoot, "dist", "bundle", "runtime-manifest.json")
  if (options.manifest !== false) writeFile(manifestPath, "{}\n")
  if (options.cli !== false) writeFile(join(senpiRoot, "dist", "bundle", "cli.js"), "export {}\n")
  return { manifestPath, senpiRoot }
}

function resolveError(fixtureManifestPath: string, platform: string): Error {
  try {
    resolveSenpi({ resolveManifest: () => fixtureManifestPath, platform })
  } catch (error) {
    return error as Error
  }
  throw new Error("expected resolveSenpi to refuse the fixture install")
}

const REINSTALL_COMMAND = updateTarget().command

describe("engine install integrity", () => {
  describe("#given a partially reified install missing the bundle manifest", () => {
    describe("#when the launcher resolves the engine", () => {
      test("#then it refuses with the missing path, the partial-install diagnosis, and the reinstall command", () => {
        const { manifestPath } = createEngineFixture({ manifest: false })

        const error = resolveError(manifestPath, "darwin")

        expect(error.message).toContain(manifestPath)
        expect(error.message).toContain("incomplete")
        expect(error.message).toContain("interrupted")
        expect(error.message).toContain(`reinstall with: ${REINSTALL_COMMAND}`)
      })

      test("#then win32 adds the locked-native-module hint", () => {
        const { manifestPath } = createEngineFixture({ manifest: false })

        const error = resolveError(manifestPath, "win32")

        expect(error.message).toContain("EBUSY")
        expect(error.message).toContain("locks loaded native modules")
      })

      test("#then posix keeps the message free of the windows hint", () => {
        const { manifestPath } = createEngineFixture({ manifest: false })

        const error = resolveError(manifestPath, "linux")

        expect(error.message).not.toContain("EBUSY")
      })
    })
  })

  describe("#given an intact engine install", () => {
    describe("#when the launcher resolves the engine", () => {
      test("#then it hands back the bundle CLI beside the manifest and the package root", () => {
        const { manifestPath, senpiRoot } = createEngineFixture()

        const resolved = resolveSenpi({ resolveManifest: () => manifestPath, platform: "win32" })

        expect(resolved).toEqual({
          cliPath: join(senpiRoot, "dist", "bundle", "cli.js"),
          packageRoot: senpiRoot,
        })
      })
    })
  })

  describe("#given an install missing the engine CLI entirely", () => {
    describe("#when the launcher resolves the engine", () => {
      test("#then the established missing-CLI message is preserved", () => {
        const { manifestPath, senpiRoot } = createEngineFixture({ cli: false })

        const error = resolveError(manifestPath, "darwin")

        expect(error.message).toBe(
          `senpi CLI is missing at ${join(senpiRoot, "dist", "bundle", "cli.js")}; reinstall with: ${REINSTALL_COMMAND}`,
        )
      })
    })
  })
})
