/**
 * ModelBest（面壁智能）provider for Magpie.
 *
 * Two hosts, two credentials:
 *
 *   - **Inference** is OpenAI-compatible at `https://api.modelbest.cn/v1`
 *     and takes an `sk-…` API key.
 *   - **Account** is the console at `https://platform.modelbest.cn/api`,
 *     which wants the browser session JWT (`localStorage["map_token"]`) as a
 *     Bearer token. That is where 积分余额 and the daily check-in live; neither
 *     is reachable with an API key.
 *
 * The web sign-in launches a throwaway Chromium profile, waits until the
 * console accepts the token, then reads the account's API key out of the
 * console so one sign-in covers both. The API-key method accepts the console
 * token as an optional prompt for users who would rather paste it.
 */

import {
  CONSOLE_PAGE,
  ConsoleError,
  claimDailyCheckin,
  consoleErrorText,
  readAccount,
  readConsoleApiKey,
  readProfile,
  readRewards,
  toUsage,
} from "./console.mjs"
import {
  DEFAULT_BASE_URL,
  NPM,
  allModels,
  toConfigModel,
  toProviderModel,
} from "./models.mjs"
import { closeSession, launchLoginBrowser, waitForConsoleToken } from "./browser.mjs"

const PROVIDER = "modelbest"
const PROVIDER_NAME = "ModelBest"

const cleanText = (value) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : ""

function normalizeKey(value) {
  const key = cleanText(value).replace(/^bearer\s+/i, "").trim()
  return key || undefined
}

/** Magpie stores an API-key sign-in as `{ type: "api", key, metadata }`. */
function keyOf(auth) {
  if (!auth || typeof auth !== "object") return undefined
  return normalizeKey(typeof auth.key === "string" ? auth.key : auth.access)
}

/**
 * The console token, which lives beside the key under `metadata`.
 *
 * It is never derived from the inference key: ModelBest has no API-key path to
 * the account endpoints, so a key-only account simply has no quota to show.
 */
function consoleTokenOf(auth) {
  const meta = auth && typeof auth === "object" ? auth.metadata ?? {} : {}
  for (const value of [meta.consoleToken, meta.token, meta.accessToken]) {
    const token = cleanText(value).replace(/^bearer\s+/i, "").trim()
    if (token) return token
  }
  return ""
}

async function readAuth(getAuth) {
  if (typeof getAuth !== "function") return undefined
  try {
    return await getAuth()
  } catch {
    return undefined
  }
}

function identityOf(profile) {
  const accountId = cleanText(profile?.accountId)
  const email = cleanText(profile?.email)
  return {
    ...(accountId ? { accountId, uid: accountId } : {}),
    ...(email ? { email } : {}),
  }
}

function recordOf({ apiKey, token, profile, type }) {
  const identity = identityOf(profile)
  return {
    type,
    key: apiKey,
    ...identity,
    metadata: {
      consoleToken: token,
      ...identity,
      source: "web",
    },
  }
}

