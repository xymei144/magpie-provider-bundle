/**
 * UI strings, in the two languages the platform serves.
 *
 * Magpie exposes no locale to a plugin and gives a plugin no way to add settings
 * UI, so the language is an option on this plugin (`locale`) that defaults to
 * following the machine. The labels this file produces are not decoration: they
 * land in Magpie's own account card and in `magpie quota`.
 *
 * Why the plugin has to translate at all: the console's quota endpoint returns
 * its pool names in Chinese no matter what `Accept-Language` says. Observed on a
 * real account — `zh-CN` and `en-US` both answer `["通用积分池","Flash-Lite积分池"]`.
 * The console's English site shows "General Pool" and "Flash-Lite Dedicated
 * Pool", so that translation happens in its frontend, not on the wire.
 *
 * @module st-sensenova-magpie/i18n
 */

/** The languages with a string table here. */
export const LOCALES = ["zh", "en"];

const ZH = {
  locale: "zh",

  poolGeneral: "通用积分池",
  poolDedicated: "专属积分池",
  window5h: "5 小时窗口",
  windowWeekly: "本周",
  unit: "积分",
  planFallback: "Token Plan",

  noAccount:
    "没有可用于读取额度的商汤控制台会话。请用「网页登录（自动填 Key + 读额度）」重新登录；插件不会再使用账号密码登录。",
  legacyPasswordRetired:
    "检测到旧版账号密码配置，已永久停用自动密码登录（它正是「操作过于频繁」的来源）。请重新网页登录；旧密码不会再被使用。",
  readFailed: "读取额度失败: {detail}",
  refreshFailed: "refresh_token 续期失败: {detail}",
  exchangeFailed: "用授权码换令牌失败: {detail}",
  cookieDead: "控制台 Cookie 已失效，请重新网页登录",
  noAuthCode: "授权端点没有返回授权码（HTTP {status}）",
  // 措辞刻意点明「控制台」和「仅影响额度」：这句话只出现在额度窗口里，
  // 读起来不能像「Magpie 账号要重新登录」，否则用户会去重登 API Key。
  quotaHttp: "读取额度失败 HTTP {status}",
  noRenewalPath:
    "控制台 access_token 已过期，且没有 refresh_token / 会话 Cookie 可用于续期。请用「网页登录」重新登录；插件不会再用账号密码自动登录。",

  rateLimitedPaused:
    "商汤控制台会话续期被限流（操作过于频繁），已暂停自动尝试 {minutes} 分钟；重启 Magpie 不会提前重试。请等限流解除后用「网页登录」重新登录；插件不会再使用密码登录。",
  loginFailedPaused:
    "控制台会话续期失败：{detail}。已暂停自动尝试 {minutes} 分钟；请用「网页登录」重新登录。",
  readFailedPaused:
    "读取额度失败：{detail}。已暂停自动重试 {minutes} 分钟，重启 Magpie 也不会跳过等待。",
  unknownError: "未知错误",
  webLoginLabel: "网页登录（自动填 Key + 读额度）",
  webLoginInstructions:
    "在打开的浏览器窗口里登录商汤日日新控制台。登录完成后插件会读取该账号的控制台令牌和 API Key，窗口随后自动关闭；不再用密码脚本登录，因此不会触发 IAM 登录限流。",
  webLoginNoKey:
    "网页登录成功，但账号下没有可直接读取的完整 API Key。请先在控制台创建 API Key，再用「API Key」方式接入，并在可选栏填写控制台 Cookie 以显示额度。",
  webLoginKeyFailed: "已登录控制台，但读取 API Key 失败：{detail}",
  webLoginFailed: "商汤日日新网页登录失败：{detail}",

  promptCookie:
    "可选：控制台 Cookie。先在 platform.sensenova.cn 登录，再从开发者工具复制该站点的 Cookie 并用分号拼成一行；插件只用它续期额度会话，不会用密码登录",
  placeholderCookie: "name=value; name2=value2",
};

