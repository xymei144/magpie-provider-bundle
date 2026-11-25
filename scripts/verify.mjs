// Acceptance check: the generated entry and the page agree with the config.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import providers from "../providers.config.mjs"
import { buildCatalog } from "./generate.mjs"
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
const noPanelOk = panels.length === 0
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
// The page catalog must mirror the config for every provider, field by
// field: a stale catalog.js would otherwise still pass while the page shows
// the wrong label or the wrong login kinds.
const CATALOG_FIELDS = [
  "id",
  "label",
  "mark",
  "group",
  "order",
  "kind",
  "icon",
  "options",
  "usage",
  "checkin",
  "login",
  "baseUrl",
  "protocol",
  "defaultModel",
]
const expectedCatalog = buildCatalog(providers)
const catalogMismatches = []
const catalogById = new Map(catalogData.map((entry) => [entry?.id, entry]))
for (const expected of expectedCatalog) {
  const actual = catalogById.get(expected.id)
  if (!actual) {
    catalogMismatches.push({
      id: expected.id,
      field: "id",
      expected: expected.id,
      actual: "(missing from catalog.js)",
    })
    continue
  }
  for (const field of CATALOG_FIELDS) {
    const want = JSON.stringify(expected[field] ?? null)
    const got = JSON.stringify(actual[field] ?? null)
    if (want !== got) {
      catalogMismatches.push({
        id: expected.id,
        field,
        expected: expected[field] ?? null,
        actual: actual[field] ?? null,
      })
    }
  }
}
for (const entry of catalogData) {
  if (expectedCatalog.some((expected) => expected.id === entry?.id)) continue
  catalogMismatches.push({
    id: entry?.id ?? null,
    field: "id",
    expected: "(not in providers.config.mjs)",
    actual: entry?.id ?? null,
  })
}
const catalogMatchesOk = catalogMismatches.length === 0
const readonlyOk = Boolean(
  appJs.includes("已登录") &&
    appJs.includes("待登录") &&
    appJs.includes("已停用") &&
    !appJs.includes("magpie plugin logout") &&
    !appJs.includes("reloginCommand") &&
    !appJs.includes("按分组筛选") &&
    indexHtml.includes("登录状态") &&
    indexHtml.includes("铅笔") &&
    !indexHtml.includes("按分组筛选") &&
    !indexHtml.includes("magpie plugin logout") &&
    !/\bfetch\s*\(/.test(appJs),
)
const snapshotOk = existsSync(join(root, "page", ".data", "snapshot.js"))
// Magpie treats a change to any file under a path plugin (bar node_modules
// and dot-folders) as an update and retires the plugin host, closing every
// sign-in in progress. Both snapshots this bundle rewrites while providers
// poll must therefore stay under page/.data (2026-11-25).
const quietWritesOk =
  readFileSync(join(root, "runtime", "snapshot.mjs"), "utf8").includes('".data"') &&
  readFileSync(join(root, "vendor", "hub", "src", "aggregate.mjs"), "utf8").includes("page/.data/")
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
  ["user@example.test", "u***@example.test"],
  ["1***@example.test", "1***@example.test"],
  ["13800138000", "138****00"],
  ["139****00", "139****00"],
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
  [{ type: "success", accountId: "13800138000" }, 0, "138****00"],
  [{ type: "oauth", accountId: "139****00" }, 1, "139****00"],
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
      usageAccounts: {
        "账号 1": {
          at: storedAt,
          windows: [{ name: "Credits", display: "42 / 100", used: 42 }],
        },
        "账号2": {
          at: storedAt,
          windows: [{ name: "Credits", display: "42 / 100", used: 42 }],
        },
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
// An unnamed account used to be numbered without the space, one row per poll;
// those rows must not come back, or the overview counts one account several
// times and adds up its quota that many times.
const staleUsageOk =
  Object.keys(restored.demo?.usageAccounts ?? {}).join(",") === "账号 1"
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
  !noPanelOk ||
  !catalogOk ||
  !catalogMatchesOk ||
  !longcatProviderOk ||
  !readonlyOk ||
  !snapshotOk ||
  !quietWritesOk ||
  !entryOk ||
  !lazyOnly ||
  !privacyOk ||
  !jsonControlOk ||
  !requestBodyOk ||
  !loaderSanitizeOk ||
  !persistenceOk ||
  !staleUsageOk
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
        noPanelOk,
        catalogOk,
        catalogMatchesOk,
        catalogMismatches,
        longcatProviderOk,
        readonlyOk,
        snapshotOk,
        quietWritesOk,
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
        staleUsageOk,
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
      noPanelOk,
      catalogMatchesOk,
      catalogMismatches,
      longcatProviderOk,
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
