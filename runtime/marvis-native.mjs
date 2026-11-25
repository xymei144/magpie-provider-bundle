// 补齐 Marvis 需要的原生组件。
//
// 腾讯 Marvis 的模型网关要求每个请求的 uskey 由官方 Beacon SDK 现签；插件侧需要四个
// 文件才能做到：官方客户端的 beacon_wrapper.dll / beacon_sdk.dll / qimei.dll，以及本
// 仓库源码编出来的 beacon_shim.dll（native/marvis_beacon_shim.c）。
//
// 这些二进制不在仓库里（第三方客户端文件 + 编译产物），而是作为 GitHub Release 的
// 附件 marvis-native.zip。插件启动/更新后检测一次，缺哪个就整包下下来解开放进
// vendor/marvis/native/ —— 用户不需要认识 DLL。
//
// 约束：
//   · 只在缺文件时联网，一天最多试一次；
//   · 下载/解压失败只写状态进快照，不抛错、不阻断供应商加载；
//   · 解压用 Windows 自带 PowerShell 的 Expand-Archive，不引入依赖。

import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hostConfigDir, recordNative } from "./snapshot.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const NATIVE_DIR = join(root, "vendor", "marvis", "native")

// 上游作者仓库；换仓库时改这一行（或设 MAGPIE_MARVIS_NATIVE_URL 指到完整地址）。
const OWNER_REPO = process.env.MAGPIE_MARVIS_REPO || "xymei144/magpie-provider-bundle"
const ASSET_URL =
  process.env.MAGPIE_MARVIS_NATIVE_URL ||
  `https://github.com/${OWNER_REPO}/releases/latest/download/marvis-native.zip`

const FILES = ["beacon_wrapper.dll", "beacon_sdk.dll", "qimei.dll", "beacon_shim.dll"]
const STATE_FILE = "provider-bundle-native.json"
const RETRY_MS = 24 * 60 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

let checked = false

function missing() {
  return FILES.filter((name) => !existsSync(join(NATIVE_DIR, name)))
}

const CLIENT_DLLS = ["beacon_wrapper.dll", "beacon_sdk.dll", "qimei.dll"]

// 装了官方客户端就用它的 DLL —— 版本永远跟用户自己的客户端一致，仓库里的
// Release 附件只是没装客户端时的兜底。
function installedClientDir() {
  const script = [
    "$roots = @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})",
    "foreach ($r in $roots) {",
    "  if (-not $r -or -not (Test-Path $r)) { continue }",
    "  $hit = Get-ChildItem -Path $r -Filter Marvis.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1",
    "  if ($hit) { Split-Path -Parent $hit.FullName; break }",
    "}",
  ].join("\n")
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout ?? "").trim())
    )
  })
}

function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

// 把已装客户端的三个 DLL 同步过来；只有内容不同才写，避免每次启动都改插件目录
// （文件一变 Magpie 会重载插件宿主）。
async function syncFromClient() {
  const dir = await installedClientDir()
  if (!dir) return ""
  const native = join(dir, "win32-native")
  const from = existsSync(join(native, "beacon_wrapper.dll")) ? native : dir
  if (!existsSync(join(from, "beacon_wrapper.dll"))) return ""
  mkdirSync(NATIVE_DIR, { recursive: true })
  for (const name of CLIENT_DLLS) {
    const src = join(from, name)
    const dst = join(NATIVE_DIR, name)
    if (existsSync(src) && !sameBytes(src, dst)) copyFileSync(src, dst)
  }
  return from
}

function lastTry() {
  try {
    return Number(JSON.parse(readFileSync(join(hostConfigDir(), STATE_FILE), "utf8"))?.at) || 0
  } catch {
    return 0
  }
}

function noteTry(at) {
  try {
    writeFileSync(join(hostConfigDir(), STATE_FILE), `${JSON.stringify({ at })}\n`, "utf8")
  } catch {
    // 记不住就退化成每次启动都试一次；不算故障。
  }
}

// PowerShell 的 Expand-Archive 在所有 Windows 10/11 上都有；Git Bash 的 tar
// 是 GNU tar，解不了 zip，所以不用它。
function unzip(archive, into) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(into)} -Force`,
      ],
      { timeout: 120_000, windowsHide: true },
      (error, _out, stderr) => resolve({ ok: !error, err: String(stderr ?? error?.message ?? "").trim() }),
    )
  })
}

async function download() {
  const res = await fetch(ASSET_URL, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "User-Agent": "magpie-provider-bundle" },
    redirect: "follow",
  })
  if (!res.ok) return { state: "error", message: `下载失败 HTTP ${res.status}` }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length < 100_000) {
    return { state: "error", message: "下载到的附件不像组件包（太小）" }
  }
  mkdirSync(NATIVE_DIR, { recursive: true })
  const tmp = join(NATIVE_DIR, `.marvis-native-${process.pid}.zip`)
  try {
    writeFileSync(tmp, bytes)
    const un = await unzip(tmp, NATIVE_DIR)
    if (!un.ok) return { state: "error", message: `解压失败：${un.err.slice(0, 140)}` }
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 临时文件留着也无害，下一次用新名字。
    }
  }
  const still = missing()
  if (still.length) return { state: "error", message: `附件里缺少 ${still.join("、")}` }
  return { state: "ok", message: "Marvis 组件已补齐" }
}

/**
 * 启动时调用；缺文件才联网，一天最多一次。调用方不等它。
 * @returns {Promise<void>}
 */
export async function ensureMarvisNative() {
  if (checked) return
  checked = true
  try {
    // Only a real checkout has the vendor folder; the tests copy the runtime
    // into a scratch dir and must never go to the network.
    if (!existsSync(join(root, "vendor", "marvis"))) return
    // 一天只检查一次：既看本机客户端有没有更新的 DLL，也决定要不要下附件。
    if (Date.now() - lastTry() < RETRY_MS) {
      const gone = missing()
      if (gone.length) recordNative({ state: "missing", message: `缺少 ${gone.join("、")}；今天已经找过` })
      return
    }
    noteTry(Date.now())
    const client = await syncFromClient()
    const gone = missing()
    if (!gone.length) {
      recordNative({ state: "ok", message: client ? `已使用本机客户端的组件（${client}）` : "组件齐全" })
      return
    }
    recordNative({ state: "downloading", message: "正在补齐 Marvis 组件…" })
    recordNative(await download())
  } catch (error) {
    recordNative({ state: "error", message: String(error?.message ?? error).slice(0, 160) })
  }
}
