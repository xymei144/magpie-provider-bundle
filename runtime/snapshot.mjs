// A small, secret-free snapshot the page can read.
//
// The page runs in Magpie's sandboxed iframe: no network, no direct host
// access. This module writes a static `page/snapshot.js` beside the page.
// It only keeps provider ids, account counts, quota windows, check-in
// outcomes and a redacted error line. It never writes auth values.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pageDir = join(root, "page")
const snapshotPath = join(pageDir, "snapshot.js")
const snapshotPrefix = "window.__PROVIDER_BUNDLE_SNAPSHOT__ = "
// Errors are only replayed from the saved snapshot when they are this recent.
const RESTORED_ERROR_MAX_MS = 10 * 60 * 1000
const checkinOutcomes = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

const state = { providers: {} }
let flushTimer = null
let metaAt = 0
let metaCache = { keys: [], accounts: {}, labels: {}, checkins: {}, models: {} }

loadStoredState()

function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie")
  return join(homedir(), ".config", "magpie")
}

function readJson(name) {
  try {
    const file = join(configDir(), name)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function storedUsage(value) {
  if (!value || typeof value !== "object") return undefined
  const at = safeText(value.at, 40)
  if (!at || Number.isNaN(Date.parse(at))) return undefined
  return {
    at,
    plan: safeText(value.plan, 80),
    until: safeText(value.until, 40),
    renew: value.renew === "auto" || value.renew === "off" ? value.renew : "",
    balance: number(value.balance),
    error: value.error ? redactError(value.error) : "",
    windows: compactWindows(value),
  }
}

function storedCheckin(value) {
  if (!value || typeof value !== "object") return undefined
  const at = safeText(value.at, 40)
  if (!at || Number.isNaN(Date.parse(at))) return undefined
  return {
    at,
    outcome: checkinOutcomes.includes(value.outcome) ? value.outcome : "failed",
    credit: number(value.credit) ?? 0,
    streak: number(value.streak) ?? 0,
    message: safeText(value.message ?? value.msg, 200),
    until: safeText(value.until, 40),
  }
}

export function parseStoredSnapshot(text) {
  const providers = {}
  if (typeof text !== "string") return providers
  const source = text.trim()
  if (!source.startsWith(snapshotPrefix)) return providers
  let json = source.slice(snapshotPrefix.length).trim()
  if (json.endsWith(";")) json = json.slice(0, -1).trim()
  let saved
  try {
    saved = JSON.parse(json)
  } catch {
    return providers
  }
  if (!saved || typeof saved !== "object") return providers
  if (!saved.providers || typeof saved.providers !== "object") return providers

  for (const [id, value] of Object.entries(saved.providers)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id)) continue
    if (!value || typeof value !== "object") continue
    const slot = { enabled: value.enabled !== false }
    const usage = storedUsage(value.usage)
    if (usage) slot.usage = usage
    if (value.usageAccounts && typeof value.usageAccounts === "object") {
      const accounts = {}
      for (const [label, each] of Object.entries(value.usageAccounts).slice(-16)) {
        const parsed = storedUsage(each)
        const key = safeText(label, 40)
        if (parsed && key && !/^账号 \d+$/.test(key)) accounts[key] = parsed
      }
      if (Object.keys(accounts).length > 0) slot.usageAccounts = accounts
    }
    const checkin = storedCheckin(value.checkin)
    if (checkin) slot.checkin = checkin
    if (typeof value.models === "number" && Number.isFinite(value.models) && value.models >= 0) {
      slot.models = Math.floor(value.models)
    }
    if (value.error && typeof value.error === "object") {
      // An error only outlives the process for a while: the host does not
      // re-ask every provider for its model list each start, so a network
      // blip from yesterday would otherwise stay pinned to the row forever.
      const at = safeText(value.error.at, 40)
      const age = at ? Date.now() - Date.parse(at) : Number.NaN
      if (Number.isFinite(age) && age >= 0 && age <= RESTORED_ERROR_MAX_MS) {
        slot.error = {
          phase: safeText(value.error.phase, 40),
          message: redactError(value.error.message ?? value.error),
          at,
        }
      }
    }
    // Account labels are deliberately refreshed from the current host data.
    // Old snapshots may predate the masking rules, so they are never trusted.
    providers[id] = slot
  }
  return providers
}

function loadStoredState() {
  try {
    if (!existsSync(snapshotPath)) return
    const providers = parseStoredSnapshot(readFileSync(snapshotPath, "utf8"))
    Object.assign(state.providers, providers)
  } catch {
    // A missing or interrupted snapshot only means this process starts empty.
  }
}

// Vendors disagree on the shape of `accounts`: most write an array, Spark and
// a few others write one object. Normalise both without touching any auth
// value; only the public account fields below are ever read.
export function accountsOf(provider) {
  const value = provider?.accounts
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0 ? [value] : []
  }
  return []
}

