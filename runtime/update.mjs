// 检查插件自身 git 仓库有没有新提交 —— 只提示，不拉取。
//
// 场景：插件以「路径插件」装在朋友机器上，作者在 GitHub 上继续提交。插件每小时查一次，
// 落后时在总览页显示「有新版本」，由用户自己运行仓库里的 `更新插件.cmd`（`git pull --ff-only`）。
// 更新是手动动作：宿主重启会打断进行中的登录，静默拉取等于替用户做了这个决定。
//
// 硬约束：永不抛错进插件宿主；结果只写进快照，不写插件目录。

import { execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hostConfigDir, recordUpdate } from "./snapshot.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stateFile = "provider-bundle-update.json"
const GIT_TIMEOUT_MS = 20_000

// One check an hour is plenty for a plugin that changes a few times a week,
// and it keeps a friend's machine from talking to GitHub all day.
const EVERY_MS = (() => {
  const ms = Number(process.env.MAGPIE_UPDATE_EVERY_MS)
  return Number.isFinite(ms) && ms > 0 ? ms : 60 * 60 * 1000
})()

let checked = false

function git(args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1 << 20,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          out: String(stdout ?? "").trim(),
          err: String(stderr ?? error?.message ?? "").trim(),
        })
      },
    )
  })
}

function lastCheck() {
  try {
    const saved = JSON.parse(readFileSync(join(hostConfigDir(), stateFile), "utf8"))
    return Number(saved?.at) || 0
  } catch {
    return 0
  }
}

function saveCheck(at) {
  try {
    writeFileSync(join(hostConfigDir(), stateFile), `${JSON.stringify({ at })}\n`, "utf8")
  } catch {
    // 记不上就下次再查，不影响插件本身。
  }
}

// firstLine 是给页面看的一句话，不含路径与命令输出以外的信息。
async function check() {
  if (!existsSync(join(root, ".git"))) {
    return { state: "nogit", message: "这个插件不是 git 安装，不会检查更新" }
  }
  const remote = await git(["remote", "get-url", "origin"])
  if (!remote.ok || !remote.out) {
    return { state: "nogit", message: "仓库没有配置 origin，不会检查更新" }
  }
  const dirty = await git(["status", "--porcelain"])
  if (!dirty.ok) {
    return { state: "error", message: dirty.err.slice(0, 160) }
  }
  const fetch = await git(["fetch", "--quiet", "origin"])
  if (!fetch.ok) {
    return { state: "error", message: `连不上远端：${fetch.err.slice(0, 160)}` }
  }
  const behind = await git(["rev-list", "--count", "HEAD..@{u}"])
  if (!behind.ok) {
    return { state: "error", message: behind.err.slice(0, 160) }
  }
  const count = Number(behind.out) || 0
  const head = await git(["rev-parse", "--short", "HEAD"])
  if (count <= 0) {
    return { state: "latest", message: "已是最新", commit: head.out }
  }
  return {
    state: "behind",
    message: dirty.out
      ? `有 ${count} 个新提交；本地有改动，更新前先提交或还原`
      : `有 ${count} 个新提交，运行仓库里的 更新插件.cmd`,
    commit: head.out,
    count,
  }
}

/**
 * 至多每小时检查一次（同一进程只查一次）。调用方不等它。
 * @returns {Promise<void>}
 */
export async function checkForUpdate() {
  if (checked) return
  checked = true
  try {
    const now = Date.now()
    if (now - lastCheck() < EVERY_MS) return
    saveCheck(now)
    recordUpdate(await check())
  } catch (error) {
    recordUpdate({ state: "error", message: String(error?.message ?? error).slice(0, 160) })
  }
}
