// Provider overview page.
//
// One row per provider: identity, quota headline, check-in state, switch.
// Everything that does not fit on one line (quota windows, the vendor's error
// text, accounts, login methods) lives in the row's detail, opened on click.
// The page reads only the static catalog and the runtime's snapshot; it never
// fetches, never touches a key and never signs in or out.

const catalog = window.__PROVIDER_BUNDLE_CATALOG__ || []
const providers = catalog.filter((entry) => entry.kind !== "tools")
const tools = catalog.filter((entry) => entry.kind === "tools")

const STATUS_FILTERS = [
  ["all", "全部"],
  ["signed", "已登录"],
  ["waiting", "未登录"],
  ["error", "异常"],
  ["disabled", "已停用"],
]

const CHECKIN = {
  claimed: ["已领取", "ok"],
  done: ["已签到", "ok"],
  inactive: ["无需签到", "muted"],
  ineligible: ["暂不可参与", "muted"],
  captcha: ["待验证", "warn"],
  failed: ["签到失败", "bad"],
}

const LOGIN = {
  web: ["网页登录", "网页"],
  desktop: ["桌面登录态", "桌面"],
  key: ["API Key / Token", "Key"],
  public: ["免密访问", "免密"],
}

const ERROR_PHASE = {
  usage: "额度",
  "check-in": "签到",
  models: "模型",
  load: "加载",
}

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.1L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CLOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M12 8.4V12l2.3 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

let activeStatus = "signed"
let query = ""
let sortKey = "default"
let sortDesc = false
let refreshTimer = null
let toastTimer = null
let bridgeOnline = false
let pluginOptions = {}
const opened = new Set()
// The switch the user just flipped. The runtime only reads the option when
// the plugin starts, so the page keeps the user's choice until the snapshot
// carries it.
const pendingEnabled = new Map()

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function snapshot() {
  return window.__PROVIDER_BUNDLE_SNAPSHOT__ || { at: "", providers: {} }
}

function slot(id) {
  if (typeof id !== "string") return {}
  const all = snapshot().providers || {}
  return all[id] || {}
}

function setText(id, value) {
  const node = document.getElementById(id)
  if (node) node.textContent = String(value)
}

