// Call every generated function with a mock host input. No network.

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
    const actual = hooks.auth?.provider
    results.push({ id: provider.id, ok: actual === provider.id, actual: actual ?? "" })
  } catch (error) {
    results.push({ id: provider.id, ok: false, error: String(error?.message ?? error) })
  }
}

const failed = results.filter((result) => !result.ok)
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
if (failed.length) process.exit(1)
