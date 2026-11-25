/**
 * Read-only client for the ModelBest console API.
 *
 * `platform.modelbest.cn` splits credentials in two:
 *
 *   - **Inference** uses an `sk-…` API key against `api.modelbest.cn/v1`.
 *   - **Account** (balance, daily check-in) uses the browser session JWT that
 *     the console keeps in `localStorage["map_token"]`, sent as
 *     `Authorization: Bearer …` to `platform.modelbest.cn/api`.
 *
 * No API-key-accessible account endpoint exists, so the console token is the
 * only way to show 积分 or claim the daily check-in reward.
 */

export const CONSOLE_ORIGIN = "https://platform.modelbest.cn"
export const CONSOLE_PAGE = `${CONSOLE_ORIGIN}/console/recharges`
export const TOKEN_STORAGE_KEY = "map_token"

const API = `${CONSOLE_ORIGIN}/api`
const CODE_UNAUTHORIZED = 10001
const CODE_DISABLED = 10003

export class ConsoleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "ConsoleError"
    this.code = code
  }
}

/** Accept a raw JWT, a `Bearer …` prefixed value, or a pasted JSON object. */
export function normalizeConsoleToken(value) {
  if (typeof value !== "string") return ""
  let text = value.trim().replace(/^bearer\s+/i, "").trim()
  if (!text) return ""
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      text = String(
        parsed?.token ?? parsed?.access_token ?? parsed?.accessToken ?? parsed?.map_token ?? "",
      ).trim()
    } catch {
      return ""
    }
  }
  return /[\u0000-\u001f\u007f]/.test(text) ? "" : text
}

function unwrap(body) {
  if (!body || typeof body !== "object") {
    throw new ConsoleError(-1, "控制台返回了空响应")
  }
  if (!("code" in body)) return body
  const code = Number(body.code)
  if (code === 0) return body.data ?? null
  throw new ConsoleError(code, String(body.message || `错误码 ${code}`))
}

/**
 * One console call, with the envelope unwrapped.
 *
 * The console answers HTTP 200 for business failures (`code` in the body), so
 * `res.ok` alone is not a success signal.
 */
export async function consoleRequest(
  path,
  { token, method = "GET", body, signal, fetchImpl = fetch } = {},
) {
  const headers = new Headers({
    accept: "application/json",
    "accept-language": "zh-CN",
  })
  if (body !== undefined) headers.set("content-type", "application/json")
  if (token) headers.set("authorization", `Bearer ${token}`)
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    throw new ConsoleError(-1, `控制台返回了非 JSON 内容（HTTP ${res.status}）`)
  }
  return unwrap(parsed)
}

/** Verify a token and read the account label shown on the card. */
export async function readProfile(token, options = {}) {
  const data = await consoleRequest("/me", { ...options, token })
  return {
    accountId: text(data?.username ?? data?.name ?? data?.email ?? data?.phone ?? data?.id),
    email: text(data?.email),
    phone: text(data?.phone),
  }
}

/** `GET /billing/account` → `{ balance, financial_status, billing_enabled }`. */
export async function readAccount(token, options = {}) {
  const data = await consoleRequest("/billing/account", { ...options, token })
  return {
    balance: number(data?.balance),
    arrears: String(data?.financial_status ?? "").toUpperCase() === "ARREARS",
    billingEnabled: data?.billing_enabled === true,
  }
}

/** `GET /rewards` → today's check-in state. */
export async function readRewards(token, options = {}) {
  const data = await consoleRequest("/rewards", { ...options, token })
  return {
    points: number(data?.daily_checkin_points),
    enabled: data?.daily_checkin_enabled === true,
    claimedToday: data?.claimed_today === true,
  }
}

/** `POST /rewards/daily-checkins` — the claim itself. */
export async function claimDailyCheckin(token, options = {}) {
  return await consoleRequest("/rewards/daily-checkins", {
    ...options,
    token,
    method: "POST",
  })
}

/**
 * Pick an inference key out of the console.
 *
 * Keys hang off a project: `GET /projects` → default project, then
 * `GET /projects/{id}/keys`, then reveal the secret of the first active one.
 * The key is only returned in memory.
 */
export async function readConsoleApiKey(token, options = {}) {
  let projects
  try {
    projects = await consoleRequest("/projects", { ...options, token })
  } catch (error) {
    if (error instanceof ConsoleError) return { error: error.message }
    throw error
  }
  const projectList = Array.isArray(projects) ? projects : projects?.list ?? []
  const project = projectList.find((item) => item?.is_default) ?? projectList[0]
  if (!project?.id) return { error: "该账号下还没有项目，无法读取 API Key" }

  const keys = await consoleRequest(
    `/projects/${encodeURIComponent(project.id)}/keys`,
    { ...options, token },
  )
  const rows = Array.isArray(keys) ? keys : keys?.list ?? []
  const active = rows.filter((item) => item?.status === "active" || !item?.status)
  const chosen = active[0] ?? rows[0]
  if (!chosen?.id) return { error: "该账号下还没有 API Key" }

  const secret = await consoleRequest(`/keys/${encodeURIComponent(chosen.id)}/secret`, {
    ...options,
    token,
  })
  const key = text(
    typeof secret === "string" ? secret : secret?.secret ?? secret?.key ?? secret?.api_key,
  )
  if (!key) return { error: "控制台没有返回 API Key 明文" }
  return { key, name: text(chosen.name), projectId: String(project.id) }
}

/** Turn a console failure into the card's `error` / `signIn` pair. */
export function consoleErrorText(error) {
  if (error instanceof ConsoleError) {
    if (error.code === CODE_UNAUTHORIZED) {
      return { error: "控制台登录已过期，请重新「网页登录」", signIn: "expired" }
    }
    if (error.code === CODE_DISABLED) {
      return { error: "控制台账号已被停用", signIn: "expired" }
    }
    return { error: `控制台返回错误：${error.message}` }
  }
  return { error: error?.message ?? String(error) }
}

/** Map `GET /billing/account` onto Magpie's usage shape. */
export function toUsage(account) {
  const balance = Number.isFinite(account?.balance) ? account.balance : 0
  return {
    plan: account?.arrears ? "ModelBest · 欠费" : "ModelBest",
    balance: `${formatPoints(balance)} 积分`,
    windows: [
      {
        name: "积分余额",
        used: 0,
        amount: 0,
        limit: balance,
        unit: "积分",
        display: `可用 ${formatPoints(balance)} 积分`,
      },
    ],
  }
}

export function formatPoints(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "0"
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number)
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value !== "string") return 0
  const parsed = Number(value.replace(/,/g, "").trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
}