function isToday(value) {
  if (!value) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

function timeText(value, withDate = false) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (!withDate) return hm
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hm}`
}

// A window keeps the name its vendor gave it in the data; the two English
// names WorkBuddy and MiniMax Code give their plan credits read in Chinese
// here, and everything else goes out as the vendor spelled it.
const WINDOW_NAME_ZH = {
  credits: "基础额度",
  "extra credits": "额外额度",
}

function windowNameOf(window) {
  const raw = String(window?.name ?? "").trim()
  if (!raw) return "额度"
  return WINDOW_NAME_ZH[raw.toLowerCase()] ?? raw
}

function loginMethodsOf(entry) {
  if (!Array.isArray(entry.login)) return []
  return entry.login.filter((kind) => Array.isArray(LOGIN[kind]))
}

function markOf(entry) {
  if (entry.mark) return entry.mark
  const label = String(entry.label || entry.id || "?").trim()
  return label.slice(0, label.length > 1 ? 2 : 1)
}

function createMark(entry) {
  const node = el("span", "mark")
  const fallback = markOf(entry)
  if (entry.icon) {
    const image = document.createElement("img")
    image.src = entry.icon
    image.alt = ""
    image.decoding = "async"
    image.loading = "lazy"
    image.draggable = false
    image.addEventListener(
      "error",
      () => {
        image.remove()
        node.textContent = fallback
      },
      { once: true },
    )
    node.append(image)
  } else {
    node.textContent = fallback
  }
  return node
}

// A quota error is a window that only carries the vendor's failure line; it
// must never be mistaken for a real quota.
function isQuotaError(window) {
  const text = `${window?.name || ""} ${window?.display || ""}`
  return /查询失败|读取失败|额度失败|未登录|登录已过期|重新登录|NOT_LOGIN|不可用|unavailable|has ended|never started/i.test(
    text,
  )
}

// A balance is money left over, not a quota window: there is no scale to
// draw a meter against, so the page shows the number instead of a bar.
function isBalanceWindow(window) {
  if (typeof window?.balance !== "number" || !Number.isFinite(window.balance)) return false
  const hasAmount = typeof window.amount === "number" && Number.isFinite(window.amount)
  const hasLimit = typeof window.limit === "number" && Number.isFinite(window.limit)
  return !hasAmount && !hasLimit
}

function windowValue(window) {
  if (isBalanceWindow(window)) {
    return `余额 ${compactNumber(window.balance)}${window.unit ? ` ${window.unit}` : ""}`
  }
  if (typeof window?.display === "string" && window.display.trim()) return window.display.trim()
  if (typeof window?.used === "number" && Number.isFinite(window.used)) {
    return `${Math.round(window.used)}%`
  }
  if (typeof window?.amount === "number" && Number.isFinite(window.amount)) {
    return `${window.amount}${window.unit || ""}`
  }
  return "—"
}

function quotaWindowsOf(item) {
  const windows = Array.isArray(item.usage?.windows) ? item.usage.windows : []
  const healthy = windows.filter((window) => !isQuotaError(window))
  return { windows, healthy, primary: healthy[0] || null }
}

// The switch is the user's intent; the snapshot only catches up after the
// plugin restarts. Until then the pending value wins. The badge and the
// filters keep following the snapshot: a row must not disappear from the
// list because the user just flipped its switch.
function enabledOf(entry, item) {
  const pending = pendingEnabled.get(entry.id)
  if (typeof pending === "boolean") return pending
  return item.enabled !== false
}

// Once the snapshot carries the switch's new state the change has taken
// effect and the "待生效" marker can go away.
function clearAppliedPending() {
  for (const [id, value] of pendingEnabled) {
    const item = slot(id)
    if (typeof item.enabled === "boolean" && item.enabled === value) {
      pendingEnabled.delete(id)
    }
  }
}

// The badge only says whether the provider is usable. Which phase failed is
// named in the row's detail, so one vendor is not labelled twice.
//
// The order is fixed: a provider that is not logged in is 未登录, not 异常,
// even when its quota window carries the vendor's "not logged in" line.
function issueOf(entry, item) {
  if (item.usage?.signIn === "expired") {
    return {
      id: entry.id,
      label: entry.label || entry.id,
      kind: "signin",
      badge: "登录已过期",
      phase: "登录",
      message: "登录已过期，请重新登录",
    }
  }
  if (item.signedIn === false) {
    return {
      id: entry.id,
      label: entry.label || entry.id,
      kind: "signin",
      badge: "未登录",
      phase: "登录",
      message: "未登录",
    }
  }
  const error =
    item.error || (item.usage?.error ? { phase: "usage", message: item.usage.error } : null)
  if (error) {
    return {
      id: entry.id,
      label: entry.label || entry.id,
      kind: "error",
      badge: "异常",
      phase: ERROR_PHASE[error.phase] || "读取",
      message: error.message || "未知错误",
    }
  }
  // Vendors that answer with an error line instead of a window look signed in
  // but cannot report a quota, so they are an issue too, not a healthy row.
  if (entry.usage !== false && item.enabled !== false) {
    const windows = Array.isArray(item.usage?.windows) ? item.usage.windows : []
    if (windows.length > 0 && windows.every((window) => isQuotaError(window))) {
      return {
        id: entry.id,
        label: entry.label || entry.id,
        kind: "error",
        badge: "异常",
        phase: ERROR_PHASE.usage,
        message:
          windows[0]?.display ||
          (windows[0]?.name ? windowNameOf(windows[0]) : "额度读取失败"),
      }
    }
  }
  return null
}

// The badge names the state the row is in right now, so it follows the
// pending switch: a provider the user just turned off reads 已停用 right
// away instead of contradicting its own switch. The filters and the counters
// keep reading the snapshot, so the row does not vanish from the list.
function statusOf(entry, item) {
  const pending = pendingEnabled.has(entry.id)
  if (!enabledOf(entry, item)) return [pending ? "已停用（待生效）" : "已停用", "off"]
  const issue = issueOf(entry, item)
  if (issue) {
    if (issue.kind === "signin") return [issue.badge, "warn"]
    return [issue.badge, "bad"]
  }
  if (item.signedIn) return ["已登录", "ok"]
  return ["待登录", "warn"]
}

function statusKeyOf(entry, item) {
  if (item.enabled === false) return "disabled"
  const issue = issueOf(entry, item)
  // A provider that is not logged in belongs to 未登录, not to 异常.
  if (issue) return issue.kind === "signin" ? "waiting" : "error"
  return item.signedIn ? "signed" : "waiting"
}

function accountLabelsOf(item) {
  if (!Array.isArray(item.accountLabels)) return []
  return item.accountLabels
    .filter((label) => typeof label === "string" && label.trim())
    .map((label) => label.trim())
    .slice(0, 8)
}

function modelCount(entry, item) {
  if (typeof item.models === "number" && item.models > 0) return item.models
  if (typeof entry.models === "number" && entry.models > 0) return entry.models
  return null
}

function withTimeout(promise, milliseconds, message) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}

function showToast(message, bad = false) {
  const node = document.getElementById("toast")
  if (!node) return
  node.textContent = String(message)
  node.className = `toast show${bad ? " bad" : ""}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.className = "toast"
  }, 3600)
}

// Counts must agree with the badges: a provider with an error is counted as
// 异常, never as 已登录, or the summary and the filter row would disagree.
function summarize() {
  let signedIn = 0
  let waiting = 0
  let accounts = 0
  let checkins = 0
  let disabled = 0
  const issues = []
  for (const entry of providers) {
    const item = slot(entry.id)
    const issue = issueOf(entry, item)
    if (item.enabled === false) {
      disabled += 1
    } else if (issue && issue.kind === "error") {
      issues.push(issue)
    } else if (issue) {
      // Not logged in: counted with 未登录, never with 异常.
      waiting += 1
    } else if (item.signedIn) {
      signedIn += 1
    } else {
      waiting += 1
    }
    if (typeof item.accounts === "number") accounts += item.accounts
    if (
      (item.checkin?.outcome === "claimed" || item.checkin?.outcome === "done") &&
      isToday(item.checkin.at)
    ) {
      checkins += 1
    }
  }
  return {
    total: providers.length,
    signedIn,
    waiting,
    disabled,
    accounts,
    checkins,
    issues,
  }
}

