// BreezeBlue（breezeblue.ai）for magpie.
//
// BreezeBlue 是语音合成（TTS）服务：按 credits 计费，Free 账户每天可以
// 在网页上点一次「Claim your free credits」。它的开发者 API（api.breeze.blue，
// xi-api-key）只读当前 key 的 credits，**没有**领取接口；领取走的是网页会话：
//
//   余额  GET  https://breezeblue.ai/api/credits/summary
//   签到  POST https://breezeblue.ai/api/credits/daily-claim
//   账号  GET  https://breezeblue.ai/api/me
//
// 三个接口都用网页登录后的 Cookie。取会话的主路径是「点击后打开默认浏览器」：
// 用默认浏览器的程序 + 一个 magpie 自己的配置目录启动窗口，用户在里面登录，
// 插件通过 DevTools 协议（Storage.getCookies）让浏览器自己交出 Cookie。这样
// 不碰磁盘上的密文 —— Edge/Chrome 127+ 的 Cookie 是 v20 App-Bound 加密，
// 直接读库解不开（DPAPI 密钥对 v20 无效）。
//
// 另外保留了读默认浏览器 Cookie 库（只对旧的 v10 加密有效）和手动粘贴 Cookie
// 两条退路。
//
// 签到结果按接口回答判断：拿到新 credits 记 claimed；明确表示今天已领过记
// done；其余失败带原始 detail，不编造「已签到」。

import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const ID = "breezeblue"
const SITE = "https://breezeblue.ai"
const SUMMARY_URL = `${SITE}/api/credits/summary`
const CLAIM_URL = `${SITE}/api/credits/daily-claim`
const ME_URL = `${SITE}/api/me`
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

const COOKIE_DOMAINS = ["breezeblue.ai", "breeze.blue"]
// Chromium 的 cookie 时间戳从 1601-01-01 起算（微秒），与 Unix 纪元差这么多毫秒。
const CHROME_EPOCH_MS = 11644473600000

// ---------------------------------------------------------------- 默认浏览器

// 默认浏览器的可执行文件（Windows 注册表 UrlAssociations → ProgId → command）。
export function defaultBrowserExecutable(run = spawnSync) {
  if (process.platform !== "win32") return null
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice"
    const choice = run("reg", ["query", key, "/v", "ProgId"], { windowsHide: true, timeout: 4000, encoding: "utf8" })
    const progId = `${choice?.stdout ?? ""}`.match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1]
    if (!progId) return null
    const command = run("reg", ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"], {
      windowsHide: true,
      timeout: 4000,
      encoding: "utf8",
    })
    const line = `${command?.stdout ?? ""}`.match(/REG_SZ\s+(.+)/)?.[1]?.trim()
    if (!line) return null
    return line.match(/^"([^"]+\.exe)"/i)?.[1] ?? line.match(/^(\S+?\.exe)/i)?.[1] ?? null
  } catch {
    return null
  }
}

// Chromium 系默认浏览器的 User Data 目录；Firefox 之类没有可读的 Cookie 库。
export function userDataDirectory(executable, env = process.env) {
  const local = env.LOCALAPPDATA ?? ""
  const name = String(executable ?? "").toLowerCase()
  const known = [
    [/(msedge)\.exe$/, join(local, "Microsoft", "Edge", "User Data")],
    [/(chrome)\.exe$/, join(local, "Google", "Chrome", "User Data")],
    [/(brave)\.exe$/, join(local, "BraveSoftware", "Brave-Browser", "User Data")],
    [/(vivaldi)\.exe$/, join(local, "Vivaldi", "User Data")],
    [/(chromium)\.exe$/, join(local, "Chromium", "User Data")],
    [/(thorium)\.exe$/, join(local, "Thorium", "User Data")],
  ]
  for (const [pattern, dir] of known) {
    if (pattern.test(name) && existsSync(dir)) return dir
  }
  return null
}

function profileNames(ud) {
  try {
    return readdirSync(ud)
      .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
      .filter((name) => existsSync(join(ud, name, "Network", "Cookies")))
      .sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b)))
  } catch {
    return []
  }
}

// ------------------------------------------------------------ Cookie 库读取