const EN = {
  locale: "en",

  poolGeneral: "General Pool",
  poolDedicated: "Dedicated Pool",
  window5h: "5h window",
  windowWeekly: "This week",
  unit: "credits",
  planFallback: "Token Plan",

  noAccount:
    "No SenseNova console session is available to read the quota. Use Web sign-in again; the plugin never uses an account password.",
  legacyPasswordRetired:
    "An old username/password configuration was found. Automatic password sign-in is permanently disabled because it is what causes the rate limit. Sign in through the browser again; the old password will not be used.",
  readFailed: "Quota read failed: {detail}",
  refreshFailed: "refresh_token renewal failed: {detail}",
  exchangeFailed: "Exchanging the authorization code for a token failed: {detail}",
  cookieDead: "The console Cookie has expired; sign in through the browser again",
  noAuthCode: "The authorization endpoint returned no code (HTTP {status})",
  quotaHttp: "Reading the quota failed with HTTP {status}",
  noRenewalPath:
    "The console access_token has expired and there is no refresh_token or session Cookie to renew it with. Use Web sign-in again; the plugin never uses an account password.",

  rateLimitedPaused:
    "The SenseNova console session renewal is being rate-limited (too many attempts). Automatic retries are paused for {minutes} minutes; restarting Magpie will not skip the wait. Sign in through the browser again after the limit clears; the plugin never uses a password.",
  loginFailedPaused:
    "The console session renewal failed: {detail}. Automatic retries are paused for {minutes} minutes; use Web sign-in again.",
  readFailedPaused:
    "Reading the quota failed: {detail}. Automatic retries are paused for {minutes} minutes; restarting Magpie will not skip the wait.",
  unknownError: "unknown error",
  webLoginLabel: "Web sign-in (auto-fill Key + read quota)",
  webLoginInstructions:
    "Sign in to the SenseNova console in the browser window that opens. The plugin then reads the console tokens and API key, and closes the window. It no longer scripts a password login, so IAM's sign-in rate limit is not triggered.",
  webLoginNoKey:
    "The web sign-in succeeded, but the account has no full API key that can be read. Create an API key in the console, then use the API Key method and paste the console Cookie in its optional field to show quota.",
  webLoginKeyFailed: "Signed in to the console, but reading API keys failed: {detail}",
  webLoginFailed: "SenseNova web sign-in failed: {detail}",

  promptCookie:
    "Optional: the console Cookie. Sign in at platform.sensenova.cn, then copy that site's Cookie header from DevTools into one semicolon-separated line. It is used only to renew the quota session; the plugin never uses a password.",
  placeholderCookie: "name=value; name2=value2",
};

const TABLES = { zh: ZH, en: EN };

/**
 * Fill `{name}` placeholders. Unknown names are left as they are, so a missing
 * string shows up in the UI instead of turning into "undefined".
 */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? String(values[key]) : whole
  );
}

/** The table for a resolved locale. */
export function strings(locale = "zh") {
  return TABLES[locale] ?? ZH;
}

/** The OS locale as Node reports it, or "" when there is nothing to report. */
function osLocale() {
  try {
    return typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : "";
  } catch {
    return "";
  }
}

/**
 * Decide the locale.
 *
 * `Intl` first, because it reflects the OS setting on every platform including
 * Windows, where `LANG` is usually `C.UTF-8` or unset and would be a lie. The
 * environment is only a fallback, for a Node built without full ICU (where
 * `Intl` reports its own default rather than the machine's) or an environment
 * that sets `LC_ALL` deliberately; a POSIX `C`/`POSIX` value is skipped rather
 * than read as "not Chinese, therefore English".
 *
 * @param {string|undefined} value - the `locale` option: `"auto"`, `"zh"`, or `"en"`.
 * @param {object} [env] - environment to read, injected for testing.
 * @param {string} [intl] - the OS locale, injected for testing.
 * @returns {"zh"|"en"}
 */
export function resolveLocale(value, env = process.env, intl = osLocale()) {
  if (value === "zh" || value === "en") return value;
  if (value && value !== "auto") {
    const explicit = String(value).toLowerCase();
    if (explicit.startsWith("zh")) return "zh";
    if (explicit.startsWith("en")) return "en";
  }

  if (/^zh/i.test(intl)) return "zh";
  if (/^en/i.test(intl)) return "en";

  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = env?.[key];
    if (typeof raw !== "string") continue;
    const tag = raw.trim().split(".")[0].split("_")[0].toLowerCase();
    if (!tag || tag === "c" || tag === "posix") continue;
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

/**
 * A pool name from the API, in the requested language.
 *
 * The endpoint answers in Chinese whatever `Accept-Language` says, so English
 * comes from the naming rule the console itself uses: a dedicated pool is
 * "<family>积分池", and the console renders that "<family> Dedicated Pool"
 * (`Flash-Lite积分池` → `Flash-Lite Dedicated Pool`, as its English site shows).
 *
 * The shared pool is the exception, and it is why this branches on `dedicated`
 * rather than translating every name: its label is this plugin's own generic
 * one, not the API's string. Running the suffix rule over the API's
 * `通用积分池` would produce the nonsense "通用 Dedicated Pool".
 *
 * A dedicated name that does not match the rule is passed through untouched
 * rather than mangled, and a missing one falls back to the generic label.
 *
 * @param {string|undefined} name - `pool.name` from the endpoint.
 * @param {object} t - the string table.
 * @param {boolean} dedicated - whether the pool is model-scoped.
 */
export function poolLabel(name, t, dedicated) {
  if (!dedicated) return t.poolGeneral;
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return t.poolDedicated;
  if (t.locale === "zh") return raw;
  // The API has answered both "Flash-Lite积分池" and "Flash-Lite 专属积分池"
  // depending on the response, so accept the optional 专属 rather than leaving
  // it stranded inside an otherwise-English label. Collapsing the spaces keeps
  // the "Flash-Lite " prefix from doubling up with the replacement.
  if (/(?:专属)?积分池$/.test(raw)) {
    return raw.replace(/(?:专属)?积分池$/, " Dedicated Pool").replace(/\s+/g, " ").trim();
  }
  return raw.replace(/\s+/g, " ").trim();
}
