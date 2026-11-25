// Refresh the Spark model catalog without putting the API key in the repo.
//
// The key is read from Magpie's plugin-auth.json, or from SPARK_API_KEY when
// this is run before the plugin has been signed in.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const base = "https://maas-api.cn-huabei-1.xf-yun.com/v2"

function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie")
  return join(homedir(), ".config", "magpie")
}

function storedKey() {
  if (process.env.SPARK_API_KEY) return process.env.SPARK_API_KEY.trim()
  const file = join(configDir(), "plugin-auth.json")
  if (!existsSync(file)) return ""
  try {
    return readFileSync(file, "utf8").match(
      /"spark-x2-6"\s*:\s*\{[^}]*"key"\s*:\s*"([^"]+)"/s,
    )?.[1] ?? ""
  } catch {
    return ""
  }
}

const key = storedKey()
if (!key) {
  console.error("No Spark key: sign in with `magpie plugin login spark-x2-6` or set SPARK_API_KEY.")
  process.exit(1)
}

const res = await fetch(`${base}/models`, {
  headers: { authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error(`Spark model catalog returned HTTP ${res.status}`)
  process.exit(1)
}

const body = await res.json()
const ids = (body?.data ?? [])
  .map((row) => String(row?.id ?? "").trim())
  .filter(Boolean)

if (!ids.length) {
  console.error("Spark model catalog was empty")
  process.exit(1)
}

const names = {
  "spark-x2.6": "Spark-X2.6",
  "spark-x2.6-4b": "Spark-X2.6-Lite",
  "spark-x2.5": "Spark-X2.5",
  "spark-x2.5-1.7b": "Spark-X2.5-1.7B",
  "spark-x2.5-4b": "Spark-X2.5-4B",
}

const models = ids.map((id) => ({
  id,
  name: names[id] || id,
  context: 1_048_576,
  output: 131_072,
}))

const out = `// Generated from ${base}/models. Run \`node scripts/spark-models.mjs\` to refresh.\nexport default ${JSON.stringify(models, null, 2)};\n`
writeFileSync(join(root, "vendor", "spark", "models.generated.mjs"), out, "utf8")
console.log(JSON.stringify({ ok: true, models: models.length }))
