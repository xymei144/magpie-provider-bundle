// Regression: a provider that was switched off must come back as enabled
// after it loads again, and stale load/models errors must not stay forever.
//
// The runtime is copied into a temporary folder so this test never touches the
// real page/snapshot.js the running Magpie process writes.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = mkdtempSync(join(tmpdir(), "magpie-provider-regression-"))
const snapshotPrefix = "window.__PROVIDER_BUNDLE_SNAPSHOT__ = "
const providerId = "regression-demo"
const checks = []

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
}

function cryptoJsEncrypt(value, passphrase = "nova") {
  const salt = randomBytes(8)
  const pass = Buffer.from(passphrase, "utf8")
  let derived = Buffer.alloc(0)
  let block = Buffer.alloc(0)
  while (derived.length < 48) {
    block = createHash("md5").update(Buffer.concat([block, pass, salt])).digest()
    derived = Buffer.concat([derived, block])
  }
  const cipher = createCipheriv(
    "aes-256-cbc",
    derived.subarray(0, 32),
    derived.subarray(32, 48),
  )
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from("Salted__", "latin1"), salt, encrypted]).toString("base64")
}

function readSnapshot() {
  const text = readFileSync(join(tmp, "page", "snapshot.js"), "utf8").trim()
  const json = text.slice(snapshotPrefix.length).replace(/;\s*$/, "")
  return JSON.parse(json)
}

