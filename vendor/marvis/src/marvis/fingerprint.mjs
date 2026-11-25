// 设备指纹 —— uskey / qimei36 的来源
//
// 这两个值都是 Marvis 客户端在本地生成的设备标识，随每个请求放进
// `Ual-Access-MarvisExt` 头里。本模块负责给出符合上游格式的值。
//
// 2026-11-17 之后，`/v1/chat/completions` 会校验 uskey 是否按**本次请求的 bus_info**
// 由 Beacon SDK 现签。随机串第一次就会 4100404。
//
// 出票顺序：
//   1. native/beacon_shim.dll + beacon_wrapper.dll（官方 Windows 客户端只有 DLL，没有 napi）
//   2. native/beacon_napi.node（旧的 Node 插件形态，可选）
//   3. 随机串（没有 SDK 时的兜底；线上会被 4100404）
//
// DLL 不随仓库分发。桥的源码在 native/marvis_beacon_shim.c。
//
// ⚠ `qimei36` 取不到真值时返回空串，由调用方整个不发该字段 ——
//   这个字段上游要求与设备一致，不适合用占位值冒充。

import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { shimAvailable, shimInit, shimQimei, shimUskey } from "./beacon-shim.mjs"

/** 与 beacon_shim 初始化用的 appKey / 版本。可用环境变量覆盖。 */
const SHIM_APP_KEY = process.env.MARVIS_QIMEI_APPKEY || "0WIN06Y06DKV1IUQ"
const SHIM_APP_VERSION = process.env.MARVIS_APP_VERSION || "1.60.3400.35"

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件根目录下的 native/ —— 可选 */
export const NATIVE_DIR = join(HERE, "..", "..", "native")

/** 四个文件一起才工作（beacon_napi.node 靠同目录兄弟 DLL 动态加载） */
const REQUIRED = ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]

/** 上游 appKey —— 来自 Marvis 的 resources/.env 的 MARVIS_QIMEI_APPKEY */
const APP_KEY = "0WIN06Y06DKV1IUQ"
const APP_VERSION = "1.60.3300.408"

/** uskey 的字节长度 */
export const USKEY_BYTES = 376

/** @type {{ getUskey: Function, getQimei: Function } | null} */
let beacon = null
let beaconTried = false

/**
 * 尝试加载**可选**的 Beacon SDK。失败不抛、不阻塞 —— 返回 null 即走本地生成。
 * @returns {{ getUskey: Function, getQimei: Function } | null}
 */
function tryBeacon() {
  if (beaconTried) return beacon
  beaconTried = true
  try {
    if (!REQUIRED.every((f) => existsSync(join(NATIVE_DIR, f)))) return null
    const mod = require(join(NATIVE_DIR, "beacon_napi.node"))
    if (mod.init({ appKey: APP_KEY, appVersion: APP_VERSION }) !== 0) return null
    beacon = mod
    return mod
  } catch {
    return null
  }
}

/**
 * 按本次请求上下文出一张 uskey。
 *
 * @param {{ guid?: string, openid?: string } | string} [acct]
 *   旧调用 `uskeyOf("marvis_client")` 仍然接受，但没有 busInfo 时签不出上下文票。
 * @param {{ busInfo?: string }} [identity]
 * @returns {Promise<string>}
 */
export async function uskeyOf(acct = {}, identity = {}) {
  const busInfo = typeof acct === "string" ? "" : String(identity?.busInfo || "")
  const businessId = typeof acct === "string" ? acct : "marvis"

  if (busInfo && (await shimInit(SHIM_APP_KEY, SHIM_APP_VERSION))) {
    const ticket = shimUskey(busInfo)
    if (ticket) return ticket
  }

  const b = tryBeacon()
  if (b) {
    try {
      const real = String(b.getUskey(businessId, busInfo || { reqScene: 1, taskType: "user" }) ?? "")
      if (real && real !== "null") return real
    } catch {
      /* 拿不到就落到本地生成，不阻塞请求 */
    }
  }
  return localUskey()
}

/**
 * 本地生成 uskey：与上游格式一致的 base64 串。
 * @returns {string}
 */
export function localUskey() {
  return randomBytes(USKEY_BYTES).toString("base64")
}

/**
 * `localUskey()` 的别名，保留旧名字方便迁移。
 * @returns {string}
 */
export function syntheticUskey() {
  return localUskey()
}

/**
 * 设备 qimei36 —— **取不到真值就返回空串**。
 * 调用方据此决定要不要把该字段放进请求。
 * @returns {string} 真值或空串
 */
export function qimei36() {
  const fromShim = shimQimei()
  if (fromShim) return fromShim
  const b = tryBeacon()
  if (!b) return ""
  try {
    return String(b.getQimei() ?? "")
  } catch {
    return ""
  }
}

/** 当前是否在用 SDK 签指纹（诊断用） */
export function usingNativeFingerprint() {
  return shimAvailable() || tryBeacon() !== null
}

/** 给用户看的说明 */
export function fingerprintHint() {
  return usingNativeFingerprint()
    ? "使用 native/ 里的 Beacon SDK 现签设备指纹"
    : "本地生成设备指纹（无需 native/ 目录）"
}