function renderFilters() {
  const box = document.getElementById("filters")
  if (!box) return
  box.replaceChildren()
  for (const [key, label] of STATUS_FILTERS) {
    const count = providers.filter((entry) => {
      const item = slot(entry.id)
      return key === "all" ? true : statusKeyOf(entry, item) === key
    }).length
    const button = el("button", `filter${activeStatus === key ? " active" : ""}`)
    button.type = "button"
    button.dataset.status = key
    button.setAttribute("aria-pressed", activeStatus === key ? "true" : "false")
    button.append(el("span", "", label), el("span", "filter-count", String(count)))
    button.addEventListener("click", () => {
      activeStatus = key
      renderFilters()
      renderList()
    })
    box.append(button)
  }
}

function renderSummary() {
  const summary = summarize()
  setText("statSigned", summary.signedIn)
  setText("statTotal", summary.total)
  setText("statCheckins", summary.checkins)
  setText("statCheckinsTotal", summary.total)
  setText("statErrors", summary.issues.length)
  setText("statAccounts", summary.accounts)

  const errorBtn = document.getElementById("statErrorBtn")
  errorBtn?.classList.toggle("is-hot", summary.issues.length > 0)
  document.getElementById("statSignedBtn")?.classList.toggle("is-on", activeStatus === "signed")
  errorBtn?.classList.toggle("is-on", activeStatus === "error")

  const total = Math.max(1, summary.total)
  const bars = [
    ["barOk", summary.signedIn],
    ["barWarn", summary.waiting],
    ["barErr", summary.issues.length],
    ["barOff", summary.disabled],
  ]
  for (const [id, count] of bars) {
    const node = document.getElementById(id)
    if (!node) continue
    node.style.width = `${(count / total) * 100}%`
    node.hidden = count === 0
  }
}

function renderSnapshotTime() {
  const at = snapshot().at
  const node = document.getElementById("snapAt")
  if (node) node.textContent = at ? `快照 ${timeText(at, true)}` : "暂无快照"
}

// Marvis 的原生组件由 runtime/marvis-native.mjs 在缺失时自动补齐；
// 齐了就不显示，下载中/失败各一行。
const NATIVE_TEXT = {
  downloading: ["正在补齐 Marvis 组件", "muted"],
  missing: ["缺少 Marvis 组件", "warn"],
  error: ["Marvis 组件补齐失败", "bad"],
}

function renderNative() {
  const node = document.getElementById("nativeNote")
  if (!node) return
  const native = snapshot().native
  if (!native || !native.state || native.state === "ok") {
    node.hidden = true
    return
  }
  const [text, tone] = NATIVE_TEXT[native.state] || ["Marvis 组件状态未知", "muted"]
  node.hidden = false
  node.className = `snap update-note is-${tone}`
  node.textContent = text
  node.title = native.message || text
}

function renderClock() {
  const now = new Date()
  const clock = document.getElementById("clock")
  if (clock) {
    clock.textContent = now.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  }
}

function quotaCell(entry, item) {
  const box = el("div", "q")
  if (entry.usage === false) {
    box.append(el("span", "qv mute", "无公开额度"), el("span", "qmore", "接口不提供"))
    return box
  }
  // A signed-out provider has no quota to read: the last error in the
  // snapshot is why it stopped, not a read failing right now.
  const signInIssue = issueOf(entry, item)
  if (signInIssue?.kind === "signin") {
    box.append(el("span", "qv mute", signInIssue.badge))
    return box
  }
  const accounts = usageAccountsOf(item)
  if (accounts.length > 1) {
    const totals = aggregateQuota(accounts)
    const total = totals[0]
    if (total) {
      const { synced, host } = accountsSynced(item, accounts.length)
      if (!total.isBalance) {
        const percent = total.used
        const meter = el("span", `qm${percent >= 95 ? " full" : percent >= 75 ? " hi" : ""}`)
        const fill = el("i")
        fill.style.width = `${percent}%`
        meter.append(fill)
        box.append(meter)
      }
      // Several accounts: the row shows what they hold together — the whole
      // quota, what is used of it, and what is left.
      if (!total.isBalance && Number.isFinite(total.total)) {
        const stack = el("span", "qstack")
        stack.append(el("span", "qv", `总额度 ${quotaNumber(total.total)}`))
        stack.append(
          el("span", "qsub", `已用 ${quotaNumber(total.amount)} · 剩余 ${quotaNumber(total.remaining)}`),
        )
        box.append(stack)
      } else {
        box.append(el("span", "qv", total.display))
      }
      box.append(el("span", "qmore", `已同步 ${synced}/${host}`))
      box.title = [
        `已同步 ${synced}/${host} 个账号`,
        ...totals.map(
          (each) => `${windowNameOf(each)}${each.folded ? "（折叠）" : ""} ${each.display}`,
        ),
        item.usage?.plan,
        "展开看每个账号的额度",
      ]
        .filter(Boolean)
        .join(" · ")
      return box
    }
  }

  const { windows, healthy } = quotaWindowsOf(item)
  const primary = tightestWindow(healthy)
  if (primary) {
    const percent = percentOf(primary)
    if (!isBalanceWindow(primary)) {
      const meter = el("span", `qm${percent >= 95 ? " full" : percent >= 75 ? " hi" : ""}`)
      const fill = el("i")
      fill.style.width = `${percent}%`
      meter.append(fill)
      box.append(meter)
    }
    box.append(el("span", "qv", windowValue(primary)))
    const exhausted = healthy.filter((window) => percentOf(window) >= 100).length
    if (exhausted > 0) {
      box.append(
        el("span", "qmore bad", windows.length > 1 ? `${exhausted}/${windows.length} 用尽` : "已用尽"),
      )
    } else if (windows.length > 1) {
      box.append(el("span", "qmore", `${windows.length} 项`))
    }
    box.title = [
      windowNameOf(primary),
      windowValue(primary),
      windows.length > 1 ? `共 ${windows.length} 个额度窗口` : "",
      item.usage?.plan,
    ]
      .filter(Boolean)
      .join(" · ")
    return box
  }
  if (Boolean(item.usage?.error) || (windows.length > 0 && healthy.length === 0)) {
    box.append(el("span", "qv bad", "读取失败"))
    box.title = item.usage?.error || windows[0]?.display || "额度读取失败"
    return box
  }
  box.append(el("span", "qv mute", "—"), el("span", "qmore", item.usage?.at ? "等待同步" : "未同步"))
  return box
}

