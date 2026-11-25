// 出站请求体的**通用正则替换层**（用户可配置，改文件即生效，不用重装插件）
//
// 为什么需要它：上游 Marvis 的内容过滤拦的是「system 里某些身份短语」，而它的指纹
// 表在持续扩大 —— 英文整句 → 中文写法 → 连字符形态（`DeepSeek-Harness` 也已 403）。
// loader.mjs 里内置的 IDENTITY_PHRASES 只能覆盖**我们已经见过**的写法；这一层让用户
// 自己加规则，不必等插件发版。
//
// 落点只有一个：`auth.loader` 的 `fetch(input, init)` —— 它是 magpie 发出真实请求的
// **唯一出口**，`init.body` 在这里还是可改的 JSON 字符串。`loader.headers` 与
// `chat.headers` 只能加请求头，改不了正文。
//
// ⚠ 四条硬约束（写错会静默坏事）：
//   1. 只在 **JSON 结构内按字段**替换，绝不对序列化后的整串跑正则 —— 正则里一个引号
//      就能把 JSON 改坏，用户只会看到 400，而且不知道是谁干的。
//   2. 不碰 `tool_calls` / `tool` 角色的返回值 / 图片 part —— 那是数据，不是提示词。
//   3. 改过 body 必须删 `content-length` / `content-encoding`，让 fetch 重新算。
//   4. 一条规则编译失败**只跳过它**，不抛 —— 用户写错一个正则不能打死整个 provider。
//
// 规则文件：`~/.cache/magpie/marvis-redact.json`（插件自己的缓存目录，不写 magpie 的配置）
// 文件形态见下方 TEMPLATE；插件首次运行会**自动写一份带示例的模板**，用户照着改就行。

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/** 规则条数上限 —— 太长的规则表会让每个请求都变慢，也说明配错了 */
const MAX_RULES = 64
/** 单条 pattern 长度上限（防灾难性回溯） */
const MAX_PATTERN = 2000
/** 默认作用域：与上游判据一致（system 首行），最不容易误伤 */
const DEFAULT_SCOPE = "system-first-line"
const SCOPES = new Set(["system-first-line", "system", "all"])
/** statSync 的节流：2 秒内复用上次结果，热路径上别每请求都碰磁盘 */
const STAT_TTL_MS = 2000

const TEMPLATE = {
  _readme:
    "在 rules 里加规则即可，保存后下一次请求就生效，不用重启 magpie。" +
    " scope 三种：system-first-line（只改 system 消息首行，最安全）/ system（改 system 全文）" +
    " / all（改所有消息，含 user 与 assistant，但跳过 tool 返回值）。" +
    " replacement 支持 $1 $2 反向引用。enabled: false 可临时停用而不删规则。",
  rules: [
    {
      enabled: false,
      pattern: "You are an AI agent powered by (DeepSeek)\\s+(Harness)",
      flags: "i",
      replacement: "You are an AI agent running in $1 $2",
      scope: "system-first-line",
    },
  ],
}

/** @returns {{ dir: string, rules: string, hits: string }} */
function paths() {
  const { homedir } = require("node:os")
  const { join } = require("node:path")
  const dir = join(homedir(), ".cache", "magpie")
  return {
    dir,
    rules: join(dir, "marvis-redact.json"),
    hits: join(dir, "marvis-redact-hits.json"),
  }
}

/** 首次运行写一份模板，让用户有个能直接改的文件（失败就算了，不影响主流程） */
let templateTried = false
function ensureTemplate() {
  if (templateTried) return
  templateTried = true
  try {
    const { existsSync, mkdirSync, writeFileSync } = require("node:fs")
    const p = paths()
    mkdirSync(p.dir, { recursive: true })
    if (!existsSync(p.rules)) {
      writeFileSync(p.rules, `${JSON.stringify(TEMPLATE, null, 2)}\n`)
    }
  } catch {
    /* 写不进去就算了，别因为这份模板把主流程搞挂 */
  }
}

/**
 * 把一条原始规则编译成可用的东西。
 * 任何一处不合法都返回 null（跳过这条），绝不抛 —— 见文件头约束 4。
 *
 * @param {unknown} raw
 * @returns {{ re: RegExp, replacement: string, scope: string, pattern: string } | null}
 */
function compile(raw) {
  if (!raw || typeof raw !== "object") return null
  const rule = /** @type {any} */ (raw)
  if (rule.enabled === false) return null
  const pattern = typeof rule.pattern === "string" ? rule.pattern : ""
  if (!pattern || pattern.length > MAX_PATTERN) return null
  const replacement = typeof rule.replacement === "string" ? rule.replacement : ""
  const scope = SCOPES.has(rule.scope) ? rule.scope : DEFAULT_SCOPE
  // 只留安全 flags，并**强制 g**：不带 g 的 replace 只改第一处，用户会以为规则没生效
  const flags = typeof rule.flags === "string" ? rule.flags.replace(/[^imsu]/g, "") : "i"
  try {
    return { re: new RegExp(pattern, `${flags}g`), replacement, scope, pattern }
  } catch {
    return null
  }
}

/** @type {{ at: number, mtimeMs: number, rules: Array<ReturnType<typeof compile>> }} */
let cache = { at: 0, mtimeMs: -1, rules: [] }

/**
 * 读用户规则。文件不存在 = 没有用户规则（返回空表，内置规则照旧跑）。
 * 带 mtime 缓存：改了文件不用重启，下一次请求（≤2 秒后）自动生效。
 *
 * @returns {Array<{ re: RegExp, replacement: string, scope: string, pattern: string }>}
 */
