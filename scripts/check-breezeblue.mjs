// Executable checks for the BreezeBlue provider: cookie decryption/selection,
// credits parsing and daily-claim outcomes. No network, no browser.

import { createCipheriv, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureLoginSession,
  cookieHeaderFrom,
  createPlugin,
  decryptCookie,
  loginCookieHeader,
  profileDirectory,
  waitForBrowserSession,
} from "../vendor/breezeblue/index.mjs"

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) console.log("FAIL", name, detail)
}

let calls = []
function fakeFetch(handlers) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const handler = handlers[String(url)] ?? handlers.default
    const { status = 200, body = {} } = typeof handler === "function" ? handler(init) : handler
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
}
const auth = async () => ({ type: "api", key: "x", metadata: { cookie: "a=1; b=2" } })

function v10(key, value) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, body, cipher.getAuthTag()])
}

// 1. cookie decrypt + domain/expiry filtering
{
  const key = randomBytes(32)
  const rows = [
    { host_key: ".breezeblue.ai", name: "s", encrypted_value: v10(key, "1"), expires_utc: 0 },
    { host_key: "breezeblue.ai", name: "t", encrypted_value: v10(key, "2"), expires_utc: 0 },
    { host_key: ".google.com", name: "nope", encrypted_value: v10(key, "3"), expires_utc: 0 },
    { host_key: ".breeze.blue", name: "old", encrypted_value: v10(key, "4"), expires_utc: 1 },
    // 真实库里的 expires_utc 超过 2^53，rowsFor 用文本取回；这里按文本喂进去。
    { host_key: ".breezeblue.ai", name: "big", encrypted_value: v10(key, "5"), expires_utc: "13438551699344272" },
    { host_key: ".breezeblue.ai", name: "past", encrypted_value: v10(key, "6"), expires_utc: "11644473600000000" },
  ]
  const header = cookieHeaderFrom(rows, key, Date.now())
  check("cookie filter", header === "s=1; t=2; big=5", header)
  check("decrypt roundtrip", decryptCookie(key, v10(key, "hello")) === "hello")
  check("non-v10 rejected", (() => {
    try {
      decryptCookie(key, Buffer.concat([Buffer.from("v20", "latin1"), Buffer.alloc(40)]))
      return false
    } catch {
      return true
    }
  })())
}

// 2. usage parse
{
  const p = createPlugin({
    fetchImpl: fakeFetch({
      default: { body: { ok: true, balance: 1486, plan: "Free", subscription_credits: 0, rollover_credits: 0, claim_credits: 1486, topup_credits: 0 } },
    }),
  })
  const u = await p.auth.usage(auth)
  check("usage total", u.windows?.[0]?.name === "Credits" && u.windows[0].balance === 1486, u)
  check("usage plan", u.plan === "Free", u.plan)
  check("usage claim window", u.windows.some((w) => w.name === "签到" && w.balance === 1486), u.windows)
  check("usage sends cookie", calls.at(-1)?.init?.headers?.cookie === "a=1; b=2", calls.at(-1)?.init?.headers)
}

// 3. usage 401
{
  const p = createPlugin({ fetchImpl: fakeFetch({ default: { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } } }) })
  const u = await p.auth.usage(auth)
  check("usage expired", u.signIn === "expired" && u.windows.length === 0, u)
}

// 4. checkin claimed
{
  const p = createPlugin({ fetchImpl: fakeFetch({ default: { body: { ok: true, credits_added: 100, balance: 1586 } } }) })
  const c = await p.auth.checkin(auth)
  check("checkin claimed", c.outcome === "claimed" && c.credit === 100, c)
}

// 5. checkin already done
{
  const p = createPlugin({
    fetchImpl: fakeFetch({ default: { status: 409, body: { ok: false, code: "ALREADY_CLAIMED", detail: "Already claimed today" } } }),
  })
  const c = await p.auth.checkin(auth)
  check("checkin done", c.outcome === "done", c)
}

// 5b. already claimed today is 200 with claimed:false (the real reply)
{
  const p = createPlugin({
    fetchImpl: fakeFetch({
      default: { body: { claimed: false, already_claimed: true, credits_issued: 0, balance: 1735.8, daily_claim_claimed_today: true } },
    }),
  })
  const c = await p.auth.checkin(auth)
  check("checkin already claimed is done", c.outcome === "done" && c.credit === undefined, c)
}

// 5c. a real claim reports the issued credits
{
  const p = createPlugin({
    fetchImpl: fakeFetch({ default: { body: { claimed: true, already_claimed: false, credits_issued: 400, balance: 2135.8 } } }),
  })
  const c = await p.auth.checkin(auth)
  check("checkin claimed credits", c.outcome === "claimed" && c.credit === 400, c)
}

// 5d. credits summary as the site really returns it
{
  const p = createPlugin({
    fetchImpl: fakeFetch({
      default: {
        body: {
          balance: 1735.8,
          granted_total: 1800,
          consumed_total: 64.2,
          daily_claim_amount: 400,
          daily_claim_available: false,
          daily_claim_claimed_today: true,
        },
      },
    }),
  })
  const u = await p.auth.usage(auth)
  check("usage real shape", u.windows?.[0]?.balance === 1735.8, u)
}

