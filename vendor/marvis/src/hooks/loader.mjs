// ④ auth.loader —— 接管所有出站请求
//
// 这里只做四件事：
//   1. 每次请求**现签一个 uskey**（同一 uskey 只给 2 次，第 3 次 403）
//   2. 换成这个账号的 Ual-Access-* 头（模型网关不认 Bearer，只认这套）
//   3. 把「模型不可用」翻成 404、「登录失效」翻成 401 + X-Magpie-Sign-In: expired
//   4. **把 Response 原样交回去** —— 绝不在 fetch 里读流（读了就是「只有第一段就结束」）
//
// ⚠ 实测：把 UAL 签名头（md5 body+ts+accessKey+nonce）加到模型网关上是**错的** ——
//   会从 403 风控变成 401 登录态过期。那套只用于 /v3/*。

import { BASE, BASE_V1, DEFAULT_MODEL, DISPLAY_BY_SLOT, PROVIDER, canonicalModelId, isUnavailableModel, FIRST_LINE_OPTION_KEY } from "../context.mjs"
import { llmHeaders } from "../marvis/protocol.mjs"
import { normalizeTools } from "../marvis/tool-schema.mjs"
import { InvalidImageError, normalizeMessages } from "../marvis/images.mjs"

/**
 * 上游说「模型不行」的信号 —— 只收**模型级**的，映射成 404（搁置这个模型，不打死账号）。
 *
 * ⚠ `4130001` = `无效模型id`（请求体里的 model 不是注册表里的槽位）。
 * ⚠ `5104002` 是 **RPC 500**，这个业务码本身不等于模型失效 —— 不能加进来：
 *   把 5104002 全局映射成 404 会把正常模型的上游抖动误判成「模型不可用」，
 *   能用的模型和账号都会被标成失效。
 */
const MODEL_ISSUE =
  /model.*not (found|exist|allowed|available)|no such model|不支持.*模型|模型.*(不存在|未开通|不可用)|无效模型\s*id|4130001|4100402/i

/** 风控（uskey 配额用完 / 缺 MarvisExt）—— 可重试，但要换新 uskey */
const RISK_BLOCK = /4100404|风控拦截/

/**
 * 模型网关的补全路径。
 *
 * ⚠ 2026-11-27 实测：`/v1/chat/completions` 对所有账号、任何 uskey（官方 SDK 现签/随机/缺失）
 *   一律 `403 {"code":4100404}`，而同一份 OpenAI 请求体、同一套 UAL 头打到 `/v1/messages`
 *   正常 200（含 SSE + tools + reasoning_content）。官方客户端现在走的就是后者。
 *   所以补全请求改投 `/v1/messages`，`/v1/chat/completions` 只在它 404 时兜底。
 */
const CHAT_UPSTREAM = `${BASE}/v1/messages`

/** 登录态过期 */
const AUTH_EXPIRED = /4100403|登录态过期|未登录/

/**
 * Marvis 的内容过滤拦的是「**system 首行 + 词对 + 单个空格**」（issue #22 / #26）。
 *
 * 2026-11-15 首次定位 + 2026-11-16 复测（直打上游，只换 system prompt 第一句）：
 *
 *   `You are an AI agent powered by DeepSeek Harness.`      → 403 非法请求
 *   中文写法（由 DeepSeek Harness 驱动…）                    → 403 非法请求
 *   全小写同一句                                             → 403（大小写不敏感）
 *   句末加 ! 或 ,                                            → 403（句末符号无效）
 *   同一句放第 2 行 / 行内带前缀 / user 或 assistant 角色     → 200
 *   `DeepSeek-Harness` / `DeepSeek — Harness`               → 200（词间插字符放行）
 *
 * ⇒ 判据是「首行里的词对」，不是「整句模板」。只认英文整句会漏掉中文与本地化写法 ——
 *   它们照样 403，而且因为不命中模板，连 content_filtered 诊断都不会触发，
 *   用户看到的仍是宿主那句「API 密钥无效」。
 */
