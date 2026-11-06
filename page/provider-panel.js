// Read-only status panel for Magpie's native provider editor.
//
// The panel is told `{ provider: { id, name } }` through magpie.context. It
// reads only the static catalog and snapshot; it never fetches, never reads
// Magpie options, and never sees a key or token.

const catalog = Array.isArray(window.__PROVIDER_BUNDLE_CATALOG__)
  ? window.__PROVIDER_BUNDLE_CATALOG__
  : []

const CHECKIN = {
  claimed: "今日已领取",
  done: "今日已签到",
  ineligible: "暂不可参与",
  inactive: "无需签到",
  captcha: "等待手动验证",
  failed: "签到失败",
}

const LOGIN = {
  web: "网页登录",
  desktop: "桌面登录态",
  key: "API Key / Token",
  public: "免密访问",
}

function byId(id) {
  return document.getElementById(id)
}

function setText(id, value) {
  const node = byId(id)
  if (node) node.textContent = String(value ?? "")
}

function shown(value) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function snapshot() {
  return window.__PROVIDER_BUNDLE_SNAPSHOT__ || { at: "", providers: {} }
}

function contextProvider() {
  try {
    const provider = window.magpie?.context?.provider
    if (provider && typeof provider.id === "string" && provider.id) return provider
  } catch {
    // Static preview: no bridge, no context.
  }
  return null
}

function entryFor(id) {
  return catalog.find((entry) => entry && entry.id === id) || null
}

function slotFor(id) {
  const providers = snapshot().providers
  const value = providers && typeof providers === "object" ? providers[id] : null
  return value && typeof value === "object" ? value : {}
}

function accountLabelsOf(item) {
  if (!Array.isArray(item.accountLabels)) return []
  return item.accountLabels
    .filter((label) => typeof label === "string" && label.trim())
    .map((label) => label.trim())
    .slice(0, 8)
}

function isQuotaError(window) {
  const text = `${window?.name || ""} ${window?.display || ""}`
  return /查询失败|读取失败|额度失败|未登录|登录已过期|重新登录|NOT_LOGIN|不可用|unavailable|has ended|never started/i.test(
    text,
  )
}

function quotaText(entry, item) {
  if (entry && entry.usage === false) return "无公开额度接口"
  const usage = item.usage || {}
  const windows = Array.isArray(usage.windows) ? usage.windows : []
  const usable = windows.filter((window) => !isQuotaError(window))
  if (usage.error || (windows.length > 0 && usable.length === 0)) return "读取失败"
  if (windows.length === 0) return usage.at ? "等待首次同步" : "—"
  const first = usable[0] || {}
  const value =
    shown(first.display) ||
    (typeof first.used === "number" ? `${Math.round(first.used)}%` : "已同步")
  if (entry?.id === "qiniu" && /未设每日上限|dailyQuota/.test(value)) {
    return `${value} · 总览页设置额度`
  }
  return windows.length > 1 ? `${value} · ${windows.length} 项` : value
}

function checkinText(entry, item) {
  if (entry && entry.checkin === false) return "无需签到"
  const value = item.checkin
  if (!value || typeof value !== "object") return "待记录"
  return CHECKIN[value.outcome] || "待记录"
}

function loginText(entry) {
  if (!entry || !Array.isArray(entry.login) || entry.login.length === 0) return "—"
  return entry.login.map((kind) => LOGIN[kind] || kind).join(" / ")
}

const ERROR_LABEL = {
  usage: "额度异常",
  "check-in": "签到异常",
  models: "模型异常",
  load: "加载异常",
}

function statusOf(item) {
  if (item.enabled === false) return ["已停用", "muted"]
  if (item.error) return [ERROR_LABEL[item.error.phase] || "读取异常", "bad"]
  if (item.signedIn) return ["已登录", "ok"]
  return ["待登录", "warn"]
}

