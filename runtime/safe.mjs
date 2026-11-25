// Per-provider isolation around the vendored upstream plugins.
//
// Magpie loads every exported function in one module as one plugin. If any
// function throws while it loads, the whole module is marked failed, so each
// provider gets its own try/catch and timeout here. A broken vendor then
// disappears alone instead of taking the bundle down.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  accountIdentity,
  accountLabelForAuth,
  hostConfigDir,
  markDisabled,
  markEnabled,
  recordCheckin,
  recordError,
  recordMeta,
  recordModels,
  recordUsage,
  redactError,
} from "./snapshot.mjs"
import { ensureMarvisNative } from "./marvis-native.mjs"

const invalidJsonControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

// Magpie gives up on a plugin's model list after 20s and marks the provider
// failed; the vendor fetch can be slower than that on a bad day. Keep the last
// good list so a slow fetch falls back instead of turning into an error.
const MODEL_LIST_TIMEOUT_MS = 18_000
// With a list the host saved last run, the vendor's own read only has to
// beat this to be used: past it the saved list answers and the read goes on
// in the background. CodeArts and OpenCode Zen each hang on one of their
// sources for longer than the host waits, and an "异常" row that stays all
// day is worse than a list one start old.
const MODEL_LIST_SOFT_MS = 4_000
const lastModels = new Map()
let seededModels = false

// The model list the host saved for each provider. Read once, on the first
// models call: a snapshot of Magpie's own plugin-providers.json, never a
// secret (ids, names, context windows).
function knownModels(id) {
  if (!seededModels) {
    seededModels = true
    try {
      const file = join(hostConfigDir(), "plugin-providers.json")
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, "utf8"))
        const list = Array.isArray(saved) ? saved : Object.values(saved ?? {})
        for (const entry of list) {
          const key = typeof entry?.id === "string" ? entry.id : ""
          const models = entry?.models
          if (key && Array.isArray(models) && models.length > 0 && !lastModels.has(key)) {
            lastModels.set(key, models)
          }
        }
      }
    } catch {
      // No saved list only means the vendor's own read is the only answer.
    }
  }
  return lastModels.get(id)
}

// Not unref'd on purpose: the answer to the caller is this timer, and a
// process that let go of it would return nothing at all.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rememberModels(id, value) {
  const models = Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : null
  if (models?.length) lastModels.set(id, value)
  return value
}

function isJsonType(headers) {
  const contentType = headers?.get?.("content-type") ?? ""
  return /(?:^|[+/])json(?:$|[;\s])/i.test(contentType)
}

function looksLikeJson(body) {
  const text = body.trimStart()
  return text.startsWith("{") || text.startsWith("[")
}

export function sanitizeJsonText(body) {
  if (typeof body !== "string") return body
  return body.replace(invalidJsonControl, "")
}

export async function sanitizeFetchRequest(input, init) {
  const source = input instanceof Request ? input : null
  const headers = new Headers(init?.headers ?? source?.headers)

  if (typeof init?.body === "string" && (isJsonType(headers) || looksLikeJson(init.body))) {
    const body = sanitizeJsonText(init.body)
    if (body !== init.body) {
      headers.delete("content-length")
      return { input, init: { ...init, body, headers } }
    }
  }

  if (!source || init?.body != null || !isJsonType(headers)) {
    return { input, init }
  }

  try {
    const body = await source.clone().text()
    const clean = sanitizeJsonText(body)
    if (clean === body) return { input, init }
    headers.delete("content-length")
    return {
      input: new Request(source, { ...(init ?? {}), body: clean, headers }),
      init: undefined,
    }
  } catch {
    return { input, init }
  }
}

