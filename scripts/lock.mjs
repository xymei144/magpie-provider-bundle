// Record the vendored package versions and a content hash per vendor folder.
//
//   node scripts/lock.mjs           rewrite vendor.lock.json from vendor/
//   node scripts/lock.mjs --check   compare vendor/ against vendor.lock.json
//
// The check mode is what `npm test` runs: a lock file that is rewritten by
// the test run itself can never catch a tampered vendor.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const vendor = join(root, "vendor")
const lockFile = join(root, "vendor.lock.json")

function files(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...files(path))
    // Platform binaries are not part of the published package (see
    // vendor/marvis/NOTICE.md), so a lock made here must not depend on them.
    else if (!/\.(?:dll|node)$/i.test(name)) out.push(path)
  }
  return out
}

function hashFolder(dir) {
  const hash = createHash("sha256")
  const perFile = {}
  for (const file of files(dir)) {
    const name = relative(dir, file).split("\\").join("/")
    const bytes = readFileSync(file)
    hash.update(name)
    hash.update("\0")
    hash.update(bytes)
    hash.update("\0")
    perFile[name] = createHash("sha256").update(bytes).digest("hex")
  }
  return { sha256: hash.digest("hex"), files: perFile }
}

function currentLock() {
  const lock = {}
  for (const name of readdirSync(vendor).sort()) {
    const dir = join(vendor, name)
    if (!statSync(dir).isDirectory()) continue
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const hash = hashFolder(dir)
    lock[name] = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "",
      sha256: hash.sha256,
      files: hash.files,
    }
  }
  return lock
}

// Read a lock file written by an older version of this script: the folder
// hash is the contract, the per-file map is optional extra detail.
function readLock() {
  if (!existsSync(lockFile)) return null
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"))
  if (!parsed || typeof parsed !== "object") return null
  const lock = {}
  for (const [name, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") continue
    lock[name] = {
      name: entry.name ?? "",
      version: entry.version ?? "",
      license: entry.license ?? "",
      sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
      files: entry.files && typeof entry.files === "object" ? entry.files : null,
    }
  }
  return lock
}

function changedFiles(expected, actual) {
  if (!expected) return []
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)])
  return [...names].filter((name) => expected[name] !== actual[name]).sort()
}

function check() {
  const expected = readLock()
  if (!expected) {
    console.error(
      `vendor.lock.json 缺失或无法解析：${lockFile}\n先跑一次 \`npm run lock\` 生成锁文件。`,
    )
    process.exit(1)
  }
  const actual = currentLock()
  const problems = []
  for (const name of Object.keys(actual).sort()) {
    const want = expected[name]
    const got = actual[name]
    if (!want) {
      problems.push({
        vendor: name,
        file: `vendor/${name}`,
        expected: "(missing from vendor.lock.json)",
        actual: got.sha256,
        detail: "锁文件里没有这个 vendor 目录",
      })
      continue
    }
    if (want.sha256 !== got.sha256) {
      problems.push({
        vendor: name,
        file: `vendor/${name}`,
        expected: want.sha256,
        actual: got.sha256,
        detail: "内容哈希不一致",
        files: changedFiles(want.files, got.files).map((file) => `vendor/${name}/${file}`),
      })
    }
  }
  for (const name of Object.keys(expected).sort()) {
    if (actual[name]) continue
    problems.push({
      vendor: name,
      file: `vendor/${name}`,
      expected: expected[name].sha256,
      actual: "(missing on disk)",
      detail: "锁文件里有这个 vendor 目录，但磁盘上没有",
    })
  }
  if (problems.length) {
    console.error("vendor.lock.json 与 vendor/ 的实际内容不一致：")
    for (const problem of problems) {
      console.error(`  ${problem.file}`)
      console.error(`    期望: ${problem.expected}`)
      console.error(`    实际: ${problem.actual}`)
      if (problem.detail) console.error(`    说明: ${problem.detail}`)
      for (const file of problem.files ?? []) console.error(`    变化文件: ${file}`)
    }
    console.error(`共 ${problems.length} 处差异。确认是本次改动后再跑 \`npm run lock\` 更新锁文件。`)
    process.exit(1)
  }
  console.log(
    JSON.stringify({ ok: true, vendors: Object.keys(actual).length, checked: "vendor.lock.json" }),
  )
}

if (process.argv.includes("--check")) {
  check()
} else {
  const lock = currentLock()
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n", "utf8")
  console.log(JSON.stringify({ ok: true, vendors: Object.keys(lock).length }))
}