try {
  mkdirSync(join(tmp, "runtime"), { recursive: true })
  mkdirSync(join(tmp, "page"), { recursive: true })
  for (const name of ["snapshot.mjs", "safe.mjs"]) {
    cpSync(join(root, "runtime", name), join(tmp, "runtime", name))
  }

  writeFileSync(
    join(tmp, "page", "snapshot.js"),
    `${snapshotPrefix}${JSON.stringify({
      at: "2026-11-04T00:00:00.000Z",
      providers: {
        [providerId]: {
          enabled: false,
          models: 7,
          error: {
            phase: "load",
            message: "old import failed",
            at: "2026-11-04T00:00:00.000Z",
          },
        },
      },
    })};\n`,
    "utf8",
  )

  const snapshot = await import(pathToFileURL(join(tmp, "runtime", "snapshot.mjs")).href)
  const safe = await import(pathToFileURL(join(tmp, "runtime", "safe.mjs")).href)
  const spec = { id: providerId, label: "Regression Demo", kind: "provider" }
  const provider = safe.defineProvider(spec, async () => async () => ({
    auth: { provider: providerId },
  }))

  await provider({}, {})
  await wait(450)
  let saved = readSnapshot().providers[providerId]
  check("re-enable sets enabled=true", saved?.enabled === true, saved)
  check("re-enable keeps the model count", saved?.models === 7, saved)
  check("re-enable clears a stale load error", saved?.error === undefined, saved)

  snapshot.recordError(spec, "usage", new Error("quota failed"))
  await wait(450)
  await provider({}, {})
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("a successful load keeps a usage error", saved?.error?.phase === "usage", saved)

  snapshot.recordError(spec, "models", new Error("models failed"))
  await wait(450)
  snapshot.recordModels(spec, [{}, {}, {}])
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("a successful models call clears a models error", saved?.error === undefined, saved)
  check("a successful models call updates the count", saved?.models === 3, saved)

  // A successful call in one phase must not hide a failure in another: the
  // error slot is shared, so each path may only clear its own phase.
  snapshot.recordError(spec, "usage", new Error("quota failed"))
  snapshot.recordCheckin(spec, { outcome: "done", at: new Date().toISOString() })
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("a successful check-in keeps a usage error", saved?.error?.phase === "usage", saved)

  snapshot.recordError(spec, "check-in", new Error("check-in failed"))
  snapshot.recordUsage(spec, { windows: [] })
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("a successful usage call keeps a check-in error", saved?.error?.phase === "check-in", saved)

  snapshot.recordError(spec, "check-in", new Error("check-in failed"))
  snapshot.recordCheckin(spec, { outcome: "done", at: new Date().toISOString() })
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("a successful check-in clears a check-in error", saved?.error === undefined, saved)

  snapshot.recordError(spec, "usage", new Error("quota failed"))
  snapshot.recordUsage(spec, { windows: [] })
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("a successful usage call clears a usage error", saved?.error === undefined, saved)

  await provider({}, { providers: { [providerId]: false } })
  await wait(450)
  saved = readSnapshot().providers[providerId]
  check("disable still sets enabled=false", saved?.enabled === false, saved)

  let seenOptions
  const withDefaults = safe.defineProvider(
    { ...spec, options: { activityTier: "verified" } },
    async () => async (_input, options) => {
      seenOptions = options
      return { auth: { provider: providerId } }
    },
  )
  await withDefaults({}, {})
  check(
    "bundle defaults reach the vendor when the user has no saved option",
    seenOptions?.activityTier === "verified",
    seenOptions,
  )
  await withDefaults({}, { activityTier: "" })
  check(
    "an empty saved option overrides the bundle default",
    seenOptions?.activityTier === "",
    seenOptions,
  )

  const qiniuUsage = await import(
    pathToFileURL(join(root, "vendor", "qiniu", "lib", "usage.mjs")).href
  )
  const usageFetch = async () =>
    new Response(
      JSON.stringify({
        status: true,
        data: [
          {
            name: "qiniu/conatus-free",
            items: [
              {
                key: "output",
                unit_name: "token",
                unit_size_default: 1000,
                total: 1000,
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  const withoutLimit = await qiniuUsage.todayUsageWindow({
    accessKey: "test-ak",
    secretKey: "test-sk",
    fetchImpl: usageFetch,
  })
  check(
    "qiniu without a limit reports used tokens only",
    withoutLimit.windows?.[0]?.display === "已用 1M · 未设每日上限" &&
      withoutLimit.windows?.[0]?.limit === undefined,
    withoutLimit.windows?.[0],
  )

  const withLimit = await qiniuUsage.todayUsageWindow({
    accessKey: "test-ak",
    secretKey: "test-sk",
    dailyLimit: 1e8,
    fetchImpl: usageFetch,
  })
  const quotaWindow = withLimit.windows?.[0]
  check(
    "qiniu with a daily limit shows remaining quota",
    quotaWindow?.limit === 1e8 &&
      typeof quotaWindow?.used === "number" &&
      quotaWindow.used > 0 &&
      quotaWindow.used < 100 &&
      String(quotaWindow?.display ?? "").startsWith("剩余 "),
    quotaWindow,
  )

  const { QiniuPlugin } = await import(
    pathToFileURL(join(root, "vendor", "qiniu", "index.mjs")).href
  )
  const qiniuHooks = await QiniuPlugin({}, { activityTier: "verified" })
  const originalFetch = globalThis.fetch
  let tierWindow
  globalThis.fetch = usageFetch
  try {
    const result = await qiniuHooks.auth.usage(async () => ({
      type: "api",
      key: "test-api-key",
      metadata: { accessKey: "test-ak", secretKey: "test-secret" },
    }))
    tierWindow = result.windows?.[0]
  } finally {
    globalThis.fetch = originalFetch
  }
  check(
    "qiniu verified tier resolves to 100M tokens per day",
    tierWindow?.limit === 1e8 && String(tierWindow?.display ?? "").startsWith("剩余 "),
    tierWindow,
  )

  const sensenovaBrowser = await import(
    pathToFileURL(join(root, "vendor", "sensenova", "browser.mjs")).href
  )
  const sensenovaState = await import(
    pathToFileURL(join(root, "vendor", "sensenova", "state.mjs")).href
  )
  const sensenovaQuota = await import(
    pathToFileURL(join(root, "vendor", "sensenova", "quota.mjs")).href
  )
  const sensenovaInternal = await import(
    pathToFileURL(join(root, "vendor", "sensenova", "internal.mjs")).href
  )

  const sensenovaStoredAuth = sensenovaInternal.consoleAuthOf({
    metadata: {
      consoleToken: "console-access",
      consoleRefreshToken: "console-refresh",
      consoleCookie: "console-cookie",
    },
  })
  check(
    "sensenova reads web-login tokens and Cookie from account metadata",
    sensenovaStoredAuth.accessToken === "console-access" &&
      sensenovaStoredAuth.refreshToken === "console-refresh" &&
      sensenovaStoredAuth.cookie === "console-cookie",
    sensenovaStoredAuth,
  )
  const sensenovaLegacyAuth = sensenovaInternal.consoleAuthOf({
    metadata: {
      email: "console-user",
      password: ["legacy", "test", "password"].join("-"),
    },
  })
  check(
    "sensenova never copies a stored password out of account metadata",
    sensenovaLegacyAuth.hasPassword === true &&
      !("password" in sensenovaLegacyAuth) &&
      sensenovaLegacyAuth.username === "console-user",
    sensenovaLegacyAuth,
  )

  const encryptedLogin = cryptoJsEncrypt({
    refreshToken: "refresh-from-console",
    username: "console-user",
    userId: "user-42",
  })
  const decodedLogin = sensenovaBrowser.decryptLoginState(encryptedLogin)
  check(
    "sensenova decrypts the console's crypto-js login record",
    decodedLogin?.refreshToken === "refresh-from-console" &&
      decodedLogin?.username === "console-user" &&
      decodedLogin?.userId === "user-42",
    decodedLogin,
  )
  check(
    "sensenova ignores a corrupt console login record",
    sensenovaBrowser.decryptLoginState("not-a-login-record") === null,
  )

  const sensenovaDisabledKey = ["sensenova", "disabled", "key", "d".repeat(24)].join("-")
  const sensenovaValidKey = ["sensenova", "valid", "key", "v".repeat(24)].join("-")
  const selectedSensenovaKey = sensenovaBrowser.pickApiKey([
    { api_key: "sk-masked-************", status: "active" },
    { api_key: "short", status: "active" },
    { api_key: sensenovaDisabledKey, status: "disabled" },
    { api_key: sensenovaValidKey, status: "active" },
  ])
  check(
    "sensenova web login skips masked, short and disabled API keys",
    selectedSensenovaKey === sensenovaValidKey,
    selectedSensenovaKey,
  )

  const sensenovaSessionFile = sensenovaState.statePath(join(tmp, "sensenova-state-test.json"))
  const stateAccount = sensenovaState.accountKey("sensenova-state-test")
  sensenovaState.rememberStoredTokens(sensenovaSessionFile, stateAccount, {
    access_token: "stored-access",
    refresh_token: "stored-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  const restoredTokens = sensenovaState.storedTokens(sensenovaSessionFile, stateAccount)
  check(
    "sensenova console tokens survive a process restart",
    restoredTokens.access_token === "stored-access" &&
      restoredTokens.refresh_token === "stored-refresh",
    restoredTokens,
  )

  const cooldownUntil = Date.now() + 30 * 60_000
  sensenovaState.rememberCooldown(sensenovaSessionFile, stateAccount, {
    until: cooldownUntil,
    streak: 2,
    fingerprint: "fingerprint-a",
    reason: "rate",
    detail: "operationTooFrequently",
  })
  const activeCooldown = sensenovaState.activeCooldown(
    sensenovaSessionFile,
    stateAccount,
    "fingerprint-a",
  )
  const changedCredentialCooldown = sensenovaState.activeCooldown(
    sensenovaSessionFile,
    stateAccount,
    "fingerprint-b",
  )
  check(
    "sensenova rate-limit cooldown survives a restart",
    activeCooldown?.until === cooldownUntil && activeCooldown?.reason === "rate",
    activeCooldown,
  )
  check(
    "sensenova changing credentials bypasses the old cooldown",
    changedCredentialCooldown === null,
    changedCredentialCooldown,
  )

  const sensenovaTestPassword = ["console", "test", "password"].join("-")
  let sensenovaLegacyCalls = 0
  let sensenovaLegacyError
  try {
    await sensenovaQuota.readQuota(
      { username: "console-user", password: sensenovaTestPassword },
      {
        fetchImpl: async () => {
          sensenovaLegacyCalls += 1
          throw new Error("legacy password must never reach a network request")
        },
      },
    )
  } catch (error) {
    sensenovaLegacyError = error
  }
  check(
    "sensenova never uses a legacy password for automatic quota login",
    sensenovaLegacyCalls === 0 &&
      sensenovaLegacyError instanceof sensenovaQuota.QuotaError &&
      /网页登录/.test(sensenovaLegacyError.message),
    { sensenovaLegacyCalls, sensenovaLegacyError },
  )

  let sensenovaRefreshAttempts = 0
  const sensenovaRefreshRateFetch = async () => {
    sensenovaRefreshAttempts += 1
    return new Response(
      JSON.stringify({ error: "operationTooFrequently", error_description: "too many" }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
    )
  }
  let sensenovaRefreshRateError
  try {
    await sensenovaQuota.readQuota(
      {
        refresh_token: ["refresh", "token", "for", "test"].join("-"),
        username: "console-user",
        password: sensenovaTestPassword,
      },
      { fetchImpl: sensenovaRefreshRateFetch },
    )
  } catch (error) {
    sensenovaRefreshRateError = error
  }
  check(
    "sensenova never falls back to a password login after a 429 refresh",
    sensenovaRefreshAttempts === 1 &&
      sensenovaRefreshRateError?.rateLimited === true &&
      sensenovaRefreshRateError?.retryAfterMs === 60_000,
    { sensenovaRefreshAttempts, sensenovaRefreshRateError },
  )

  const { SenseNovaPlugin } = await import(
    pathToFileURL(join(root, "vendor", "sensenova", "index.mjs")).href
  )
  const sensenovaLegacyCredentials = join(tmp, "sensenova-legacy-credentials.json")
  const sensenovaLegacyKey = ["sensenova", "legacy", "key", "l".repeat(24)].join("-")
  const sensenovaLegacyHooks = await SenseNovaPlugin(
    {},
    { credentialsFile: sensenovaLegacyCredentials, locale: "zh" },
  )
  const sensenovaNativeFetch = globalThis.fetch
  let sensenovaLegacyProviderCalls = 0
  globalThis.fetch = async () => {
    sensenovaLegacyProviderCalls += 1
    throw new Error("legacy provider account must not touch the network")
  }
  let sensenovaLegacyUsage
  try {
    sensenovaLegacyUsage = await sensenovaLegacyHooks.auth.usage(async () => ({
      type: "api",
      key: sensenovaLegacyKey,
      metadata: { email: "console-user", password: sensenovaTestPassword },
    }))
  } finally {
    globalThis.fetch = sensenovaNativeFetch
  }
  const sensenovaLegacyCooldown = sensenovaState.activeCooldown(
    sensenovaState.statePath(sensenovaLegacyCredentials),
    sensenovaState.accountKey(sensenovaLegacyKey),
    sensenovaState.credentialFingerprint({ username: "console-user" }),
  )
  check(
    "sensenova legacy password accounts are reported without touching IAM",
    sensenovaLegacyProviderCalls === 0 &&
      /永久停用自动密码登录/.test(sensenovaLegacyUsage?.error ?? "") &&
      sensenovaLegacyCooldown === null,
    { sensenovaLegacyProviderCalls, sensenovaLegacyUsage, sensenovaLegacyCooldown },
  )

  const sensenovaRateCredentials = join(tmp, "sensenova-rate-credentials.json")
  const sensenovaRateState = sensenovaState.statePath(sensenovaRateCredentials)
  const sensenovaRateKey = ["sensenova", "rate", "key", "r".repeat(24)].join("-")
  const sensenovaRateRefresh = ["rate", "limited", "refresh", "token"].join("-")
  sensenovaState.rememberStoredTokens(
    sensenovaRateState,
    sensenovaState.accountKey(sensenovaRateKey),
    { refresh_token: sensenovaRateRefresh },
  )
  const sensenovaRateHooks = await SenseNovaPlugin(
    {},
    { credentialsFile: sensenovaRateCredentials, locale: "zh" },
  )
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: "operationTooFrequently" }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
    )
  let sensenovaRateUsage
  try {
    sensenovaRateUsage = await sensenovaRateHooks.auth.usage(async () => ({
      type: "api",
      key: sensenovaRateKey,
    }))
  } finally {
    globalThis.fetch = sensenovaNativeFetch
  }
  const persistedRateCooldown = sensenovaState.activeCooldown(
    sensenovaRateState,
    sensenovaState.accountKey(sensenovaRateKey),
    sensenovaState.credentialFingerprint({}),
  )
  check(
    "sensenova provider persists a rate-limit cooldown from a 429 refresh",
    persistedRateCooldown?.reason === "rate" &&
      persistedRateCooldown?.streak === 1 &&
      /暂停自动尝试/.test(sensenovaRateUsage?.error ?? ""),
    { persistedRateCooldown, sensenovaRateUsage },
  )

  const sensenovaCooldownCredentials = join(tmp, "sensenova-cooldown-credentials.json")
  const sensenovaCooldownState = sensenovaState.statePath(sensenovaCooldownCredentials)
  const sensenovaCooldownKey = ["sensenova", "cooldown", "key", "c".repeat(24)].join("-")
  const sensenovaCooldownAccount = sensenovaState.accountKey(sensenovaCooldownKey)
  sensenovaState.rememberStoredTokens(
    sensenovaCooldownState,
    sensenovaCooldownAccount,
    {
      access_token: ["cooldown", "console", "access", "token"].join("-"),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  )
  sensenovaState.rememberCooldown(sensenovaCooldownState, sensenovaCooldownAccount, {
    until: Date.now() + 45 * 60_000,
    streak: 3,
    fingerprint: sensenovaState.credentialFingerprint({}),
    reason: "rate",
    detail: "operationTooFrequently",
  })
  const sensenovaCooldownHooks = await SenseNovaPlugin(
    {},
    { credentialsFile: sensenovaCooldownCredentials, locale: "zh" },
  )
  let sensenovaFetchCalled = false
  globalThis.fetch = async () => {
    sensenovaFetchCalled = true
    throw new Error("cooldown must prevent network access")
  }
  let sensenovaCooldownUsage
  try {
    sensenovaCooldownUsage = await sensenovaCooldownHooks.auth.usage(async () => ({
      type: "api",
      key: sensenovaCooldownKey,
    }))
  } finally {
    globalThis.fetch = sensenovaNativeFetch
  }
  check(
    "sensenova quota honors a disk cooldown before any network request",
    sensenovaFetchCalled === false &&
      /暂停自动尝试/.test(sensenovaCooldownUsage?.error ?? ""),
    { sensenovaFetchCalled, sensenovaCooldownUsage },
  )

  const sensenovaTokenCredentials = join(tmp, "sensenova-token-credentials.json")
  const sensenovaTokenState = sensenovaState.statePath(sensenovaTokenCredentials)
  const sensenovaTokenKey = ["sensenova", "token", "key", "t".repeat(24)].join("-")
  const sensenovaStoredAccess = ["stored", "console", "access", "token"].join("-")
  const sensenovaStoredRefresh = ["stored", "console", "refresh", "token"].join("-")
  sensenovaState.rememberStoredTokens(
    sensenovaTokenState,
    sensenovaState.accountKey(sensenovaTokenKey),
    { access_token: sensenovaStoredAccess, refresh_token: sensenovaStoredRefresh },
  )
  const sensenovaTokenHooks = await SenseNovaPlugin(
    {},
    { credentialsFile: sensenovaTokenCredentials, locale: "zh" },
  )
  let sensenovaUsageRequest
  globalThis.fetch = async (input, init) => {
    sensenovaUsageRequest = {
      input: String(input),
      headers: new Headers(init?.headers),
    }
    return new Response(
      JSON.stringify({
        plan: { name: "Free Plan" },
        pools: [
          {
            name: "通用积分池",
            pool_type: "shared",
            window_5h: { limit: 100, remaining: 75 },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  let sensenovaStoredUsage
  try {
    sensenovaStoredUsage = await sensenovaTokenHooks.auth.usage(async () => ({
      type: "api",
      key: sensenovaTokenKey,
    }))
  } finally {
    globalThis.fetch = sensenovaNativeFetch
  }
  check(
    "sensenova reuses a persisted console token without a password login",
    sensenovaUsageRequest?.input.endsWith("/lite/console/v1/tokenplan/pool-usage") &&
      sensenovaUsageRequest?.headers.get("authorization") ===
        `Bearer ${sensenovaStoredAccess}` &&
      sensenovaStoredUsage?.windows?.[0]?.amount === 25,
    { sensenovaUsageRequest, sensenovaStoredUsage },
  )

  const sensenovaConcurrentCredentials = join(tmp, "sensenova-concurrent-credentials.json")
  const sensenovaConcurrentState = sensenovaState.statePath(sensenovaConcurrentCredentials)
  const sensenovaConcurrentKey = ["sensenova", "concurrent", "key", "f".repeat(24)].join("-")
  sensenovaState.rememberStoredTokens(
    sensenovaConcurrentState,
    sensenovaState.accountKey(sensenovaConcurrentKey),
    {
      access_token: ["concurrent", "console", "access", "token"].join("-"),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  )
  const sensenovaConcurrentHooks = await SenseNovaPlugin(
    {},
    { credentialsFile: sensenovaConcurrentCredentials, locale: "zh" },
  )
  let sensenovaConcurrentRequests = 0
  let releaseConcurrent
  const concurrentGate = new Promise((resolve) => {
    releaseConcurrent = resolve
  })
  globalThis.fetch = async () => {
    sensenovaConcurrentRequests += 1
    await concurrentGate
    return new Response(
      JSON.stringify({
        plan: { name: "Free Plan" },
        pools: [{ name: "通用积分池", pool_type: "shared", window_5h: { limit: 100, remaining: 60 } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  let sensenovaConcurrentResults
  try {
    const getConcurrentAuth = async () => ({ type: "api", key: sensenovaConcurrentKey })
    const first = sensenovaConcurrentHooks.auth.usage(getConcurrentAuth)
    const second = sensenovaConcurrentHooks.auth.usage(getConcurrentAuth)
    for (let i = 0; i < 50 && sensenovaConcurrentRequests === 0; i += 1) await wait(10)
    const requestsWhileWaiting = sensenovaConcurrentRequests
    releaseConcurrent()
    sensenovaConcurrentResults = await Promise.all([first, second])
    check(
      "sensenova concurrent usage polls share one quota request",
      requestsWhileWaiting === 1 &&
        sensenovaConcurrentRequests === 1 &&
        sensenovaConcurrentResults.every((result) => result.windows?.[0]?.amount === 40),
      {
        requestsWhileWaiting,
        sensenovaConcurrentRequests,
        sensenovaConcurrentResults,
      },
    )
  } finally {
    releaseConcurrent()
    globalThis.fetch = sensenovaNativeFetch
  }

  const sparkConsole = await import(
    pathToFileURL(join(root, "vendor", "spark", "console.mjs")).href
  )
  const sparkQuotaWindow = sparkConsole.freeQuotaWindow({
    data: {
      claim: {
        appId: "app-test",
        freeQuota: {
          totalTokens: 10_000_000,
          usedTokens: 2_500_000,
          remainingTokens: 7_500_000,
          quotaStatus: "ACTIVE",
          expiresAt: "2026-12-31 23:59:59",
        },
      },
    },
  })
  check(
    "spark free quota turns into a remaining/total window",
    sparkQuotaWindow?.limit === 10_000_000 &&
      sparkQuotaWindow?.amount === 7_500_000 &&
      sparkQuotaWindow?.used === 25 &&
      sparkQuotaWindow?.display === "剩余 7.5M / 共 10M（已用 2.5M）",
    sparkQuotaWindow,
  )

  const sparkNoClaim = sparkConsole.freeQuotaWindow({ data: { claim: null } })
  check(
    "spark missing claim is not invented as zero balance",
    sparkNoClaim?.display === "未领取（请到星辰控制台领取）" &&
      sparkNoClaim?.limit === 0,
    sparkNoClaim,
  )

  const sparkKeys = sparkConsole.pickApiKey([
    { apiKey: "ak-old", createTime: "2026-01-01 10:00:00" },
    { apiKey: "ak-new", createTime: "2026-11-01 10:00:00" },
  ])
  check("spark web login picks the newest console API key", sparkKeys === "ak-new", sparkKeys)
  check(
    "spark console token accepts JSON and a Bearer prefix",
    sparkConsole.normalizeConsoleToken(
      JSON.stringify({ value: "Bearer token-abc" }),
    ) === "token-abc",
  )
  check(
    "spark console code 4001 becomes a visible error",
    sparkConsole.consoleResponseError({ code: 4001, message: "用户未登录" }) ===
      "用户未登录",
  )
  check(
    "spark console code 0 is not an error",
    sparkConsole.consoleResponseError({ code: 0, data: [] }) === "",
  )
  check(
    "spark console key rows unwrap the data envelope",
    sparkConsole.apiKeyRows({
      code: 0,
      data: [{ apiKey: "ak-test", createTime: "2026-11-01 10:00:00" }],
    }).length === 1,
  )
  check(
    "spark console user unwraps the data envelope",
    sparkConsole.userOfConsolePayload({
      code: 0,
      data: { email: "user@example.test" },
    })?.email === "user@example.test",
  )

  const abortedKeys = new AbortController()
  abortedKeys.abort()
  const abortedKeyRead = await sparkConsole.fetchApiKeys({
    token: "token-abc",
    signal: abortedKeys.signal,
  })
  check(
    "spark console request stops when sign-in is cancelled",
    abortedKeyRead.aborted === true && abortedKeyRead.error === "登录已取消",
    abortedKeyRead,
  )

  let sparkUsageRequest = null
  const sparkUsageFetch = async (input, init) => {
    sparkUsageRequest = { input: String(input), headers: new Headers(init?.headers) }
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          claim: {
            freeQuota: {
              totalTokens: 1_000,
              usedTokens: 250,
              remainingTokens: 750,
              quotaStatus: "ACTIVE",
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const sparkUsage = await sparkConsole.fetchFreeQuota({
    token: "console-token",
    cookie: "test-cookie",
    fetchImpl: sparkUsageFetch,
  })
  check(
    "spark free-quota request uses the console channel and headers",
    sparkUsage?.data?.claim?.freeQuota?.remainingTokens === 750 &&
      sparkUsageRequest?.input.includes("channel=spark-x2.6") &&
      sparkUsageRequest?.headers.get("authorization") === "console-token" &&
      sparkUsageRequest?.headers.get("cookie") === "test-cookie" &&
    { sparkUsage, sparkUsageRequest },
  )

  const sparkBrowser = await import(
    pathToFileURL(join(root, "vendor", "spark", "browser.mjs")).href
  )
  const consoleCookieHeader = sparkBrowser.formatConsoleCookies([
    { domain: ".xfyun.cn", name: "ssoSessionId", value: "session-test", path: "/" },
    { domain: "maas.xfyun.cn", name: "account_id", value: "42", path: "/" },
    { domain: ".example.com", name: "foreign", value: "no", path: "/" },
    {
      domain: ".xfyun.cn",
      name: "expired",
      value: "no",
      path: "/",
      expires: 1,
    },
  ])
  check(
    "spark cookie reader keeps only live xfyun cookies",
    consoleCookieHeader === "account_id=42; ssoSessionId=session-test",
    consoleCookieHeader,
  )

  // iFlytek's SSO cookie names change; the console page's own answer is the
  // sign-in proof, and the cookie header only has to be usable.
  const probeOnlySession = sparkBrowser.usableSession({
    token: "",
    cookie: "account_id=42",
    signedIn: true,
  })
  check(
    "spark session accepts a page-proven sign-in with only cookies",
    probeOnlySession?.signedIn === true && probeOnlySession?.cookie === "account_id=42",
    probeOnlySession,
  )
  const probeWithoutCredentials = sparkBrowser.usableSession({
    token: "",
    cookie: "",
    signedIn: true,
  })
  check(
    "spark session is not saved when the page proved a sign-in but no cookie was read",
    probeWithoutCredentials === null,
    probeWithoutCredentials,
  )
  const longToken = "x".repeat(24)
  const tokenOnlySession = sparkBrowser.usableSession({
    token: longToken,
    cookie: "",
    signedIn: false,
  })
  check(
    "spark session still accepts a long console token alone",
    tokenOnlySession?.token === longToken && tokenOnlySession?.cookie === "",
    tokenOnlySession,
  )
  const localCookieValue = ["x-auth-token", "test-session-value"].join("=")
  const localCookieSession = sparkBrowser.usableSession({
    token: "",
    cookie: "SESSION=anonymous; di_c_mti=analytics",
    localCookie: localCookieValue,
    signedIn: false,
  })
  check(
    "spark session accepts localStorage x-auth-token and replays it verbatim",
    localCookieSession?.cookie === localCookieValue && localCookieSession?.signedIn === false,
    localCookieSession,
  )
  const anonymousCookieSession = sparkBrowser.usableSession({
    token: "",
    cookie: "SESSION=anonymous; di_c_mti=analytics",
    localCookie: "",
    signedIn: false,
  })
  check(
    "spark session rejects anonymous cookies alone",
    anonymousCookieSession === null,
    anonymousCookieSession,
  )

  let cookieOnlyRequest = null
  const cookieOnly = await sparkConsole.fetchFreeQuota({
    cookie: "ssoSessionId=session-test; account_id=42",
    fetchImpl: async (input, init) => {
      cookieOnlyRequest = { input: String(input), headers: new Headers(init?.headers) }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            claim: {
              freeQuota: {
                totalTokens: 1_000,
                usedTokens: 250,
                remainingTokens: 750,
                quotaStatus: "ACTIVE",
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })
  check(
    "spark free quota works with a cookie-only console session",
    cookieOnly?.data?.claim?.freeQuota?.remainingTokens === 750 &&
      cookieOnlyRequest?.headers.get("cookie") ===
        "ssoSessionId=session-test; account_id=42" &&
      !cookieOnlyRequest?.headers.has("authorization"),
    { cookieOnly, cookieOnlyRequest },
  )

  const sparkWithoutSession = await sparkConsole.fetchFreeQuota({})
  check(
    "spark without a token or cookie reports not signed in",
    sparkWithoutSession?.error === "未登录星辰控制台",
    sparkWithoutSession,
  )

  const { SparkX26AuthPlugin } = await import(
    pathToFileURL(join(root, "vendor", "spark", "index.mjs")).href
  )
  const sparkHooks = await SparkX26AuthPlugin({}, {})
  const nativeFetch = globalThis.fetch
  let sparkCookieUsage
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          claim: {
            freeQuota: {
              totalTokens: 1_000,
              usedTokens: 250,
              remainingTokens: 750,
              quotaStatus: "ACTIVE",
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  try {
    sparkCookieUsage = await sparkHooks.auth.usage(async () => ({
      type: "api",
      access: "ak-test",
      metadata: { consoleCookie: "ssoSessionId=session-test; account_id=42" },
    }))
  } finally {
    globalThis.fetch = nativeFetch
  }
  check(
    "spark provider usage accepts a cookie-only account",
    sparkCookieUsage?.windows?.[0]?.amount === 750 &&
      sparkCookieUsage?.windows?.[0]?.limit === 1_000,
    sparkCookieUsage,
  )

  const sparkExpired = await sparkConsole.fetchFreeQuota({
    token: "console-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 4001, message: "用户未登录" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  })
  check(
    "spark expired console session is reported as sign-in expired",
    sparkExpired?.signIn === "expired" && /登录已过期/.test(sparkExpired?.error ?? ""),
    sparkExpired,
  )

  const sparkCookieExpired = await sparkConsole.fetchFreeQuota({
    cookie: "ssoSessionId=session-test",
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 4001, message: "用户未登录" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  })
  check(
    "spark expired cookie session is reported as sign-in expired",
    sparkCookieExpired?.signIn === "expired" &&
      /登录已过期/.test(sparkCookieExpired?.error ?? ""),
    sparkCookieExpired,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const failed = checks.filter((entry) => !entry.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
if (failed.length) process.exit(1)
