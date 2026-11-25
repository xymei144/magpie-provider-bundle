// 把 vendor/marvis/native 里的四个组件打成 GitHub Release 附件 marvis-native.zip。
//
// 这三个官方 DLL 不进仓库（腾讯客户端文件）；插件在检测到缺文件时会从
// `<owner>/<repo>/releases/latest/download/marvis-native.zip` 自动下载这份附件。
// 发版时：
//   node scripts/marvis-native-pack.mjs        # 产出 dist/marvis-native.zip
//   在 GitHub 上建 release，把 zip 作为附件上传
//
// 只用 Windows 自带的 PowerShell 压缩，不引入依赖。

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const native = join(root, "vendor", "marvis", "native")
const out = join(root, "dist")
const zip = join(out, "marvis-native.zip")
const FILES = ["beacon_wrapper.dll", "beacon_sdk.dll", "qimei.dll", "beacon_shim.dll"]

const missing = FILES.filter((name) => !existsSync(join(native, name)))
if (missing.length) {
  console.error(`缺少 ${missing.join("、")}（${native}）`)
  process.exit(1)
}

mkdirSync(out, { recursive: true })
const list = FILES.map((name) => `'${join(native, name).replaceAll("'", "''")}'`).join(",")
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path ${list} -DestinationPath '${zip.replaceAll("'", "''")}' -Force`,
  ],
  { stdio: "inherit" },
)
console.log(JSON.stringify({ ok: true, zip, entries: FILES.length }))
