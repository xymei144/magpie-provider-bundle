// Marvis 上游协议 —— 请求头与签名
//
// 两个上游，两套鉴权，**不能混**：
//   /v1/chat/completions  模型网关 → 只要 Ual-Access-Openid/Access-Token/Login-Type/Guid
//                                       + Ual-Access-MarvisExt（uskey 指纹）。**不要**签名。
//   /v3/*                 业务接口 → 要 md5(query + timestamp + accessKey + nonce) 签名。
//
// 把签名头加到模型网关上是**错**的：会从 403 风控变成 401 登录态过期（实测）。
//
// ⚠ 模型网关的 UA 必须是 `AsyncOpenAI/Python 2.32.0`（Marvis agent 自己的）。
//   换成浏览器 UA 或 magpie 自己的 UA 都会被风控拦（4100404）。

import { createHash, randomUUID } from "node:crypto"
import { ACCESS_KEY, BUSINESS_ID, CLIENT, BROWSER_UA, BASE } from "../context.mjs"
import { uskeyOf, qimei36 } from "./fingerprint.mjs"

function hex32() {
  return randomUUID().replace(/-/g, "")
}

/**
 * 本次请求的 Marvis 上下文。uskey 的 bus_info 和 Marvis-* 头必须用同一份 id。
 *
 * @param {{ openid?: string, loginType?: string }} acct
 * @param {{ scene?: string, agentTag?: string, model?: string, conversationId?: string, responseId?: string, nonce?: string }} [opts]
 */
export function requestIdentity(acct, opts = {}) {
  const agentTag = opts.agentTag || "main"
  const scene = opts.scene || "agent_chat"
  const model = opts.model || "main-auto"
  const conversationId = opts.conversationId || `conv_${hex32()}`
  const responseId = opts.responseId || `resp_${hex32()}`
  const nonce = opts.nonce || randomUUID()
  const loginType = String(opts.loginType || acct?.loginType || "1")
  const busInfo = [
    `marvisAgentTag=${agentTag}`,
    `marvisConversationID=${conversationId}`,
    `marvisResponseID=${responseId}`,
    `marvisScene=${scene}`,
    `model=${model}`,
    `nonce=${nonce}`,
    `originOpenID=${acct?.openid ?? ""}`,
  ].join("&")
  return { agentTag, scene, model, conversationId, responseId, nonce, loginType, busInfo }
}

/**
 * 模型网关要求的 `Ual-Access-MarvisExt`。uskey 按 bus_info 现签。
 *
 * @param {{ guid?: string, openid?: string, clientVersion?: string, loginType?: string }} acct
 * @param {{ busInfo: string, nonce: string, loginType?: string }} identity
 * @returns {Promise<string>}
 */
export async function marvisExt(acct, identity) {
  const uskey = await uskeyOf(acct, identity)
  const qimei = qimei36()
  return JSON.stringify({
    ...(qimei ? { qimei36: qimei } : {}),
    osVersion: process.env.MARVIS_OS_VERSION || "Windows-10-10.0.26100",
    guid: acct.guid ?? "",
    uskey,
    nonce: identity.nonce,
    reqScene: 1,
    taskType: "user",
    clientVersion: acct.clientVersion || process.env.MARVIS_CLIENT_VERSION || "1.60.3400.795",
    clientPlatform: "Windows",
    clientPlatformVersion: process.env.MARVIS_CLIENT_PLATFORM_VERSION || "1.60.3400.35",
    isIoa: false,
  })
}

/**
 * 模型网关的完整请求头。
 *
 * @param {{ openid: string, accessToken: string, guid: string, loginType?: string }} acct
 * @param {{ scene?: string, agentTag?: string, model?: string, conversationId?: string, responseId?: string }} [opts]
 * @returns {Promise<Record<string, string>>}
 */
export async function llmHeaders(acct, opts = {}) {
  const identity = requestIdentity(acct, opts)
  const ext = await marvisExt(acct, identity)
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": CLIENT,
    "X-Stainless-Lang": "python",
    "X-Stainless-Package-Version": "2.32.0",
    "X-Stainless-OS": "Windows",
    "X-Stainless-Arch": "other:amd64",
    "X-Stainless-Runtime": "CPython",
    "X-Stainless-Runtime-Version": "3.11.9",
    "X-Stainless-Async": "async:asyncio",
    "X-Stainless-Raw-Response": "true",
    "X-Stainless-Read-Timeout": "600.0",
    "X-Stainless-Retry-Count": "0",
    Authorization: "Bearer placeholder",
    "Ual-Access-Openid": acct.openid,
    "Ual-Access-Access-Token": acct.accessToken,
    "Ual-Access-Login-Type": identity.loginType,
    "Ual-Access-Guid": acct.guid ?? "",
    "Ual-Access-Requestid": identity.responseId,
    "Marvis-AgentTag": identity.agentTag,
    "Marvis-Conversation-ID": identity.conversationId,
    "Marvis-Response-ID": identity.responseId,
    "Marvis-Scene": identity.scene,
    "Marvis-Model-Level": "1",
    "Marvis-Protocol-Version": "1000",
    "X-Device-GUID": acct.guid ?? "",
    "Ual-Access-MarvisExt": ext,
  }
}

/**
 * `/v3/*` 业务接口的签名。
 *
 * 逆向自 Marvis 主进程：`md5(query + timestamp + accessKey + nonce)`，
 * accessKey 硬编码在渲染层（`fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi`）。
 * 实测重放真实请求返回 200。
 *
 * @param {string} query 签名原文 —— GET 是查询串（不含 `?`），POST 是 JSON body
 * @param {string} timestamp 毫秒时间戳
 * @param {string} nonce 4 位随机数
 * @returns {string} 32 位小写 hex
 */
export function ualSignature(query, timestamp, nonce) {
  return createHash("md5").update(query + timestamp + ACCESS_KEY + nonce).digest("hex")
}

/**
 * `/v3/*` 业务接口的完整请求头。
 *
 * @param {{ openid: string, accessToken: string, guid: string, loginType?: string }} acct
 * @param {{ query: string, method?: string }} opts
 * @returns {Record<string, string>}
 */
export function businessHeaders(acct, { query, method = "GET" }) {
  const timestamp = String(Date.now())
  const nonce = String(1000 + Math.floor(Math.random() * 9000))
  return {
    Accept: "*/*",
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": BROWSER_UA,
    "Ual-Access-Businessid": BUSINESS_ID,
    "Ual-Access-Timestamp": timestamp,
    "Ual-Access-Nonce": nonce,
    "Ual-Access-Signature": ualSignature(query, timestamp, nonce),
    "Ual-Access-Guid": acct.guid ?? "",
    "Ual-Access-Access-Token": acct.accessToken,
    "Ual-Access-Login-Type": acct.loginType ?? "1",
    "Ual-Access-Openid": acct.openid,
    ...(method === "POST" ? {} : {}),
  }
}

/** 模型网关地址 */
export const CHAT_URL = `${BASE}/v1/chat/completions`