function refreshMetaCache() {
  metaAt = Date.now()
  const auth = readJson("plugin-auth.json")
  const logins = readJson("logins.json")
  const checkins = readJson("plugin-checkin.json")
  const providerConfigs = readJson("plugin-providers.json")
  const models = {}
  const accounts = {}
  const labels = {}
  const accountBacked = new Set()
  if (Array.isArray(providerConfigs)) {
    for (const provider of providerConfigs) {
      if (typeof provider?.id !== "string") continue
      if (Array.isArray(provider.models)) models[provider.id] = provider.models.length
      const list = accountsOf(provider)
      if (list.length > 0) {
        accounts[provider.id] = list.length
        accountBacked.add(provider.id)
        labels[provider.id] = uniqueLabels(list)
      }
    }
  }
  if (Array.isArray(logins)) {
    for (const login of logins) {
      const agent = safeText(login?.agent, 120)
      if (!agent.startsWith("plugin:")) continue
      const id = agent.slice("plugin:".length)
      if (accountBacked.has(id)) continue
      labels[id] ??= []
      const next = uniqueLabels([...labels[id], login?.user])
      labels[id] = next
    }
  }
  if (auth && typeof auth === "object") {
    for (const [key, value] of Object.entries(auth)) {
      const id = key.split("#")[0]
      if (accountBacked.has(id)) continue
      const entries = [value?.nickname, value?.name, value?.displayName]
      if (entries.some((entry) => safeText(entry))) {
        labels[id] = uniqueLabels([...(labels[id] || []), ...entries])
      }
    }
  }
  metaCache = {
    keys: auth && typeof auth === "object" ? Object.keys(auth) : [],
    accounts,
    labels,
    checkins: checkins && typeof checkins === "object" ? checkins : {},
    models,
  }
}

export function redactError(value) {
  let text = typeof value === "string" ? value : value?.message ?? String(value ?? "")
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(/([?&](?:key|token|access_token|refresh_token|api_key)=)[^&\s]+/gi, "$1***")
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, "***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***")
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "***")
  return text.slice(0, 240)
}

