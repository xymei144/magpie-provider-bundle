// A small, secret-free snapshot the page can read.
//
// The page runs in Magpie's sandboxed iframe: no network, no direct host
// access. This module writes a static `page/.data/snapshot.js` beside the page.
// It only keeps provider ids, account counts, quota windows, check-in
// outcomes and a redacted error line. It never writes auth values.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pageDir = join(root, "page")
// A dot-folder on purpose. Magpie decides whether the plugin changed by
// walking the files of a path plugin (names, times, sizes) about once a
// second, and a change retires the plugin host — which closes every
// sign-in in progress ("no such sign-in"). This snapshot is written every
// second or so while providers poll, so it lives where that walk does not
// look: folders starting with "." are skipped. It is still served to the
// page, which asks for it by path.
const snapshotPath = join(pageDir, ".data", "snapshot.js")
const snapshotPrefix = "window.__PROVIDER_BUNDLE_SNAPSHOT__ = "
// Errors are only replayed from the saved snapshot when they are this recent.
const RESTORED_ERROR_MAX_MS = 10 * 60 * 1000
const checkinOutcomes = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

// Plain objects carry `Object.prototype`, so an id like "constructor" would
// read back an inherited function instead of a missing entry.
const state = { providers: Object.create(null), update: null, native: null }
let flushTimer = null
let metaAt = 0
let metaCache = {
  keys: [],
  accounts: Object.create(null),
  labels: Object.create(null),
  identity: Object.create(null),
  labelSets: Object.create(null),
  hostSignedIn: Object.create(null),
  checkins: Object.create(null),
  models: Object.create(null),
}

loadStoredState()

// Where Magpie keeps its own files. Exported for the model-list fallback in
// safe.mjs, which reads the list the host saved last time.
export function hostConfigDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie")
  return join(homedir(), ".config", "magpie")
}

function readJson(name) {
  try {
    const file = join(hostConfigDir(), name)
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
    plan: safeText(redactSecrets(value.plan), 80),
    until: safeText(value.until, 40),
    renew: value.renew === "auto" || value.renew === "off" ? value.renew : "",
    balance: number(value.balance),
    error: value.error ? redactError(value.error) : "",
    signIn: typeof value.signIn === "string" ? safeText(value.signIn, 40) : "",
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
    message: safeText(redactSecrets(value.message ?? value.msg), 200),
    until: safeText(value.until, 40),
  }
}

