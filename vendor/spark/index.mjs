/**
 * iFlytek Spark-X2.6 provider for Magpie.
 *
 * The Astron MaaS gateway exposes an OpenAI-compatible Chat Completions
 * endpoint at `/v2/chat/completions`. An API key is enough for inference.
 *
 * The free quota is not part of that API. It lives in the Astron web console
 * behind a separate browser session. The optional web sign-in launches a
 * one-shot browser, reads that session, and uses the console's read-only
 * endpoints to show the Spark-X2.6 free quota. It never invents a balance and
 * never claims quota on the user's behalf.
 */

import catalog from "./models.generated.mjs"
import {
  CONSOLE_USAGE_URL,
  accountNameOf,
  apiKeyRows,
  consoleCredentials,
  consoleResponseError,
  fetchApiKeys,
  fetchConsoleUser,
  fetchFreeQuota,
  freeQuotaWindow,
  pickApiKey,
  userOfConsolePayload,
} from "./console.mjs"
import {
  closeSession,
  launchLoginBrowser,
  readConsoleApi,
  waitForConsoleCredentials,
} from "./browser.mjs"

export const PROVIDER = "spark-x2-6"

const NPM = "@ai-sdk/openai-compatible"
const DEFAULT_BASE_URL = "https://maas-api.cn-huabei-1.xf-yun.com/v2"
const DEFAULT_MODEL = "spark-x2.6"

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%2314181c'/%3E%3Cpath d='M16 5.5l2.4 7.1 7.1 2.4-7.1 2.4-2.4 7.1-2.4-7.1L6.5 15l7.1-2.4z' fill='%23d8ff6e'/%3E%3Ccircle cx='16' cy='15' r='2.1' fill='%2314181c'/%3E%3C/svg%3E"

const MODELS = catalog.length
  ? catalog
  : [
      {
        id: DEFAULT_MODEL,
        name: "Spark-X2.6",
        context: 1_048_576,
        output: 131_072,
      },
    ]

export function sanitizeOutgoing(value) {
  if (typeof value !== "string") return value
  return value.replace(/\u0000/g, "")
}

function cleanText(value) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
}

function normalizeKey(value) {
  const key = cleanText(value).replace(/^bearer\s+/i, "").trim()
  return key || undefined
}

function keyOf(auth) {
  if (!auth || typeof auth !== "object") return undefined
  return normalizeKey(typeof auth.key === "string" ? auth.key : auth.access)
}

// Magpie keeps an API-key sign-in as { type: "api", key, metadata }. The
// callback result below is turned into that shape by Magpie's own save(); the
// stored copy is what a `client.auth.set` fallback writes when the auto flow
// does not call the callback.
function identityOf(accountName, email) {
  return {
    ...(accountName ? { accountId: accountName, uid: accountName } : {}),
    ...(email ? { email } : {}),
  }
}

function recordOf({ apiKey, token, cookie, accountName, email }) {
  const identity = identityOf(accountName, email)
  return {
    type: "success",
    key: apiKey,
    ...identity,
    metadata: {
      consoleToken: token,
      ...(cookie ? { consoleCookie: cookie } : {}),
      ...identity,
      source: "web",
    },
  }
}

function storedRecordOf({ apiKey, token, cookie, accountName, email }) {
  const identity = identityOf(accountName, email)
  return {
    // client.auth.set writes this object verbatim; Magpie's API-key accounts
    // use type "api". callback() still returns type "success" so the host's
    // own save path accepts it.
    type: "api",
    key: apiKey,
    ...identity,
    metadata: {
      consoleToken: token,
      ...(cookie ? { consoleCookie: cookie } : {}),
      ...identity,
      source: "web",
    },
  }
}

function emailOfUser(user) {
  if (!user || typeof user !== "object") return ""
  return cleanText(
    String(
      user.email ??
        user.mail ??
        user.emailAddress ??
        "",
    ),
  )
}

async function readAuth(getAuth) {
  if (typeof getAuth !== "function") return undefined
  try {
    return await getAuth()
  } catch {
    return undefined
  }
}

function trimBaseURL(value) {
  if (typeof value !== "string" || !cleanText(value)) return DEFAULT_BASE_URL
  return cleanText(value).replace(/\/+$/, "")
}

function configModel(model) {
  return {
    name: model.name,
    reasoning: true,
    tool_call: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: model.context, output: model.output },
  }
}