function decodeConsole(buffer) {
  if (!buffer || !buffer.length) return ""
  try {
    return new TextDecoder("gbk").decode(buffer)
  } catch {
    return Buffer.from(buffer).toString("utf8")
  }
}

// 浏览器独占 Cookie 库：用 FileShare.ReadWrite|Delete 打开再复制；仍失败说明
// 浏览器还开着，返回 code="locked"。
function copyShared(source, target) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$s=[IO.File]::Open(${JSON.stringify(source)},'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))`,
    `$d=[IO.File]::Create(${JSON.stringify(target)})`,
    "$s.CopyTo($d);$d.Close();$s.Close()",
  ].join(";")
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 15000,
  })
  if (run.status !== 0) {
    // PowerShell 5.1 用控制台代码页输出，中文 Windows 是 GBK。
    const stderr = decodeConsole(run.stderr)
    throw Object.assign(new Error(`Cookie 库读取失败：${(stderr.match(/[^。\n]*。?/) ?? [stderr])[0].trim().slice(0, 160)}`), {
      // Chromium 打开 Cookies 时不开共享写，运行中必然是独占锁。
      code: "locked",
      stderr,
    })
  }
}

function dpapiUnprotect(buffer) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${buffer.toString("base64")}')`,
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join(";")
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 15000,
    encoding: "utf8",
  })
  if (run.status !== 0 || !`${run.stdout ?? ""}`.trim()) {
    throw Object.assign(new Error("DPAPI 解不开 Cookie 主密钥"), { code: "dpapi" })
  }
  return Buffer.from(`${run.stdout}`.trim(), "base64")
}

export function masterKey(userDataDir) {
  let state
  try {
    state = JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8"))
  } catch {
    throw Object.assign(new Error("读不到浏览器 Local State"), { code: "no-local-state" })
  }
  const encoded = state?.os_crypt?.encrypted_key
  if (typeof encoded !== "string" || !encoded) {
    throw Object.assign(new Error("浏览器没有登记 Cookie 主密钥"), { code: "no-key" })
  }
  const raw = Buffer.from(encoded, "base64")
  if (raw.subarray(0, 5).toString("latin1") !== "DPAPI") {
    // v20 / app-bound 加密需要浏览器自己的身份才能解，DPAPI 路走不通。
    throw Object.assign(new Error("浏览器 Cookie 用了 App-Bound 加密，读不出来"), { code: "appbound" })
  }
  return dpapiUnprotect(raw.subarray(5))
}

export function decryptCookie(key, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 3 + 12 + 16) throw new Error("Cookie 密文过短")
  const prefix = blob.subarray(0, 3).toString("latin1")
  if (prefix !== "v10" && prefix !== "v11") {
    throw Object.assign(new Error(`不支持的 Cookie 加密版本：${prefix}`), { code: "version" })
  }
  const nonce = blob.subarray(3, 15)
  const tag = blob.subarray(blob.length - 16)
  const data = blob.subarray(15, blob.length - 16)
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

async function rowsFor(dbFile) {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(dbFile)
  try {
    return db
      .prepare(
        // expires_utc 是 1601 起的微秒，值超过 2^53 时 node:sqlite 直接抛
        // RangeError，所以按文本取回来再自己转。
        "SELECT host_key, name, encrypted_value, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly FROM cookies WHERE host_key LIKE '%breezeblue.ai%' OR host_key LIKE '%breeze.blue%'",
      )
      .all()
  } finally {
    db.close()
  }
}