export function parseStoredSnapshot(text) {
  const providers = Object.create(null)
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
      const accounts = Object.create(null)
      for (const [label, each] of Object.entries(value.usageAccounts).slice(-16)) {
        const parsed = storedUsage(each)
        const key = safeText(label, 40)
        // Older builds numbered unnamed accounts without the space ("账号3"),
        // one row per poll, so a single account showed up as four. Current
        // labels always carry the space; the no-space form is stale data.
        if (!parsed || !key || /^账号\d+$/.test(key)) continue
        accounts[key] = parsed
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

// The host names every account three times over: the auth store holds one
// entry per account, the login list holds one entry per account, and the
// provider list repeats the accounts inside the provider. They are three
// views of the same accounts, so they are joined into one list of slots
// here: one slot per account, never one per source.
function refreshMetaCache() {
  metaAt = Date.now()
  const auth = readJson("plugin-auth.json")
  const logins = readJson("logins.json")
  const checkins = readJson("plugin-checkin.json")
  const providerConfigs = readJson("plugin-providers.json")
  const models = Object.create(null)
  // The host's own answer to "is this provider signed in". The auth store is
  // not the only way in (an API key the host keeps elsewhere counts too), so
  // counting auth slots alone labelled working providers as 未登录.
  const hostSignedIn = Object.create(null)

  // A login names the auth slot it belongs to (`home`); a slot the logins do
  // not name carries the provider id in its own key.
  const loginByHome = new Map()
  if (Array.isArray(logins)) {
    for (const login of logins) {
      const agent = safeText(login?.agent, 120)
      if (!agent.startsWith("plugin:")) continue
      const home = safeText(login?.home, 160)
      if (home && !loginByHome.has(home)) loginByHome.set(home, login)
    }
  }

  const slots = new Map()
  const addSlot = (id, slot) => {
    if (!id) return
    const list = slots.get(id)
    if (list) list.push(slot)
    else slots.set(id, [slot])
  }

  const authEntries = auth && typeof auth === "object" ? Object.entries(auth) : []
  for (const [key, value] of authEntries) {
    const login = loginByHome.get(key) ?? null
    const agent = login ? safeText(login.agent, 120) : ""
    const id = agent.startsWith("plugin:") ? agent.slice("plugin:".length) : key.split("#")[0]
    addSlot(id, { key, auth: value, account: null, login })
  }

  if (Array.isArray(providerConfigs)) {
    for (const provider of providerConfigs) {
      const id = typeof provider?.id === "string" ? provider.id : ""
      if (!id) continue
      if (typeof provider.signedIn === "boolean") hostSignedIn[id] = provider.signedIn
      if (Array.isArray(provider.models)) models[id] = provider.models.length
      const known = new Set((slots.get(id) ?? []).map((slot) => slot.key))
      accountsOf(provider).forEach((account, index) => {
        const key = safeText(account?.key, 160)
        if (key && known.has(key)) return
        // The host repeats the auth slots in its own account list. An account
        // it does not name is one of its own only when it carries a name or
        // a key hint; otherwise it would be counted twice.
        const named = Boolean(safeText(account?.accountId, 120) || safeText(account?.hint, 24))
        if (!named && (slots.get(id) ?? []).length > 0) return
        addSlot(id, {
          key: key || `${id}#${index}`,
          auth: null,
          account,
          login: key ? loginByHome.get(key) ?? null : null,
        })
      })
    }
  }

  const accounts = Object.create(null)
  const labels = Object.create(null)
  const identity = Object.create(null)
  const labelSets = Object.create(null)
  for (const [id, list] of slots) {
    const seen = new Set()
    const slotLabels = []
    const identityMap = new Map()
    const labelSet = new Set()
    let count = 0
    for (const [index, slot] of list.entries()) {
      const key = accountIdentity(slot.auth) || accountIdentity(slot.account)
      // The same account can reach this list twice (an auth slot and the
      // provider's own copy of it): the identity decides, not the position.
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      const label = slotLabel(slot, index)
      slotLabels.push(label)
      labelSet.add(label)
      if (key) identityMap.set(key, label)
      count += 1
    }
    if (count === 0) continue
    accounts[id] = count
    labels[id] = slotLabels.slice(0, 8)
    identity[id] = identityMap
    labelSets[id] = labelSet
  }

  metaCache = {
    keys: authEntries.map(([key]) => key),
    accounts,
    labels,
    identity,
    labelSets,
    hostSignedIn,
    checkins:
      checkins && typeof checkins === "object"
        ? Object.assign(Object.create(null), checkins)
        : Object.create(null),
    models,
  }

  // A provider the host no longer counts as signed in keeps no quota from
  // before. This sweep runs even when the provider itself is not loaded
  // (a signed-out one is not), so its row stops reading 未登录 with the last
  // session's numbers still under it.
  for (const [id, slot] of Object.entries(state.providers)) {
    if (hostSignedIn[id] !== false || accounts[id] > 0) continue
    slot.signedIn = false
    slot.accounts = 0
    slot.accountLabels = []
    clearSignedOutQuota(slot)
  }
}

// One account's label. The host's own name for the account comes first; the
// ordinal is the last resort and says only that there is an account.
function slotLabel(slot, index) {
  if (slot.login) {
    const label = accountLabel(slot.login.user, 0)
    if (label && !isOrdinalLabel(label)) return label
  }
  if (slot.account) {
    const label = accountLabelForAccount(slot.account, 0)
    if (label && !isOrdinalLabel(label)) return label
  }
  const label = readableAccountLabel(slot.auth)
  if (label) return label
  return `账号 ${index + 1}`
}

// "账号 3" is the placeholder for an account nobody named: it must never be
// read as a label of its own. Older builds wrote it without the space.
function isOrdinalLabel(label) {
  return typeof label === "string" && /^账号 ?\d+$/.test(label)
}

// One account's identity, computed the same way from the auth the host
// stored and from the auth the host hands to the usage hook. Both sides
// have to land on the same key, or the overview counts one account twice.
export function accountIdentity(auth) {
  if (!auth || typeof auth !== "object") return ""
  const meta = auth.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  const first = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim()
      if (typeof value === "number" && Number.isFinite(value)) return String(value)
    }
    return ""
  }
  const named = first(
    auth.accountId,
    auth.uid,
    auth.nickname,
    auth.name,
    auth.displayName,
    auth.user,
    auth.email,
    meta.accountId,
    meta.uid,
    meta.email,
    meta.user,
  )
  // A placeholder the host stored but no one can read — WorkBuddy's unnamed
  // slot carries an accountId of control characters — is no name at all: it
  // must not beat the uid or the credential below it.
  if (named && !/^[\s\000-\x1f\x7f]+$/.test(named)) return `id:${named}`
  // A key-only account has nothing but its credential. The hash joins the
  // two sides; the secret itself never leaves this module. The refresh
  // token comes before the access token: the access token rotates, and a
  // rotating identity would make one account look like many. The access
  // token joins in last on purpose: the host's stored auth carries refresh
  // and access together, and an auth the vendor hands back with either
  // field alone must still land on the key the stored one maps to. The
  // refresh hash and the full hash cannot both match, so the hash of the
  // refresh token alone is the key both sides reach.
  const refresh = first(auth.key, auth.refresh, auth.refresh_token)
  const access = first(
    auth.access,
    auth.access_token,
    meta.cookie,
    meta.accessKey,
    meta.secretKey,
    meta.consoleCookie,
  )
  if (refresh) return `h:${createHash("sha256").update(refresh).digest("hex").slice(0, 16)}`
  return access ? `h:${createHash("sha256").update(access).digest("hex").slice(0, 16)}` : ""
}

