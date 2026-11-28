import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

for (const prepared of [false, true]) {
  test(`Windows launcher preserves its captured pair with prepared=${prepared}`, () => {
    const root = mkdtempSync(join(tmpdir(), "omo-capture-"))
    try {
      const pkg = join(root, "app")
      const engine = join(pkg, "node_modules", "@code-yeongyu", "senpi")
      mkdirSync(join(engine, "dist", "bundle"), { recursive: true })
      cpSync(resolve(import.meta.dir, "../bin"), join(pkg, "bin"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), '{"name":"omo-ai","version":"0.0.0-test","type":"module"}')
      writeFileSync(
        join(engine, "package.json"),
        '{"name":"@code-yeongyu/senpi","type":"module","exports":{".":"./dist/index.js","./runtime-manifest.json":"./dist/bundle/runtime-manifest.json"}}',
      )
      writeFileSync(join(engine, "dist", "index.js"), "export {}\n")
      writeFileSync(join(engine, "dist", "bundle", "runtime-manifest.json"), "{}\n")
      writeFileSync(join(engine, "dist", "bundle", "cli.js"), "export {}\n")
      if (prepared) writeFileSync(join(engine, ".omo-engine-prepared"), "0.0.0-test\n")
      const node = Bun.which("node")
      if (node === null) throw new Error("launcher regression requires Node")
      const result = spawnSync(
        node,
        [
          "--input-type=module",
          "-e",
          `
import fs from "node:fs"
import cp from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
const stat = fs.fstatSync
const close = fs.closeSync
fs.fstatSync = fd => fd === 5 || fd === 6 ? { mode: 0o010600, isFIFO: () => false, isSocket: () => false } : stat(fd)
fs.closeSync = fd => { if (fd !== 5 && fd !== 6) close(fd) }
cp.spawn = (_file, _argv, options) => {
  console.log(JSON.stringify({ table: options.env.SENPI_PRIVATE_FDS, stdio: options.stdio }))
  const child = new EventEmitter()
  queueMicrotask(() => child.emit("exit", 0, null))
  return child
}
syncBuiltinESMExports()
Object.defineProperty(process, "platform", { value: "win32" })
process.argv = [process.execPath, ${JSON.stringify(join(pkg, "bin", "omo.js"))}, "host", "ensure"]
await import(${JSON.stringify(pathToFileURL(join(pkg, "bin", "omo.js")).href)})
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            OMO_CODING_AGENT_DIR: join(root, "agent"),
            OMO_RUNTIME: "node",
            SENPI_PRIVATE_FDS: '{"a":[5,6]}',
          },
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        table: '{"a":[5,6]}',
        stdio: ["inherit", "inherit", "inherit", "ignore", "ignore", 5, 6],
      })
      // An unprepared engine is prepared by this launch before the spawn.
      expect(result.stderr).not.toContain("could not prepare")
      expect(readFileSync(join(engine, ".omo-engine-prepared"), "utf8").trim()).toBe("0.0.0-test")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
