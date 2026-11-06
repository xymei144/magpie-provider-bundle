/**
 * One-shot Chromium session for the Spark console.
 *
 * The console session may live in localStorage (a bearer token) or only in
 * cookies set by the iFlytek SSO pages. The user's normal browser is not
 * debuggable, so this launches a separate profile, lets the user sign in,
 * reads both forms through CDP, then closes the window and deletes the
 * profile.
 *
 * The token is only returned in memory. It is never logged or written here.
 */

import { spawn } from "node:child_process"
import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeConsoleToken } from "./console.mjs"

const BASE = () => join(tmpdir(), "magpie-spark-console-login")
const PROFILE_PREFIX = "spark-login-"
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
      const stat = statSync(path)
      if (!stat.isDirectory()) continue
      if (Date.now() - stat.mtimeMs < maxAgeMs) continue
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
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  )
  if (reply?.exceptionDetails) return ""
  return reply?.result?.value ?? ""
}

async function readBrowserCookies(port) {
  const pages = (await listPages(port)).filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  )
  for (const page of pages) {
    try {
      const result = await commandOnPage(page, "Network.getAllCookies")
      if (Array.isArray(result?.cookies)) return result.cookies
    } catch {
      /* Try another target or the browser-level Storage domain. */
    }
  }

  let version
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(4_000),
    })
    version = await response.json()
  } catch {
    return []
  }
  if (!version?.webSocketDebuggerUrl) return []

  const socket = await openSocket(version.webSocketDebuggerUrl)
  try {
    const result = await cdpRequest(socket, "Storage.getCookies")
    return Array.isArray(result?.cookies) ? result.cookies : []
  } catch {
    return []
  } finally {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  }
}

function iFlytekCookie(cookie) {
  const domain = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase()
  return domain === "xfyun.cn" || domain.endsWith(".xfyun.cn")
}

/**
 * Turn CDP cookie objects into a Cookie header. Only iFlytek cookies are
 * included; values never leave this process.
 */
