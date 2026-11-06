// Acceptance check: the generated entry and the page agree with the config.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import providers from "../providers.config.mjs"
import {
  accountLabel,
  accountLabelForAccount,
  accountsOf,
  parseStoredSnapshot,
  redactError,
} from "../runtime/snapshot.mjs"
import { sanitizeFetchRequest, sanitizeJsonText } from "../runtime/safe.mjs"
import { sanitizeOutgoing } from "../vendor/spark/index.mjs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const expected = providers.map((provider) => provider.export)
const ids = providers.map((provider) => provider.id)
const uniqueIds = new Set(ids)
const loginKinds = new Set(["web", "desktop", "key", "public"])
const badLogin = providers
  .filter((provider) => provider.kind !== "tools")
  .filter(
    (provider) =>
      !Array.isArray(provider.login) ||
      provider.login.length === 0 ||
      provider.login.some((kind) => !loginKinds.has(kind)),
  )
  .map((provider) => provider.id)

const mod = await import("../index.mjs")
const exported = Object.keys(mod)
const sparkHooks = await mod.SparkX26AuthPlugin({}, {})
const sparkLoader = await sparkHooks.auth.loader(async () => ({
  type: "api",
  key: "test-key",
}))
const originalFetch = globalThis.fetch
let loaderBody = ""
globalThis.fetch = async (_input, init) => {
  loaderBody = typeof init?.body === "string" ? init.body : ""
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
try {
  await sparkLoader.fetch("https://example.test/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"a\u0000\u0006b"}',
  })
} finally {
  globalThis.fetch = originalFetch
}
const loaderSanitizeOk =
  loaderBody === '{"input":"ab"}' &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(loaderBody)

const longcatHooks = await mod.LongCatAuthPlugin({}, {})
const longcatLoader = await longcatHooks.auth.loader(async () => ({
  type: "api",
  key: "test-key",
}))
const longcatConfig = { provider: {} }
await longcatHooks.config(longcatConfig)
const longcatModel = (await longcatHooks.provider.models({ id: "longcat" }))["LongCat-2.5"]
let longcatBody = ""
let longcatAuth = ""
globalThis.fetch = async (_input, init) => {
  longcatBody = typeof init?.body === "string" ? init.body : ""
  longcatAuth = new Headers(init?.headers).get("authorization") ?? ""
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
try {
  await longcatLoader.fetch("https://example.test/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"a\u0000b"}',
  })
} finally {
  globalThis.fetch = originalFetch
}
const longcatProviderOk = Boolean(
  longcatHooks.auth.provider === "longcat" &&
    longcatLoader.baseURL === "https://api.longcat.chat/openai/v1" &&
    longcatConfig.provider.longcat?.api === "https://api.longcat.chat/openai/v1" &&
    longcatModel?.limit?.context === 1_048_576 &&
    longcatModel?.limit?.output === 262_144 &&
    longcatModel?.capabilities?.input?.image === true &&
    longcatModel?.capabilities?.input?.video === true &&
    longcatModel?.capabilities?.interleaved?.field === "reasoning_content" &&
    longcatBody === '{"input":"ab"}' &&
    longcatAuth === "Bearer test-key",
)
const missing = expected.filter((name) => typeof mod[name] !== "function")
const extra = exported.filter((name) => !expected.includes(name))
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const pageFile = pkg?.magpie?.page?.file
const pageOk = typeof pageFile === "string" && existsSync(join(root, pageFile))
const appJs = existsSync(join(root, "page", "app.js"))
  ? readFileSync(join(root, "page", "app.js"), "utf8")
  : ""
const indexHtml = existsSync(join(root, "page", "index.html"))
  ? readFileSync(join(root, "page", "index.html"), "utf8")
  : ""
const panels = Array.isArray(pkg?.magpie?.panels) ? pkg.magpie.panels : []
const panel = panels.find((entry) => entry?.slot === "provider")
const panelHtmlFile = panel?.file ? join(root, panel.file) : ""
const panelFileOk = Boolean(panelHtmlFile && existsSync(panelHtmlFile))
const panelHtml = panelFileOk ? readFileSync(panelHtmlFile, "utf8") : ""
const panelJs = panelFileOk
  ? readFileSync(join(dirname(panelHtmlFile), "provider-panel.js"), "utf8")
  : ""