// 6. checkin 401 throws signIn
{
  const p = createPlugin({ fetchImpl: fakeFetch({ default: { status: 401, body: { ok: false, code: "AUTH_REQUIRED" } } }) })
  let threw = null
  try {
    await p.auth.checkin(auth)
  } catch (error) {
    threw = error
  }
  check("checkin expired throws", threw?.signIn === "expired", threw?.message)
}

// 7. no cookie → ineligible
{
  const p = createPlugin({ fetchImpl: fakeFetch({ default: { body: {} } }) })
  const c = await p.auth.checkin(async () => ({ type: "api", key: "x", metadata: {} }))
  check("checkin no session", c.outcome === "ineligible", c)
}

// 8. browser login result is shaped for magpie
{
  const p = createPlugin({
    captureSession: async () => ({ cookie: "c=1", me: { email: "user@example.com" }, profile: "magpie" }),
  })
  const method = p.auth.methods.find((m) => m.type === "oauth")
  const res = await method.authorize()
  const out = await res.callback()
  check("browser login shape", out.type === "success" && out.accountId === "user@example.com" && out.metadata.cookie === "c=1", out)
}

// 8b. CDP cookie list → header (domain filter + expiry)
{
  const header = loginCookieHeader([
    { domain: ".breezeblue.ai", name: "a", value: "1", expires: -1 },
    { domain: "breezeblue.ai", name: "b", value: "2", expires: 0 },
    { domain: ".breeze.blue", name: "gone", value: "3", expires: 1 },
    { domain: ".example.com", name: "nope", value: "4", expires: -1 },
  ])
  check("cdp cookie header", header === "a=1; b=2", header)
}

// 8d. stored session is reused headlessly (no login window)
{
  const env = { LOCALAPPDATA: mkdtempSync(join(tmpdir(), "bb-stored-")) }
  let killed = []
  let headless = null
  const session = await captureLoginSession({
    env,
    now: () => 0,
    sleep: async () => {},
    launch: (_exe, dir, _url, options) => {
      headless = options?.headless
      writeFileSync(join(profileDirectory(env), "DevToolsActivePort"), "41235\n/devtools/browser/y\n")
      return { pid: 99 }
    },
    kill: (pid) => killed.push(pid),
    readCookies: async () => [{ domain: ".breezeblue.ai", name: "s", value: "old", expires: -1 }],
    fetchImpl: fakeFetch({ default: { body: { email: "reuse@example.com" } } }),
  })
  check("stored session reused", headless === true && session.me.email === "reuse@example.com", { headless, session })
  check("stored session closed", killed.length === 1, killed)
}

// 8c. capture: opens a plain login window (no debug port), waits until it closes,
// then reads the session headlessly
{
  const env = { LOCALAPPDATA: mkdtempSync(join(tmpdir(), "bb-login-")) }
  let killed = []
  let clock = 0
  let windowClosed = false
  let windowPid = 0
  const session = await captureLoginSession({
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    killProfile: () => {},
    launchWindow: () => {
      windowPid = 4321
      const emitter = new EventEmitter()
      emitter.pid = 4321
      setTimeout(() => {
        windowClosed = true
        emitter.emit("exit")
      }, 0)
      return emitter
    },
    launch: () => {
      writeFileSync(join(profileDirectory(env), "DevToolsActivePort"), "41234\n/devtools/browser/x\n")
      return { pid: 777 }
    },
    kill: (pid) => killed.push(pid),
    readCookies: async () =>
      windowClosed ? [{ domain: ".breezeblue.ai", name: "s", value: "tok", expires: -1 }] : [],
    fetchImpl: fakeFetch({ default: { body: { email: "late@example.com" } } }),
  })
  check("capture waits for window close", session.cookie === "s=tok" && session.me.email === "late@example.com", session)
  check("capture closes login window", killed.includes(windowPid), killed)
}

// 9. waits for the browser to exit, then reads
{
  let callsLeft = 2
  let clock = 0
  const waited = await waitForBrowserSession({
    readSession: async () => {
      if (callsLeft-- > 0) throw Object.assign(new Error("locked"), { code: "locked" })
      return { cookie: "c=2", me: { email: "late@example.com" } }
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    timeoutMs: 10000,
    stepMs: 1000,
  })
  check("waits for browser exit", waited.status === "ready" && waited.session.me.email === "late@example.com", waited)
}

// 10. times out instead of hanging forever
{
  let clock = 0
  const waited = await waitForBrowserSession({
    readSession: async () => {
      throw Object.assign(new Error("locked"), { code: "locked" })
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    timeoutMs: 3000,
    stepMs: 1000,
  })
  check("lock timeout", waited.status === "timeout", waited)
}

console.log(JSON.stringify({ ok: checks.every((c) => c.ok), passed: checks.filter((c) => c.ok).length, total: checks.length }))
process.exit(checks.every((c) => c.ok) ? 0 : 1)