// Magpie answers usage per account. When several accounts answered, the row
// totals them and the detail lists each account separately.
function usageAccountsOf(item) {
  const by = item.usageAccounts
  if (!by || typeof by !== "object") return []
  const keys = Object.keys(by)
  if (keys.length === 0) return []
  const known = accountLabelsOf(item)
  const ordered = []
  for (const label of known) {
    if (by[label]) ordered.push({ label, usage: by[label] })
  }
  for (const label of keys) {
    if (!known.includes(label)) ordered.push({ label, usage: by[label] })
  }
  return ordered
}

// How many of the host's accounts answered: synced out of the host's total.
function accountsSynced(item, synced) {
  const host = typeof item.accounts === "number" ? item.accounts : synced
  return { synced, host: Math.max(host, synced) }
}

function compactNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  const round = (n) => String(Math.round(n * 100) / 100)
  const abs = Math.abs(number)
  if (abs >= 1e9) return `${round(number / 1e9)}B`
  if (abs >= 1e6) return `${round(number / 1e6)}M`
  if (abs >= 1e4) return `${round(number / 1e4)} 万`
  return round(number)
}

// Quota totals read better exact: a total of 16885 must not turn into
// "1.69 万" next to a used amount of 8735.
function quotaNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  if (Number.isInteger(number) && Math.abs(number) < 1e6) return String(number)
  return compactNumber(number)
}

// Total quota across accounts: windows with the same name are summed. Only
// windows that all carry numbers can be added; otherwise the meter falls back
// to the mean used percentage, which is still comparable across accounts.
// A window the vendor set aside is not the account's allowance (an estimate,
// a breakdown of another window), so it stays out of the total.
// A window the vendor set aside is not the account's allowance (an
// estimate, a breakdown of another window): it is shown, but it does not go
// into the total.
function isAsideWindow(window) {
  return window?.aside === true || window?.aside === "true"
}

function aggregateQuota(accounts) {
  const groups = new Map()
  for (const { usage } of accounts) {
    for (const window of usage?.windows || []) {
      if (isQuotaError(window)) continue
      const name = window?.name || "额度"
      let group = groups.get(name)
      if (!group) {
        group = {
          name,
          amount: 0,
          limit: 0,
          numeric: 0,
          count: 0,
          aside: 0,
          percent: 0,
          balance: 0,
          balances: 0,
          unit: "",
        }
        groups.set(name, group)
      }
      group.count += 1
      group.percent += percentOf(window)
      if (isAsideWindow(window)) group.aside += 1
      if (isBalanceWindow(window)) {
        group.balance += window.balance
        group.balances += 1
        group.unit = window.unit || group.unit
      } else if (
        Number.isFinite(window?.amount) &&
        Number.isFinite(window?.limit) &&
        window.limit > 0
      ) {
        group.amount += window.amount
        group.limit += window.limit
        group.numeric += 1
        group.unit = window.unit || group.unit
      }
    }
  }
  const totals = []
  for (const group of groups.values()) {
    const folded = group.aside > 0 && group.aside === group.count
    if (group.balances === group.count && group.balances > 0) {
      // Balances add up; there is no percentage to report.
      totals.push({
        name: group.name,
        used: 0,
        isBalance: true,
        folded,
        balance: group.balance,
        unit: group.unit,
        display: `余额 ${compactNumber(group.balance)}${group.unit ? ` ${group.unit}` : ""}`,
      })
      continue
    }
    const numeric = group.numeric === group.count && group.limit > 0
    const used = numeric
      ? Math.max(0, Math.min(100, (group.amount / group.limit) * 100))
      : group.percent / Math.max(1, group.count)
    const remaining = numeric ? Math.max(0, group.limit - group.amount) : undefined
    totals.push({
      name: group.name,
      used,
      isBalance: false,
      folded,
      total: numeric ? group.limit : undefined,
      amount: numeric ? group.amount : undefined,
      remaining,
      unit: group.unit,
      display: numeric
        ? `剩余 ${compactNumber(group.limit - group.amount)} / ${compactNumber(group.limit)}`
        : `剩余 ${Math.max(0, Math.round(100 - used))}%`,
    })
  }
  // The allowance comes first: a folded window is shown, not counted.
  return totals.sort((a, b) => {
    if (a.folded !== b.folded) return a.folded ? 1 : -1
    return b.used - a.used
  })
}

