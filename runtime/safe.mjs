// Per-provider isolation around the vendored upstream plugins.
//
// Magpie loads every exported function in one module as one plugin. If any
// function throws while it loads, the whole module is marked failed, so each
// provider gets its own try/catch and timeout here. A broken vendor then
// disappears alone instead of taking the bundle down.

import {
  accountLabel,
  markDisabled,
  markEnabled,
  recordCheckin,
  recordError,
  recordMeta,
  recordModels,
  recordUsage,
  redactError,
} from "./snapshot.mjs"

const invalidJsonControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

// Magpie gives up on a plugin's model list after 20s and marks the provider
// failed; the vendor fetch can be slower than that on a bad day. Keep the last
// good list so a slow fetch falls back instead of turning into an error.
const MODEL_LIST_TIMEOUT_MS = 18_000
const lastModels = new Map()

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
async function usageAccountOf(getAuth) {
  try {
    const auth = typeof getAuth === "function" ? await getAuth() : undefined
    if (!auth || typeof auth !== "object") return ""
    const id = [auth.accountId, auth.nickname, auth.user, auth.email].find(
      (value) => typeof value === "string" && value.trim(),
    )
    const label = id ? accountLabel(id, 0) : ""
    return /^账号 \d+$/.test(label) ? "" : label
  } catch {
    return ""
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
          recordUsage(spec, value, await usageAccountOf(args[0]))
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
  }

  if (hooks.provider && typeof hooks.provider.models === "function") {
    out.provider = { ...hooks.provider }
    const models = hooks.provider.models
    out.provider.models = async (...args) => {
      try {
        const value = await withTimeout(
          models(...args),
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
    const settings =
      options && typeof options === "object" && !Array.isArray(options) ? options : {}
    // Bundle defaults (for example Qiniu's verified tier) are overridden by
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
