// Call every generated function with a mock host input. No network.
//
// Besides "the plugin loads and answers", this checks the offline contract
// between providers.config.mjs and the auth hooks every provider exports:
// the login kinds the config promises must actually be offered, and a
// provider that talks to an OpenAI-compatible endpoint must expose a loader.

const input = {
  client: {
    auth: {
      set: async () => ({ data: true }),
      remove: async () => ({ data: true }),
    },
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { provider: {} } }) },
  },
  magpie: {
    option: () => false,
    options: () => ({}),
    load: () => {},
    usage: () => true,
    account: () => undefined,
  },
  project: { id: "magpie", worktree: process.cwd(), time: { created: Date.now() } },
  directory: process.cwd(),
  worktree: process.cwd(),
  serverUrl: new URL("http://127.0.0.1:4096"),
}

globalThis.fetch = async () => {
  throw new Error("network disabled in smoke test")
}

// Providers Hub puts "paste your credential" into the very same browser
// login page as the automatic sign-in, so those channels expose a single
// oauth-type method and no api-type one. The config's "key" is covered by
// that unified entry (see vendor/hub/src/magicrew.mjs and monkeycode.mjs).
const UNIFIED_KEY_LOGIN = new Set([
  "hub-magicrew",
  "hub-magicrew-intl",
  "hub-monkeycode",
  "hub-monkeycode-intl",
])
const API_LOGIN_KINDS = new Set(["key", "public"])
const OAUTH_LOGIN_KINDS = new Set(["web", "desktop"])

const mod = await import("../index.mjs")
const providers = (await import("../providers.config.mjs")).default
const results = []

for (const provider of providers) {
  const fn = mod[provider.export]
  if (typeof fn !== "function") {
    results.push({ id: provider.id, ok: false, error: "not a function" })
    continue
  }
  try {
    const hooks = await fn(input, {})
    if (!hooks || typeof hooks !== "object") {
      results.push({ id: provider.id, ok: false, error: "no hooks" })
      continue
    }
    if (provider.kind === "tools") {
      const tools = hooks.tool && typeof hooks.tool === "object" ? Object.keys(hooks.tool) : []
      results.push({ id: provider.id, ok: tools.length > 0, tools: tools.length })
      continue
    }
    const auth = hooks.auth ?? {}
    const problems = []
    if (auth.provider !== provider.id) {
      problems.push(`auth.provider is ${JSON.stringify(auth.provider ?? null)}`)
    }
    const methods = Array.isArray(auth.methods) ? auth.methods : []
    if (!methods.length) problems.push("auth.methods is empty")
    for (const method of methods) {
      if (method?.type !== "api" && method?.type !== "oauth") {
        problems.push(`auth method ${JSON.stringify(method?.label ?? "")} has type ${JSON.stringify(method?.type ?? null)}`)
      }
    }
    const hasApi = methods.some((method) => method?.type === "api")
    const hasOauth = methods.some((method) => method?.type === "oauth")
    // A method that asks the user for a credential ("prompts") is a pasted
    // key even when it is modelled as oauth (Qoder's PAT sign-in).
    const hasPasted = methods.some(
      (method) => Array.isArray(method?.prompts) && method.prompts.length > 0,
    )
    const login = Array.isArray(provider.login) ? provider.login : []
    if (
      login.some((kind) => API_LOGIN_KINDS.has(kind)) &&
      !hasApi &&
      !hasPasted &&
      !UNIFIED_KEY_LOGIN.has(provider.id)
    ) {
      problems.push(`login ${JSON.stringify(login)} promises a key but no api-type method is exported`)
    }
    if (login.some((kind) => OAUTH_LOGIN_KINDS.has(kind)) && !hasOauth) {
      problems.push(`login ${JSON.stringify(login)} promises a browser sign-in but no oauth-type method is exported`)
    }
    // Only an OpenAI-compatible chat endpoint needs a loader: the host uses it
    // to forward chat requests. BreezeBlue's baseUrl is the root of its web
    // session API (credits and check-in), it serves no chat traffic.
    const needsLoader =
      Boolean(provider.baseUrl) && /OpenAI-compatible/i.test(provider.protocol || "")
    if (needsLoader && typeof auth.loader !== "function") {
      problems.push("config declares an OpenAI-compatible baseUrl but no auth.loader is exported")
    }
    results.push({
      id: provider.id,
      ok: problems.length === 0,
      methods: methods.map((method) => method?.type),
      problems,
    })
  } catch (error) {
    results.push({ id: provider.id, ok: false, error: String(error?.message ?? error) })
  }
}

const failed = results.filter((result) => !result.ok)
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
if (failed.length) process.exit(1)