function timeText(value) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`
  return `快照 ${time}`
}

function renderAccounts(item) {
  const box = byId("accounts")
  if (!box) return
  const labels = accountLabelsOf(item)
  box.replaceChildren()
  const signedIn = item.signedIn === true
  setText("accountsLabel", labels.length > 0 ? `已绑定账号 · ${labels.length}` : "已绑定账号")
  if (labels.length === 0) {
    const empty = document.createElement("span")
    empty.className = "empty"
    empty.textContent = signedIn ? "已登录，账号信息待同步" : "尚未绑定账号"
    box.append(empty)
    return
  }
  for (const label of labels.slice(0, 3)) {
    const chip = document.createElement("span")
    chip.className = "chip"
    chip.textContent = label
    chip.title = `已绑定账号：${label}`
    box.append(chip)
  }
  if (labels.length > 3) {
    const extra = labels.length - 3
    const chip = document.createElement("span")
    chip.className = "chip more"
    chip.textContent = `+${extra}`
    chip.title = `另有 ${extra} 个账号：${labels.slice(3).join(" · ")}`
    box.append(chip)
  }
}

function renderConnect(entry) {
  const box = byId("connect")
  if (!box) return
  const rows = [
    ["baseUrl", entry?.baseUrl],
    ["protocol", entry?.protocol],
    ["defaultModel", entry?.defaultModel],
  ]
  let any = false
  for (const [id, value] of rows) {
    const text = shown(value)
    const row = byId(`${id}Row`)
    const cell = byId(id)
    if (row) row.hidden = !text
    if (cell) cell.textContent = text
    if (text) any = true
  }
  box.hidden = !any
}

function nativeHint(entry) {
  const methods = Array.isArray(entry?.login) ? entry.login : []
  const hasKey = methods.includes("key")
  const hasWeb = methods.includes("web") || methods.includes("desktop")
  if (hasKey && !hasWeb) {
    return "Key 模式没有“退出登录”。重设 Key：鼠标移到上方 Key 行，点右侧铅笔图标，粘贴新 Key。只有一个 Key 时 Magpie 不显示“移除”；要彻底删除账号，先添加另一个 Key，再移除旧的。"
  }
  if (hasWeb) {
    return "退出 / 重设：鼠标移到上方账号行，点右侧出现的 … → 移除，再重新点登录。"
  }
  if (hasKey) {
    return "重设 Key：鼠标移到上方 Key 行，点右侧铅笔图标替换；或点账号行右侧操作中的“移除”后重新添加。"
  }
  return "鼠标移到上方账号行，点右侧出现的 … 或行尾操作，选择“移除”，再重新登录或添加凭据。"
}

function render() {
  const provider = contextProvider()
  const entry = provider ? entryFor(provider.id) : null
  const item = provider ? slotFor(provider.id) : {}

  setText("title", entry?.label || provider?.name || "供应商状态")
  setText("providerId", provider?.id || "")
  const idNode = byId("providerId")
  if (idNode) idNode.hidden = !provider?.id

  const [statusText, state] = provider ? statusOf(item) : ["等待供应商信息", "muted"]
  setText("status", statusText)
  const status = byId("status")
  if (status) status.className = `status ${state === "muted" ? "" : state}`.trim()
  const dot = byId("dot")
  if (dot) dot.className = `dot ${state === "muted" ? "" : state}`.trim()

  const count =
    typeof item.models === "number" && item.models >= 0
      ? item.models
      : typeof entry?.models === "number"
        ? entry.models
        : null
  setText("models", count === null ? "—" : `${count} 个`)
  const quota = provider ? quotaText(entry, item) : "—"
  setText("quota", quota)
  const quotaNode = byId("quota")
  if (quotaNode) quotaNode.title = shown(item.usage?.error) || quota
  setText("checkin", provider ? checkinText(entry, item) : "—")
  setText("login", loginText(entry))
  setText("snapAt", timeText(snapshot().at))

  renderAccounts(item)
  renderConnect(entry)
  setText("nativeHint", nativeHint(entry))

  const error = shown(item.error?.message)
  const errorNode = byId("error")
  if (errorNode) {
    errorNode.textContent = error
    errorNode.hidden = !error
  }
}

function reloadSnapshot() {
  const old = document.getElementById("snapDynamic")
  if (old) old.remove()
  const script = document.createElement("script")
  script.id = "snapDynamic"
  script.src = `snapshot.js?v=${Date.now()}`
  script.onload = render
  script.onerror = render
  document.head.append(script)
}

function start() {
  render()
  const bridge = window.magpie
  if (bridge && typeof bridge === "object" && bridge.ready) {
    Promise.resolve(bridge.ready)
      .then(render, render)
      .finally(() => {
        render()
        setInterval(reloadSnapshot, 30_000)
      })
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start)
} else {
  start()
}