function safeText(value, limit = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

export function accountLabel(value, index = 0) {
  const text = safeText(value, 120)
  if (!text) return `账号 ${index + 1}`
  // Labels the host already masked stay as they are. Re-masking them would
  // turn a useful contact into an anonymous row.
  if (/^\d{3,4}\*{2,}\d{2,4}$/.test(text)) return text
  if (/^[^@\s*][^@\s*]*\*{2,}@[^@\s]+$/.test(text)) return text
  // Magpie's own login hint for a key-only provider.
  const keyHint = text.match(/^api\s*key\s*[.…]+\s*([A-Za-z0-9_-]{2,12})$/i)
  if (keyHint) return `Key •••• ${keyHint[1].slice(-4)}`
  if (/^[^@\s]+@[^@\s]+$/.test(text)) {
    const [local, domain] = text.split("@")
    return `${local.slice(0, 1)}***@${domain}`
  }
  if (/^\+?\d[\d -]{6,}$/.test(text)) {
    const digits = text.replace(/\D/g, "")
    return `${digits.slice(0, 3)}****${digits.slice(-2)}`
  }
  return `账号 ${index + 1}`
}

// A provider account object may carry an API key. Only `type`, `accountId`
// and the short public `hint` are read here; `account.key` is never touched.
export function accountLabelForAccount(account, index = 0) {
  if (!account || typeof account !== "object") return `账号 ${index + 1}`
  const id = account.accountId
  if (typeof id === "string" && id.trim()) return accountLabel(id, index)
  if (typeof id === "number" && Number.isFinite(id)) return accountLabel(String(id), index)
  const type = typeof account.type === "string" ? account.type.toLowerCase() : ""
  const hint = safeText(account.hint, 24)
  if (type === "api" && /^[A-Za-z0-9_-]{2,12}$/.test(hint)) {
    return `Key •••• ${hint.slice(-4)}`
  }
  return `账号 ${index + 1}`
}

function uniqueLabels(values) {
  const labels = []
  const seen = new Set()
  for (const [index, value] of values.entries()) {
    const label =
      value && typeof value === "object"
        ? accountLabelForAccount(value, index)
        : accountLabel(value, index)
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels.slice(0, 8)
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function compactWindows(usage) {
  if (!Array.isArray(usage?.windows)) return []
  return usage.windows.slice(0, 8).map((window) => ({
    name: safeText(window?.name, 80),
    used: number(window?.used),
    display: safeText(window?.display, 140),
    resetsAt: typeof window?.resetsAt === "string" ? window.resetsAt : "",
    amount: number(window?.amount),
    limit: number(window?.limit),
    unit: safeText(window?.unit, 20),
  }))
}

function compactUsage(usage) {
  return {
    at: new Date().toISOString(),
    plan: safeText(usage?.plan, 80),
    until: typeof usage?.until === "string" ? usage.until : "",
    renew: usage?.renew === "auto" || usage?.renew === "off" ? usage.renew : "",
    balance: number(usage?.balance),
    error: usage?.error ? redactError(usage.error) : "",
    windows: compactWindows(usage),
  }
}

function compactCheckin(value) {
  return {
    at: typeof value?.at === "string" ? value.at : new Date().toISOString(),
    outcome: checkinOutcomes.includes(value?.outcome) ? value.outcome : "failed",
    credit: number(value?.credit) ?? 0,
    streak: number(value?.streak) ?? 0,
    // Magpie keeps the vendor's line in `msg`; upstream hooks may say `message`.
    message: safeText(value?.message ?? value?.msg, 200),
    until: typeof value?.until === "string" ? value.until : "",
  }
}

function slotFor(id) {
  if (!state.providers[id]) state.providers[id] = { enabled: true }
  return state.providers[id]
}

export function markDisabled(spec) {
  slotFor(spec.id).enabled = false
  schedule()
}

export function markEnabled(spec) {
  const slot = slotFor(spec.id)
  slot.enabled = true
  // A failed import is repaired by the next successful load. Other phases
  // keep their error until that operation itself succeeds again.
  if (slot.error?.phase === "load") slot.error = undefined
  schedule()
}

function applyMeta(providerIds) {
  for (const id of providerIds) {
    const authAccounts = metaCache.keys.filter((key) => key === id || key.startsWith(id + "#")).length
    const accounts = Math.max(metaCache.accounts[id] ?? 0, authAccounts)
    const slot = slotFor(id)
    slot.accounts = accounts
    slot.signedIn = accounts > 0
    slot.accountLabels = (metaCache.labels[id] || []).slice(0, 8)

    const rows = Object.entries(metaCache.checkins)
      .filter(([key]) => key.startsWith(id + "|"))
      .map(([, value]) => value)
      .filter((value) => value && typeof value === "object")
      .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))
    const lastCheckin = Date.parse(slot.checkin?.at ?? "")
    if (
      rows[0] &&
      (!Number.isFinite(lastCheckin) || Date.parse(rows[0].at ?? "") > lastCheckin)
    ) {
      slot.checkin = compactCheckin(rows[0])
    }
    if (typeof metaCache.models[id] === "number") slot.models = metaCache.models[id]
  }
}

export function recordMeta(providerIds = []) {
  const now = Date.now()
  if (now - metaAt > 10_000) refreshMetaCache()
  applyMeta(providerIds)
  schedule()
}

export function recordUsage(spec, usage, account = "") {
  const slot = slotFor(spec.id)
  const compact = compactUsage(usage)
  slot.usage = compact
  // Magpie asks for usage once per account. Keep each account's answer so the
  // overview can total them when collapsed and break them down when opened.
  const label = safeText(account, 40)
  if (label && !/^账号 \d+$/.test(label)) {
    const kept = { ...(slot.usageAccounts || {}), [label]: compact }
    slot.usageAccounts = Object.fromEntries(Object.entries(kept).slice(-16))
  }
  // Only the phase that just succeeded may clear the error: a daily check-in
  // must not hide a quota read that is still failing (and the reverse).
  if (slot.error?.phase === "usage") slot.error = undefined
  schedule()
}

export function recordCheckin(spec, value) {
  const slot = slotFor(spec.id)
  slot.checkin = compactCheckin(value)
  if (slot.error?.phase === "check-in") slot.error = undefined
  schedule()
}

export function recordModels(spec, value) {
  const models = Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : null
  if (models) {
    const slot = slotFor(spec.id)
    slot.models = models.length
    if (slot.error?.phase === "models") slot.error = undefined
  }
  schedule()
}

export function recordError(spec, phase, error) {
  slotFor(spec.id).error = {
    phase: String(phase ?? "").slice(0, 40),
    message: redactError(error),
    at: new Date().toISOString(),
  }
  schedule()
}

function schedule() {
  if (flushTimer) return
  flushTimer = setTimeout(flush, 300)
  flushTimer.unref?.()
}

function flush() {
  flushTimer = null
  try {
    refreshMetaCache()
    applyMeta(Object.keys(state.providers))
    mkdirSync(pageDir, { recursive: true })
    const text = `window.__PROVIDER_BUNDLE_SNAPSHOT__ = ${JSON.stringify({
      at: new Date().toISOString(),
      providers: state.providers,
    })};\n`
    const tmp = snapshotPath + ".tmp"
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, snapshotPath)
  } catch {
    // A read-only install still works; the page just keeps its last snapshot.
  }
}