function inDomain(hostKey) {
  const host = String(hostKey ?? "").replace(/^\./, "").toLowerCase()
  return COOKIE_DOMAINS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

export function cookieHeaderFrom(rows, key, now = Date.now()) {
  const parts = []
  for (const row of rows) {
    if (!row?.name || !inDomain(row.host_key)) continue
    // expires_utc: 1601-01-01 起的微秒；0 表示会话 cookie。
    const expires = Number(row.expires_utc) || 0
    if (expires > 0 && expires / 1000 - CHROME_EPOCH_MS < now) continue
    let value
    try {
      value = decryptCookie(key, Buffer.from(row.encrypted_value))
    } catch {
      continue
    }
    if (value === undefined || value === null || value === "") continue
    parts.push(`${row.name}=${value}`)
  }
  return parts.join("; ")
}

// 结束默认浏览器的所有进程：先请求正常关闭，再强制结束后台残留。
export function terminateBrowser(executable, run = spawnSync) {
  const name = String(executable).split(/[\/]/).pop()
  run("taskkill", ["/IM", name], { windowsHide: true, timeout: 10000 })
  run("taskkill", ["/IM", name, "/F"], { windowsHide: true, timeout: 10000 })
  return name
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 依次试每个 profile，第一个能通过 /api/me 的就是登录态所在。
// quitBrowser=true 时，遇到 Cookie 库被占用会先退出默认浏览器再读（方法标签
// 已经把这件事写给用户看了）；读完不自动重开，用户自己开回来。
export async function readDefaultBrowserSession({
  fetchImpl = globalThis.fetch,
  env = process.env,
  quitBrowser = false,
  quit = terminateBrowser,
  sleep = pause,
  waitMs = 20000,
} = {}) {
  const executable = defaultBrowserExecutable()
  if (!executable) throw Object.assign(new Error("读不到系统默认浏览器"), { code: "no-default" })
  if (!/(chrome|msedge|brave|chromium|vivaldi|thorium)\.exe$/i.test(executable)) {
    throw Object.assign(new Error("默认浏览器不是 Chromium 系（Chrome/Edge/Brave/Vivaldi），读不了 Cookie 库"), {
      code: "not-chromium",
    })
  }
  const ud = userDataDirectory(executable, env)
  if (!ud) throw Object.assign(new Error("没找到默认浏览器的用户数据目录"), { code: "no-user-data" })
  const key = masterKey(ud)
  const profiles = profileNames(ud)
  if (!profiles.length) throw Object.assign(new Error("默认浏览器里没有任何 profile"), { code: "no-profile" })

  const temp = mkdtempSync(join(tmpdir(), "magpie-breezeblue-ck-"))
  let locked = false
  let sawCookies = false
  const scan = async () => {
    for (const profile of profiles) {
      const dbFile = join(temp, `${profile.replace(/\s+/g, "_")}.db`)
      try {
        copyShared(join(ud, profile, "Network", "Cookies"), dbFile)
      } catch (error) {
        if (error?.code === "locked") locked = true
        continue
      }
      let rows = []
      try {
        rows = await rowsFor(dbFile)
      } catch {
        continue
      }
      if (rows.length) sawCookies = true
      const cookie = cookieHeaderFrom(rows, key)
      if (!cookie) continue
      const me = await probeMe(cookie, fetchImpl)
      if (me.ok) return { cookie, me: me.data, profile, browser: executable }
    }
    return null
  }

  try {
    let session = await scan()
    if (!session && locked && quitBrowser) {
      // Edge 的启动加速会在被结束后几秒内自己拉起来，所以每轮都重新结束再试，
      // 读到了就停。
      const deadline = Date.now() + waitMs
      while (!session && Date.now() < deadline) {
        quit(executable)
        await sleep(150)
        locked = false
        session = await scan()
        if (!session) await sleep(250)
      }
    }
    if (session) return session
    if (locked) {
      throw Object.assign(
        new Error("默认浏览器仍在后台占用 Cookie 库（后台扩展/后台进程）：退出浏览器后重试，或改用「粘贴网页 Cookie」"),
        { code: "locked" },
      )
    }
    if (sawCookies) {
      throw Object.assign(new Error("读到了 BreezeBlue 的 Cookie 但解不开（浏览器用了 App-Bound 加密），请改用「粘贴网页 Cookie」"), {
        code: "undecryptable",
      })
    }
    throw Object.assign(new Error("默认浏览器里没有 BreezeBlue 的登录 Cookie：先在浏览器里登录一次"), {
      code: "not-signed-in",
    })
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

async function probeMe(cookie, fetchImpl) {
  try {
    const response = await fetchImpl(ME_URL, {
      headers: { accept: "application/json", cookie, "user-agent": UA, referer: `${SITE}/` },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
    if (!response.ok) return { ok: false, status: response.status }
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { ok: true, data: body?.data ?? body }
  } catch (error) {
    return { ok: false, status: 0, error }
  }
}

// ------------------------------------------------------------ 打开浏览器登录

// magpie 自己的一本配置目录：和用户日常的 Edge 分开，互不干扰，但会话会保留
// 在磁盘上，下次再点可以直接复用登录态。
export function profileDirectory(env = process.env) {
  return join(env.LOCALAPPDATA ?? tmpdir(), "magpie", "breezeblue-profile")
}

// DevTools 协议里的 Cookie（domain/expires 为 Unix 秒，-1 表示会话 Cookie）。
export function loginCookieHeader(cookies, now = Date.now()) {
  const parts = []
  for (const cookie of cookies ?? []) {
    const host = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase()
    if (!COOKIE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue
    if (!cookie.name || !cookie.value) continue
    if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires * 1000 < now) continue
    parts.push(`${cookie.name}=${cookie.value}`)
  }
  return parts.join("; ")
}

// 登录窗口：不开放调试端口。带 --remote-debugging-port 启动时 Google 会判定
// 「此浏览器或应用可能不安全」并拒绝登录，所以登录和读取分成两步。
function launchLoginWindow(executable, dir, url) {
  const child = spawn(
    executable,
    [
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      // 关窗口就让进程退出，否则后台常驻会一直占着 profile。
      "--disable-background-mode",
      url,
    ],
    { detached: true, stdio: "ignore" },
  )
  return child
}

function launchBrowser(executable, dir, url, { headless = false } = {}) {
  const args = [
    `--user-data-dir=${dir}`,
    // 端口交给浏览器挑，避免和别的调试实例抢 9222 之类的固定端口。
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ]
  if (headless) args.push("--headless=new")
  args.push(url)
  const child = spawn(executable, args, { detached: true, stdio: "ignore" })
  child.unref()
  return child
}

// 上一次尝试可能留了窗口占着 magpie 配置目录：按命令行匹配后结束，不动用户日常浏览器。
export function killProfileBrowsers(dir, run = spawnSync) {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\"",
    ` | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' }`,
    " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  ].join("")
  try {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 })
  } catch {
    /* 没有残留也正常 */
  }
}

export function stopBrowser(pid, run = spawnSync) {
  if (!pid) return
  try {
    run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 })
  } catch {
    /* 已经退出 */
  }
}

async function waitForDevToolsPort(dir, { sleep, now, timeoutMs = 25000 }) {
  const file = join(dir, "DevToolsActivePort")
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      // 第一行是端口，第二行是浏览器级 WebSocket 路径。
      const port = Number(`${readFileSync(file, "utf8")}`.split(/\r?\n/)[0])
      if (port > 0) return port
    } catch {
      /* 还没写出来 */
    }
    await sleep(200)
  }
  return null
}