// The readable name of an account, without the ordinal fallback. A `uid` is
// an internal id, not a name, so it never becomes a label.
function readableAccountLabel(auth) {
  if (!auth || typeof auth !== "object") return ""
  const meta = auth.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  for (const value of [
    auth.accountId,
    auth.nickname,
    auth.name,
    auth.displayName,
    auth.user,
    auth.email,
    meta.email,
    meta.accountId,
  ]) {
    if (typeof value !== "string" || !value.trim()) continue
    const label = accountLabel(value, 0)
    if (label && !isOrdinalLabel(label)) return label
  }
  return ""
}

// The label the host already knows for the account the usage hook was
// called with. Empty when the host names no account.
export function accountLabelForAuth(providerId, auth) {
  const id = typeof providerId === "string" ? providerId : ""
  if (!id) return ""
  const key = accountIdentity(auth)
  const table = metaCache.identity[id]
  if (table && key) {
    const hit = table.get(key)
    if (hit) return hit
  }
  // The host may hand back fewer fields than it stored: the readable name
  // still names the account when the host knows one.
  const label = readableAccountLabel(auth)
  if (label) {
    const known = metaCache.labelSets[id]
    if (known && known.has(label)) return label
  }
  return ""
}

// Masks anything that looks like a secret. It deliberately leaves hosts and
// ports alone: `redactError` adds that rule on top of this one.
export function redactSecrets(text, limit = 240) {
  const source = typeof text === "string" ? text : text == null ? "" : String(text)
  return source
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    // The lookbehind keeps "risk-assessment" and "disk-space" intact: a key
    // never follows a word character.
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "***")
    .replace(/(Basic\s+)[A-Za-z0-9+/=_-]{8,}/gi, "$1***")
    .replace(/([?&](?:key|token|access_token|refresh_token|api_key)=)[^&\s]+/gi, "$1***")
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, "***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***")
    // Digits may be separated by spaces or dashes: "138 0013 8000".
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[\s-]?\d){9}(?!\d)/g, "***")
    .slice(0, limit)
}

export function redactError(value) {
  let text = typeof value === "string" ? value : value?.message ?? String(value ?? "")
  text = redactSecrets(text)
  // The endpoint says more than the page needs; the port included.
  text = text.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:\d{1,5}\b|\[[0-9A-Fa-f:]+\]:\d{1,5}/g,
    "***",
  )
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
  // Magpie's own login hint for a key-only provider. The tail must not
  // contain a dot, or "API key ….com" would read as the key "com".
  const keyHint = text.match(/^api\s*key\s*…+\s*([A-Za-z0-9_-]{2,12})$/i)
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

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function compactWindows(usage) {
  if (!Array.isArray(usage?.windows)) return []
  return usage.windows.slice(0, 8).map((window) => ({
    name: safeText(redactSecrets(window?.name), 80),
    used: number(window?.used),
    display: safeText(redactSecrets(window?.display), 140),
    resetsAt: typeof window?.resetsAt === "string" ? window.resetsAt : "",
    amount: number(window?.amount),
    limit: number(window?.limit),
    unit: safeText(window?.unit, 20),
    // Some vendors only publish a balance. Without these the whole row
    // would read as an empty window.
    balance: number(window?.balance),
    aside: safeText(window?.aside, 80),
    runsOutAt: typeof window?.runsOutAt === "string" ? window.runsOutAt : "",
    runsOut: safeText(window?.runsOut, 80),
  }))
}