export async function ModelBestAuthPlugin(input = {}, options = {}) {
  const baseURL = cleanText(options.baseURL) || DEFAULT_BASE_URL
  const models = allModels({ modelId: cleanText(options.modelId) })

  function canceledError() {
    const error = new Error("登录已取消")
    error.name = "AbortError"
    return error
  }

  async function finishWebLogin(session, { signal } = {}) {
    try {
      const found = await waitForConsoleToken(session, { signal })
      if (found?.aborted || signal?.aborted) throw canceledError()
      if (found?.closed) {
        throw new Error(
          "登录窗口被关闭了，没读到控制台会话。请重新点「网页登录」，登录完成后保持窗口打开，它会自己关闭。",
        )
      }
      if (!found) {
        throw new Error(
          "网页登录超时（5 分钟内未检测到 ModelBest 控制台登录）。请确认是在插件打开的窗口里登录的；普通浏览器里的登录插件读不到。",
        )
      }

      const token = found.token
      let profile = { accountId: "", email: "" }
      try {
        profile = await readProfile(token)
      } catch (error) {
        if (error instanceof ConsoleError) {
          throw new Error(
            `已读到控制台 Token，但控制台拒绝了这个会话（${error.message}）。请重新网页登录。`,
          )
        }
        throw error
      }

      let foundKey = null
      try {
        foundKey = await readConsoleApiKey(token)
      } catch (error) {
        foundKey = {
          error:
            error instanceof ConsoleError
              ? error.message
              : error?.message ?? String(error),
        }
      }
      if (!foundKey?.key) {
        throw new Error(
          `登录成功，但该账号下没有可用的 API Key（${foundKey?.error || "未知原因"}）。请先在控制台创建 API Key 再重新登录；或改用「${PROVIDER_NAME} API Key」方式，并在可选栏粘贴控制台 Token。`,
        )
      }

      const record = recordOf({
        apiKey: foundKey.key,
        token,
        profile,
        type: "success",
      })
      // Magpie's auto flow may not call callback(); callback() is idempotent.
      try {
        await input?.client?.auth?.set?.({
          path: { id: PROVIDER },
          body: recordOf({
            apiKey: foundKey.key,
            token,
            profile,
            type: "api",
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
      // `modelbest` is also a common hand-made custom provider (the platform
      // is the same one), and that entry carries the user's own key and model
      // picks. Keep those instead of replacing them with this snapshot.
      const existingModels =
        previous.models && Object.keys(previous.models).length ? previous.models : null
      cfg.provider[PROVIDER] = {
        name: previous.name || PROVIDER_NAME,
        npm: previous.npm || NPM,
        api: previous.api || baseURL,
        ...previous,
        models:
          existingModels ??
          Object.fromEntries(models.map((model) => [model.id, toConfigModel(model)])),
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        const providerID = provider?.id ?? PROVIDER
        return Object.fromEntries(
          models.map((model) => [model.id, toProviderModel(model, providerID, baseURL)]),
        )
      },
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "网页登录（自动填 Key + 查积分 + 签到）",
          async authorize(_inputs, { signal } = {}) {
            const session = await launchLoginBrowser(CONSOLE_PAGE)
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
                  body: { message: `${PROVIDER_NAME} 登录失败：${message}`, variant: "error" },
                })
              } catch {
                /* toast is best effort */
              }
              try {
                void input?.client?.app?.log?.({
                  body: {
                    service: PROVIDER,
                    level: "error",
                    message: `${PROVIDER_NAME} web login failed: ${message}`,
                  },
                })
              } catch {
                /* logging is best effort */
              }
            })
            return {
              url: CONSOLE_PAGE,
              method: "auto",
              opened: true,
              instructions:
                "在打开的浏览器窗口里登录 ModelBest 控制台。登录完成后插件会读取账号的 API Key 与积分，窗口随后自动关闭。",
              async callback(_code, { signal: callbackSignal } = {}) {
                if (callbackSignal?.aborted) abort()
                else callbackSignal?.addEventListener("abort", abort, { once: true })
                try {
                  return await result
                } catch (error) {
                  if (error?.name === "AbortError" || error?.message === "登录已取消") {
                    return { type: "failed", error: "登录已取消" }
                  }
                  return { type: "failed", error: error?.message ?? String(error) }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: `${PROVIDER_NAME} API Key`,
          placeholder: "sk-...",
          // Optional: the console token is the only way to show 积分 and to
          // claim the daily check-in. Blank means "models only".
          prompts: [
            {
              type: "password",
              key: "consoleToken",
              message:
                "可选：控制台 Token（显示积分、参与每日签到用）← 登录 platform.modelbest.cn 后 F12 → Application → Local Storage → map_token",
              placeholder: "留空则只调用模型、不显示积分、不签到",
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
            // Re-read per request so a sign-in that changes mid-session is
            // picked up without waiting for the loader to re-run.
            const current = keyOf(await readAuth(getAuth))
            const source = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? source?.headers)
            if (current === undefined) headers.delete("authorization")
            else headers.set("authorization", `Bearer ${current}`)
            return source
              ? fetch(new Request(source, { ...init, headers }))
              : fetch(input, { ...init, headers })
          },
        }
      },

      /**
       * 积分余额 from the console. An account signed in with an API key only
       * has no console token, so it gets an explanatory row instead of a
       * number nobody can verify.
       */
      async usage(getAuth) {
        const auth = await readAuth(getAuth)
        const token = consoleTokenOf(auth)
        if (!token) {
          return {
            plan: PROVIDER_NAME,
            windows: [
              {
                name: "积分余额",
                used: 0,
                display: "未登录控制台（用「网页登录」查看）",
                amount: 0,
                limit: 0,
                unit: "积分",
              },
            ],
          }
        }
        try {
          const account = await readAccount(token)
          return toUsage(account)
        } catch (error) {
          return { plan: PROVIDER_NAME, windows: [], ...consoleErrorText(error) }
        }
      },

      /**
       * 每日签到. The claim endpoint answers with an envelope, not the new
       * balance, so the balance is re-read only when the reward state does
       * not change; the credit reported is the console's published daily
       * amount, not a guess.
       */
      async checkin(getAuth) {
        const auth = await readAuth(getAuth)
        const token = consoleTokenOf(auth)
        if (!token) {
          return {
            outcome: "failed",
            message: "未登录控制台，签到需要「网页登录」或填写控制台 Token",
          }
        }
        let rewards
        try {
          rewards = await readRewards(token)
        } catch (error) {
          return { outcome: "failed", message: consoleErrorText(error).error }
        }
        if (!rewards.enabled) {
          return { outcome: "ineligible", message: "该账号当前没有开放每日签到" }
        }
        if (rewards.claimedToday) {
          return { outcome: "done", message: "今日已签到" }
        }
        try {
          await claimDailyCheckin(token)
        } catch (error) {
          return { outcome: "failed", message: consoleErrorText(error).error }
        }
        const credit = rewards.points > 0 ? rewards.points : undefined
        return {
          outcome: "claimed",
          ...(credit === undefined ? {} : { credit }),
          message:
            credit === undefined ? "每日签到已领取" : `每日签到 +${credit} 积分`,
        }
      },
    },
  }
}