function cdpCommand(url, method, params, timeoutMs = 10000) {
  if (typeof WebSocket !== "function") {
    return Promise.reject(Object.assign(new Error("当前运行时不支持 WebSocket，读不了浏览器会话"), { code: "no-websocket" }))
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error("浏览器调试连接超时"))
    }, timeoutMs)
    const finish = (fn, value) => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      fn(value)
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== 1) return
      if (message.error) finish(reject, new Error(`浏览器拒绝读取 Cookie：${message.error.message ?? "未知错误"}`))
      else finish(resolve, message.result ?? {})
    })
    ws.addEventListener("error", () => finish(reject, new Error("连不上浏览器的调试端口")))
  })
}

export async function readBrowserCookies(port, fetchImpl = globalThis.fetch) {
  const version = await (await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json()
  const url = version?.webSocketDebuggerUrl
  if (!url) throw Object.assign(new Error("浏览器没有开放调试端口"), { code: "cdp" })
  return (await cdpCommand(url, "Storage.getCookies", {}))?.cookies ?? []
}

// 复用 magpie 配置目录里已有的登录态：headless 跑一次，有会话就直接返回，
// 全程不弹窗口。
export async function readStoredSession({
  executable,
  dir,
  fetchImpl = globalThis.fetch,
  launch = launchBrowser,
  readCookies = readBrowserCookies,
  kill = stopBrowser,
  sleep = pause,
  now = Date.now,
  startTimeoutMs = 15000,
  probeMs = 10000,
  stepMs = 800,
} = {}) {
  try {
    rmSync(join(dir, "DevToolsActivePort"), { force: true })
  } catch {
    /* ignore */
  }
  const child = launch(executable, dir, `${SITE}/`, { headless: true })
  try {
    const port = await waitForDevToolsPort(dir, { sleep, now, timeoutMs: startTimeoutMs })
    if (!port) return null
    const deadline = now() + probeMs
    for (;;) {
      let cookies = []
      try {
        cookies = await readCookies(port, fetchImpl)
      } catch {
        /* 页面还在加载 */
      }
      const cookie = loginCookieHeader(cookies)
      if (cookie) {
        const me = await probeMe(cookie, fetchImpl)
        if (me.ok) return { cookie, me: me.data, profile: "magpie", browser: executable }
      }
      if (now() >= deadline) return null
      await sleep(stepMs)
    }
  } catch {
    return null
  } finally {
    kill(child?.pid)
  }
}

// 打开默认浏览器让用户登录，登录成功后自动关闭窗口并返回会话。
export async function captureLoginSession({
  fetchImpl = globalThis.fetch,
  env = process.env,
  launch = launchBrowser,
  launchWindow = launchLoginWindow,
  killProfile = killProfileBrowsers,
  readCookies = readBrowserCookies,
  kill = stopBrowser,
  sleep = pause,
  signal,
  now = Date.now,
  loginTimeoutMs = 10 * 60 * 1000,
  startTimeoutMs = 25000,
  stepMs = 1500,
  reuseStored = true,
} = {}) {
  const executable = defaultBrowserExecutable()
  if (!executable) throw Object.assign(new Error("读不到系统默认浏览器"), { code: "no-default" })
  if (!/(chrome|msedge|brave|chromium|vivaldi|thorium)\.exe$/i.test(executable)) {
    throw Object.assign(new Error("默认浏览器不是 Chromium 系（Chrome/Edge/Brave/Vivaldi），拿不到会话"), {
      code: "not-chromium",
    })
  }
  const dir = profileDirectory(env)
  mkdirSync(dir, { recursive: true })
  if (reuseStored) {
    // 上次登录过的会话还在：不弹窗，直接复用。
    const stored = await readStoredSession({ executable, dir, fetchImpl, launch, readCookies, kill, sleep, now })
    if (stored) return stored
  }
  // 阶段一：普通窗口登录，不开调试端口（开了 Google 会拒绝登录）。
  killProfile?.(dir)
  const child = launchWindow(executable, dir, `${SITE}/`)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    kill(child?.pid)
  }
  try {
    await waitForWindowClose(child, { sleep, signal, timeoutMs: loginTimeoutMs })
    if (signal?.aborted) return { status: "aborted" }
  } finally {
    // 窗口关掉或超时后都要确保进程退出，否则 profile 被占着，下面 headless 起不来。
    close()
  }
  await sleep(400)

  // 阶段二：headless 打开同一份配置目录，让浏览器自己把会话交出来。
  const session = await readStoredSession({
    executable,
    dir,
    fetchImpl,
    launch,
    readCookies,
    kill,
    sleep,
    now,
    startTimeoutMs,
    probeMs: 20000,
  })
  if (!session) {
    throw Object.assign(new Error("窗口关闭了，但没读到 BreezeBlue 登录态：请确认在这个窗口里登录成功后再关"), {
      code: "no-session",
    })
  }
  return session
}

