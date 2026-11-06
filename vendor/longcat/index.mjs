/**
 * LongCat provider for Magpie.
 *
 * LongCat exposes an OpenAI-compatible Chat Completions endpoint at
 * `/openai/v1/chat/completions`, and an Anthropic-compatible one at
 * `/anthropic/v1/messages`. This provider uses the OpenAI shape:
 *
 *   base URL  https://api.longcat.chat/openai/v1
 *   endpoint  POST {baseURL}/chat/completions
 *   models    GET  {baseURL}/models
 *
 * One API key is enough. LongCat publishes no account-quota or check-in
 * endpoint behind that key, so the provider declares only models and routing
 * instead of inventing numbers.
 */

export const PROVIDER = "longcat"

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const NPM = "@ai-sdk/openai-compatible"
const DEFAULT_BASE_URL = "https://api.longcat.chat/openai/v1"
const DEFAULT_MODEL = "LongCat-2.5"

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%2314181c'/%3E%3Cpath d='M9 10.5l3 3.5h8l3-3.5 1 11A5 5 0 0 1 19 27h-6a5 5 0 0 1-5-5.5z' fill='%23ffb454'/%3E%3Ccircle cx='13' cy='18' r='1.3' fill='%2314181c'/%3E%3Ccircle cx='19' cy='18' r='1.3' fill='%2314181c'/%3E%3Cpath d='M14.5 22h3' stroke='%2314181c' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"

// Official model-parameter reference, read 2026-11-04:
// LongCat-2.5, 1,048,576-token context, 262,144-token output, text/image/video
// input, reasoning_content in responses and a `thinking` request toggle.
const MODELS = [
  {
    id: DEFAULT_MODEL,
    name: "LongCat-2.5",
    context: 1_048_576,
    output: 262_144,
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
    attachment: true,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
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
      input: 0.3,
      output: 1.2,
      cache: { read: 0.006, write: 0 },
    },
    limit: { context: model.context, output: model.output },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: true,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: { field: "reasoning_content" },
    },
    release_date: "",
    variants: {},
  }
}

// LongCat has no quota endpoint, so the only honest number is what magpie
// itself saw this key spend. The usage log is magpie's own; a plugin outside it
// (OpenCode) simply finds no file and reports nothing.
function magpieConfigDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie")
  return join(homedir(), ".config", "magpie")
}

function localDayKey(ms) {
  const at = new Date(ms)
  const month = String(at.getMonth() + 1).padStart(2, "0")
  const day = String(at.getDate()).padStart(2, "0")
  return `${at.getFullYear()}-${month}-${day}`
}

let usageCache = { stamp: "", tokens: 0 }

function tokensToday() {
  const file = join(magpieConfigDir(), "usage.jsonl")
  if (!existsSync(file)) return 0
  let stamp = ""
  try {
    const info = statSync(file)
    stamp = `${info.mtimeMs}:${info.size}`
  } catch {
    return usageCache.tokens
  }
  if (usageCache.stamp === stamp) return usageCache.tokens
  let text = ""
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return usageCache.tokens
  }
  const today = localDayKey(Date.now())
  let tokens = 0
  for (const line of text.split("\n")) {
    if (!line.includes('"provider":"longcat')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row?.provider !== "string" || !row.provider.startsWith(PROVIDER)) continue
    const at = Date.parse(row.t)
    if (!Number.isFinite(at) || localDayKey(at) !== today) continue
    tokens += (Number(row.in) || 0) + (Number(row.out) || 0)
  }
  usageCache = { stamp, tokens }
  return tokens
}

function thousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export async function LongCatAuthPlugin(_input = {}, options = {}) {
  const baseURL = trimBaseURL(options.baseURL)
  const modelId = cleanText(options.modelId) || DEFAULT_MODEL
  const models = MODELS.map((model) =>
    model.id === DEFAULT_MODEL ? { ...model, id: modelId } : model,
  )

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const previous = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "LongCat",
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
          type: "api",
          label: "LongCat API Key",
          placeholder: "API Keys 页面创建的 Key",
        },
      ],

      // Nothing on the vendor side to read, so report the day's spend that
      // magpie recorded for this key. No limit is claimed: the window only
      // says how much went out, which is all this key can tell.
      async usage() {
        const used = tokensToday()
        return {
          plan: "本地记账",
          windows: [
            {
              name: "今日 tokens",
              used,
              display: `已用 ${thousands(used)} tokens`,
              unit: "tokens",
            },
          ],
        }
      },

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
    },
  }
}
