import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { builtinModules, createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { RELEASE_BINARY_TARGETS, resolveExpectedSidecarRelPaths } from "./build-omo-binary"
import {
  codemodeRuntimeDependencySources,
  engineServedPackages,
  engineServedSpecifiers,
  engineSidecarSources,
} from "./engine-sidecar-sources"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
// Node resolves a symlinked package from its real path, so the engine's view starts there.
const installedSenpiRequire = createRequire(
  join(realpathSync(join(repoRoot, "node_modules", "@code-yeongyu", "senpi")), "package.json"),
)

// Independent of the production resolver: the installed engine either resolves the
// package's manifest or Node reports it missing.
function engineResolves(packageName: string): boolean {
  try {
    installedSenpiRequire.resolve(`${packageName}/package.json`)
    return true
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "MODULE_NOT_FOUND") return false
    throw error
  }
}

function writePackage(
  packageDir: string,
  manifest: {
    readonly name: string
    readonly version: string
    readonly dependencies?: Readonly<Record<string, string>>
    readonly optionalDependencies?: Readonly<Record<string, string>>
  },
): void {
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest)}\n`)
}

/** An engine fixture whose public runtime manifest export (`./runtime-manifest.json`) holds `manifest`. */
function writeEngineManifest(hostDir: string, manifest: unknown): void {
  mkdirSync(join(hostDir, "dist", "bundle"), { recursive: true })
  writeFileSync(
    join(hostDir, "package.json"),
    `${JSON.stringify({
      name: "host",
      version: "1.0.0",
      exports: { "./runtime-manifest.json": { default: "./dist/bundle/runtime-manifest.json" } },
    })}\n`,
  )
  writeFileSync(join(hostDir, "dist", "bundle", "runtime-manifest.json"), JSON.stringify(manifest))
}

/** An engine fixture whose extension loader serves `specifiers`. */
function writeEngine(hostDir: string, specifiers: readonly string[]): void {
  writeEngineManifest(hostDir, { buildId: "fixture", externals: [], extensionModules: specifiers })
}

/**
 * What the installed engine serves, read from its runtime manifest through Bun's resolution of the public export:
 * independent of the export-map reader under test.
 */
function installedServedModules(): string[] {
  const manifestPath = fileURLToPath(import.meta.resolve("@code-yeongyu/senpi/runtime-manifest.json"))
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  const modules: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "extensionModules") : undefined
  if (!Array.isArray(modules) || !modules.every((entry) => typeof entry === "string")) {
    throw new Error(`${manifestPath} lists no extensionModules`)
  }
  return modules
}

/**
 * Bare imports in a staged package (its src/ and every staged node_modules/ package) that Bun's own resolver cannot
 * resolve from the importing file and that the engine does not serve.
 */
function unresolvedBareImports(stagedPackage: string, served: ReadonlySet<string>): string[] {
  const builtins = new Set(builtinModules)
  const unresolved = new Set<string>()
  const sourceFiles = [join(stagedPackage, "src"), join(stagedPackage, "node_modules")].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
          (entry) =>
            entry.isFile() &&
            /\.(?:ts|mts|js|mjs|cjs)$/.test(entry.name) &&
            !/\.(?:test|d)\.[mc]?[jt]s$/.test(entry.name),
        )
      : [],
  )
  if (sourceFiles.length === 0) throw new Error(`no sources to scan under ${stagedPackage}`)
  for (const entry of sourceFiles) {
    const file = join(entry.parentPath, entry.name)
    const transpiler = new Bun.Transpiler({ loader: /\.[mc]?ts$/.test(entry.name) ? "ts" : "js" })
    for (const { path: specifier } of transpiler.scanImports(readFileSync(file, "utf8").replace(/^#![^\n]*/, ""))) {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("bun:")) continue
      if (specifier.startsWith("node:") || builtins.has(specifier.split("/")[0] ?? "")) continue
      if (served.has(specifier)) continue
      try {
        Bun.resolveSync(specifier, dirname(file))
      } catch {
        unresolved.add(specifier)
      }
    }
  }
  return [...unresolved].sort()
}

describe("sidecar parity set", () => {
  test("requires every wasm asset when a runtime dependency ships nested assets", () => {
    // Given
    const root = join(tmpdir(), `omo-codemode-wasm-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    const dependency = join(codemode, "node_modules", "runtime")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { runtime: "1.0.0" } })
      writeEngine(host, ["typebox"])
      writePackage(dependency, { name: "runtime", version: "1.0.0" })
      mkdirSync(join(dependency, "assets"), { recursive: true })
      writeFileSync(join(dependency, "assets", "runtime.wasm"), new Uint8Array([0, 97, 115, 109]))
      // When
      const sources = codemodeRuntimeDependencySources(codemode, host)
      // Then
      expect(sources).toContainEqual({
        from: realpathSync(join(dependency, "assets", "runtime.wasm")),
        to: "node_modules/@code-yeongyu/senpi-codemode/node_modules/runtime/assets/runtime.wasm",
        required: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails when codemode declares an uninstalled runtime dependency", () => {
    // Given
    const root = join(tmpdir(), `omo-codemode-missing-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { missing: "1.0.0" } })
      writeEngine(host, ["typebox"])
      // When / Then
      expect(() => codemodeRuntimeDependencySources(codemode, host)).toThrow("missing/package.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given the css-tree trio #when the engine sidecars are resolved #then each is embedded exactly when the installed engine resolves it", () => {
    // given - the jsdom-era engine ships all three, a linkedom-era engine (senpi#1666) none
    const trio = ["css-tree", "mdn-data", "source-map-js"]

    const target = RELEASE_BINARY_TARGETS.find((entry) => entry.target === "darwin-arm64")
    if (target === undefined) throw new Error("darwin-arm64 is not a release target")

    // when
    const sources = engineSidecarSources()
    const relPaths = resolveExpectedSidecarRelPaths(target)

    // then
    for (const packageName of trio) {
      const installed = engineResolves(packageName)
      expect(sources.some((source) => source.to === `node_modules/${packageName}`)).toBe(installed)
      expect(relPaths.includes(`node_modules/${packageName}/package.json`)).toBe(installed)
    }
  })

  test("#given codemode's manifest #when runtime dependencies are resolved #then only dependencies the engine does not serve are nested transitively", () => {
    // given
    const codemode = installedSenpiRequire.resolve("@code-yeongyu/senpi-codemode/package.json")

    // when
    const destinations = codemodeRuntimeDependencySources(dirname(codemode)).map((source) => source.to)

    // then
    const parser = "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser"
    const types = `${parser}/node_modules/@babel/types`
    expect(destinations).toContain(parser)
    expect(destinations).toContain(types)
    expect(destinations).toContain(`${types}/node_modules/@babel/helper-string-parser`)
    expect(destinations).toContain(`${types}/node_modules/@babel/helper-validator-identifier`)
    expect(destinations.some((path) => path.includes("@earendil-works/pi-ai"))).toBe(false)
    expect(destinations.some((path) => path.endsWith("/typebox"))).toBe(false)
    // the engine depends on it but does not serve it to extensions (senpi 2026.11.13)
    expect(destinations).toContain(
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@earendil-works/pi-realm-registry",
    )
  })

  test.each([
    [
      "the host declares it at the same identity",
      (host: string) => {
        writeEngine(host, ["typebox"])
        writePackage(join(host, "node_modules", "shared"), { name: "shared", version: "2.0.0" })
      },
    ],
    [
      "the host declares it at another version",
      (host: string) => {
        writeEngine(host, ["typebox"])
        writePackage(join(host, "node_modules", "shared"), { name: "shared", version: "1.0.0" })
      },
    ],
    ["the host does not have it", (host: string) => writeEngine(host, ["typebox"])],
  ])(
    "#given %s #when the engine does not serve codemode's dependency #then codemode's copy is staged",
    (_label, prepareHost) => {
      // given
      const root = join(tmpdir(), `omo-codemode-unserved-${process.pid}-${crypto.randomUUID()}`)
      const codemode = join(root, "codemode")
      const host = join(root, "host")
      try {
        writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { shared: "2.0.0" } })
        writePackage(join(codemode, "node_modules", "shared"), { name: "shared", version: "2.0.0" })
        prepareHost(host)

        // when
        const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

        // then
        expect(destinations).toEqual(["node_modules/@code-yeongyu/senpi-codemode/node_modules/shared"])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test.each([
    [
      "only a subpath of the package",
      ["served/value"],
      ["node_modules/@code-yeongyu/senpi-codemode/node_modules/served"],
    ],
    ["the package's root", ["served", "served/value"], []],
  ] as const)(
    "#given the engine serves %s #when codemode depends on the package #then it is staged only when the root is not served",
    (_label, specifiers, expected) => {
      // given
      const root = join(tmpdir(), `omo-codemode-served-${process.pid}-${crypto.randomUUID()}`)
      const codemode = join(root, "codemode")
      const host = join(root, "host")
      try {
        writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { served: "1.0.0" } })
        writePackage(join(codemode, "node_modules", "served"), { name: "served", version: "1.0.0" })
        writeEngine(host, specifiers)

        // when
        const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

        // then
        expect(destinations).toEqual([...expected])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test("#given the engine serves a package's root #when a staged dependency depends on it #then it is not staged under that dependency either", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-served-deep-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { runtime: "1.0.0" } })
      const runtime = join(codemode, "node_modules", "runtime")
      writePackage(runtime, { name: "runtime", version: "1.0.0", dependencies: { served: "1.0.0" } })
      writePackage(join(runtime, "node_modules", "served"), { name: "served", version: "1.0.0" })
      writeEngine(host, ["served"])

      // when
      const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

      // then
      expect(destinations).toEqual(["node_modules/@code-yeongyu/senpi-codemode/node_modules/runtime"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["no runtime manifest export", (host: string) => writePackage(host, { name: "host", version: "1.0.0" })],
    [
      "an export whose file is missing",
      (host: string) => {
        writeEngine(host, ["typebox"])
        rmSync(join(host, "dist", "bundle", "runtime-manifest.json"))
      },
    ],
    ["a manifest without extensionModules", (host: string) => writeEngineManifest(host, { buildId: "fixture" })],
    ["an empty extensionModules", (host: string) => writeEngine(host, [])],
    ["a non-string entry", (host: string) => writeEngineManifest(host, { extensionModules: ["typebox", 7] })],
  ] as const)(
    "#given an engine with %s #when its served set is read #then the build fails naming the table",
    (_label, arrange) => {
      // given
      const host = join(tmpdir(), `omo-engine-bad-table-${process.pid}-${crypto.randomUUID()}`)
      try {
        arrange(host)

        // when / then
        expect(() => engineServedSpecifiers(host)).toThrow("cannot read the engine's extension module table")
      } finally {
        rmSync(host, { recursive: true, force: true })
      }
    },
  )

  // Release contract (senpi#7662): the served set is the engine's own published list, which senpi's bundle build writes
  // from the table its extension loader serves, including the senpi subpaths that table spreads in.
  test("#given the installed engine #when its served set is read #then it equals the extensionModules its runtime manifest publishes", () => {
    // given
    const published = installedServedModules()

    // when
    const served = engineServedSpecifiers()

    // then
    expect([...served].sort()).toEqual([...published].sort())
    expect(served.has("@code-yeongyu/senpi")).toBe(true)
    expect(served.has("@code-yeongyu/senpi/session-worker-data")).toBe(true)
  })

  test("#given optional dependencies #when one is installed and one is not #then the installed one is staged and the missing one is skipped", () => {
    // given - senpi's own copier walks optionalDependencies and skips one that does not resolve
    const root = join(tmpdir(), `omo-codemode-optional-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, {
        name: "codemode",
        version: "1.0.0",
        optionalDependencies: { present: "1.0.0", absent: "1.0.0" },
      })
      writePackage(join(codemode, "node_modules", "present"), { name: "present", version: "1.0.0" })
      writeEngine(host, ["typebox"])

      // when
      const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

      // then
      expect(destinations).toEqual(["node_modules/@code-yeongyu/senpi-codemode/node_modules/present"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given an engine whose extension table cannot be read #when codemode dependencies are resolved #then the build fails naming the table", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-no-table-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0" })
      writePackage(host, { name: "host", version: "1.0.0" })

      // when / then
      expect(() => codemodeRuntimeDependencySources(codemode, host)).toThrow("extension module table")
      expect(() => engineServedPackages(host)).toThrow(join(host, "package.json"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a transitive dependency cycle #when resolved #then ancestor packages are not staged twice", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-cycle-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { cycleA: "1.0.0" } })
      const cycleA = join(codemode, "node_modules", "cycleA")
      const cycleB = join(cycleA, "node_modules", "cycleB")
      writePackage(cycleA, { name: "cycleA", version: "1.0.0", dependencies: { cycleB: "1.0.0" } })
      writePackage(cycleB, { name: "cycleB", version: "1.0.0", dependencies: { cycleA: "1.0.0" } })
      writeEngine(host, ["typebox"])

      // when
      const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

      // then
      expect(destinations).toEqual([
        "node_modules/@code-yeongyu/senpi-codemode/node_modules/cycleA",
        "node_modules/@code-yeongyu/senpi-codemode/node_modules/cycleA/node_modules/cycleB",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given the installed engine #when the sidecars are resolved #then the sandbox runtime quickjs-wasi and its wasm are staged as required entries", () => {
    // Given / When
    const sources = engineSidecarSources()
    // Then
    const target = "node_modules/@code-yeongyu/senpi-codemode/node_modules/quickjs-wasi"
    expect(sources).toContainEqual(expect.objectContaining({ to: target, required: true }))
    expect(sources).toContainEqual(expect.objectContaining({ to: `${target}/quickjs.wasm`, required: true }))
  })

  test("#given the installed engine #when the sidecars are resolved #then the staged codemode package carries the vendored sandbox host and worker", () => {
    // Given / When
    const codemode = engineSidecarSources().find((source) => source.to === "node_modules/@code-yeongyu/senpi-codemode")
    // Then
    expect(codemode?.required).toBe(true)
    const vendored = join(codemode?.from ?? "", "src", "kernels", "sandbox", "vendor", "pi-codemode")
    for (const file of ["runtime/host.ts", "runtime/worker.ts", "runtime/prelude-source.ts", "wasm.ts", "LICENSE"]) {
      expect(existsSync(join(vendored, file))).toBe(true)
    }
  })

  test("#given a staged dependency that imports a package nobody stages #when the staged tree is scanned #then that import is reported", () => {
    // given
    const root = join(tmpdir(), `omo-staged-scan-${process.pid}-${crypto.randomUUID()}`)
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "src", "index.js"), 'import { run } from "runtime";\nimport value from "served";\n')
      writePackage(join(root, "node_modules", "runtime"), { name: "runtime", version: "1.0.0" })
      writeFileSync(
        join(root, "node_modules", "runtime", "index.js"),
        'import missing from "not-staged";\nexport const run = missing;\n',
      )

      // when
      const unresolved = unresolvedBareImports(root, new Set(["served"]))

      // then
      expect(unresolved).toEqual(["not-staged"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Release contract: the compiled binary loads codemode from the staged sidecars, so every package its sources
  // import must come from the engine's extension loader or be staged beside it (senpi 2026.11.13 added
  // @earendil-works/pi-realm-registry, which the engine depends on but does not serve to extensions).
  test("#given the installed engine #when codemode's sidecars are staged #then every bare import of codemode and its staged dependencies resolves to an engine-served module or a staged package", () => {
    // given - what the installed engine's loader serves, read with an independent parser
    const served = new Set(installedServedModules())
    const codemodeRoot = "node_modules/@code-yeongyu/senpi-codemode"
    const stage = join(tmpdir(), `omo-codemode-stage-${process.pid}-${crypto.randomUUID()}`)
    try {
      // when - stage exactly what the binary embeds for codemode
      for (const source of engineSidecarSources()) {
        if (source.to === codemodeRoot || source.to.startsWith(`${codemodeRoot}/`))
          cpSync(source.from, join(stage, source.to), { recursive: true, dereference: true })
      }

      // then - Bun's own resolver finds every import that the engine does not serve, in codemode's sources and in
      // every staged dependency
      expect(unresolvedBareImports(join(stage, codemodeRoot), served)).toEqual([])
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }, 60_000)
})
