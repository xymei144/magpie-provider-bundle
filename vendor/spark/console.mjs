/**
 * Spark / Astron MaaS console helpers.
 *
 * The inference API only knows API keys. The free-quota number lives in the
 * web console behind a session that may be a localStorage token, SSO cookies,
 * or both:
 *
 *   https://maas.xfyun.cn/usageStatistics
 *
 * The console page calls:
 *
 *   GET /api/v1/gpt-finetune/api-services/free-quota?channel=spark-x2.6
 *
 * This module is read-only. It never claims the quota and never prints the
 * console token.
 */

export const CONSOLE_ORIGIN = "https://maas.xfyun.cn"
export const CONSOLE_USAGE_URL = `${CONSOLE_ORIGIN}/usageStatistics`
export const CONSOLE_CHANNEL = "spark-x2.6"

const API_PREFIX = "/api/v1/gpt-finetune"
const FREE_QUOTA_PATH = `${API_PREFIX}/api-services/free-quota`
const API_KEYS_PATH = `${API_PREFIX}/api-keys`
const USER_PATH = `${API_PREFIX}/user`
const REQUEST_TIMEOUT_MS = 15_000

function cleanText(value) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
}

function unwrapValue(value) {
  const text = cleanText(value)
  if (!text) return ""
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object") {
      return cleanText(
        parsed.value ?? parsed.token ?? parsed.accessToken ?? parsed.access_token,
      )
    }
  } catch {
    /* plain string */
  }
  return text
}

export function normalizeConsoleToken(value) {
  return unwrapValue(value).replace(/^bearer\s+/i, "").trim()
}

export function normalizeConsoleCookie(value) {
  return unwrapValue(value)
}

/**
 * The page-side reader returns the console's full envelope; the Node reader
 * unwraps it already. Both shapes are accepted here.
 */
function payloadData(payload) {
  return payload && typeof payload === "object" && "data" in payload
    ? payload.data
    : payload
}

export function consoleResponseError(payload) {
  if (!payload || typeof payload !== "object") return "控制台没有返回 JSON"
  const code = Number(payload.code)
  if (payload.failed === true || (Number.isFinite(code) && code !== 0)) {
    return (
      cleanText(payload.message) ||
      (Number.isFinite(code) ? `code ${code}` : "控制台返回失败")
    )
  }
  return ""
}

export function apiKeyRows(payload) {
  const data = payloadData(payload)
  return Array.isArray(data)
    ? data
    : Array.isArray(data?.rows)
      ? data.rows
      : Array.isArray(data?.list)
        ? data.list
        : []
}

export function userOfConsolePayload(payload) {
  const data = payloadData(payload)
  return data && typeof data === "object" && !Array.isArray(data) ? data : null
}

/**
 * Read the console session from a Magpie account.
 *
 * OAuth login stores the fields at the top level; the optional API-key
 * prompts store them in metadata. Both are accepted so an account can be
 * repaired without signing in again.
 */
export function consoleCredentials(auth) {
  const metadata =
    auth && typeof auth.metadata === "object" && auth.metadata !== null
      ? auth.metadata
      : {}
  return {
    token: normalizeConsoleToken(
      metadata.consoleToken ??
        metadata.token ??
        auth?.consoleToken ??
        auth?.token,
    ),
    cookie: normalizeConsoleCookie(
      metadata.consoleCookie ??
        metadata.cookie ??
        auth?.consoleCookie ??
        auth?.cookie,
    ),
  }
}

function authHeaders(credentials) {
  const headers = {
    accept: "application/json",
    "x-auth-source": "",
  }
  if (credentials.token) headers.authorization = credentials.token
  if (credentials.cookie) headers.cookie = credentials.cookie
  return headers
}