// 等用户关掉登录窗口；超时就当作完成，交给下一步去读。
function waitForWindowClose(child, { sleep, signal, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    if (typeof timer?.unref === "function") timer.unref()
    const onAbort = () => finish()
    signal?.addEventListener?.("abort", onAbort, { once: true })
    if (child && typeof child.once === "function") child.once("exit", finish)
    else finish()
  })
}

// ---------------------------------------------------------------- HTTP 辅助

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function pickNumber(source, keys) {
  if (!source || typeof source !== "object") return undefined
  for (const key of keys) {
    const value = numberOrUndefined(source[key])
    if (value !== undefined) return value
  }
  return undefined
}

async function jsonRequest(url, { fetchImpl, cookie, method = "GET", body, operation = url }) {
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        cookie,
        "user-agent": UA,
        referer: `${SITE}/`,
        origin: SITE,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
  } catch (error) {
    throw new Error(`${operation} 网络失败：${error?.cause?.code || error?.message || "未知错误"}`)
  }
  const text = await response.text().catch(() => "")
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  return { response, payload, text }
}

function unwrap(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") return payload.data
  return payload && typeof payload === "object" ? payload : {}
}

function messageOf(payload, text, response) {
  const body = payload && typeof payload === "object" ? payload : {}
  return (
    (typeof body.detail === "string" && body.detail) ||
    (typeof body.error === "string" && body.error) ||
    (typeof body.message === "string" && body.message) ||
    (typeof body.code === "string" && body.code) ||
    (text ? text.slice(0, 160) : "") ||
    `HTTP ${response?.status ?? 0}`
  )
}