const panelOk = Boolean(
  panelFileOk &&
    panelHtml.includes("_magpie/bridge.js") &&
    panelHtml.includes("--magpie-") &&
    panelJs.includes("accountLabels") &&
    !/\bfetch\s*\(/.test(panelJs),
)
const panelTitleOk = panel?.titles?.zh === "供应商状态"
const catalogOk = existsSync(join(root, "page", "catalog.js"))
const catalogText = catalogOk ? readFileSync(join(root, "page", "catalog.js"), "utf8") : ""
let catalogData = []
try {
  catalogData = JSON.parse(
    catalogText
      .replace(/^window\.__PROVIDER_BUNDLE_CATALOG__\s*=\s*/, "")
      .replace(/;\s*$/, ""),
  )
} catch {
  catalogData = []
}
const sparkCatalog = catalogData.find((entry) => entry?.id === "spark-x2-6")
const sparkCatalogOk = Boolean(
  sparkCatalog?.baseUrl === "https://maas-api.cn-huabei-1.xf-yun.com/v2" &&
    sparkCatalog?.defaultModel === "spark-x2.6" &&
    /OpenAI-compatible/.test(sparkCatalog?.protocol || "") &&
    sparkCatalog?.usage === true &&
    sparkCatalog?.login?.includes("web") &&
    sparkCatalog?.login?.includes("key"),
)
const longcatCatalog = catalogData.find((entry) => entry?.id === "longcat")
const longcatCatalogOk = Boolean(
  longcatCatalog?.baseUrl === "https://api.longcat.chat/openai/v1" &&
    longcatCatalog?.defaultModel === "LongCat-2.5" &&
    /OpenAI-compatible/.test(longcatCatalog?.protocol || "") &&
    longcatCatalog?.usage === false &&
    longcatCatalog?.checkin === false,
)
const qoderCatalog = catalogData.find((entry) => entry?.id === "qoder")
const qoderPatCatalogOk = Boolean(qoderCatalog?.login?.includes("web") && qoderCatalog?.login?.includes("key"))
const readonlyOk = Boolean(
  appJs.includes("已登录") &&
    appJs.includes("待登录") &&
    appJs.includes("已停用") &&
    !appJs.includes("magpie plugin logout") &&
    !appJs.includes("reloginCommand") &&
    !appJs.includes("按分组筛选") &&
    !panelJs.includes("magpie plugin logout") &&
    !panelJs.includes("reloginCommand") &&
    !panelHtml.includes("reloginCommand") &&
    panelHtml.includes("原生") &&
    panelHtml.includes("移除") &&
    panelJs.includes("铅笔") &&
    panelJs.includes("Key 模式") &&
    indexHtml.includes("登录状态") &&
    indexHtml.includes("铅笔") &&
    !indexHtml.includes("按分组筛选") &&
    !indexHtml.includes("magpie plugin logout") &&
    !/\bfetch\s*\(/.test(appJs),
)
const snapshotOk = existsSync(join(root, "page", "snapshot.js"))
const entryOk = existsSync(join(root, "index.mjs"))
const entry = entryOk ? readFileSync(join(root, "index.mjs"), "utf8") : ""
// Vendors must be imported lazily so one broken package cannot fail the rest.
const lazyOnly = !/^import\s[^\n]*\.\/vendor\//m.test(entry) && !/^import\s+\*\s+as\s/m.test(entry)
const privacyCases = [
  ["API key …bca1", "Key •••• bca1"],
  ["\u0000\u0001", "账号 2"],
  ["Bearer abcdefghijklmnop", "账号 3"],
  ["sk-abcdefghijklmnop", "账号 4"],
]
const maskCases = [
  ["1852558332@qq.com", "1***@qq.com"],
  ["1***@qq.com", "1***@qq.com"],
  ["17605543723", "176****23"],
  ["156****5208", "156****5208"],
]
const privacyFailures = privacyCases
  .map(([input, expected], index) => ({
    input,
    expected,
    actual: accountLabel(input, index),
  }))
  .filter((entry) => entry.actual !== entry.expected)
const maskFailures = maskCases
  .map(([input, expected]) => ({
    input,
    expected,
    actual: accountLabel(input, 0),
  }))
  .filter((entry) => entry.actual !== entry.expected)
const accountCases = [
  [{ type: "api", accountId: "", hint: "bca1" }, 0, "Key •••• bca1"],
  [{ type: "api", accountId: "", hint: "", key: "sk-should-not-appear" }, 0, "账号 1"],
  [{ type: "success", accountId: "17605543723" }, 0, "176****23"],
  [{ type: "oauth", accountId: "156****5208" }, 1, "156****5208"],
  [{ type: "oauth", accountId: "oiwkbchr" }, 1, "账号 2"],
]
const accountFailures = accountCases
  .map(([account, index, expected]) => ({
    expected,
    actual: accountLabelForAccount(account, index),
  }))
  .filter((entry) => entry.actual !== entry.expected)
const accountsShapeOk =
  accountsOf({ accounts: { type: "api" } }).length === 1 &&
  accountsOf({ accounts: [{}, {}] }).length === 2 &&
  accountsOf({ accounts: [] }).length === 0 &&
  accountsOf({}).length === 0
const errorText = redactError("invalid character '\u0000' in string literal")
const requestOk = !sanitizeOutgoing('{"input":"a\u0000b"}').includes("\u0000")
const nulBody = '{"input":"a\u0000b"}'
const controlBody = '{"input":"a\u0006b"}'
const escapedBody = '{"input":"a\\u0000b"}'
const unicodeBody = '{"input":"安全 😀"}'
const cleanNul = sanitizeJsonText(nulBody)
const cleanControl = sanitizeJsonText(controlBody)
const cleanEscaped = sanitizeJsonText(escapedBody)
const cleanUnicode = sanitizeJsonText(unicodeBody)
const requestObject = new Request("https://example.test/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: controlBody,
})
const sanitizedRequest = await sanitizeFetchRequest(requestObject)
const requestBody =
  sanitizedRequest.init?.body ?? (await sanitizedRequest.input.clone().text())
const requestBodyOk =
  !requestBody.includes("\u0006") &&
  JSON.parse(requestBody)?.input === "ab"
const jsonControlOk =
  !cleanNul.includes("\u0000") &&
  !cleanControl.includes("\u0006") &&
  JSON.parse(cleanNul)?.input === "ab" &&
  JSON.parse(cleanControl)?.input === "ab" &&
  cleanEscaped === escapedBody &&
  cleanUnicode === unicodeBody
const storedAt = "2026-11-02T08:30:00.000Z"
const storedSnapshot = `window.__PROVIDER_BUNDLE_SNAPSHOT__ = ${JSON.stringify({
  at: storedAt,
  providers: {
    demo: {
      enabled: false,
      accountLabels: ["API key …bca1"],
      models: 7,
      usage: {
        at: storedAt,
        plan: "Free",
        windows: [{ name: "Credits", display: "42 / 100", used: 42 }],
      },
      checkin: {
        at: "2026-11-02T07:00:00.000Z",
        outcome: "claimed",
        credit: 10,
      },
    },
  },
})};\n`
const restored = parseStoredSnapshot(storedSnapshot)
const persistenceOk =
  restored.demo?.enabled === false &&
  restored.demo?.models === 7 &&
  restored.demo?.usage?.at === storedAt &&
  restored.demo?.usage?.windows?.[0]?.display === "42 / 100" &&
  restored.demo?.checkin?.at === "2026-11-02T07:00:00.000Z" &&
  !Object.hasOwn(restored.demo ?? {}, "accountLabels")
const privacyOk =
  privacyFailures.length === 0 &&
  maskFailures.length === 0 &&
  accountFailures.length === 0 &&
  accountsShapeOk &&
  !accountLabelForAccount({ type: "api", hint: "bca1", key: "sk-should-not-appear" }).includes(
    "should-not-appear",
  ) &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(errorText) &&
  requestOk

if (
  missing.length ||
  extra.length ||
  duplicateIds.length ||
  uniqueIds.size !== ids.length ||
  badLogin.length ||
  !pageOk ||
  !panelOk ||
  !panelTitleOk ||
  !catalogOk ||
  !sparkCatalogOk ||
  !longcatCatalogOk ||
  !longcatProviderOk ||
  !qoderPatCatalogOk ||
  !readonlyOk ||
  !snapshotOk ||
  !entryOk ||
  !lazyOnly ||
  !privacyOk ||
  !jsonControlOk ||
  !requestBodyOk ||
  !loaderSanitizeOk ||
  !persistenceOk
) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        missing,
        extra,
        duplicateIds,
        badLogin,
        pageOk,
        panelOk,
        panelTitleOk,
        catalogOk,
        sparkCatalogOk,
        longcatCatalogOk,
        longcatProviderOk,
        qoderPatCatalogOk,
        readonlyOk,
        snapshotOk,
        entryOk,
        lazyOnly,
        privacyOk,
        privacyFailures,
        maskFailures,
        accountFailures,
        accountsShapeOk,
        errorText,
        requestOk,
        jsonControlOk,
        requestBodyOk,
        loaderSanitizeOk,
        persistenceOk,
        exported: exported.sort(),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      providers: providers.filter((provider) => provider.kind !== "tools").length,
      tools: providers.filter((provider) => provider.kind === "tools").length,
      page: pageFile,
      panel: panel?.file,
      panelOk,
      panelTitleOk,
      sparkCatalogOk,
      longcatCatalogOk,
      longcatProviderOk,
      qoderPatCatalogOk,
      readonlyOk,
      privacyOk,
      jsonControlOk,
      requestBodyOk,
      loaderSanitizeOk,
      persistenceOk,
      exported: exported.sort(),
    },
    null,
    2,
  ),
)