// The row shows the tightest window, not the first one: with several windows
// the one closest to running out is the one worth seeing.
function tightestWindow(windows) {
  let best = null
  for (const window of windows) {
    if (!best || percentOf(window) > percentOf(best)) best = window
  }
  return best
}

function resetText(value) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} 重置`
}

function percentOf(window) {
  if (typeof window?.used === "number" && Number.isFinite(window.used)) {
    return Math.max(0, Math.min(100, window.used))
  }
  if (
    typeof window?.amount === "number" &&
    typeof window?.limit === "number" &&
    window.limit > 0
  ) {
    return Math.max(0, Math.min(100, (window.amount / window.limit) * 100))
  }
  if (typeof window?.display === "string") {
    const match = window.display.match(/(\d+(?:\.\d+)?)\s*%/)
    if (match) return Math.max(0, Math.min(100, Number(match[1])))
  }
  return 0
}

function checkinCell(entry, item) {
  const box = el("div", "ci")
  if (entry.checkin === false) {
    box.className = "ci muted"
    box.append(el("span", "", "无需签到"))
    return box
  }
  const value = item.checkin
  if (!value || typeof value !== "object") {
    box.className = "ci muted"
    box.append(el("span", "", "待记录"))
    return box
  }
  const [label, tone] = CHECKIN[value.outcome] || ["待记录", "muted"]
  box.className = `ci ${tone === "muted" ? "muted" : tone}`
  box.append(el("span", "", label))
  if (!isToday(value.at)) {
    const at = timeText(value.at, true)
    if (at) box.append(el("span", "qmore", at))
  }
  if (value.message) box.title = value.message
  return box
}

function createSwitch(entry, item, onChanged) {
  const label = el("label", "switch")
  const input = document.createElement("input")
  input.type = "checkbox"
  input.checked = enabledOf(entry, item)
  input.setAttribute("aria-label", `${entry.label || entry.id} 启用`)
  const track = el("span", "switch-track")
  track.append(el("span", "switch-knob"))
  const sync = () => {
    const state = input.checked ? "已启用" : "已停用"
    const pending = pendingEnabled.has(entry.id)
    label.classList.toggle("is-pending", pending)
    label.title = `${entry.label || entry.id} ${state}${pending ? "，待生效" : ""}。只控制供应商是否在 Magpie 中启用。`
  }
  sync()
  label.append(input, track)
  label.addEventListener("click", (event) => event.stopPropagation())
  input.addEventListener("change", async () => {
    input.disabled = true
    try {
      await saveProvider(entry.id, input.checked)
      // The runtime only reads the option on the next start, so the page keeps
      // the user's choice instead of following the stale snapshot back.
      pendingEnabled.set(entry.id, input.checked)
      sync()
      onChanged()
      showToast(
        input.checked
          ? `${entry.label || entry.id} 已启用，关开插件后生效`
          : `${entry.label || entry.id} 已停用，关开插件后生效`,
      )
    } catch (error) {
      input.checked = enabledOf(entry, item)
      sync()
      showToast(`保存失败：${String(error?.message ?? error)}`, true)
    } finally {
      input.disabled = false
    }
  })
  return label
}

function detailSection(title) {
  const box = el("div", "detail-col")
  if (title) box.append(el("h4", "", title))
  return box
}

function kvRow(label, value, tone) {
  const row = el("div", "kv")
  row.append(el("span", "", label), el("b", tone ? `val ${tone}` : "val", String(value)))
  return row
}

// One quota window: name, its own meter, the vendor's number, reset date.
function createWindowRow(window) {
  const row = el("div", "wrow")
  const bad = isQuotaError(window)
  const balance = isBalanceWindow(window)
  const name = el("span", "wname", windowNameOf(window))
  name.title = windowNameOf(window)
  row.append(name)

  const percent = percentOf(window)
  const meter = el("span", `wmeter${balance ? " flat" : percent >= 95 ? " full" : percent >= 75 ? " hi" : ""}`)
  if (!bad && !balance) {
    const fill = el("i")
    fill.style.width = `${percent}%`
    meter.append(fill)
  }
  row.append(meter)

  const value = el("span", bad ? "wval bad" : "wval", windowValue(window))
  value.title = windowValue(window)
  row.append(value)

  const reset = resetText(window?.resetsAt)
  row.append(el("span", "wreset", bad ? "" : reset))
  return row
}

function createAccountRow(label, index) {
  const row = el("div", "acct")
  // "账号 2" is a placeholder the runtime makes when the account has no id or
  // hint; say so plainly instead of repeating the row number as a name.
  const unnamed = /^账号\s*\d+$/.test(label)
  row.append(
    el("span", "acct-n", String(index + 1)),
    el("span", unnamed ? "acct-l muted" : "acct-l", unnamed ? "未命名账号" : label),
  )
  row.title = unnamed ? `第 ${index + 1} 个账号，未提供邮箱或备注` : label
  return row
}

function createDetail(entry, item) {
  const box = el("div", "detail")
  box.id = `detail-${entry.id}`

  const quota = detailSection("额度")
  const quotaIssue = issueOf(entry, item)
  if (entry.usage === false) {
    quota.append(el("span", "empty-line", "该供应商不提供公开额度接口"))
  } else if (quotaIssue?.kind === "signin") {
    quota.append(
      el("span", "empty-line", item.signedIn === false ? "未登录，不读取额度" : "登录已过期，不读取额度"),
    )
  } else {
    const { windows } = quotaWindowsOf(item)
    const accounts = usageAccountsOf(item)
    const head = []
    if (item.usage?.plan) head.push(`计划 ${item.usage.plan}`)
    if (accounts.length > 1) {
      const { synced, host } = accountsSynced(item, accounts.length)
      head.push(`已同步 ${synced}/${host} 个账号`)
      const total = aggregateQuota(accounts)[0]
      if (total && !total.isBalance && Number.isFinite(total.total)) {
        head.push(
          `总额度 ${quotaNumber(total.total)} · 已用 ${quotaNumber(total.amount)} · 剩余 ${quotaNumber(total.remaining)}`,
        )
      }
    } else if (windows.length > 1) head.push(`${windows.length} 个窗口`)
    if (head.length > 0) quota.append(el("div", "quota-head", head.join(" · ")))

    if (accounts.length > 1) {
      const groups = el("div", "waccounts")
      for (const account of accounts) {
        const own = Array.isArray(account.usage?.windows) ? account.usage.windows : []
        const group = el("div", "wgroup")
        const title = el("div", "wacct")
        title.append(
          el("span", "wacct-name", account.label),
          el("span", "wacct-note", own.length > 0 ? `${own.length} 个窗口` : "未同步"),
        )
        group.append(title)
        if (own.length > 0) {
          const rows = el("div", "wlist")
          for (const window of own.slice(0, 5)) rows.append(createWindowRow(window))
          group.append(rows)
          if (own.length > 5) {
            group.append(el("span", "empty-line", `另有 ${own.length - 5} 个窗口`))
          }
        }
        groups.append(group)
      }
      quota.append(groups)
      const missing = accountLabelsOf(item).filter(
        (label) => !accounts.some((account) => account.label === label),
      ).length
      if (missing > 0) {
        quota.append(el("span", "empty-line", `另有 ${missing} 个账号未同步额度`))
      }
    } else {
      if (windows.length === 0) {
        quota.append(el("span", "empty-line", item.usage?.at ? "等待首次同步" : "尚未同步额度"))
      }
      if (windows.length > 0) {
        const list = el("div", "wlist")
        for (const window of windows.slice(0, 8)) list.append(createWindowRow(window))
        quota.append(list)
      }
      if (windows.length > 8) {
        quota.append(el("span", "empty-line", `另有 ${windows.length - 8} 个窗口未列出`))
      }
    }
    if (item.usage?.error) quota.append(el("div", "err", item.usage.error))
  }

  const state = detailSection("状态")
  const issue = issueOf(entry, item)
  if (issue) {
    const row = el("div", "kv")
    row.append(el("span", "", "失败阶段"), el("b", "phase", issue.phase))
    state.append(row, el("div", "err", issue.message))
  } else {
    state.append(kvRow("当前", statusOf(entry, item)[0]))
  }

  const accounts = accountLabelsOf(item)
  const who = detailSection("账号")
  const total = typeof item.accounts === "number" ? item.accounts : accounts.length
  if (accounts.length === 0) {
    who.append(el("span", "empty-line", item.signedIn ? "已登录，账号信息待同步" : "尚未绑定账号"))
  } else {
    who.querySelector("h4")?.append(el("span", "hd-note", `共 ${Math.max(total, accounts.length)} 个`))
    const list = el("div", "acct-list")
    accounts.forEach((label, index) => list.append(createAccountRow(label, index)))
    who.append(list)
    if (total > accounts.length) {
      who.append(el("span", "empty-line", `另有 ${total - accounts.length} 个账号未列出`))
    }
  }
  const methods = loginMethodsOf(entry)
  if (methods.length > 0) {
    who.append(
      el("div", "acct-meta", `登录方式 · ${methods.map((kind) => LOGIN[kind][1]).join(" / ")}`),
    )
  }

  const last = item.checkin
  if (entry.checkin !== false && last && typeof last === "object") {
    const [label] = CHECKIN[last.outcome] || ["待记录", "muted"]
    const when = timeText(last.at, true)
    state.append(kvRow("签到", when ? `${label} · ${when}` : label))
  }

  box.append(quota, state, who)
  box.addEventListener("click", (event) => event.stopPropagation())
  return box
}

function createRow(entry) {
  const item = slot(entry.id)
  const wrap = el("div", "row-wrap")
  const row = el("div", "row")
  const isOpen = opened.has(entry.id)
  if (isOpen) row.classList.add("is-open")
  row.tabIndex = 0
  row.setAttribute("role", "button")
  row.setAttribute("aria-expanded", isOpen ? "true" : "false")
  if (isOpen) row.setAttribute("aria-controls", `detail-${entry.id}`)

  const who = el("div", "who")
  const [statusText, tone] = statusOf(entry, item)
  const head = el("div", "who-head")
  head.append(el("span", "nm", entry.label || entry.id))
  const badge = el("span", `st ${tone}`)
  badge.append(el("i"), el("span", "", statusText))
  head.append(badge)
  if (pendingEnabled.has(entry.id)) head.append(el("span", "pending-tag", "待生效"))

  const meta = el("div", "meta")
  const bits = []
  if (typeof item.accounts === "number" && item.accounts > 0) bits.push(`${item.accounts} 账户`)
  else if (item.signedIn) bits.push("账户已登记")
  const models = modelCount(entry, item)
  if (models) bits.push(`${models} 模型`)
  if (bits.length === 0) bits.push(entry.id)
  meta.append(el("span", "", bits.join(" · ")))

  who.append(createMark(entry), el("span", "who-copy", ""))
  who.lastChild.append(head, meta)

  row.append(who, quotaCell(entry, item), checkinCell(entry, item))
  row.append(createSwitch(entry, item, () => renderAll()))

  const toggle = () => {
    if (opened.has(entry.id)) opened.delete(entry.id)
    else opened.add(entry.id)
    renderList()
  }
  row.addEventListener("click", toggle)
  row.addEventListener("keydown", (event) => {
    // Space on the switch belongs to the switch, not to the row.
    if (event.target instanceof HTMLInputElement) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      toggle()
    }
  })

  wrap.append(row)
  if (isOpen) wrap.append(createDetail(entry, item))
  return wrap
}

function matches(entry) {
  const item = slot(entry.id)
  if (activeStatus !== "all" && statusKeyOf(entry, item) !== activeStatus) return false
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const { windows } = quotaWindowsOf(item)
  const haystack = [
    entry.label,
    entry.id,
    entry.mark,
    entry.group,
    item.usage?.plan,
    item.error?.message,
    item.usage?.error,
    ...accountLabelsOf(item),
    ...loginMethodsOf(entry).flatMap((kind) => LOGIN[kind]),
    ...windows.flatMap((window) => [window?.name, windowNameOf(window)]),
  ]
  return haystack
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle))
}

// ---- sorting -------------------------------------------------------------

const STATUS_RANK = { error: 0, waiting: 1, signed: 2, disabled: 3 }
const SORT_DEFAULT_DESC = { status: false, checkin: false, name: false, quota: true, default: false }

function quotaScore(entry, item) {
  if (entry.usage === false) return null
  const accounts = usageAccountsOf(item)
  if (accounts.length > 1) {
    const total = aggregateQuota(accounts)[0]
    return total ? total.used : null
  }
  const primary = tightestWindow(quotaWindowsOf(item).healthy)
  return primary ? percentOf(primary) : null
}

// 0 = still owes today's check-in, 1 = nothing to do, 2 = already done.
function checkinRank(entry, item) {
  if (entry.checkin === false) return 1
  const checkin = item.checkin
  if (checkin && typeof checkin === "object") {
    if (checkin.outcome === "inactive" || checkin.outcome === "ineligible") return 1
    if ((checkin.outcome === "claimed" || checkin.outcome === "done") && isToday(checkin.at)) return 2
  }
  return 0
}

function catalogOrder(entry) {
  return typeof entry.order === "number" ? entry.order : 0
}

function compareEntries(a, b) {
  const fallback = catalogOrder(a) - catalogOrder(b)
  const direction = sortDesc ? -1 : 1

  if (sortKey === "status") {
    const left = STATUS_RANK[statusKeyOf(a, slot(a.id))] ?? 9
    const right = STATUS_RANK[statusKeyOf(b, slot(b.id))] ?? 9
    return (left - right) * direction || fallback
  }

  if (sortKey === "quota") {
    const left = quotaScore(a, slot(a.id))
    const right = quotaScore(b, slot(b.id))
    // Providers with no usable quota stay at the end either way.
    if (left === null && right === null) return fallback
    if (left === null) return 1
    if (right === null) return -1
    return (right - left) * direction || fallback
  }

  if (sortKey === "checkin") {
    return (checkinRank(a, slot(a.id)) - checkinRank(b, slot(b.id))) * direction || fallback
  }

  if (sortKey === "name") {
    return (
      String(a.label || a.id).localeCompare(String(b.label || b.id), "zh-Hans-CN") * direction ||
      fallback
    )
  }

  return fallback
}

function renderList() {
  const box = document.getElementById("grid")
  const empty = document.getElementById("empty")
  if (!box) return
  const visible = providers.filter(matches).slice().sort(compareEntries)
  box.replaceChildren(...visible.map(createRow))
  setText("visibleCount", visible.length)
  if (empty) empty.hidden = visible.length > 0
}

function renderTools() {
  const section = document.getElementById("toolsSection")
  const box = document.getElementById("tools")
  if (!box || !section) return
  section.hidden = tools.length === 0
  setText("toolCount", String(tools.length))
  box.replaceChildren()
  for (const entry of tools) {
    const item = slot(entry.id)
    const row = el("div", "tool-row")
    row.append(createMark(entry))
    const copy = el("div", "who-copy")
    copy.append(el("span", "nm", entry.label || entry.id))
    const parts = [entry.id]
    const models = modelCount(entry, item)
    if (models) parts.push(`${models} 个模型`)
    if (item.error?.message) parts.push(item.error.message)
    if (pendingEnabled.has(entry.id)) parts.push("待生效")
    copy.append(el("span", "meta", parts.join(" · ")))
    row.append(copy)
    row.append(el("span", `st ${item.error ? "bad" : "off"}`, item.error ? "异常" : "随插件启用"))
    row.append(createSwitch(entry, item, () => renderAll()))
    box.append(row)
  }
}

function renderAll() {
  clearAppliedPending()
  renderSummary()
  renderFilters()
  renderList()
  renderTools()
  renderSnapshotTime()
  renderNative()
  renderClock()
}

function reloadSnapshot() {
  const old = document.getElementById("snapDynamic")
  if (old) old.remove()
  const script = document.createElement("script")
  script.id = "snapDynamic"
  script.src = `.data/snapshot.js?v=${Date.now()}`
  script.onload = renderAll
  script.onerror = renderAll
  document.head.append(script)
}

function armRefresh(seconds) {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = seconds > 0 ? setInterval(reloadSnapshot, seconds * 1000) : null
}

// The only place plugin options are written: read the latest options, mutate
// a draft in place and write it back. Writing from the options read at start
// would drop whatever the user changed in the meantime.
async function saveOptions(mutate) {
  if (!bridgeOnline || typeof magpie === "undefined" || !magpie.options) {
    throw new Error("页面桥未就绪，无法保存")
  }
  const current = (await magpie.options.get()) || {}
  const draft = { ...current }
  mutate(draft)
  await magpie.options.set(draft)
  pluginOptions = draft
  return draft
}

async function saveProvider(id, enabled) {
  await saveOptions((draft) => {
    draft.providers = { ...(draft.providers || {}), [id]: enabled }
  })
}

function bindSearch() {
  const input = document.getElementById("search")
  if (!input) return
  input.addEventListener("input", () => {
    query = input.value
    renderList()
  })
  document.addEventListener("keydown", (event) => {
    const target = event.target
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      input.focus()
      input.select()
    }
    if (event.key === "Escape" && document.activeElement === input && input.value) {
      input.value = ""
      query = ""
      renderList()
    }
  })
}

function bindSummary() {
  document.getElementById("statSignedBtn")?.addEventListener("click", () => {
    activeStatus = activeStatus === "signed" ? "all" : "signed"
    renderSummary()
    renderFilters()
    renderList()
  })
  document.getElementById("statErrorBtn")?.addEventListener("click", () => {
    activeStatus = activeStatus === "error" ? "all" : "error"
    renderSummary()
    renderFilters()
    renderList()
  })
  const sortBy = document.getElementById("sortBy")
  const sortDir = document.getElementById("sortDir")
  const syncDir = () => {
    if (!sortDir) return
    const arrow = sortDir.querySelector("span")
    if (arrow) arrow.textContent = sortDesc ? "↓" : "↑"
    sortDir.setAttribute("aria-pressed", sortDesc ? "true" : "false")
    sortDir.disabled = sortKey === "default"
    sortDir.title = sortDesc ? "当前降序，点击切换升序" : "当前升序，点击切换降序"
  }
  sortBy?.addEventListener("change", () => {
    sortKey = sortBy.value
    sortDesc = SORT_DEFAULT_DESC[sortKey] ?? false
    syncDir()
    renderList()
  })
  sortDir?.addEventListener("click", () => {
    sortDesc = !sortDesc
    syncDir()
    renderList()
  })
  syncDir()
}

function bindRefresh() {
  const button = document.getElementById("refreshBtn")
  if (!button) return
  button.addEventListener("click", () => {
    reloadSnapshot()
    showToast("已请求最新快照")
  })
}

/* ---- boot -------------------------------------------------------------- */

async function main() {
  // The note is plain HTML so it survives a page whose assets never arrived;
  // reaching this line means they did.
  document.getElementById("bootNote")?.remove()
  renderClock()
  setInterval(renderClock, 30_000)
  renderAll()
  bindSearch()
  bindSummary()
  bindRefresh()

  if (typeof magpie === "undefined") {
    showToast("页面桥未加载：_magpie/bridge.js 没有生效", true)
    return
  }
  try {
    await withTimeout(
      magpie.ready,
      8_000,
      "页面桥响应超时：Magpie 宿主没有返回主题，已使用本地样式",
    )
    bridgeOnline = true
  } catch (error) {
    showToast(String(error?.message ?? error), true)
    return
  }

  const select = document.getElementById("refreshEvery")
  let initialOptions = {}
  try {
    initialOptions = (await withTimeout(magpie.options?.get?.(), 5_000, "读取插件设置超时")) || {}
  } catch {
    initialOptions = {}
  }
  pluginOptions = initialOptions
  renderAll()
  const saved = Number(initialOptions.pageRefreshSeconds)
  // 0 is the saved "manual" choice; undefined (never set) still means 10s.
  const every = [0, 5, 10, 30, 60].includes(saved) ? saved : 10
  if (select) {
    select.value = String(every)
    select.addEventListener("change", async () => {
      const seconds = Number(select.value)
      try {
        await saveOptions((draft) => {
          draft.pageRefreshSeconds = seconds
        })
      } catch {
        // The timer still works for this session.
      }
      armRefresh(seconds)
      showToast(seconds > 0 ? `快照每 ${seconds} 秒刷新` : "已切换为手动刷新")
    })
  }
  const wake = () => {
    if (document.hidden) return
    reloadSnapshot()
  }
  window.addEventListener("focus", wake)
  document.addEventListener("visibilitychange", wake)
  armRefresh(every)
}

main()