function accountOf(me) {
  if (!me || typeof me !== "object") return undefined
  const email = typeof me.email === "string" ? me.email.trim() : ""
  const id = me.id ?? me.uid ?? me.user_id ?? me.userId
  return email || (id != null ? String(id) : undefined)
}

// 浏览器开着时 Cookie 库是独占锁：等用户退出浏览器后自动继续。
export async function waitForBrowserSession({
  readSession,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  timeoutMs = 5 * 60 * 1000,
  stepMs = 2000,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return { status: "aborted" }
    try {
      return { status: "ready", session: await readSession() }
    } catch (error) {
      if (error?.code !== "locked") throw error
      if (now() >= deadline) return { status: "timeout", error }
      await sleep(stepMs)
    }
  }
}

export function createPlugin({ fetchImpl = globalThis.fetch, client, captureSession = captureLoginSession } = {}) {
  function notify(message, variant) {
    try {
      void Promise.resolve(client?.tui?.showToast?.({ body: { message, variant } })).catch(() => {})
    } catch {
      /* toast is best effort */
    }
  }

  function resultOf(session) {
    const account = accountOf(session.me)
    return {
      type: "success",
      key: account ?? ID,
      accountId: account,
      metadata: {
        cookie: session.cookie,
        method: "browser",
        profile: session.profile,
        ...(account ? { account } : {}),
      },
    }
  }

  return {
    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "打开浏览器登录（自动保存会话）",
          async authorize(_inputs, { signal } = {}) {
            // 点一下就会弹出默认浏览器窗口；登录成功后窗口自动关闭。
            return {
              // 空白 URL：窗口由下面的 captureSession 启动（带独立配置目录），
              // 这里再给 URL 会让 magpie 用默认浏览器多开一个窗口。
              url: "",
              method: "auto",
              instructions:
                "已在独立窗口打开 BreezeBlue（普通窗口，不开调试模式，Google 登录不会被拦）。在里面登录，**登录成功后请关闭这个窗口**，插件会自动读取会话。只有第一次需要登录，之后再点不会弹窗；最多等 10 分钟。",
              async callback(_code, { signal: callbackSignal } = {}) {
                try {
                  const session = await captureSession({ fetchImpl, signal: callbackSignal ?? signal })
                  if (session?.status === "aborted") return { type: "failed", error: "登录已取消" }
                  return resultOf(session)
                } catch (error) {
                  const message = error?.message ?? "浏览器登录失败"
                  notify(`BreezeBlue 登录失败：${message}`, "error")
                  return { type: "failed", error: message }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "粘贴网页 Cookie",
          prompts: [
            {
              type: "password",
              key: "cookie",
              message: "Cookie 头（浏览器 F12 → Network → 任一 /api/ 请求 → 请求头里的 Cookie）",
              validate: (value) => (value && value.trim() ? undefined : "必填"),
            },
            {
              type: "text",
              key: "account",
              message: "账号显示名（可选，如邮箱）",
            },
          ],
          async authorize(inputs) {
            const cookie = String(inputs?.cookie ?? "").trim()
            if (!cookie) return { type: "failed", error: "Cookie 必填" }
            const account = String(inputs?.account ?? "").trim() || undefined
            return {
              type: "success",
              key: account ?? ID,
              accountId: account,
              metadata: { cookie, method: "paste", ...(account ? { account } : {}) },
            }
          },
        },
      ],

      async usage(getAuth) {
        const auth = await getAuth()
        const cookie = auth?.metadata?.cookie
        if (typeof cookie !== "string" || !cookie.trim()) {
          return { error: "这个账号没有网页会话，请用「读取默认浏览器」添加", windows: [] }
        }
        let result
        try {
          result = await jsonRequest(SUMMARY_URL, { fetchImpl, cookie, operation: "credits 余额" })
        } catch (error) {
          return { error: error?.message ?? "BreezeBlue 不可达", windows: [] }
        }
        const { response, payload, text } = result
        if (response.status === 401 || response.status === 403) {
          return { error: "BreezeBlue 会话已失效，请重新登录", signIn: "expired", windows: [] }
        }
        if (!response.ok || payload?.ok === false) {
          return { error: messageOf(payload, text, response), windows: [] }
        }
        const body = unwrap(payload)
        const total = pickNumber(body, ["balance", "total", "credits", "total_credits", "balance_total"])
        const windows = []
        if (total !== undefined) windows.push({ name: "Credits", balance: total })
        for (const [keys, name] of [
          [["subscription_credits", "subscription", "plan_credits"], "订阅"],
          [["rollover_credits", "rollover"], "结转"],
          [["claim_credits", "claimed_credits", "daily_claim_credits"], "签到"],
          [["topup_credits", "top_up_credits", "purchased_credits"], "充值"],
        ]) {
          const value = pickNumber(body, keys)
          // 0 分的分项不占一行；分项与总额相同是正常的（例如签到就是唯一来源）。
          if (value !== undefined && value !== 0) windows.push({ name, balance: value })
        }
        const plan =
          (typeof body.plan === "string" && body.plan) ||
          (typeof body.plan_name === "string" && body.plan_name) ||
          (typeof body.tier === "string" && body.tier) ||
          "BreezeBlue"
        return { plan, windows }
      },

      async checkin(getAuth) {
        const auth = await getAuth()
        const cookie = auth?.metadata?.cookie
        if (typeof cookie !== "string" || !cookie.trim()) {
          return { outcome: "ineligible", message: "只有网页会话才能领取每日 credits" }
        }
        let result
        try {
          result = await jsonRequest(CLAIM_URL, { fetchImpl, cookie, method: "POST", operation: "每日签到" })
        } catch (error) {
          return { outcome: "failed", message: error?.message ?? "签到请求失败" }
        }
        const { response, payload, text } = result
        if (response.status === 401 || response.status === 403) {
          throw Object.assign(new Error("BreezeBlue 会话已失效，请重新登录"), { signIn: "expired" })
        }
        const body = unwrap(payload)
        if (response.ok && payload?.ok !== false) {
          // 真实回答：今天已领过时也是 200，只是 claimed:false + already_claimed:true。
          if (body.already_claimed === true || (body.claimed === false && body.already_claimed !== false)) {
            return { outcome: "done", message: "今天已经领过了" }
          }
          const added =
            pickNumber(body, ["credits_issued", "credits_added", "added", "amount", "claim_amount", "reward"]) ??
            pickNumber(payload, ["credits_issued", "credits_added", "added", "amount", "claim_amount", "reward"])
          return {
            outcome: "claimed",
            ...(added !== undefined ? { credit: added } : {}),
            message: added !== undefined ? `每日签到 +${added} credits` : "每日签到完成",
          }
        }
        const message = messageOf(payload, text, response)
        if (/already|claimed|today|used/i.test(message) || /ALREADY|CLAIMED|USED/.test(String(body.code ?? ""))) {
          return { outcome: "done", message }
        }
        return { outcome: "failed", message }
      },
    },
  }
}

export const BreezeBluePlugin = async () => createPlugin()

export const _internal = {
  createPlugin,
  defaultBrowserExecutable,
  userDataDirectory,
  profileNames,
  copyShared,
  masterKey,
  decryptCookie,
  cookieHeaderFrom,
  readDefaultBrowserSession,
  waitForBrowserSession,
  captureLoginSession,
  readStoredSession,
  loginCookieHeader,
  profileDirectory,
  readBrowserCookies,
  stopBrowser,
  terminateBrowser,
  accountOf,
  pickNumber,
  messageOf,
  SITE,
  SUMMARY_URL,
  CLAIM_URL,
  ME_URL,
  ID,
}