function sanitizeLoaderResult(value) {
  if (!value || typeof value !== "object" || typeof value.fetch !== "function") return value
  const original = value.fetch
  return {
    ...value,
    async fetch(input, init) {
      const request = await sanitizeFetchRequest(input, init)
      return original(request.input, request.init)
    },
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

// Magpie calls `usage(getAuth)` once per account; the label lets the snapshot
// keep each account's own answer instead of overwriting the previous one.
// The label has to be the same on every call for the same account: a
// counter would turn one account into a new row on every poll, and the
// overview would then count (and add up) the same quota several times.
// A sign-in the vendor already called expired is not renewed again on the
// next poll: the host asks by the second, and every throw from here turns
// into a "plugin [error]" line and, on some providers, a re-sent refresh
// that the sign-in server answers with 409 (one token, two rotations).
// The host still learns the account is signed out from the first refusal,
// and the provider's own 401 does the rest.
const REFRESH_QUIET_MS = 10 * 60 * 1000
const quietRefresh = new Map()
const refreshing = new Map()

function refreshAccountKey(auth) {
  try {
    return accountIdentity(auth) || "#none"
  } catch {
    return "#none"
  }
}

function isSignedOutError(error) {
  if (!error || typeof error !== "object") return false
  if (error.signIn === "expired") return true
  return /signed out|sign in again|重新登录|登录态过期|登录已?失效/i.test(
    String(error.message ?? error),
  )
}

const unknownAccounts = new Map()

function unknownAccountLabel(providerId, identity) {
  const id = typeof providerId === "string" && providerId ? providerId : ""
  let table = unknownAccounts.get(id)
  if (!table) {
    table = new Map()
    unknownAccounts.set(id, table)
  }
  const key = identity || "#none"
  const hit = table.get(key)
  if (hit) return hit
  // Same spelling as the host-side ordinal ("账号 3"): one format for one
  // account, so a restored row maps onto the label the next poll produces.
  const label = `账号 ${table.size + 1}`
  table.set(key, label)
  return label
}

async function usageAccountOf(spec, getAuth) {
  try {
    const auth = typeof getAuth === "function" ? await getAuth() : undefined
    if (!auth || typeof auth !== "object") return unknownAccountLabel(spec.id, "")
    // The host's own name for this account, when it knows one.
    const known = accountLabelForAuth(spec.id, auth)
    if (known) return known
    // Nobody named this account: fall back to its identity, so the same
    // account keeps the same label from one poll to the next.
    return unknownAccountLabel(spec.id, accountIdentity(auth))
  } catch {
    return unknownAccountLabel(spec.id, "")
  }
}

function instrument(spec, hooks) {
  if (!hooks || typeof hooks !== "object") return {}
  const out = { ...hooks }

  if (hooks.auth && typeof hooks.auth === "object") {
    out.auth = { ...hooks.auth }
    if (spec.icon && !out.auth.icon) out.auth.icon = spec.icon
    if (typeof hooks.auth.loader === "function") {
      const loader = hooks.auth.loader
      out.auth.loader = async (...args) => sanitizeLoaderResult(await loader(...args))
    }
    if (typeof hooks.auth.usage === "function") {
      out.auth.usage = async (...args) => {
        try {
          const value = await withTimeout(
            hooks.auth.usage(...args),
            spec.usageTimeoutMs ?? 25_000,
            `${spec.id} usage`,
          )
          recordUsage(spec, value, await usageAccountOf(spec, args[0]))
          return value
        } catch (error) {
          recordError(spec, "usage", error)
          throw error
        }
      }
    }
    if (typeof hooks.auth.checkin === "function") {
      out.auth.checkin = async (...args) => {
        try {
          const value = await withTimeout(
            hooks.auth.checkin(...args),
            spec.checkinTimeoutMs ?? 35_000,
            `${spec.id} check-in`,
          )
          recordCheckin(spec, value)
          return value
        } catch (error) {
          recordError(spec, "check-in", error)
          return { outcome: "failed", message: redactError(error) }
        }
      }
    }
    if (typeof hooks.auth.refresh === "function") {
      const refresh = hooks.auth.refresh
      out.auth.refresh = async (...args) => {
        const key = refreshAccountKey(args[0])
        const block = quietRefresh.get(key)
        if (block && block.until > Date.now()) return undefined
        if (block) quietRefresh.delete(key)
        const running = refreshing.get(key)
        if (running) return running
        const run = (async () => {
          try {
            return await refresh(...args)
          } catch (error) {
            if (!isSignedOutError(error)) throw error
            // Nothing to renew: answer as a hook with no refresh token does,
            // and keep the vendor from being asked again for a while.
            quietRefresh.set(key, { until: Date.now() + REFRESH_QUIET_MS })
            recordError(spec, "refresh", error)
            return undefined
          } finally {
            refreshing.delete(key)
          }
        })()
        refreshing.set(key, run)
        return run
      }
    }
  }

  if (hooks.provider && typeof hooks.provider.models === "function") {
    out.provider = { ...hooks.provider }
    const models = hooks.provider.models
    out.provider.models = async (...args) => {
      const known = knownModels(spec.id)
      const run = Promise.resolve().then(() => models(...args))
      if (known) {
        const fresh = await Promise.race([
          run.then((value) => ({ value }), () => null),
          delay(MODEL_LIST_SOFT_MS).then(() => null),
        ])
        if (fresh) {
          recordModels(spec, rememberModels(spec.id, fresh.value))
          return fresh.value
        }
        run.then((value) => recordModels(spec, rememberModels(spec.id, value))).catch(() => {})
        recordModels(spec, known)
        return known
      }
      try {
        const value = await withTimeout(
          run,
          spec.modelsTimeoutMs ?? MODEL_LIST_TIMEOUT_MS,
          `${spec.id} models`,
        )
        recordModels(spec, rememberModels(spec.id, value))
        return value
      } catch (error) {
        const cached = lastModels.get(spec.id)
        if (cached) {
          recordModels(spec, cached)
          return cached
        }
        recordError(spec, "models", error)
        throw error
      }
    }
  }

  return out
}

export function defineProvider(spec, load) {
  return async function provider(input = {}, options = {}) {
    recordMeta([spec.id])
    // 每小时至多一次，后台检查插件自身的 git 更新；失败只写进快照。
    void ensureMarvisNative()
    const settings =
      options && typeof options === "object" && !Array.isArray(options) ? options : {}
    // Bundle defaults (a provider's own option defaults) are overridden by
    // whatever the user saved in Magpie's own options store.
    const merged = { ...(spec.options ?? {}), ...settings }
    if (merged.providers?.[spec.id] === false) {
      markDisabled(spec)
      return {}
    }

    let hooks
    try {
      // `load` imports the vendor lazily, so a broken vendor module is a
      // load error for this provider alone instead of a failure of the
      // whole bundle at import time.
      const factory = await withTimeout(
        Promise.resolve().then(load),
        spec.loadTimeoutMs ?? 20_000,
        `${spec.id} import`,
      )
      if (typeof factory !== "function") {
        throw new Error(`${spec.export ?? spec.id} is not a function`)
      }
      hooks = await withTimeout(
        Promise.resolve(factory(input, merged)),
        spec.loadTimeoutMs ?? 20_000,
        `${spec.id} load`,
      )
    } catch (error) {
      recordError(spec, "load", error)
      return {}
    }

    markEnabled(spec)
    return instrument(spec, hooks)
  }
}