/**
 * 上游内容过滤拦截时的**统一**提示（本插件自己的 403 文案，不发给上游）。
 *
 * ⚠ 措辞必须同时成立三件事：
 *   ① 性质是内容过滤，不是密钥或登录（否则用户去重登，白折腾）；
 *   ② 说明**怎么自己解决** —— 首行是用户自己的事，插件只负责把它写进去；
 *   ③ 给出「还是被拦」时的上报动作（把首行带到群里）。
 * ⚠ 不要把「改哪一句」写死成唯一修法：不同客户端首句不同（issue #38 的 ZCode 提示词不可配置，
 *   用户侧根本没有可改的地方），写死一家会在别家命中时把人带偏。
 */
const CONTENT_FILTER_HINT =
  "上游内容过滤拦截：系统提示词首句被当成了身份指纹（不是密钥或登录问题）。" +
  "插件不再替你猜「哪句能过」—— 上游的黑名单一直在长，今天能过的改写明天就被加进去。" +
  "首行请自己写一句：设置 → 插件 → 本插件「选项」把「提示词首行替换」换成你的话" +
  "（别写任何 agent 产品名），再打开卡片上的「每个请求都改写首行」；只想被拦后兜底就保持默认。" +
  "还是被拦就把 system 首行原样带到 QQ 群 451129479。"

// ── 首行兜底（插件选项 firstLine）────────────────────────────────────
//
// 为什么要有它：上游拦的是「system 首行里的身份词对」，而**哪句能过一直在变** ——
// 我们把一句句首行加进白名单，换来的是它们很快也被拦。所以不再替用户猜：
// 首行由用户自己写（选项「提示词首行替换」），插件只负责把它写进去。
// 兜底句不含任何 agent 产品名（`You are Marvis, Tencent's AI assistant.` 实测 200），
// 它能过；代价是模型不知道自己是哪个客户端，所以**默认只在被拦之后才用**（mode=blocked）。
//
// 两个开关由 **magpie 渲染在供应商卡片里**（`auth.options`，见 context.mjs 的 PLUGIN_OPTIONS），
// 用户在编辑器里点 Off/On 即生效，插件用 `input.magpie.option("marvis", key)` 读，
// **不用重启**（magpie 每次调用都现读）：
//
//   first_line_fallback（默认开）被拦时换兜底句重试一次 → blocked
//   first_line_always  （默认关）每个请求都换首行        → always
//   两个都关                                            → off（一个字节都不改）
//
// 首行文本来自插件选项的 JSON，**就一个键**（`magpie.options` = `{"text": "…"}`）：
// 设置 → 插件 → 本插件那一行的「选项」框里直接改那句话。只留一个键是有意的 ——
// 那个框是 magpie 的通用 JSON 编辑器（值必须是对象，写字符串会被拒），键越少越好改。
// 老版本存下的 `{ "firstLine": { "text": "…", "mode": "…" } }` 仍然读。
// 留空 = 内置兜底句。整行替换：只换 system 消息的第一行，第二行起原样。

/** 内置兜底首行：不含任何 agent 产品名（实测 200） */
const FALLBACK_FIRST_LINE = "You are Marvis, Tencent's AI assistant."


/**
 * 读一次「首行改写」配置。
 *
 * 开关从 magpie 现读（`input.magpie.option(provider, key)`，用户点一下就到，不用重启）；
 * 文本从插件选项的 JSON 读（`magpie.options.firstLine.text`）。任何形状不对的值都退回默认
 * （fallback 开 + 内置兜底句），绝不因为配置写错而让请求失败。
 *
 * @param {unknown} input   magpie 给插件的 input（`input.magpie.option` 在里面）
 * @param {unknown} options 插件选项（设置页那个 JSON）
 * @returns {{ mode: "off" | "blocked" | "always", text: string }}
 */