export function compactUsage(usage) {
  return {
    at: new Date().toISOString(),
    plan: safeText(redactSecrets(usage?.plan), 80),
    until: typeof usage?.until === "string" ? usage.until : "",
    renew: usage?.renew === "auto" || usage?.renew === "off" ? usage.renew : "",
    balance: number(usage?.balance),
    error: usage?.error ? redactError(usage.error) : "",
    signIn: typeof usage?.signIn === "string" ? safeText(usage.signIn, 40) : "",
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
    message: safeText(redactSecrets(value?.message ?? value?.msg), 200),
    until: typeof value?.until === "string" ? value.until : "",
  }
}

function slotFor(id) {
  if (!state.providers[id]) state.providers[id] = { enabled: true }
  return state.providers[id]
}

// What was read while the provider was signed in is not this provider's
// answer any more: keep the reason it was last asked, drop the quota and the
// check-in so a signed-out row stops showing both.
function clearSignedOutQuota(slot) {
  if (slot.usage) {
    slot.usage = { ...slot.usage, windows: [], balance: undefined, plan: undefined }
  }
  slot.usageAccounts = undefined
  slot.checkin = undefined
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
    const accounts = metaCache.accounts[id] ?? 0
    const slot = slotFor(id)
    const signedIn = accounts > 0 || metaCache.hostSignedIn[id] === true
    slot.accounts = accounts
    slot.signedIn = signedIn
    slot.accountLabels = signedIn ? (metaCache.labels[id] || []).slice(0, 8) : []
    if (!signedIn) clearSignedOutQuota(slot)

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
  if (label) {
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

// What the last git check said, for the page's one-line note. Never carries
// a path or a credential: just the state word and a short message.
export function recordUpdate(value) {
  const state_ = typeof value?.state === "string" ? value.state.slice(0, 20) : "error"
  state.update = {
    state: state_,
    message: safeText(value?.message, 160),
    ...(value?.commit ? { commit: safeText(value.commit, 40) } : {}),
    ...(Number.isFinite(value?.count) ? { count: value.count } : {}),
    at: new Date().toISOString(),
  }
  schedule()
}

// Marvis 的原生组件（三个官方 DLL + 自编桥）齐不齐，给页面一行提示。
export function recordNative(value) {
  const state_ = typeof value?.state === "string" ? value.state.slice(0, 20) : "error"
  state.native = {
    state: state_,
    message: safeText(value?.message, 160),
    at: new Date().toISOString(),
  }
  schedule()
}

// How long the snapshot waits for the next write to settle. Providers poll
// continuously and the page reads the file every 30s, so one write a second
// is plenty; the tests shorten it instead of waiting a second per case.
const FLUSH_MS = (() => {
  const ms = Number(process.env.MAGPIE_SNAPSHOT_FLUSH_MS)
  return Number.isFinite(ms) && ms > 0 ? ms : 1000
})()

function schedule() {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
  flushTimer.unref?.()
}

function flush() {
  flushTimer = null
  try {
    refreshMetaCache()
    applyMeta(Object.keys(state.providers))
    mkdirSync(dirname(snapshotPath), { recursive: true })
    const text = `window.__PROVIDER_BUNDLE_SNAPSHOT__ = ${JSON.stringify({
      at: new Date().toISOString(),
      providers: state.providers,
      ...(state.update ? { update: state.update } : {}),
      ...(state.native ? { native: state.native } : {}),
    })};\n`
    // One temp file per writer: two processes refreshing the snapshot at the
    // same time must not write into the same file.
    const tmp = `${snapshotPath}.${process.pid}.${Date.now()}.tmp` // unique per writer
    try {
      writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 })
      renameSync(tmp, snapshotPath)
    } catch (error) {
      // A failed write would leave the temp file in the page folder, which
      // ships with the plugin.
      try {
        rmSync(tmp, { force: true })
      } catch {
        // The temp file stays; the next flush uses another name anyway.
      }
      throw error
    }
  } catch {
    // A read-only install still works; the page just keeps its last snapshot.
  }
}