function providerModel(model, providerID, baseURL) {
  return {
    id: model.id,
    providerID,
    name: model.name,
    api: { id: model.id, url: baseURL, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: { context: model.context, output: model.output },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export async function SparkX26AuthPlugin(input = {}, options = {}) {
  const baseURL = trimBaseURL(options.baseURL)
  const modelId = cleanText(options.modelId) || DEFAULT_MODEL
  const models = MODELS.map((model) =>
    model.id === DEFAULT_MODEL ? { ...model, id: modelId } : model,
  )

  function canceledError() {
    const error = new Error("登录已取消")
    error.name = "AbortError"
    return error
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(canceledError())
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(canceledError())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  // A console login is only useful once its API-key endpoint answers. Waiting
  // for `signedIn` alone races the SSO redirect: the old code then closed the
  // window and Magpie kept showing its login spinner.
  async function readKeysAfterLogin(session, sessionValues, signal) {
    let pageValues = null
    let lastError = ""
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw canceledError()
      pageValues = await readConsoleApi(session, {
        timeout: 15_000,
        signal,
      }).catch(() => null)
      if (pageValues?.keys) {
        const error = consoleResponseError(pageValues.keys)
        if (!error) return { keys: { rows: apiKeyRows(pageValues.keys) }, pageValues }
        lastError = error
      }
      try {
        const keys = await fetchApiKeys({ ...sessionValues, signal })
        if (!keys.error) return { keys, pageValues }
        if (keys.aborted || signal?.aborted) throw canceledError()
        lastError = keys.error || lastError
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw canceledError()
        lastError = error?.message ?? String(error)
      }
      if (attempt < 2) await sleep(800, signal)
    }
    return { keys: { error: lastError || "控制台未返回 API Key" }, pageValues }
  }

  async function finishWebLogin(session, { signal } = {}) {
    try {
      const sessionValues = await waitForConsoleCredentials(session, {
        signal,
        // Acceptance means the console's own API-key request works, not merely
        // that the SSO page redirected. An empty key list is accepted; the
        // clearer "create an API Key" error is produced below.
        validate: async (credentials) => {
          if (signal?.aborted) return false
          try {
            const pageValues = await readConsoleApi(session, {
              timeout: 12_000,
              signal,
            })
            if (pageValues?.keys && !consoleResponseError(pageValues.keys)) {
              return true
            }
          } catch {
            /* Fall through to the Node replay. */
          }
          if (!credentials.token && !credentials.cookie) return false
          try {
            const keys = await fetchApiKeys({ ...credentials, signal })
            return !keys.error && !keys.aborted
          } catch {
            return false
          }
        },
      })
      if (sessionValues?.aborted || signal?.aborted) throw canceledError()
      if (sessionValues?.closed) {
        throw new Error(
          "登录窗口被关闭了，没读到控制台会话。请重新点「网页登录」，登录完成后保持窗口打开，它会自己关闭。",
        )
      }
      if (!sessionValues) {
        throw new Error(
          "网页登录超时（5 分钟内未检测到星辰控制台登录）。请确认是在插件打开的窗口里登录的；普通浏览器里的登录插件读不到。",
        )
      }

      // Read through the signed-in page first. iFlytek's SSO session can live
      // in HttpOnly or partitioned cookies that the console accepts but a
      // replay from Node does not. Node remains the fallback for token-only
      // accounts.
      const { keys, pageValues } = await readKeysAfterLogin(
        session,
        sessionValues,
        signal,
      )
      if (keys.error) {
        throw new Error(
          `已登录控制台，但读取 API Key 失败：${keys.error}。可改用「Spark-X2.6 API Key」，在可选栏填入完整 Cookie。`,
        )
      }

      const apiKey = pickApiKey(keys.rows)
      if (!apiKey) {
        throw new Error(
          "登录成功，但这个账号下没有 API Key。请先在星辰控制台创建 API Key，再重新登录。",
        )
      }

      let user = userOfConsolePayload(pageValues?.user)
      if (!user) {
        const userResult = await fetchConsoleUser({
          ...sessionValues,
          signal,
        }).catch(() => ({ user: null }))
        user = userResult?.user ?? null
      }
      const accountName = accountNameOf(user)
      const email = emailOfUser(user)
      const record = recordOf({
        apiKey,
        token: sessionValues.token,
        cookie: sessionValues.cookie,
        accountName,
        email,
      })

      // Magpie's auto flow may not call callback() (see the hub adapter's
      // note). Persist the account here as well; callback() is idempotent.
      try {
        await input?.client?.auth?.set?.({
          path: { id: PROVIDER },
          body: storedRecordOf({
            apiKey,
            token: sessionValues.token,
            cookie: sessionValues.cookie,
            accountName,
            email,
          }),
        })
      } catch {
        /* callback still returns the record */
      }
      return record
    } finally {
      await closeSession(session)
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const previous = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Spark-X2.6",
        npm: NPM,
        api: baseURL,
        ...previous,
        models: Object.fromEntries(models.map((model) => [model.id, configModel(model)])),
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        const providerID = provider?.id ?? PROVIDER
        return Object.fromEntries(
          models.map((model) => [
            model.id,
            providerModel(model, providerID, baseURL),
          ]),
        )
      },
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      methods: [
        {
          type: "oauth",
          label: "网页登录（自动填 Key + 查免费额度）",
          async authorize(_inputs, { signal } = {}) {
            const session = await launchLoginBrowser(CONSOLE_USAGE_URL)
            const controller = new AbortController()
            const abort = () => {
              if (!controller.signal.aborted) controller.abort()
            }
            if (signal?.aborted) abort()
            else signal?.addEventListener("abort", abort, { once: true })
            const result = finishWebLogin(session, { signal: controller.signal })
            result.catch((error) => {
              const message = error?.message ?? String(error)
              if (error?.name === "AbortError" || message === "登录已取消") return
              try {
                void input?.client?.tui?.showToast?.({
                  body: { message: `Spark-X2.6 登录失败：${message}`, variant: "error" },
                })
              } catch {
                /* toast is best effort */
              }
              try {
                void input?.client?.app?.log?.({
                  body: {
                    service: PROVIDER,
                    level: "error",
                    message: `Spark-X2.6 web login failed: ${message}`,
                  },
                })
              } catch {
                /* logging is best effort */
              }
            })
            return {
              url: CONSOLE_USAGE_URL,
              method: "auto",
              opened: true,
              instructions:
                "在打开的浏览器窗口里登录讯飞星辰控制台。登录完成后插件会读取免费额度并自动填入该账号的 API Key；窗口随后自动关闭。",
              async callback(_code, { signal: callbackSignal } = {}) {
                if (callbackSignal?.aborted) abort()
                else callbackSignal?.addEventListener("abort", abort, { once: true })
                try {
                  return await result
                } catch (error) {
                  if (error?.name === "AbortError" || error?.message === "登录已取消") {
                    return { type: "failed", error: "登录已取消" }
                  }
                  return {
                    type: "failed",
                    error: error?.message ?? String(error),
                  }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Spark-X2.6 API Key",
          placeholder: "ak-...",
          // Optional: paste the console session token to show quota without
          // the browser helper. The inference key stays in the normal field.
          prompts: [
            {
              type: "password",
              key: "consoleToken",
              message:
                "可选：星辰控制台 token（显示免费额度用）← maas.xfyun.cn → F12 → Application → Local Storage → token",
              placeholder: "留空则只调用模型、不显示额度",
            },
            {
              type: "password",
              key: "consoleCookie",
              message:
                "可选：完整 Cookie（显示免费额度用）← 登录 maas.xfyun.cn 后 F12 → Network → 任一请求 → Request Headers → Cookie",
              placeholder: "留空则只调用模型、不显示额度",
            },
          ],
        },
      ],

      async loader(getAuth) {
        const key = keyOf(await readAuth(getAuth))
        return {
          baseURL,
          apiKey: key,
          async fetch(input, init) {
            const current = keyOf(await readAuth(getAuth))
            const source = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? source?.headers)
            if (current === undefined) headers.delete("authorization")
            else headers.set("authorization", `Bearer ${current}`)
            const body = sanitizeOutgoing(init?.body)
            const next = body === init?.body ? init : { ...init, body }
            return source
              ? fetch(new Request(source, { ...next, headers }))
              : fetch(input, { ...next, headers })
          },
        }
      },

      // Read-only console quota. No console session means the card says so;
      // a missing API key is not an error here, because usage is optional.
      async usage(getAuth) {
        const auth = await readAuth(getAuth)
        const credentials = consoleCredentials(auth)
        if (!credentials.token && !credentials.cookie) {
          return {
            plan: "Spark-X2.6",
            windows: [
              {
                name: "免费额度",
                used: 0,
                display: "未登录控制台（用「网页登录」查看）",
                amount: 0,
                limit: 0,
                unit: "tokens",
              },
            ],
          }
        }

        const result = await fetchFreeQuota(credentials)
        if (result.error) {
          return {
            plan: "Spark-X2.6",
            windows: [],
            error: result.error,
            ...(result.signIn ? { signIn: result.signIn } : {}),
          }
        }

        return {
          plan: "Spark-X2.6",
          windows: [freeQuotaWindow(result)],
        }
      },
    },
  }
}