function firstLineOption(input, options) {
  let opts = options
  if (typeof opts === "string") {
    try {
      opts = JSON.parse(opts)
    } catch {
      opts = {}
    }
  }
  // 新形状：{"提示词首行替换": "…"}（键名就是给人看的字段名）；
  // 0.2.50 用的是 {"text": "…"}，0.2.49 及以前是 {"firstLine": {"text": "…"}} —— 都还读
  const raw =
    typeof opts?.[FIRST_LINE_OPTION_KEY] === "string"
      ? { text: opts[FIRST_LINE_OPTION_KEY] }
      : typeof opts?.text === "string"
        ? opts
        : opts?.firstLine
  const text =
    typeof raw?.text === "string" && raw.text.trim()
      ? raw.text.trim().replace(/\s*\n\s*/g, " ")
      : FALLBACK_FIRST_LINE
  // 开关：用户的值 → 插件默认。读不到（老 magpie / 抛错）就当默认
  const switched = (key, fallback) => {
    try {
      const v = input?.magpie?.option?.(PROVIDER, key)
      return typeof v === "boolean" ? v : fallback
    } catch {
      return fallback
    }
  }
  const always = switched("first_line_always", false)
  const blocked = switched("first_line_fallback", true)
  const mode = always ? "always" : blocked ? "blocked" : "off"
  return { mode, text }
}

/**
 * 把 system 消息的**第一行**整行换掉（第二行起原样）。
 *
 * 只动第一条 system 消息 —— 再往后的 system 不是身份句的常见位置，改了反而多余。
 * 没有 system 消息时原样返回（调用方据此判断有没有改动）。
 *
 * @param {unknown} messages
 * @param {string} text
 * @returns {unknown}
 */
function withFirstLine(messages, text) {
  if (!Array.isArray(messages)) return messages
  let touched = false
  const out = messages.map((message) => {
    if (touched) return message
    if (!message || typeof message !== "object") return message
    if (message.role !== "system" || typeof message.content !== "string") return message
    touched = true
    const line = firstLineOf(message.content)
    return { ...message, content: text + message.content.slice(line.length) }
  })
  return touched ? out : messages
}

/**
 * 把 system 提示词的**第一行**换成 `text` —— 三种协议一次覆盖。
 *
 *   chat（/v1/chat/completions）        `messages[]` 里第一条 `role: "system"`
 *   responses（/v1/responses）          顶层 `instructions`（字符串）
 *   anthropic（/v1/messages）           顶层 `system`：字符串，或 `[{type:"text", text}]` 数据块
 *
 * 为什么三处都要看：magpie 会把客户的协议折成 provider 的 chat 上游，但**折法不止一种**
 * （issue #62：Claude Desktop 走 /v1/messages 时 always 选项等于空操作）。
 * 抓到哪处换哪处，其余字段一个字节不动；都没命中就把原对象原样返回（调用方靠引用判「有没有改」）。
 *
 * 来历：#62 由 @zhey80 定位（同一模型只改首行长度，比对 usage.jsonl 的 up_bytes 差值 = 多加的字符数，
 * 证明首行没被替换）。
 *
 * @param {object} json  请求体
 * @param {string} text  要写进去的第一行（整行替换，行内其余内容与后续行不动）
 * @returns {object} 改过的**新对象**，或原对象（没得改）
 */
function withFirstLineInBody(json, text) {
  if (!json || typeof json !== "object") return json
  let out = json
  let changed = false

  const messages = withFirstLine(out.messages, text)
  if (messages !== out.messages) {
    out = { ...out, messages }
    changed = true
  }

  if (typeof out.instructions === "string" && out.instructions.trim()) {
    const line = firstLineOf(out.instructions)
    const next = text + out.instructions.slice(line.length)
    if (next !== out.instructions) {
      out = { ...out, instructions: next }
      changed = true
    }
  }

  if (typeof out.system === "string" && out.system.trim()) {
    const line = firstLineOf(out.system)
    const next = text + out.system.slice(line.length)
    if (next !== out.system) {
      out = { ...out, system: next }
      changed = true
    }
  } else if (Array.isArray(out.system)) {
    let done = false
    const blocks = out.system.map((block) => {
      if (done || !block || typeof block !== "object") return block
      if (block.type !== "text" || typeof block.text !== "string") return block
      done = true
      const line = firstLineOf(block.text)
      return { ...block, text: text + block.text.slice(line.length) }
    })
    if (done) {
      out = { ...out, system: blocks }
      changed = true
    }
  }

  return changed ? out : json
}

