// Record the vendored package versions and a content hash per vendor folder.

import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const vendor = join(root, "vendor")

function files(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...files(path))
    else out.push(path)
  }
  return out
}

const lock = {}
for (const name of readdirSync(vendor).sort()) {
  const dir = join(vendor, name)
  if (!statSync(dir).isDirectory()) continue
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  const hash = createHash("sha256")
  for (const file of files(dir)) {
    hash.update(relative(dir, file).split("\\").join("/"))
    hash.update("\0")
    hash.update(readFileSync(file))
    hash.update("\0")
  }
  lock[name] = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "",
    sha256: hash.digest("hex"),
  }
}

writeFileSync(join(root, "vendor.lock.json"), JSON.stringify(lock, null, 2) + "\n", "utf8")
console.log(JSON.stringify({ ok: true, vendors: Object.keys(lock).length }))
