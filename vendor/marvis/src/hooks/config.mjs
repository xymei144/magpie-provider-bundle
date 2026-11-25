// ① config —— 声明 provider 与静态模型表
//
// ⚠ `config.models` 必须有内容：它是**没人登录时**模型列表的唯一来源，
//   空了就是「插件装上了但显示 0 models」。
//
// ⚠⚠ **模型表是对象，键是真实模型显示名**（`cfg.models[<id>]`），不是内部槽位名。
//   写成数组会被 magpie 存成数组下标 `"0"…"7"`，路由里显示 `0`、请求发 `model:"0"`，上游 400。
//
// ⚠⚠ **用户在 magpie 设置里改过的值优先，插件不许覆盖。**
//   宿主把用户改过的 provider 配置原样传进来（`cfg.provider[PROVIDER]`），
//   我们要做的是「**补齐缺失**」，不是「重置成默认」。
//
// 合并规则（逐模型、逐字段）：
//   · 用户有的字段 → 保留用户的（`limit.context` / `limit.output` / `modalities` / `name` …）
//   · 用户没有的字段 → 用默认值补
//   · 默认表里有、用户配置里没有的模型 → 追加（新版本新增模型能自动出现）
//   · 能归一到默认表的旧条目（数字下标 `"0"`…`"7"` / 槽位名 `main-auto` / 真实显示名）
//     → 归一成真实显示名，`apiId` 保留上游槽位名
//   · 默认表外的手工 / 旧槽位（`app-auto` / `file-auto` / `computer-auto` / `browser-auto` …）
//     → **原样保留**，键 / id / name 都不改写成别的模型
//   · 只有 `isUnavailableModel` 明确判为不可用的条目（当前只有 `kimi-k2.5`）被删除
//
// 边界一句话：**不可用 denylist + 其余保留**。默认表（TABLE）是**对外展示目录**，
// 不是上游可用性的全集 —— 旧真实槽位不在目录里，但上游仍返回 200，删掉就是误伤用户配置。

import {
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  BASE_V1,
  staticModels,
  canonicalModelId,
  displayModelId,
  isUnavailableModel,
} from "../context.mjs"

/**
 * 候选值 → 去掉首尾空白的字符串。
 *
 * ⚠ 手工配置 / 旧版本落盘里常带首尾空白（`"main-auto "`、`" main-auto"`）。
 *   **不 trim 就会绕过归一**：`"main-auto "` 落不进默认表，于是走「保留」分支，
 *   以 `main-auto` 为键露出来；第二次合并它又能落进默认表 —— 用户看到模型漂移。
 *   所以所有候选值在归一 / 比对 / 当键之前都必须先 trim。
 */
function trimmedText(value) {
  return value === undefined || value === null ? "" : String(value).trim()
}

/** 给定值 → 真实显示名（槽位名 / 旧数字下标 / 真实模型名都能归一；未知原样返回） */
function toDisplayName(value) {
  return displayModelId(canonicalModelId(trimmedText(value)))
}

/**
 * 在默认表里找一个匹配的键。
 *
 * 依次尝试每个候选值（**先 trim**）：先按 `displayModelId` 直接归一，再经
 * `canonicalModelId` 把旧数字下标 / 槽位名换成显示名。全部匹配不到 → 返回
 * undefined（=不在展示目录里）。
 *
 * @param {Record<string, any>} defaults
 * @param {...unknown} values
 * @returns {string | undefined}
 */
function matchDefaultKey(defaults, ...values) {
  for (const value of values) {
    const key = trimmedText(value)
    if (key === "") continue
    const direct = displayModelId(key)
    if (defaults[direct]) return direct
    const aliased = toDisplayName(key)
    if (defaults[aliased]) return aliased
  }
  return undefined
}

/** 纯数字 = 旧数组下标（能归一进默认表的在上面已经匹配掉了） */
function isBareIndex(value) {
  return value !== undefined && value !== null && /^\d+$/.test(String(value).trim())
}

/**
 * 从候选值里挑一个能当模型键的：非空、且不是纯数字下标。
 * 越界的纯数字下标没有名字可用，不能拿它当键（否则路由里显示 `9`、上游 400）。
 */
function keepableId(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text === "" || isBareIndex(text)) continue
    return text
  }
  return undefined
}

/** 条目是否落在**不可用 denylist** 里（键 / id / apiId 任一命中） */
function isUnavailableEntry(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue
    if (isUnavailableModel(value)) return true
  }
  return false
}

/**
 * 名字归一：缺省、或是内部槽位名（main-auto）/ 旧数字下标 → 回落到真实键。
 * 用户自己起的普通名字（含自定义展示名）原样保留。
 */
function normalizeName(rawName, id) {
  const name = trimmedText(rawName)
  return name === "" || toDisplayName(name) !== name ? id : name
}