export function loadRules() {
  ensureTemplate()
  const now = Date.now()
  if (now - cache.at < STAT_TTL_MS) return cache.rules
  cache.at = now

  let mtimeMs
  try {
    const { statSync } = require("node:fs")
    mtimeMs = statSync(paths().rules).mtimeMs
  } catch {
    cache = { at: now, mtimeMs: -1, rules: [] }
    return cache.rules
  }
  if (mtimeMs === cache.mtimeMs) return cache.rules

  let parsed = null
  try {
    const { readFileSync } = require("node:fs")
    parsed = JSON.parse(readFileSync(paths().rules, "utf8"))
  } catch {
    // JSON 写坏了：保留上一次能用的规则，不要因为这个文件把出站请求搞挂
    cache.at = now
    return cache.rules
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rules) ? parsed.rules : []
  const rules = []
  for (const item of list.slice(0, MAX_RULES)) {
    const rule = compile(item)
    if (rule) rules.push(rule)
  }
  cache = { at: now, mtimeMs, rules }
  return rules
}

/** 服务端诊断用：当前实际生效的规则（只读，不含任何请求内容） */
export function describeRules() {
  return loadRules().map((rule) => ({ pattern: rule.pattern, scope: rule.scope }))
}

/** 最近命中的规则 —— 用户靠它确认「我写的规则到底有没有跑」 */
let pendingHits = /** @type {Array<any>} */ ([])
let flushTimer = /** @type {any} */ (null)

function flushHits() {
  flushTimer = null
  if (pendingHits.length === 0) return
  const batch = pendingHits
  pendingHits = []
  try {
    const { readFileSync, writeFileSync, mkdirSync } = require("node:fs")
    const p = paths()
    mkdirSync(p.dir, { recursive: true })
    let prev = []
    try {
      const old = JSON.parse(readFileSync(p.hits, "utf8"))
      if (Array.isArray(old?.recent)) prev = old.recent
    } catch {
      /* 没有或坏了：从空开始 */
    }
    const recent = [...batch, ...prev].slice(0, 50)
    writeFileSync(p.hits, `${JSON.stringify({ at: new Date().toISOString(), recent }, null, 2)}\n`)
  } catch {
    /* 写不进去就算了 */
  }
}

function recordHit(rule, sample) {
  pendingHits.push({
    at: new Date().toISOString(),
    pattern: rule.pattern,
    scope: rule.scope,
    sample,
  })
  if (pendingHits.length > 20) pendingHits.shift()
  if (flushTimer) return
  flushTimer = setTimeout(flushHits, 1000)
  if (typeof flushTimer?.unref === "function") flushTimer.unref()
}

/** 首行切分：与 loader.mjs 的判据保持一致（上游只看第一行） */
function firstLineOf(text) {
  const cut = text.indexOf("\n")
  return cut < 0 ? text : text.slice(0, cut)
}

/**
 * 对一段文本按规则表替换。
 * `role` 决定哪几条规则适用（`all` 只跳过 tool 角色）。
 *
 * @param {string} text
 * @param {string} role
 * @param {Array<{ re: RegExp, replacement: string, scope: string, pattern: string }>} rules
 * @returns {string}
 */
function rewriteText(text, role, rules) {
  if (!text) return text
  let out = text
  for (const rule of rules) {
    if (role === "tool") continue
    if (rule.scope !== "all" && role !== "system") continue

    let head
    let tail
    if (rule.scope === "system-first-line") {
      head = firstLineOf(out)
      tail = out.slice(head.length)
    } else {
      head = out
      tail = ""
    }

    const replaced = head.replace(rule.re, rule.replacement)
    if (replaced === head) continue
    out = replaced + tail
    recordHit(rule, replaced.slice(0, 120))
  }
  return out
}

/**
 * 按用户规则改写 messages。**返回原引用**表示没改过 —— 调用方据此决定要不要重新序列化。
 *
 * 只碰 `content`：字符串，或 content 数组里的 `{ type: "text" }` 片段。
 * `tool_calls`、工具返回值、图片 part 一律不碰。
 *
 * @param {unknown} messages
 * @param {Array<{ re: RegExp, replacement: string, scope: string, pattern: string }>} [rules]
 * @returns {unknown}
 */
export function rewriteMessagesByRules(messages, rules) {
  const list = rules ?? loadRules()
  if (!Array.isArray(messages) || list.length === 0) return messages

  let touched = false
  const out = messages.map((message) => {
    if (!message || typeof message !== "object") return message
    const role = typeof message.role === "string" ? message.role : ""

    if (typeof message.content === "string") {
      const content = rewriteText(message.content, role, list)
      if (content === message.content) return message
      touched = true
      return { ...message, content }
    }

    if (Array.isArray(message.content)) {
      let partTouched = false
      const parts = message.content.map((part) => {
        if (!part || typeof part !== "object") return part
        if (part.type !== "text" || typeof part.text !== "string") return part
        const text = rewriteText(part.text, role, list)
        if (text === part.text) return part
        partTouched = true
        return { ...part, text }
      })
      if (!partTouched) return message
      touched = true
      return { ...message, content: parts }
    }

    return message
  })
  return touched ? out : messages
}

/** 测试用：清掉缓存，让下一次 loadRules 重新读盘 */
export function resetRuleCache() {
  cache = { at: 0, mtimeMs: -1, rules: [] }
  templateTried = false
  pendingHits = []
}
