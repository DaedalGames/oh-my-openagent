// script/engine-sidecar-sources.ts
// The engine half of the compiled binary's sidecar parity set: which files of the
// installed @code-yeongyu/senpi package (and of the packages it resolves) are embedded
// next to the executable, mapped from the npm layout onto the flattened binary layout.

import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
export const senpiPackageDir = join(repoRoot, "node_modules", "@code-yeongyu", "senpi")
// Resolve from senpi's REAL path: bun's isolated store links senpi's dependencies beside that
// path (`.bun/<key>/node_modules`), not beside the `node_modules/@code-yeongyu/senpi` symlink,
// so a require rooted at the symlink finds nothing once senpi stops bundling its dependencies.
const senpiRequire = createRequire(
  join(existsSync(senpiPackageDir) ? realpathSync(senpiPackageDir) : senpiPackageDir, "package.json"),
)

export interface SidecarSource {
  /** Absolute source path (file or directory). */
  readonly from: string
  /** Payload-relative destination path. */
  readonly to: string
  /** When true a missing source aborts the build. */
  readonly required: boolean
}

/**
 * Node's two "this package is not resolvable from here" outcomes. Anything else the
 * resolver throws (a malformed package.json, a permission error) is a real failure and
 * must surface instead of being read as "not installed".
 */
function isUnresolvable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code: unknown = Reflect.get(error, "code")
  return code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}

function resolveFromSenpi(specifier: string): string | undefined {
  try {
    return senpiRequire.resolve(specifier)
  } catch (error) {
    if (isUnresolvable(error)) return undefined
    throw error
  }
}

export function resolvePackageDir(packageName: string): string | undefined {
  const packageJsonPath = resolveFromSenpi(`${packageName}/package.json`)
  return packageJsonPath === undefined ? undefined : dirname(packageJsonPath)
}

interface PackageDependency {
  readonly name: string
  readonly optional: boolean
}

function readDependencyMap(manifest: object, field: string, manifestPath: string): readonly string[] {
  const dependencies = Reflect.get(manifest, field)
  if (dependencies === undefined || dependencies === null) return []
  if (typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error(`package manifest ${field} are not an object: ${manifestPath}`)
  }
  return Object.keys(dependencies)
}

/** `dependencies` and `optionalDependencies`, as senpi's own codemode sidecar copier walks them. */
function readPackageDependencies(packageDir: string): readonly PackageDependency[] {
  const manifestPath = join(packageDir, "package.json")
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(`package manifest is not an object: ${manifestPath}`)
  }
  const optional = new Set(readDependencyMap(manifest, "optionalDependencies", manifestPath))
  const names = new Set([...readDependencyMap(manifest, "dependencies", manifestPath), ...optional])
  return [...names].sort().map((name) => ({ name, optional: optional.has(name) }))
}

function dependencyManifestPath(packageDir: string, dependencyName: string): string {
  const packageRequire = createRequire(join(realpathSync(packageDir), "package.json"))
  return packageRequire.resolve(`${dependencyName}/package.json`)
}

const RUNTIME_MANIFEST_EXPORT = "./runtime-manifest.json"

function exportTarget(packageJson: unknown): string | undefined {
  const exportsMap: unknown =
    typeof packageJson === "object" && packageJson !== null ? Reflect.get(packageJson, "exports") : undefined
  const entry: unknown =
    typeof exportsMap === "object" && exportsMap !== null ? Reflect.get(exportsMap, RUNTIME_MANIFEST_EXPORT) : undefined
  const target: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "default") : entry
  return typeof target === "string" ? target : undefined
}

/**
 * The specifiers the installed engine's extension loader serves to extensions: `extensionModules` in the engine's
 * public `./runtime-manifest.json` export, which senpi's bundle build writes from the loader's own table (senpi#7662).
 * Senpi's per-file `dist/` tree is never read. Anything the manifest does not state exactly fails the build.
 */
export function engineServedSpecifiers(hostPackageDir = senpiPackageDir): ReadonlySet<string> {
  const packageJsonPath = join(hostPackageDir, "package.json")
  const target = exportTarget(JSON.parse(readFileSync(packageJsonPath, "utf8")))
  if (target === undefined) {
    throw new Error(
      `cannot read the engine's extension module table: ${packageJsonPath} has no ${RUNTIME_MANIFEST_EXPORT} export`,
    )
  }
  const manifestPath = join(hostPackageDir, target)
  const fail = (reason: string): never => {
    throw new Error(`cannot read the engine's extension module table from ${manifestPath}: ${reason}`)
  }
  if (!existsSync(manifestPath)) return fail("the runtime manifest does not exist")
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  const modules: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "extensionModules") : undefined
  if (!Array.isArray(modules)) return fail("it has no extensionModules list")
  if (modules.length === 0) return fail("extensionModules is empty")
  return new Set(
    modules.map((specifier: unknown) =>
      typeof specifier === "string" && specifier !== "" ? specifier : fail("extensionModules has a non-string entry"),
    ),
  )
}

function packageRoot(specifier: string): string {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/")
}

/** The packages the engine serves whole: a served subpath alone (typebox/value) does not provide the package. */
export function engineServedPackages(hostPackageDir = senpiPackageDir): ReadonlySet<string> {
  return new Set(
    [...engineServedSpecifiers(hostPackageDir)].filter((specifier) => packageRoot(specifier) === specifier),
  )
}

