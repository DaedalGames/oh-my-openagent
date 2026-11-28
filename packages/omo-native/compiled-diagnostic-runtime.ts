// The compiled binary has no npm package layout: `bin/lib/package-paths.js` resolves `packageRoot`
// inside the binary's virtual filesystem and `resolveSenpi()` finds no installed engine, so the npm
// loaders behind doctor and setup coverage fail open and silently drop their lines. These loaders
// answer the same questions from the provisioned runtime (the staged category-coverage bundle) and
// from the engine modules compiled into this binary. The literal subpath keeps bun tracing them.
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const COMPILED_DIAGNOSTIC_RUNTIME = join("plugin", "runtime", "category-coverage", "index.js")

export function compiledDiagnosticRuntimeLoader(execDir: string): () => Promise<unknown> {
  return () => import(pathToFileURL(join(execDir, COMPILED_DIAGNOSTIC_RUNTIME)).href)
}

// `omo setup` validates model choices against the builtin provider catalog. The npm loader finds it
// beside the installed engine; here it is the pi-ai graph compiled into this binary, read through
// senpi's model-coverage subpath.
export async function loadCompiledModelCatalog() {
  const { builtinProviders } = await import("@code-yeongyu/senpi/model-coverage")
  return builtinProviders()
}

export async function loadCompiledCoverageEngine() {
  const coverage = await import("@code-yeongyu/senpi/model-coverage")
  return {
    ModelRuntime: coverage.ModelRuntime,
    AuthStorage: coverage.AuthStorage,
    ReadOnlyAuthStorage: coverage.ReadOnlyAuthStorage,
    InMemoryCodingAgentModelsStore: coverage.InMemoryCodingAgentModelsStore,
    SettingsManager: coverage.SettingsManager,
    registerAnthropicSubscription: coverage.registerAnthropicSubscriptionExtension,
    loadAnthropicSubscriptionSettings: coverage.loadAnthropicSubscriptionProviderSettings,
  }
}