export function formatConsoleCookies(cookies) {
  const now = Date.now() / 1000
  const byName = new Map()
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!iFlytekCookie(cookie)) continue
    const name = String(cookie?.name ?? "").trim()
    const value = typeof cookie?.value === "string" ? cookie.value : ""
    if (!name || !value) continue
    const expires = Number(cookie?.expires)
    if (Number.isFinite(expires) && expires > 0 && expires < now) continue

    const domain = String(cookie.domain ?? "").replace(/^\./, "").toLowerCase()
    const path = String(cookie.path ?? "/")
    const priority =
      (domain === "maas.xfyun.cn" ? 3 : domain === "xfyun.cn" ? 2 : 1) +
      path.length / 1000
    const previous = byName.get(name)
    if (!previous || priority >= previous.priority) {
      byName.set(name, { name, value, priority })
    }
  }
  return [...byName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

// Asking the console itself is the only check that does not depend on the
// cookie names iFlytek happens to use. An anonymous visit already sets
// `di_c_mti`, `SESSION` and the analytics cookies, so a name list marks
// everyone as signed in; the console answers `code 4001 用户未登录` until the
// SSO login really finished. The request runs inside the page, so the browser
// sends every cookie, HttpOnly ones included.
const PROBE_CONSOLE = `(async () => {
  if (location.hostname !== "maas.xfyun.cn") return JSON.stringify({ ok: false });
  const headers = { accept: "application/json", "x-auth-source": "" };
  try {
    const readToken = () => {
      for (const store of [localStorage, sessionStorage]) {
        for (const key of ["token", "access_token", "Authorization"]) {
          try {
            const raw = store.getItem(key);
            if (!raw) continue;
            let value = raw;
            try {
              const parsed = JSON.parse(raw);
              value = parsed.value ?? parsed.token ?? parsed.accessToken ?? parsed.access_token ?? raw;
            } catch {}
            value = String(value || "").replace(/^bearer\\s+/i, "").trim();
            if (value) return value;
          } catch {}
        }
      }
      return "";
    };
    const token = readToken();
    if (token) headers.Authorization = token;
  } catch {}
  try {
    const response = await fetch("/api/v1/gpt-finetune/user", {
      credentials: "include",
      headers,
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text) } catch {}
    const code = Number(body && body.code);
    return JSON.stringify({
      ok: response.ok && code === 0,
      status: response.status,
    });
  } catch {
    return JSON.stringify({ ok: false, status: 0 });
  }
})()`

async function probeConsole(page) {
  try {
    const raw = await evaluateOnPage(page, PROBE_CONSOLE, 12_000)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed?.ok === true
  } catch {
    return false
  }
}

// The console's own requests carry the session; asking from the page avoids
// replaying a cookie header from Node, which some iFlytek sessions refuse.
const READ_CONSOLE_API = `(async () => {
  if (location.hostname !== "maas.xfyun.cn") return "";
  const headers = { accept: "application/json", "x-auth-source": "" };
  try {
    const readToken = () => {
      for (const store of [localStorage, sessionStorage]) {
        for (const key of ["token", "access_token", "Authorization"]) {
          try {
            const raw = store.getItem(key);
            if (!raw) continue;
            let value = raw;
            try {
              const parsed = JSON.parse(raw);
              value = parsed.value ?? parsed.token ?? parsed.accessToken ?? parsed.access_token ?? raw;
            } catch {}
            value = String(value || "").replace(/^bearer\\s+/i, "").trim();
            if (value) return value;
          } catch {}
        }
      }
      return "";
    };
    const token = readToken();
    if (token) headers.Authorization = token;
  } catch {}
  const get = async (url) => {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers,
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { code: -1, message: "控制台返回了非 JSON 内容", httpStatus: response.status };
      }
    } catch (error) {
      return { code: -1, message: String((error && error.message) || error) };
    }
  };
  return JSON.stringify({
    keys: await get("/api/v1/gpt-finetune/api-keys"),
    quota: await get("/api/v1/gpt-finetune/api-services/free-quota?channel=spark-x2.6"),
    user: await get("/api/v1/gpt-finetune/user"),
  });
})()`

/**
 * Read the API keys, free quota and user from the signed-in console page.
 * Returns null when no console page is open or the calls cannot run.
 */
export async function readConsoleApi(session, { timeout = 20_000, signal } = {}) {
  if (signal?.aborted) return null
  let pages = []
  try {
    pages = (await listPages(session.port)).filter(
      (target) => target.type === "page" && target.webSocketDebuggerUrl,
    )
  } catch {
    return null
  }
  const consolePages = pages.filter((target) => {
    try {
      return new URL(String(target.url ?? "")).hostname === "maas.xfyun.cn"
    } catch {
      return false
    }
  })
  for (const page of consolePages) {
    if (signal?.aborted) return null
    try {
      const raw = await evaluateOnPage(page, READ_CONSOLE_API, timeout)
      if (raw) return JSON.parse(raw)
    } catch {
      /* A popup or a page still on the SSO redirect may reject evaluation. */
    }
  }
  return null
}

function mergeCookies(first, second) {
  const parts = []
  for (const value of [first, second]) {
    const text = String(value ?? "").trim()
    if (!text) continue
    for (const part of text.split(";")) {
      const piece = part.trim()
      if (piece && !parts.includes(piece)) parts.push(piece)
    }
  }
  return parts.join("; ")
}

/** Read the console session from every login-related target. */
async function readConsoleSession(port) {
  let token = ""
  let extraCookie = ""
  let localCookie = ""
  let signedIn = false
  let pages = []
  try {
    pages = (await listPages(port)).filter(
      (target) => target.type === "page" && target.webSocketDebuggerUrl,
    )
  } catch {
    /* The browser may still be starting. */
  }
  for (const page of pages) {
    try {
      const raw = await evaluateOnPage(page, READ_CONSOLE_SESSION)
      const parsed = raw ? JSON.parse(raw) : null
      if (!token && typeof parsed?.token === "string") {
        token = normalizeConsoleToken(parsed.token)
      }
      if (typeof parsed?.cookie === "string" && parsed.cookie.trim()) {
        if (!localCookie) localCookie = parsed.cookie.trim()
        extraCookie = mergeCookies(extraCookie, parsed.cookie)
      }
    } catch {
      /* This target may not allow script evaluation. */
    }
    if (!signedIn && (await probeConsole(page))) signedIn = true
  }

  const browserCookie = formatConsoleCookies(await readBrowserCookies(port).catch(() => []))
  const cookie = mergeCookies(browserCookie, extraCookie)
  return { token, cookie, localCookie, signedIn }
}

/** Read the two console localStorage values without touching document.cookie. */
const READ_CONSOLE_SESSION = `(() => {
  if (location.hostname !== "maas.xfyun.cn") return JSON.stringify({ token: "", cookie: "" });
  const read = (store, key) => { try { return store.getItem(key) || "" } catch { return "" } };
  const token =
    read(localStorage, "token") ||
    read(localStorage, "access_token") ||
    read(localStorage, "Authorization") ||
    read(sessionStorage, "token") ||
    read(sessionStorage, "access_token");
  const cookie =
    read(localStorage, "x-auth-token") ||
    read(localStorage, "cookie") ||
    read(sessionStorage, "x-auth-token");
  return JSON.stringify({ token, cookie });
})()`

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
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
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

export function usableSession(raw) {
  if (!raw) return null
  const token = typeof raw?.token === "string" ? raw.token.trim() : ""
  const cookie = typeof raw?.cookie === "string" ? raw.cookie.trim() : ""
  const localCookie = typeof raw?.localCookie === "string" ? raw.localCookie.trim() : ""
  // The console's own request interceptor replaces the Cookie header with
  // localStorage["x-auth-token"] instead of merging it with the anonymous
  // cookies. When that value exists it is the session, so replay it verbatim.
  // The page probe can fail for a token-only console because browser fetch
  // cannot set Cookie, which is why this is accepted before `signedIn` turns
  // true.
  const cookieHeader = localCookie || cookie
  if (raw?.signedIn === true && (token || cookieHeader)) {
    return { token, cookie: cookieHeader, signedIn: true }
  }
  if (localCookie.length >= 8 && !/^(null|undefined)$/i.test(localCookie)) {
    return { token, cookie: localCookie, signedIn: false }
  }
  // A long console token in localStorage is proof on its own; cookies are not,
  // because the anonymous page sets several of them.
  if (token.length < 16) return null
  return { token, cookie: cookieHeader, signedIn: raw?.signedIn === true }
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

export async function waitForConsoleCredentials(
  session,
  { timeout = LOGIN_TIMEOUT_MS, interval = 1_500, validate, signal } = {},
) {
  const deadline = Date.now() + timeout
  let gone = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) return { aborted: true }
    try {
      const found = usableSession(await readConsoleSession(session.port))
      if (found) {
        if (typeof validate !== "function") return found
        let accepted = false
        try {
          accepted = Boolean(await validate(found))
        } catch {
          accepted = false
        }
        if (accepted) return found
      }
    } catch {
      /* The page may still be on SSO or loading. */
    }
    // A closed sign-in window leaves nothing to read: say so at once instead
    // of spinning until the five-minute timeout.
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
