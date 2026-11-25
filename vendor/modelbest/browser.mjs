/**
 * One-shot Chromium session for the ModelBest console.
 *
 * The console keeps its session in `localStorage["map_token"]` (a JWT) and
 * sends it as a Bearer token, so no cookie replay is needed. The user's normal
 * browser is not debuggable, so this launches a separate profile, lets the
 * user sign in, reads the token through CDP, then closes the window and
 * deletes the profile.
 *
 * The token is only returned in memory. It is never logged or written here.
 */

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONSOLE_ORIGIN, TOKEN_STORAGE_KEY, normalizeConsoleToken } from "./console.mjs"

const CONSOLE_HOST = new URL(CONSOLE_ORIGIN).hostname
const BASE = () => join(tmpdir(), "magpie-modelbest-console-login")
const PROFILE_PREFIX = "modelbest-login-"
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function findBrowser() {
  const platform = process.platform
  const candidates =
    platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        ]
      : platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/snap/bin/chromium",
          ]
  for (const path of candidates) {
    try {
      if (path && existsSync(path)) return path
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

function newProfileDir() {
  const dir = join(
    BASE(),
    `${PROFILE_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function sweepProfiles({ maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  let names = []
  try {
    names = readdirSync(BASE())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue
    const path = join(BASE(), name)
    try {
      if (!statSync(path).isDirectory()) continue
      if (Date.now() - statSync(path).mtimeMs < maxAgeMs) continue
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      /* best effort */
    }
  }
}

async function waitPort(dir, timeoutMs = 8_000) {
  const file = join(dir, "DevToolsActivePort")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, "utf8").split("\n")[0].trim())
      if (port > 0) return port
    } catch {
      /* Chromium has not written the port yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return 0
}

async function listPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(4_000),
  })
  return (await response.json()) ?? []
}

async function openSocket(url, timeoutMs = 8_000) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 连接超时")), timeoutMs)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("CDP 连接失败"))
    })
  })
  return socket
}

async function cdpRequest(socket, method, params = {}, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 请求超时")), timeoutMs)
    socket.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message || "CDP 请求失败"))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id: 1, method, params }))
  })
}

async function commandOnPage(page, method, params = {}, timeoutMs = 8_000) {
  const socket = await openSocket(page.webSocketDebuggerUrl, timeoutMs)
  try {
    return await cdpRequest(socket, method, params, timeoutMs)
  } finally {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  }
}

async function evaluateOnPage(page, expression, timeoutMs = 8_000) {
  const reply = await commandOnPage(
    page,
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs,
  )
  if (reply?.exceptionDetails) return ""
  return reply?.result?.value ?? ""
}

function consolePages(pages) {
  return pages.filter((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) return false
    try {
      return new URL(String(target.url ?? "")).hostname === CONSOLE_HOST
    } catch {
      return false
    }
  })
}

const READ_TOKEN = `(() => {
  if (location.hostname !== ${JSON.stringify(CONSOLE_HOST)}) return "";
  try { return localStorage.getItem(${JSON.stringify(TOKEN_STORAGE_KEY)}) || ""; } catch { return ""; }
})()`

/**
 * Ask the console itself whether the token works. `code === 0` is the only
 * signal that does not depend on a storage key being populated at the right
 * moment; the page fetch also sends whatever headers the console expects.
 */
const PROBE_TOKEN = `(async () => {
  if (location.hostname !== ${JSON.stringify(CONSOLE_HOST)}) return JSON.stringify({ ok: false });
  const token = (() => {
    try { return localStorage.getItem(${JSON.stringify(TOKEN_STORAGE_KEY)}) || ""; } catch { return ""; }
  })();
  if (!token) return JSON.stringify({ ok: false });
  try {
    const response = await fetch("/api/me", {
      credentials: "include",
      headers: { accept: "application/json", authorization: "Bearer " + token },
    });
    const body = await response.json().catch(() => null);
    return JSON.stringify({ ok: response.ok && Number(body && body.code) === 0 });
  } catch {
    return JSON.stringify({ ok: false });
  }
})()`

async function readSession(port) {
  let pages = []
  try {
    pages = consolePages(await listPages(port))
  } catch {
    return { token: "", signedIn: false }
  }
  let token = ""
  let signedIn = false
  for (const page of pages) {
    try {
      const raw = await evaluateOnPage(page, READ_TOKEN)
      if (!token && typeof raw === "string") token = normalizeConsoleToken(raw)
    } catch {
      /* This target may not allow script evaluation yet. */
    }
    if (!signedIn) {
      try {
        const raw = await evaluateOnPage(page, PROBE_TOKEN, 12_000)
        signedIn = raw ? JSON.parse(raw)?.ok === true : false
      } catch {
        signedIn = false
      }
    }
  }
  return { token, signedIn }
}

export async function launchLoginBrowser(url) {
  const executable = findBrowser()
  if (!executable) {
    throw new Error("本机没找到 Chrome / Edge / Brave / Chromium，网页登录需要其中之一")
  }

  sweepProfiles()
  const profile = newProfileDir()
  for (const name of [
    "DevToolsActivePort",
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "lockfile",
  ]) {
    try {
      unlinkSync(join(profile, name))
    } catch {
      /* ignore */
    }
  }

  let child
  try {
    child = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions",
        url,
      ],
      { detached: true, stdio: "ignore", windowsHide: false },
    )
    child.unref?.()
  } catch (error) {
    throw new Error(`浏览器启动失败：${error?.message ?? error}`)
  }

  const port = await waitPort(profile)
  if (!port) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
    throw new Error("浏览器已启动，但 8 秒内没有写出调试端口")
  }
  return { port, dir: profile, child }
}

async function browserAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Wait until the console accepts the stored token.
 *
 * The console writes `map_token` only after the login response lands, so
 * reading storage alone can return the previous account's token. The probe
 * runs in the page and is what turns "a token exists" into "signed in".
 */
export async function waitForConsoleToken(
  session,
  { timeout = LOGIN_TIMEOUT_MS, interval = 1_500, signal } = {},
) {
  const deadline = Date.now() + timeout
  let gone = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) return { aborted: true }
    try {
      const found = await readSession(session.port)
      if (found.token && found.signedIn) return found
    } catch {
      /* The page may still be loading or on the login form. */
    }
    if (await browserAlive(session.port)) {
      gone = 0
    } else if (++gone >= 2) {
      return { closed: true }
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return signal?.aborted ? { aborted: true } : null
}

export async function closeSession(session) {
  if (!session) return
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/version`, {
      signal: AbortSignal.timeout(3_000),
    })
    const version = await response.json()
    if (version?.webSocketDebuggerUrl) {
      await new Promise((resolve) => {
        const socket = new WebSocket(version.webSocketDebuggerUrl)
        const done = () => {
          try {
            socket.close()
          } catch {
            /* ignore */
          }
          resolve()
        }
        const timer = setTimeout(done, 2_000)
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ id: 1, method: "Browser.close" }))
        })
        socket.addEventListener("message", () => {
          clearTimeout(timer)
          done()
        })
        socket.addEventListener("error", () => {
          clearTimeout(timer)
          done()
        })
      })
    }
  } catch {
    /* fall through to the process kill */
  }

  try {
    session.child?.kill()
  } catch {
    /* ignore */
  }
  if (process.platform === "win32" && session.child?.pid) {
    try {
      spawn("taskkill", ["/PID", String(session.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(session.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* best effort */
  }
}