async function requestJson(
  path,
  { token, cookie, fetchImpl = fetch, signal } = {},
) {
  if (!token && !cookie) {
    return { error: "未登录星辰控制台" }
  }
  if (signal?.aborted) {
    return { error: "登录已取消", aborted: true }
  }

  let response
  try {
    response = await fetchImpl(`${CONSOLE_ORIGIN}${path}`, {
      headers: authHeaders({ token, cookie }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (signal?.aborted) {
      return { error: "登录已取消", aborted: true }
    }
    return {
      error: `连接星辰控制台失败：${error?.cause?.code || error?.message || error}`,
    }
  }

  const text = await response.text().catch(() => "")
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    /* Non-JSON response: use the status below. */
  }

  if (response.status === 401 || response.status === 403) {
    return { error: "星辰控制台登录已过期，请重新登录", signIn: "expired" }
  }
  if (!response.ok) {
    const detail = payload?.message || text.slice(0, 120)
    return { error: `星辰控制台返回 HTTP ${response.status}${detail ? `：${detail}` : ""}` }
  }
  if (payload?.code === 4001 || payload?.code === 401) {
    return { error: "星辰控制台登录已过期，请重新登录", signIn: "expired" }
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    return {
      error: `星辰控制台返回失败：${payload?.message || `code ${payload.code}`}`,
    }
  }
  return { data: payload?.data ?? payload }
}

export async function fetchFreeQuota({ token, cookie, fetchImpl = fetch } = {}) {
  const query = new URLSearchParams({ channel: CONSOLE_CHANNEL }).toString()
  return requestJson(`${FREE_QUOTA_PATH}?${query}`, { token, cookie, fetchImpl })
}

export async function fetchApiKeys({
  token,
  cookie,
  fetchImpl = fetch,
  signal,
} = {}) {
  const result = await requestJson(API_KEYS_PATH, {
    token,
    cookie,
    fetchImpl,
    signal,
  })
  if (result.error) return result
  const rows = apiKeyRows(result.data)
  return { rows }
}

export async function fetchConsoleUser({
  token,
  cookie,
  fetchImpl = fetch,
  signal,
} = {}) {
  const result = await requestJson(USER_PATH, {
    token,
    cookie,
    fetchImpl,
    signal,
  })
  if (result.error) return result
  return { user: userOfConsolePayload(result.data) }
}

export function pickApiKey(rows) {
  const list = Array.isArray(rows) ? rows : []
  const candidates = list.filter(
    (row) => row && typeof row.apiKey === "string" && row.apiKey.trim(),
  )
  if (candidates.length === 0) return ""
  candidates.sort((a, b) => {
    const left = Date.parse(a.createTime ?? "")
    const right = Date.parse(b.createTime ?? "")
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
      return right - left
    }
    return 0
  })
  return candidates[0].apiKey.trim()
}

export function accountNameOf(user) {
  if (!user || typeof user !== "object") return ""
  const value =
    user.phone ??
    user.mobile ??
    user.email ??
    user.userName ??
    user.username ??
    user.nickname ??
    user.name ??
    user.uid ??
    user.userId ??
    user.id
  return cleanText(String(value ?? ""))
}

function formatTokens(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return "0"
  if (number >= 1e9) return `${trimFixed(number / 1e9)}B`
  if (number >= 1e6) return `${trimFixed(number / 1e6)}M`
  if (number >= 1e3) return `${trimFixed(number / 1e3)}K`
  return String(Math.round(number))
}

function trimFixed(value) {
  return String(Number(value.toFixed(2)))
}

function isoTime(value) {
  const text = cleanText(value)
  if (!text) return ""
  let normalized = text
  if (!/T/.test(normalized)) normalized = normalized.replace(" ", "T")
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(normalized)) normalized += "+08:00"
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ""
}

/**
 * Turn the console's free-quota payload into a Magpie usage window.
 *
 * `used` is a 0–100 percentage (Magpie's convention); `amount` is the
 * remaining token count and `limit` is the total. The display string carries
 * the exact numbers because Magpie has no separate `remaining` field.
 */
export function freeQuotaWindow(payload) {
  const data = payload?.data ?? payload
  const claim = data?.claim ?? data?.freeQuota?.claim ?? null
  const quota = claim?.freeQuota ?? data?.freeQuota ?? null

  if (!quota || typeof quota !== "object") {
    return {
      name: "免费额度",
      used: 0,
      display: "未领取（请到星辰控制台领取）",
      resetsAt: "",
      amount: 0,
      limit: 0,
      unit: "tokens",
    }
  }

  const total = Math.max(0, Number(quota.totalTokens) || 0)
  const usedTokens = Math.max(0, Number(quota.usedTokens) || 0)
  const remainingRaw = Number(quota.remainingTokens)
  const remaining = Number.isFinite(remainingRaw)
    ? Math.max(0, remainingRaw)
    : Math.max(0, total - usedTokens)
  const status = cleanText(String(quota.quotaStatus ?? "")).toUpperCase()
  const statusText =
    status === "EXPIRED" ? " · 已过期" : status === "EXHAUSTED" ? " · 已耗尽" : ""
  const usedPercent = total > 0 ? Math.min(100, (usedTokens / total) * 100) : 0

  return {
    name: "免费额度",
    used: usedPercent,
    display:
      total > 0
        ? `剩余 ${formatTokens(remaining)} / 共 ${formatTokens(total)}（已用 ${formatTokens(usedTokens)}）${statusText}`
        : `剩余 ${formatTokens(remaining)}${statusText}`,
    resetsAt: isoTime(quota.expiresAt),
    amount: remaining,
    limit: total,
    unit: "tokens",
  }
}