/** 合并一个默认表内的模型：用户字段优先，缺的用默认值补；键 / id / name 一律用真实显示名 */
function mergeModel(userModel, defaultModel, id) {
  const merged = { ...(defaultModel ?? {}), ...(userModel ?? {}) }
  merged.id = id
  merged.apiId = canonicalModelId(userModel?.apiId ?? defaultModel?.apiId ?? id)

  // limit 逐字段合并 —— 只改 context 的用户不该把 output 也吃掉
  merged.limit = { ...(defaultModel?.limit ?? {}), ...(userModel?.limit ?? {}) }

  // config 形状用 modalities 数组 + tool_call 下划线；用户可能只改了其中一个
  if (userModel?.modalities || defaultModel?.modalities) {
    merged.modalities = {
      ...(defaultModel?.modalities ?? {}),
      ...(userModel?.modalities ?? {}),
    }
  }

  // name 必须是真实显示名：缺省、或是内部槽位名（main-auto）、或旧数字下标
  // 都回落到真实显示名；用户自定义的真实名字保留。
  merged.name = normalizeName(merged.name, id)
  return merged
}

/**
 * 保留一条默认表外的条目：字段一律以用户的为准，只补 `id` / `name` 的缺省。
 *
 * ⚠ 这里**不做**默认值补全 —— 没有默认值可用，凭空补字段就是编造上游能力。
 * ⚠ 这里**不**把 `id` / `name` 归一到别的模型：`app-auto` 保留成 `app-auto`。
 */
function keepModel(userModel, id) {
  const kept = { ...(userModel ?? {}) }
  kept.id = id
  kept.name = normalizeName(kept.name, id)
  // apiId 是上游真正认的 id：用户给了就照用，缺省时用条目自己的键
  if (kept.apiId === undefined || kept.apiId === null || kept.apiId === "") kept.apiId = id
  return kept
}

/**
 * 合并模型表（不可用 denylist + 其余保留）。
 *
 * @param {Record<string, any>} defaults 插件内置的默认表（对象）
 * @param {Record<string, any> | any[] | undefined} user 宿主里用户改过的表（对象；旧版可能是数组）
 * @returns {Record<string, any>}
 */
export function mergeModels(defaults, user) {
  const defaultIds = Object.keys(defaults)
  /** @type {Record<string, any>} */
  const out = {}
  const seen = new Set()

  if (Array.isArray(user)) {
    // 旧版：数组下标就是 TABLE 顺序。按位置认回槽位名，字段仍用用户的。
    // ⚠ 条目自带可归一的 id（数字下标 / 槽位名 / 显示名）→ 用它；否则用位置。
    user.forEach((um, index) => {
      if (!um || typeof um !== "object" || Array.isArray(um)) return
      const positional = defaultIds[index]
      const hasOwnId = um.id !== undefined && um.id !== null && um.id !== ""
      const matched = hasOwnId
        ? matchDefaultKey(defaults, um.id, um.apiId)
        : positional && defaults[positional]
          ? positional
          : undefined
      if (matched) {
        out[matched] = mergeModel(um, defaults[matched], matched)
        seen.add(matched)
        return
      }
      // 不在展示目录里：只有 denylist 明确判死的才删，其余原样保留
      if (isUnavailableEntry(um.id, um.apiId)) return
      const id = hasOwnId ? keepableId(um.id, um.apiId) : undefined
      if (!id) return // 没有可用的名字（越界纯数字下标）→ 无法保留
      out[id] = keepModel(um, id)
      seen.add(id)
    })
  } else if (user && typeof user === "object") {
    for (const [key, um] of Object.entries(user)) {
      if (!um || typeof um !== "object" || Array.isArray(um)) continue
      // 键可能是显示名、旧槽位名（main-auto）、旧数字下标；都归一成显示名。
      const matched = matchDefaultKey(defaults, key, um.id, um.apiId)
      if (matched) {
        out[matched] = mergeModel(um, defaults[matched], matched)
        seen.add(matched)
        continue
      }
      // 不在展示目录里：denylist 删（如 kimi-k2.5），其余保留（如 app-auto）
      if (isUnavailableEntry(key, um.id, um.apiId)) continue
      const id = keepableId(key, um.id, um.apiId)
      if (!id) continue
      out[id] = keepModel(um, id)
      seen.add(id)
    }
  }

  // 默认表里有、用户没有的 → 追加（新版本新增的模型）
  for (const id of defaultIds) {
    if (!seen.has(id)) out[id] = mergeModel(undefined, defaults[id], id)
  }
  return out
}

export function configHook() {
  return async (cfg) => {
    cfg.provider ??= {}
    const existing = cfg.provider[PROVIDER]

    if (!existing) {
      cfg.provider[PROVIDER] = {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE_V1,
        models: staticModels(),
      }
      return
    }

    // 已有配置：只补缺，用户改过的优先
    existing.name ??= PROVIDER_NAME
    existing.npm ??= SDK
    existing.api ??= BASE_V1
    existing.models = mergeModels(staticModels(), existing.models)
  }
}