function packageDependencySources(
  packageDir: string,
  targetRoot: string,
  dependencies: readonly PackageDependency[],
  served: ReadonlySet<string>,
  ancestors: ReadonlySet<string>,
): SidecarSource[] {
  const sources: SidecarSource[] = []
  for (const { name: dependencyName, optional } of dependencies) {
    if (served.has(dependencyName)) continue
    let dependencyManifest: string
    try {
      dependencyManifest = dependencyManifestPath(packageDir, dependencyName)
    } catch (error) {
      if (optional && isUnresolvable(error)) continue
      throw error
    }
    const dependencyDir = dirname(dependencyManifest)
    const realDependencyDir = realpathSync(dependencyDir)
    if (ancestors.has(realDependencyDir)) continue
    const dependencyTarget = `${targetRoot}/node_modules/${dependencyName}`
    sources.push({ from: dependencyDir, to: dependencyTarget, required: true })
    for (const entry of readdirSync(dependencyDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".wasm")) continue
      const from = join(entry.parentPath, entry.name)
      const assetPath = relative(dependencyDir, from).split(sep).join("/")
      sources.push({ from, to: `${dependencyTarget}/${assetPath}`, required: true })
    }
    sources.push(
      ...packageDependencySources(
        dependencyDir,
        dependencyTarget,
        readPackageDependencies(dependencyDir),
        served,
        new Set([...ancestors, realDependencyDir]),
      ),
    )
  }
  return sources
}

/**
 * codemode's runtime dependency closure, staged beside it in the binary. A dependency is skipped only when the engine's
 * extension loader serves it (engineServedPackages); an optional dependency that is not installed is skipped too.
 */
export function codemodeRuntimeDependencySources(
  codemodeDir: string,
  hostPackageDir = senpiPackageDir,
): SidecarSource[] {
  const targetRoot = "node_modules/@code-yeongyu/senpi-codemode"
  return packageDependencySources(
    codemodeDir,
    targetRoot,
    readPackageDependencies(codemodeDir),
    engineServedPackages(hostPackageDir),
    new Set([realpathSync(codemodeDir)]),
  )
}

/**
 * The jsdom-era engine (senpi <= 2026.9.13) pulls css-tree in through jsdom; a
 * linkedom-era engine (senpi#1666) ships none of the trio. The sidecar set follows
 * the installed engine: whichever of these it carries is embedded, none is required.
 */
export const ENGINE_OPTIONAL_SIDECAR_PACKAGES = ["css-tree", "mdn-data", "source-map-js"] as const

/**
 * Sidecar parity set = senpi's own copy-binary-assets manifest (re-read from
 * node_modules/@code-yeongyu/senpi/package.json scripts.copy-binary-assets)
 * mapped from the published npm layout onto the flattened binary layout the
 * engine resolves next to process.execPath.
 */
export function engineSidecarSources(): SidecarSource[] {
  const dist = join(senpiPackageDir, "dist")
  const sources: SidecarSource[] = [
    { from: join(senpiPackageDir, "README.md"), to: "README.md", required: true },
    { from: join(senpiPackageDir, "CHANGELOG.md"), to: "CHANGELOG.md", required: true },
    { from: join(dist, "modes", "interactive", "theme"), to: "theme", required: true },
    { from: join(dist, "modes", "interactive", "assets"), to: "assets", required: true },
    { from: join(dist, "core", "export-html"), to: "export-html", required: true },
    { from: join(senpiPackageDir, "docs"), to: "docs", required: true },
    { from: join(senpiPackageDir, "examples"), to: "examples", required: true },
    { from: join(senpiPackageDir, "vendor"), to: "vendor", required: true },
  ]
  for (const packageName of ENGINE_OPTIONAL_SIDECAR_PACKAGES) {
    const packageDir = resolvePackageDir(packageName)
    if (packageDir === undefined) continue
    sources.push({ from: packageDir, to: `node_modules/${packageName}`, required: true })
  }
  const codemodeDir = resolvePackageDir("@code-yeongyu/senpi-codemode")
  if (codemodeDir === undefined) {
    throw new Error("codemode sidecar @code-yeongyu/senpi-codemode is not installed")
  }
  sources.push({
    from: codemodeDir,
    to: "node_modules/@code-yeongyu/senpi-codemode",
    required: true,
  })
  sources.push(...codemodeRuntimeDependencySources(codemodeDir))
  const photonDir = resolvePackageDir("@silvia-odwyer/photon-node")
  if (photonDir === undefined) {
    throw new Error("@silvia-odwyer/photon-node is not installed under the senpi package")
  }
  sources.push({
    from: join(photonDir, "photon_rs_bg.wasm"),
    to: "photon_rs_bg.wasm",
    required: true,
  })
  const tuiDir = resolvePackageDir("@earendil-works/pi-tui")
  if (tuiDir !== undefined) {
    for (const platform of ["darwin", "win32"]) {
      const prebuilds = join(tuiDir, "native", platform, "prebuilds")
      if (existsSync(prebuilds)) {
        sources.push({ from: prebuilds, to: `native/${platform}/prebuilds`, required: false })
      }
    }
  }
  return sources
}