/**
 * 请求体里**当前**那行 system 首行（三处协议都看）。
 *
 * 403 兜底重试要先问一句「是不是已经是用户那句了」—— 已经是就别再白打一次。
 *
 * @param {object} json
 * @returns {string}
 */
function firstLineInBody(json) {
  if (!json || typeof json !== "object") return ""
  const messages = Array.isArray(json.messages) ? json.messages : []
  for (const message of messages) {
    if (!message || message.role !== "system") continue
    const text = typeof message.content === "string" ? message.content : ""
    if (text.trim()) return firstLineOf(text).trim()
  }
  if (typeof json.instructions === "string" && json.instructions.trim()) {
    return firstLineOf(json.instructions).trim()
  }
  if (typeof json.system === "string" && json.system.trim()) return firstLineOf(json.system).trim()
  if (Array.isArray(json.system)) {
    for (const block of json.system) {
      if (!block || typeof block !== "object" || block.type !== "text") continue
      if (typeof block.text === "string" && block.text.trim()) return firstLineOf(block.text).trim()
    }
  }
  return ""
}


/**
 * 构造一个错误 Response。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
/** 请求头构造失败（uskey 现签）—— 与「连不上上游」不是一类故障，别混成同一个 503 */
class HeaderUnavailable extends Error {}

