// Beacon 出票桥 —— 直接调官方 beacon_wrapper.dll
//
// 为什么需要这一层：官方客户端里没有 `beacon_napi.node`（那是别的发行版带的 Node
// 插件），只有 `beacon_wrapper.dll` / `beacon_sdk.dll` / `qimei.dll`。而取 uskey 要用
// 到 `beacon_wrapper.dll` 里**未导出**的 Client 单例 getter，其偏移每次客户端升级都会变。
//
// 所以这里配一个很小的 C 桥（`native/beacon_shim.dll`，源码 `marvis_beacon_shim.c`）：
// 它自己解析 PE 导出表 + 在 `beacon_get_uskey` 函数体里找第一个 `call rel32` 目标，
// 运行时定位那个 getter —— 与版本无关。JS 侧只用 bun:ffi 调三个稳定入口。
//
// 需要 native/ 里有两个文件：
//   beacon_shim.dll     —— C 桥（与版本无关，不用随客户端升级）
//   beacon_wrapper.dll  —— 官方 SDK（从客户端取，升级后替换即可）
// 以及可选的 beacon_sdk.dll / qimei.dll（beacon_wrapper 的兄弟依赖）。

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件根目录下的 native/；可用 MARVIS_NATIVE_DIR 指到外部目录 */
export const SHIM_NATIVE_DIR = process.env.MARVIS_NATIVE_DIR || join(HERE, "..", "..", "native")

const SHIM_DLL = "beacon_shim.dll"
const WRAPPER_DLL = "beacon_wrapper.dll"
// beacon_wrapper.dll's own imports. Windows resolves them by exe directory,
// system32, cwd and PATH — never by the directory the wrapper was loaded
// from — and the host exe lives in magpie's cache, not here. Loading them by
// absolute path first puts them in the process, where the wrapper finds them.
const SIBLING_DLLS = ["beacon_sdk.dll", "qimei.dll"]
const OUT_LEN = 4096
/** Loaded handles, kept for the life of the process so nothing is unloaded. */
const pinned = []

/** @type {{ symbols: any } | null} */
let lib = null
let shimTried = false
let shimError = ""
let initOk = false
let initKey = ""

/** 桥是否可用（装了文件、能加载、init 过） */
export function shimAvailable() {
  return initOk
}

/** 最近一次失败原因（诊断用） */
export function shimErrorText() {
  return shimError
}

/**
 * 加载并初始化 C 桥。失败不抛，返回 false —— 调用方据此回落到其它出票通道。
 *
 * @param {string} appKey 上游 appKey（Marvis 的 MARVIS_QIMEI_APPKEY）
 * @param {string} appVer  客户端版本号；服务端会核对，优先用真实安装版本
 * @returns {Promise<boolean>}
 */
export async function shimInit(appKey, appVer) {
  const key = `${appKey}@${appVer}`
  if (initOk && initKey === key) return true
  if (shimTried && initOk) return true
  shimTried = true

  if (!process.versions?.bun) {
    shimError = "bun:ffi 只在 Bun 运行时可用（当前不是 Bun）"
    return false
  }
  const shimPath = join(SHIM_NATIVE_DIR, SHIM_DLL)
  const wrapperPath = join(SHIM_NATIVE_DIR, WRAPPER_DLL)
  if (!existsSync(shimPath)) {
    shimError = `缺少 ${SHIM_DLL}（目录 ${SHIM_NATIVE_DIR}）`
    return false
  }
  if (!existsSync(wrapperPath)) {
    shimError = `缺少 ${WRAPPER_DLL}（目录 ${SHIM_NATIVE_DIR}）`
    return false
  }

  try {
    const { dlopen, FFIType } = await import("bun:ffi")
    if (!lib) {
      for (const name of SIBLING_DLLS) {
        const path = join(SHIM_NATIVE_DIR, name)
        if (!existsSync(path)) continue
        try {
          pinned.push(dlopen(path, {}))
        } catch {
          // The wrapper may still find it another way; the init rc says.
        }
      }
      lib = dlopen(shimPath, {
        marvis_shim_init: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.int },
        marvis_shim_uskey: { args: [FFIType.cstring, FFIType.ptr, FFIType.int], returns: FFIType.int },
        marvis_shim_qimei: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
        marvis_shim_status: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
      })
    }
    const rc = lib.symbols.marvis_shim_init(Buffer.from(`${appKey}\0`), Buffer.from(`${appVer}\0`))
    if (rc !== 0) {
      const status = shimStatus()
      shimError = `marvis_shim_init rc=${rc}${status ? `（${status}）` : ""}`
      return false
    }
    initOk = true
    initKey = key
    shimError = ""
    return true
  } catch (err) {
    shimError = `${err?.name ?? "Error"}: ${err?.message ?? err}`
    return false
  }
}

/** 桥的状态字符串（含探测到的 getter 偏移），没加载时返回空串 */
export function shimStatus() {
  if (!lib) return ""
  try {
    const buf = Buffer.alloc(1024)
    const n = lib.symbols.marvis_shim_status(buf, buf.length)
    if (n <= 0) return ""
    return buf.toString("latin1").replace(/\0[\s\S]*$/, "")
  } catch {
    return ""
  }
}

/**
 * 按 bus_info 现签一张 uskey。失败返回空串。
 * @param {string} busInfo
 * @returns {string}
 */
export function shimUskey(busInfo) {
  if (!initOk || !lib || !busInfo) return ""
  try {
    const out = Buffer.alloc(OUT_LEN)
    const n = lib.symbols.marvis_shim_uskey(Buffer.from(`${busInfo}\0`), out, out.length)
    if (n <= 0) return ""
    return out.toString("latin1").replace(/\0[\s\S]*$/, "")
  } catch {
    return ""
  }
}

/**
 * 设备 qimei36（设备级常量）。失败返回空串。
 * @returns {string}
 */
export function shimQimei() {
  if (!initOk || !lib) return ""
  try {
    const out = Buffer.alloc(256)
    const n = lib.symbols.marvis_shim_qimei(out, out.length)
    if (n <= 0) return ""
    return out.toString("latin1").replace(/\0[\s\S]*$/, "").trim()
  } catch {
    return ""
  }
}
