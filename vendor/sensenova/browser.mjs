/**
 * One-shot Chromium sign-in for the SenseNova console.
 *
 * The console keeps its OAuth session in `localStorage`, behind a real browser
 * login (password, SMS, captcha — whatever SenseTime asks for). A scripted
 * password login through IAM is the path that gets rate-limited, so the plugin
 * opens a throwaway browser profile, lets the user finish the normal login
 * once, and reads the session through CDP.
 *
 * What is read:
 *
 *   - `access_token` — a plain JWT in localStorage, sent as `Authorization`.
 *   - `NOVA_AUTH:nova:login` — the SDK's login record, AES-encrypted by
 *     crypto-js with the client id (`nova`) as the passphrase. It contains the
 *     long-lived `refreshToken`, which is what keeps the quota alive without a
 *     password.
 *   - cookies for `sensenova.cn` / `sensecoreapi.cn`, as a fallback when the
 *     refresh token is rotated away or the console changes its storage.
 *
 * The profile is deleted after the window closes. Tokens never leave this
 * process except into the plugin's own state file (see `state.mjs`).
 *
 * @module st-sensenova-magpie/browser
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONSOLE_URL = "https://platform.sensenova.cn/";
export const IAM_API = "https://iam.sensecoreapi.cn";
export const QUOTA_PATH = "/lite/console/v1/tokenplan/pool-usage";

const BASE = () => join(tmpdir(), "magpie-sensenova-console-login");
const PROFILE_PREFIX = "sensenova-login-";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_STORE_KEY = "NOVA_AUTH:nova:login";
const AUTH_PASSPHRASE = "nova";

/** Chrome first, then the Chromium derivatives people actually have. */
export function findBrowser() {
  const platform = process.platform;
  const candidates =
    platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\Application\\msedge.exe"),
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
          ];
  for (const file of candidates) {
    try {
      if (file && existsSync(file)) return file;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function newProfileDir() {
  const dir = join(
    BASE(),
    `${PROFILE_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sweepProfiles({ maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  let names = [];
  try {
    names = readdirSync(BASE());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = join(BASE(), name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      if (Date.now() - stat.mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  }
}

async function waitPort(dir, timeoutMs = 8_000) {
  const file = join(dir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, "utf8").split("\n")[0].trim());
      if (port > 0) return port;
    } catch {
      /* Chromium has not written the port yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 0;
}

async function listPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(4_000),
  });
  return (await response.json()) ?? [];
}

async function openSocket(url, timeoutMs = 8_000) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 连接超时")), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP 连接失败"));
    });
  });
  return socket;
}

async function cdpRequest(socket, method, params = {}, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 请求超时")), timeoutMs);
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || "CDP 请求失败"));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id: 1, method, params }));
  });
}

async function commandOnPage(page, method, params = {}, timeoutMs = 8_000) {
  const socket = await openSocket(page.webSocketDebuggerUrl, timeoutMs);
  try {
    return await cdpRequest(socket, method, params, timeoutMs);
  } finally {
    try {
      socket.close();
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
    timeoutMs
  );
  if (reply?.exceptionDetails) return "";
  return reply?.result?.value ?? "";
}

async function readBrowserCookies(port) {
  const pages = (await listPages(port)).filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl
  );
  for (const page of pages) {
    try {
      const result = await commandOnPage(page, "Network.getAllCookies");
      if (Array.isArray(result?.cookies)) return result.cookies;
    } catch {
      /* Try another target or the browser-level Storage domain. */
    }
  }

  let version;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(4_000),
    });
    version = await response.json();
  } catch {
    return [];
  }
  if (!version?.webSocketDebuggerUrl) return [];

  const socket = await openSocket(version.webSocketDebuggerUrl);
  try {
    const result = await cdpRequest(socket, "Storage.getCookies");
    return Array.isArray(result?.cookies) ? result.cookies : [];
  } catch {
    return [];
  } finally {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
}

const COOKIE_DOMAINS = ["sensenova.cn", "sensecoreapi.cn", "sensecore.cn"];

function inCookieDomain(cookie) {
  const domain = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase();
  return COOKIE_DOMAINS.some((root) => domain === root || domain.endsWith(`.${root}`));
}

/**
 * Cookie header for the console and IAM hosts.
 *
 * `CookieJar` in `quota.mjs` replays a flat header to both hosts, so a name
 * that exists on both is deduplicated by host priority here instead of being
 * sent twice with conflicting values.
 */
export function formatCookies(cookies) {
  const now = Date.now() / 1000;
  const byName = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!inCookieDomain(cookie)) continue;
    const name = String(cookie?.name ?? "").trim();
    const value = typeof cookie?.value === "string" ? cookie.value : "";
    if (!name || !value) continue;
    const expires = Number(cookie?.expires);
    if (Number.isFinite(expires) && expires > 0 && expires < now) continue;

    const domain = String(cookie.domain ?? "").replace(/^\./, "").toLowerCase();
    const path = String(cookie.path ?? "/");
    const priority =
      (domain === "platform.sensenova.cn" ? 4 : domain === "iam.sensecoreapi.cn" ? 3 : 2) +
      path.length / 1000;
    const previous = byName.get(name);
    if (!previous || priority >= previous.priority) {
      byName.set(name, { name, value, priority });
    }
  }
  return [...byName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * crypto-js `AES.encrypt(json, "nova")` uses the OpenSSL KDF: MD5-derived
 * 32-byte key + 16-byte IV, CBC, PKCS#7, `Salted__` + 8-byte salt prefix.
 * That is reproducible with Node's crypto, so the refresh token can be read
 * without shipping crypto-js.
 */
export function decryptLoginState(blob, passphrase = AUTH_PASSPHRASE) {
  try {
    const raw = Buffer.from(String(blob ?? ""), "base64");
    if (raw.length < 32 || raw.subarray(0, 8).toString("latin1") !== "Salted__") return null;
    const salt = raw.subarray(8, 16);
    const ciphertext = raw.subarray(16);
    const pass = Buffer.from(passphrase, "utf8");
    let derived = Buffer.alloc(0);
    let block = Buffer.alloc(0);
    while (derived.length < 48) {
      block = crypto.createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
      derived = Buffer.concat([derived, block]);
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      derived.subarray(0, 32),
      derived.subarray(32, 48)
    );
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const READ_SESSION = `(() => {
  if (location.hostname !== "platform.sensenova.cn") return "";
  const read = (key) => { try { return localStorage.getItem(key) || "" } catch { return "" } };
  return JSON.stringify({
    token: read("access_token"),
    idToken: read("id_token"),
    login: read(${JSON.stringify(AUTH_STORE_KEY)}),
  });
})()`;

const PROBE_QUOTA = `(async () => {
  const token = (() => { try { return localStorage.getItem("access_token") || "" } catch { return "" } })();
  if (!token) return JSON.stringify({ ok: false, status: 0 });
  try {
    const response = await fetch(${JSON.stringify(QUOTA_PATH)}, {
      credentials: "include",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    return JSON.stringify({ ok: response.ok, status: response.status });
  } catch {
    return JSON.stringify({ ok: false, status: 0 });
  }
})()`;

async function readPageSession(port) {
  let pages = [];
  try {
    pages = (await listPages(port)).filter(
      (target) => target.type === "page" && target.webSocketDebuggerUrl
    );
  } catch {
    return null;
  }
  for (const page of pages) {
    try {
      const raw = await evaluateOnPage(page, READ_SESSION);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === "string" && parsed.token.trim()) {
        return { page, ...parsed };
      }
    } catch {
      /* This target may not allow script evaluation. */
    }
  }
  return null;
}

async function probeQuota(page) {
  try {
    const raw = await evaluateOnPage(page, PROBE_QUOTA, 15_000);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.ok === true;
  } catch {
    return false;
  }
}

async function browserAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function launchLoginBrowser(url = CONSOLE_URL) {
  const executable = findBrowser();
  if (!executable) {
    throw new Error("本机没找到 Chrome / Edge / Brave / Chromium，网页登录需要其中之一");
  }

  sweepProfiles();
  const profile = newProfileDir();
  for (const name of [
    "DevToolsActivePort",
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "lockfile",
  ]) {
    try {
      unlinkSync(join(profile, name));
    } catch {
      /* ignore */
    }
  }

  let child;
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
        "--window-size=1100,820",
        url,
      ],
      { detached: true, stdio: "ignore", windowsHide: false }
    );
    child.unref?.();
  } catch (error) {
    throw new Error(`浏览器启动失败：${error?.message ?? error}`);
  }

  const port = await waitPort(profile);
  if (!port) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
    throw new Error("浏览器已启动，但 8 秒内没有写出调试端口");
  }
  return { port, dir: profile, child };
}

/**
 * Wait until the console is really signed in.
 *
 * `access_token` appears before the quota API accepts it in some flows, so the
 * page itself asks its own quota endpoint; only a 2xx counts as finished.
 */
export async function waitForSession(
  session,
  { timeout = LOGIN_TIMEOUT_MS, interval = 1_500, signal } = {}
) {
  const deadline = Date.now() + timeout;
  let gone = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { aborted: true };
    try {
      const found = await readPageSession(session.port);
      if (found && (await probeQuota(found.page))) {
        return {
          accessToken: String(found.token).trim(),
          idToken: typeof found.idToken === "string" ? found.idToken.trim() : "",
          login: typeof found.login === "string" ? found.login.trim() : "",
        };
      }
    } catch {
      /* The page may still be on the IAM redirect or loading. */
    }
    if (await browserAlive(session.port)) {
      gone = 0;
    } else if (++gone >= 2) {
      return { closed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return signal?.aborted ? { aborted: true } : null;
}

/** The captured session plus the encrypted login record's refresh token. */
export async function readSession(session, { signal } = {}) {
  const found = await waitForSession(session, { signal });
  if (!found) throw new Error("等待网页登录超时（5 分钟）");
  if (found.aborted) throw new Error("登录已取消");
  if (found.closed) throw new Error("登录窗口被关闭，网页登录未完成");

  const record = decryptLoginState(found.login);
  const cookies = formatCookies(await readBrowserCookies(session.port).catch(() => []));
  const refreshToken =
    typeof record?.refreshToken === "string" ? record.refreshToken.trim() : "";
  const idToken =
    found.idToken || (typeof record?.idToken === "string" ? record.idToken.trim() : "");
  return {
    accessToken: found.accessToken,
    refreshToken,
    idToken,
    cookie: cookies,
    username: typeof record?.username === "string" ? record.username.trim() : "",
    userId: typeof record?.userId === "string" ? record.userId.trim() : "",
  };
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

/** A key the console returns in full; masked list entries never match. */
export function pickApiKey(keys) {
  for (const entry of Array.isArray(keys) ? keys : []) {
    const value =
      typeof entry === "string"
        ? entry
        : typeof entry?.api_key === "string"
          ? entry.api_key
          : typeof entry?.apiKey === "string"
            ? entry.apiKey
            : typeof entry?.key === "string"
              ? entry.key
            : "";
    const text = value.trim();
    if (!KEY_PATTERN.test(text)) continue;
    const status = String(entry?.status ?? "").toLowerCase();
    if (status && !/active|enabled|normal|valid/.test(status)) continue;
    return text;
  }
  return "";
}

/** `GET /iam/idp/v1/apiKeys` — the same list the console's API Key page reads. */
export async function fetchApiKeys(accessToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${IAM_API}/iam/idp/v1/apiKeys?page_size=50`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data?.message || data?.details?.[0]?.message || text.slice(0, 160);
    throw new Error(`读取 API Key 失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
  }
  const rows =
    data?.api_keys ??
    data?.data?.api_keys ??
    data?.data?.items ??
    data?.items;
  return Array.isArray(rows) ? rows : [];
}

export async function closeSession(session) {
  if (!session) return;
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    const version = await response.json();
    if (version?.webSocketDebuggerUrl) {
      await new Promise((resolve) => {
        const socket = new WebSocket(version.webSocketDebuggerUrl);
        const done = () => {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          resolve();
        };
        const timer = setTimeout(done, 2_000);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        });
        socket.addEventListener("message", () => {
          clearTimeout(timer);
          done();
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  } catch {
    /* fall through to the process kill */
  }

  try {
    session.child?.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === "win32" && session.child?.pid) {
    try {
      spawn("taskkill", ["/PID", String(session.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(session.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* best effort */
  }
}