function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { type: "upstream_error", code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * 把会被上游内容过滤拦下的身份句改写成能放行的形态。
 *
 * ⚠ 只改 system 消息**第一行**里的身份短语 —— 那是上游唯一会拦的位置；
 *   user / assistant 里的同一句上游本来就放行，改了反而是多余改动。
 * ⚠ 门禁不变：只把词间那一个空格换成连字符，其余字符一个都不碰；
 *   已经写成连字符 / 破折号的形态没有空格可换，仍然原样发出（0.2.30 的用例继续守着）。
 * ⚠ 返回**新数组**才表示改过 —— 调用方据此决定要不要重新序列化 body（并去掉 content-length）。
 *
 * @param {unknown} messages
 * @returns {unknown}
 */
function firstLineOf(text) {
  const cut = text.indexOf("\n")
  return cut < 0 ? text : text.slice(0, cut)
}

/**
 * 这次请求里的 system 首行 —— 403 兜底重试拿它跟用户自己那句比：一样就不再白试一次。
 *
 * @param {unknown} bodyString
 * @returns {string}
 */
function systemFirstLineOf(bodyString) {
  if (typeof bodyString !== "string") return ""
  let json = null
  try {
    json = JSON.parse(bodyString)
  } catch {
    return ""
  }
  return firstLineInBody(json)
}

// ⚠ 不要用 TABLE（`DISPLAY_BY_SLOT`）当准入集合。
//   TABLE 是**对外展示目录**，不是「上游可用集合」：`app-auto` / `file-auto` /
//   `computer-auto` / `browser-auto` 这类旧真实槽位不在 TABLE 里，上游却仍然 200。
//   拿 TABLE 做 allowlist 会把它们本地 404 掉（0.2.21 的事故）。
//   准入只查 `isUnavailableModel`（明确不可用名单，当前只有 `kimi-k2.5`），其余交给上游判。

/** 请求体里到底有没有指定模型（空 / null 的交回上游判） */
function hasModelId(value) {
  return value != null && String(value) !== ""
}

/**
 * 明确不可用的模型：**本地** 404，不出网、不 fallback。
 *
 * 只对 `isUnavailableModel` 命中名单的模型生效（当前只有 `kimi-k2.5`）。
 * TABLE 外的旧真实槽位不归这里管 —— 它们照常出网，可用性由上游响应决定。
 *
 * 为什么是 404 而不是 401/500（AGENTS 坑 6）：
 *   · 401 会被宿主当登录问题，failover 到**每一个账号**；
 *   · 500 会被当可重试的上游故障，同一个请求连打 8 次（kimi-k2.5 的 5104002 现场）；
 *   · 404 只搁置这个模型，文案把用户引导回模型列表里**真实模型名**的条目。
 */
function modelUnavailableResponse(id) {
  const example = DISPLAY_BY_SLOT[DEFAULT_MODEL] ?? DEFAULT_MODEL
  return errorResponse(
    404,
    "model_unavailable",
    `模型「${String(id).slice(0, 120)}」已被标记为持续不可用（上游稳定失败），` +
      `这次请求没有发往上游。请在模型列表里重新选择一个真实模型名条目（例如 ${example}）。`,
  )
}

/** 从账号凭据里取模型网关要的四件套 */
function credsOf(auth) {
  const meta = auth?.metadata ?? {}
  return {
    openid: String(meta.openid ?? auth?.uid ?? ""),
    accessToken: String(auth?.access ?? auth?.key ?? ""),
    guid: String(meta.guid ?? ""),
    loginType: String(meta.loginType ?? "1"),
  }
}

export function loaderHook(input, options = {}) {
  return async (getAuth) => {
    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds.accessToken || !creds.openid) {
      return {}
    }

    return {
      baseURL: BASE_V1,
      apiKey: "placeholder",
      fetch: async (target, init) => {
        // ⚠ 每次请求都现读开关：magpie 的 option() 本来就是现查的，改了立刻生效
        const firstLine = firstLineOption(input, options)
        const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url

        // 非补全请求（/models 之类）原样放行 —— 上游没有这个端点，交给上层兜底。
        // 三种补全协议都要进来：/chat/completions、/messages（Anthropic）、/responses，
        // 否则那两种协议下「每个请求都改写首行」等于空操作（issue #62）。
        if (!/\/(?:chat\/completions|messages|responses)\b(?!\/)/.test(url)) {
          return fetch(target, init)
        }

        /**
         * 发一次上游请求。**每次都重新签 uskey** —— 它是一次性的：
         * 403 兜底重试若复用上一次的 uskey，会直接撞风控（`risk_blocked`），
         * 看起来像另一个故障，排查时会被带偏。
         */
        const callUpstream = async (payload) => {
          let headers
          try {
            // uskey 必须按本次请求的 model / conv / resp 现签，不能复用上一张票。
            let payloadModel = DEFAULT_MODEL
            try {
              const payloadText =
                typeof payload === "string"
                  ? payload
                  : Buffer.isBuffer(payload)
                    ? payload.toString("utf8")
                    : ""
              if (payloadText) payloadModel = canonicalModelId(JSON.parse(payloadText)?.model) || DEFAULT_MODEL
            } catch {
              /* 非 JSON 用默认槽位 */
            }
            headers = await llmHeaders(creds, { model: payloadModel, scene: "agent_chat", agentTag: "main" })
          } catch (err) {
            throw new HeaderUnavailable(err?.message ?? String(err))
          }
          // 保留调用方传的 stream / 业务体，只换鉴权头。
          // ⚠ 必须**按小写判重**：magpie 传进来的头是普通对象、键的大小写不固定
          //   （`user-agent` 与 `User-Agent` 同时存在时，Headers 会把两条**用逗号连起来**，
          //   于是上游收到 `magpie/0.1.4342, AsyncOpenAI/Python 2.32.0` —— 既不是官方 UA，
          //   也可能被当成伪造头触发 4100404 风控）。
          const oursLower = new Set(Object.keys(headers).map((k) => k.toLowerCase()))
          const merged = {}
          const incoming = init?.headers
          if (incoming && typeof incoming.forEach === "function" && !Array.isArray(incoming)) {
            // Headers 实例
            incoming.forEach((value, key) => {
              if (!oursLower.has(String(key).toLowerCase())) merged[key] = value
            })
          } else if (Array.isArray(incoming)) {
            for (const [key, value] of incoming) {
              if (!oursLower.has(String(key).toLowerCase())) merged[key] = value
            }
          } else {
            for (const [key, value] of Object.entries(incoming ?? {})) {
              if (!oursLower.has(String(key).toLowerCase())) merged[key] = value
            }
          }
          Object.assign(merged, headers)
          if (payload !== init?.body) {
            // body 变了，长度 / 压缩头必须去掉，让 fetch 重新算
            delete merged["content-length"]
            delete merged["Content-Length"]
            delete merged["content-encoding"]
            delete merged["Content-Encoding"]
          }
          // 补全请求改投 `/v1/messages`（见 CHAT_UPSTREAM）；其余路径原样。
          const target = /\/chat\/completions\b/.test(url) ? CHAT_UPSTREAM : url
          const res = await fetch(target, { ...init, body: payload, headers: merged })
          // 端点若被撤掉（404），退回原路径，保持旧行为
          if (target !== url && res.status === 404) {
            return fetch(url, { ...init, body: payload, headers: merged })
          }
          return res
        }

        /** 上游给流式响应时带的是 text/plain，但 body 是标准 SSE —— 归一化 content-type */
        const normalizeStreaming = (res) => {
          const ct = res.headers.get("content-type") ?? ""
          if (res.body && !/event-stream/i.test(ct)) {
            const headers = new Headers(res.headers)
            headers.set("content-type", "text/event-stream; charset=utf-8")
            return new Response(res.body, { status: res.status, headers })
          }
          return res
        }

        /**
         * 403 兜底：把首行换成兜底句，**重试一次**。
         * 成功返回规范化后的响应；失败返回 null（落回统一诊断，不把第二次的错误文本当结果）。
         */
        const retryWithFallbackFirstLine = async (json) => {
          const next = withFirstLineInBody(json, firstLine.text)
          if (next === json) return null // 三处都找不到 system 文本，无从下手
          try {
            const retry = await callUpstream(JSON.stringify(next))
            return retry.ok ? normalizeStreaming(retry) : null
          } catch {
            return null
          }
        }

        // ⚠ 旧路由里模型 ID 是数组下标 `"0"…"7"`，上游只认槽位名。
        //   在这里做一次归一，旧路由不改配置也能继续用。
        let body = init?.body
        /** 改写前的原始请求体 —— 403 诊断要靠它判断上游拦的是哪句身份声明（body 可能已被改写） */
        const originalBody = typeof body === "string" ? body : ""
        /** @type {string | null} 命中「明确不可用」名单的模型 ID */
        let unavailableModel = null
        /** 请求体里的 system 首行 —— 403 兜底重试拿它比「是不是已经是用户那句」 */
        let systemFirstLine = ""
        /** 解析后的请求体 —— 403 兜底重试要用它重建 body */
        let requestJson = null
        if (typeof body === "string") {
          // 只做标记，不改 body —— 命中与否只影响错误文案
          systemFirstLine = systemFirstLineOf(originalBody)
          let json = null
          try {
            json = JSON.parse(body)
          } catch {
            /* 不是 JSON 就原样转发 */
          }
          if (json && typeof json === "object") {
            requestJson = json
            let changed = false
            const canonical = canonicalModelId(json.model)
            if (canonical !== json.model) {
              json.model = canonical
              changed = true
            }
            if (hasModelId(json.model) && isUnavailableModel(json.model)) {
              // 明确不可用名单（当前只有 kimi-k2.5）：本地挡掉，不出网、不 fallback。
              unavailableModel = String(json.model)
            }
            if (unavailableModel === null) {
              // Marvis 要求每个工具 parameters 显式 type:"object"；
              // DSH 的部分工具省略了它，缺一个就 400 invalid parameter。
              const tools = normalizeTools(json.tools)
              if (tools !== json.tools) {
                json.tools = tools
                changed = true
              }
              try {
                // 图片 URL / 裸 base64 / Anthropic image 显式归一为 data URI；
                // 转换不了就本地 400，不再静默丢图或把无效输入交给上游。
                const messages = await normalizeMessages(json.messages)
                if (messages !== json.messages) {
                  json.messages = messages
                  changed = true
                }
              } catch (err) {
                if (err instanceof InvalidImageError) {
                  return errorResponse(400, "invalid_image", `图片输入无效：${err.message}`)
                }
                throw err
              }
              // mode=always：用户明确要求「每个请求都换成我填的那句」
              if (firstLine.mode === "always") {
                const forced = withFirstLineInBody(json, firstLine.text)
                if (forced !== json) {
                  json = forced
                  changed = true
                }
              }
            }
            if (changed) body = JSON.stringify(json)
          }
        }

        // 明确不可用模型：本地 404，一次 fetch 都不发
        if (unavailableModel !== null) {
          return modelUnavailableResponse(unavailableModel)
        }

        let response
        try {
          response = await callUpstream(body)
        } catch (err) {
          if (err instanceof HeaderUnavailable) {
            return errorResponse(503, "header_unavailable", `请求头构造失败：${err.message}`)
          }
          return errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${err?.message ?? err}`)
        }

        if (response.ok) return normalizeStreaming(response)

        // —— 错误分流：只读 **错误** 的 body（成功响应绝不读，见文件头 ⚠）——
        let text = ""
        try {
          text = await response.clone().text()
        } catch {
          /* 读不出来就按状态码判 */
        }

        if (AUTH_EXPIRED.test(text) || response.status === 401) {
          return errorResponse(401, "sign_in_expired", "Marvis 登录态已过期，请重新登录。", {
            "X-Magpie-Sign-In": "expired",
          })
        }
        if (RISK_BLOCK.test(text)) {
          // 风控可重试：换新 uskey 就能过，交给宿主重试
          return errorResponse(
            503,
            "risk_blocked",
            "上游风控拦截：uskey 没有按本次请求上下文用 Beacon SDK 现签（不是登录失效，也不是密钥错）。"
              + "请把官方客户端的 beacon_wrapper.dll / beacon_sdk.dll / qimei.dll 放到插件 native/，并编译 beacon_shim.dll。"
              + "没有这套 DLL 时插件只能发随机 uskey，上游会一直返回 4100404，重试没用，换账号没用。"
              + `原始返回：${text.slice(0, 300)}`,
          )
        }
        if (MODEL_ISSUE.test(text) || response.status === 404) {
          // 模型级错误 → 404，只搁置这个模型，不打死账号（AGENTS 坑 6）
          return errorResponse(404, "model_unavailable", `该模型在当前账号不可用：${text.slice(0, 300)}`)
        }
        // ⚠ 403 +「非法请求」一律按内容过滤处理，**不再看是否命中已知指纹**。
        //   理由：上游的指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏；
        //   而 403 + 这个组合目前只出现在内容过滤上（模型无权限是 400「无效模型id」）。
        //   宁可多给一句「进群」，也不要把人甩回宿主那句「API 密钥无效」。
        if (response.status === 403 && /非法请求|permission_error/i.test(text)) {
          // 兜底：把 system 首行换成**用户自己写的那句**（选项「提示词首行替换」；留空 = 内置兜底句）
          // 重试一次。已经是那句就不白试（省一次请求，也不掩盖真问题）。
          if (firstLine.mode === "blocked" && requestJson && systemFirstLine !== firstLine.text) {
            const retried = await retryWithFallbackFirstLine(requestJson)
            if (retried) return retried
          }
          return errorResponse(403, "content_filtered", CONTENT_FILTER_HINT)
        }
        // 其余原样透出
        return new Response(text || null, {
          status: response.status,
          headers: response.headers,
        })
      },
    }
  }
}

export { DEFAULT_MODEL, credsOf }
