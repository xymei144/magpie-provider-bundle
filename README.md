# magpie-provider-bundle

One Magpie plugin for every third-party provider in this bundle. The
upstream drivers are vendored unchanged; one config file decides what is
exported; one page shows the whole list.

25 providers + 1 tool plugin, from 13 vendor folders:
ZCode, WorkBuddy AI, WorkBuddy, MiniMax Code (CN/Global), MiniMax tools,
CodeArts, OfficeAce, 商汤小浣熊, 商汤日日新, AStudio desktop, Spark-X2.6,
LongCat, Qoder, OpenCode Zen Free, 七牛云 Conatus, and the 10 Providers Hub
channels (including Loomy and MonkeyCode CN/Global).

## 快速开始（中文）

**这是什么**：一个 Magpie 插件，把 25 家第三方供应商（ZCode、WorkBuddy、MiniMax、
CodeArts、商汤小浣熊/日日新、LongCat、Qoder、七牛云、Spark、Providers Hub 各频道等）
收进同一个插件，并提供一个「供应商总览」页面，看额度、签到状态和账号数。

**安装**（需要先装 Magpie，命令行能用 `magpie`）：

```
magpie plugin add github:xymei144/magpie-provider-bundle
```

也可以把仓库克隆下来，用 `magpie plugin add <文件夹路径>`。之后升级用
`magpie plugin update`。

**登录**：装完只是多了供应商条目，凭证要自己弄。打开 Magpie 的「供应商」页，
逐个登录或填 API Key——扫码类的点登录，纯 Key 类的贴 Key。密钥保存在你自己的
`~/.config/magpie/plugin-auth.json`，**不会随插件分发**，也不会出现在页面快照里。

**看额度**：侧边栏打开「供应商总览」。默认只显示已登录的；点开一行可以看每个账号、
每个窗口的余额和续期时间。每家能显示什么取决于它自己的接口——有的给剩余额度，
有的只给余额，LongCat 这类没有额度接口的只能按本机用量记账。

**签到**：在 Magpie 设置里勾选要自动签到的供应商，之后每天自动跑；失败会在总览页
显示原因。

**页面白屏 / 「页面没有响应」**：部分 Magpie 版本（0.1.2983 起）把插件页放在沙箱
iframe 里，子资源被拦，页面加载不出来。带这两个参数启动即可：

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process
```

没有页面的纯供应商插件不受影响。

**来源与改动**：`vendor/` 是上游供应商插件，原样引用，版本锁在 `vendor.lock.json`，
来源声明见 `NOTICE.md`；本仓库只加了聚合层（`runtime/`）、页面（`page/`）和配置
（`providers.config.mjs`）。

## Use it on another machine

1. Install Magpie, with `magpie` on `PATH`.
2. `magpie plugin add github:xymei144/magpie-provider-bundle`, or clone the
   folder and `magpie plugin add <folder>`. Later: `magpie plugin update`.
3. Sign in to the providers you actually use in Magpie's Providers view.
   Keys, sessions and routing groups live in the other machine's
   `~/.config/magpie`, never in this plugin.

Windows note: some Magpie builds from 0.1.2983 on render plugin pages in a
sandboxed frame whose subresources are blocked — the page comes up blank or
answers `ERR_CONNECTION_REFUSED`. Start Magpie with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process`
and it renders. Plugins with no page, and pages that load nothing external,
are unaffected.

## Sign-in methods

The overview page labels what each upstream plugin actually supports. A
`web` label means the vendor already provides a browser account sign-in; a
`key` label means the vendor exposes only an API key or token. The bundle
does not turn a key-only vendor into a fake browser login, and it does not
rewrite vendor sign-in or check-in code.

- `web`: ZCode, WorkBuddy AI, WorkBuddy, MiniMax Code (CN/Global), Qoder,
  CodeArts, OfficeAce, 商汤小浣熊, 商汤日日新 (console), AStudio (web), Accio, LobsterAI,
  MagiCrew (CN/Global), Loomy, MonkeyCode (CN/Global), Spark-X2.6 (console)
- `desktop`: ZCode, WorkBuddy AI, WorkBuddy, 商汤小浣熊, AStudio desktop,
  AutoClaw (CN/Global)
- `key`: ZCode, WorkBuddy AI, WorkBuddy, Qoder (PAT), 商汤日日新, AStudio
  desktop, Spark-X2.6, LongCat, 七牛云 Conatus, AutoClaw (CN/Global), MagiCrew
  (CN/Global), MonkeyCode (CN/Global, manual credential paste)
- `public`: OpenCode Zen Free

Sign-in, sign-out and key replacement still run through Magpie's native
provider editor. The overview page and the provider panel are read-only: the
page sandbox has no host login/logout call, so neither page pretends to start
one or reads a credential by itself.

## Re-login and re-configure

Open **模型 → 供应商**, click the provider row, and use Magpie's native
account controls. The same controls sit directly above the read-only
**供应商状态** panel. No terminal step is needed.

For a web or desktop sign-in, hover the account row and open the right-side
`…` menu, then choose **移除**. Sign in again with the native button above.

An API-key provider has no separate sign-out action. Hover the key row and
click the pencil (**Change key**) to replace the key. When only one active
key exists, Magpie does not show **Remove** for it; add another key first if
the old account must be removed completely.

The red **移除** at the bottom-left of the editor deletes the whole provider
and is not the account action. Removing an account forgets its saved sign-in
or Key; add it again with the native control above.

The overview page deliberately has no login/logout button. Magpie's plugin
page bridge only exposes theme, page options and declared reads; it has no
host command that starts a provider sign-in. The native provider editor owns
account removal and key storage, and the plugin does not bypass that boundary.

## Provider editor panel

`magpie.panels` puts one read-only “供应商状态” panel at the bottom of
Magpie's own provider editor (`slot: "provider"`). It is not a second editor
and does not replace the native API-key field or the OAuth buttons:

- shows the provider id, login state, bound account chips, model count, quota
  state, check-in state and login methods;
- shows the OpenAI-compatible providers' Base URL, protocol and default model;
- points to the native Magpie sign-in, sign-out and Key controls directly
  above it instead of showing a command line;
- uses only `--magpie-*` theme tokens, so it follows Magpie's light/dark theme;
- reads `catalog.js` and `snapshot.js` only: no request, no Magpie private
  API, no key and no option value.

Keys stay in Magpie's `plugin-auth.json`. Account chips are masked before
they reach the page: a full email becomes `1***@qq.com`, a full phone becomes
`176****23`, a label Magpie already masked is kept as it is, and a key-only
account shows `Key •••• bca1` from the vendor's short public hint.

## Install and migrate

Magpie loads a plugin from a folder, not from a `.tgz`:

```powershell
magpie plugin add D:\workspace\Work\AI\ChatGPT\magpie-provider-bundle
```

Migrating from the separate plugins:

1. Back up `%USERPROFILE%\.config\magpie` (at least `plugins.json`,
   `plugin-auth.json`, `plugin-checkin.json`, `plugin-tools.json`,
   `plugin-providers.json`, `plugin-icons.json`, `settings.json`,
   `providers.json`, `logins.json`).
2. Remove the old plugins, or turn them off.
3. `magpie plugin add <this folder>`.
4. Check `magpie plugin` (one entry), `magpie providers` (25 bundled
   providers) and the account counts. Sign-ins are keyed by provider id, so
   they carry over.
5. If a provider is still served by another plugin, run
   `magpie plugin use magpie-provider-bundle <provider-id>`.

Rollback: remove this folder plugin and re-add the original specs; the config
backup restores switches and check-in settings.

## Layout

- `providers.config.mjs`: the only provider list. Add or remove one here.
- `scripts/generate.mjs`: writes `index.mjs` exports and `page/catalog.js`.
- `scripts/regression.mjs`: re-enable/model-error regression against a temporary
  runtime copy, so it never touches the live snapshot.
- `runtime/safe.mjs`: per-provider lazy import, try/catch, timeouts, JSON
  request-body repair and snapshot recording; one broken driver does not take
  the bundle down.
- `runtime/snapshot.mjs`: merges the previous secret-free `page/snapshot.js`
  with the current run, so quota and check-in data survive a plugin reload.
- `page/`: the one overview page (no network, read-only snapshot).
- `page/provider-panel.*`: the read-only panel in Magpie's provider editor.
- `vendor/`: unmodified upstream packages, pinned by `vendor.lock.json`.

## 商汤日日新

- The model API is OpenAI-compatible and uses the normal API Key. The 积分额度
  is account-level and lives behind the console OAuth session at
  `platform.sensenova.cn`, not behind the model API key.
- **网页登录（自动填 Key + 读额度）** opens a temporary Chrome/Edge window and
  reads the console `access_token`, encrypted refresh-token record and cookies
  after the user signs in. It never scripts the IAM password endpoint.
- Automatic password sign-in is **removed**, not merely backed off. Even an old
  `email + password` account performs zero network requests: the quota card
  tells the user to replace it with a browser sign-in. This removes the only
  path that could produce `operationTooFrequently` in the first place.
- The console token set is persisted in
  `~/.sensenova-quota.json.session.json` (or
  `<credentialsFile>.session.json`). A restart reuses the access/refresh token;
  when the access token expires it performs one refresh, or a Cookie-based
  re-authorization if a console Cookie was captured.
- Concurrent `auth.usage` polls are coalesced per account and credential
  fingerprint. A burst of host calls can no longer turn one expired token into
  several refresh/login requests.
- Rate limits and other quota-read failures are also written to that file and
  survive a Magpie restart. A limiter response creates a 10-minute cooldown that
  doubles to two hours; changing the account identity or console Cookie clears
  the old fingerprint. Passwords are not part of the fingerprint because they
  are never used.
- The API Key method keeps only the console Cookie optional. Pasting a console
  Cookie lets quota renew without touching IAM.
- **Migration:** remove the old `email + password` account and add the provider
  again with **网页登录**. The stored password is ignored immediately and can be
  deleted from Magpie's account metadata; the API key itself keeps working.
- If the console only exposes a masked API Key, use the API Key method and paste
  the console Cookie. The browser helper never invents an API key it cannot read
  in full.

## Spark-X2.6

- Base URL: `https://maas-api.cn-huabei-1.xf-yun.com/v2`
- Protocol: OpenAI-compatible Chat Completions
  (`@ai-sdk/openai-compatible`), `Authorization: Bearer <API key>`
- Models: `GET /v2/models` currently returns 33; the catalog is pinned in
  `vendor/spark/models.generated.mjs` and the main model is `spark-x2.6`
- The inference API key alone has no quota endpoint. The console at
  `https://maas.xfyun.cn/usageStatistics` does expose the Spark-X2.6 free
  quota (`/api/v1/gpt-finetune/api-services/free-quota`), so the provider now
  offers **网页登录（自动填 Key + 查免费额度）** as the primary sign-in:
  it opens a one-shot Chromium window, reads the console session after login
  (both the localStorage token and the SSO cookies, including HttpOnly ones),
  fetches the account's existing API key, and shows the free quota. The
  console token/cookie is stored only in Magpie's account metadata; it is
  never written to the page or snapshot.
- The session counts as signed in when the console page itself answers
  `/api/v1/gpt-finetune/user`, so detection does not depend on iFlytek's
  cookie names. Closing the window before that answer ends the sign-in at
  once instead of leaving the button spinning.
- iFlytek's console also keeps `x-auth-token` in localStorage and sends it as
  the whole `Cookie` header. The helper reads that value separately and
  replays it verbatim from Node, because a browser `fetch` cannot set Cookie
  and the anonymous `SESSION`/`di_c_mti` cookies must not mask a real login.
- Sign in inside the window the plugin opens (a temporary profile, not the
  everyday browser) and leave it open until it closes itself.
- The console request is read-only. The provider does not claim quota, create
  keys, or change the account. If the console session expires, the card
  reports “登录已过期” and asks for a fresh web sign-in.
- The plain **Spark-X2.6 API Key** method remains as a fallback. Its two
  optional prompts accept the console `token` and a full `Cookie` request
  header if the browser helper cannot start.
- The free-quota card shows exactly what the console returns. If the account
  has not claimed the free quota, it says “未领取” instead of showing zero.
- All JSON request bodies go through the bundle's control-character repair
  before reaching a vendor. Literal NUL, `\u0006` and similar raw controls are
  removed; escaped text such as `"\\u0000"` and normal Unicode are unchanged.

Refresh the model catalog after an upstream change:

```powershell
npm run spark:models
```

## LongCat

- Base URL: `https://api.longcat.chat/openai/v1`
- Protocol: OpenAI-compatible Chat Completions
  (`@ai-sdk/openai-compatible`), `Authorization: Bearer <API key>`
- Model: `LongCat-2.5`; 1,048,576-token context, 262,144-token output,
  text/image/video input, `reasoning_content` in responses and a `thinking`
  request toggle
- Sign-in is the API key created on LongCat's API Keys page. LongCat publishes
  no account-quota or check-in endpoint for that key, so the page does not
  invent either.
- LongCat also documents an Anthropic-compatible endpoint at
  `/anthropic/v1/messages`; this provider uses the OpenAI-compatible one.

## Qoder

- Uses Qoder's own PKCE device flow: Magpie opens the official `qoder.com`
  page, then polls Qoder's device-token endpoint until the sign-in completes.
- A Personal Access Token (`pt-...`) is available as a second sign-in method.
- If the device flow fails, open Qoder in Magpie's native provider editor and
  use its PAT sign-in method instead.
- The vendored package also contains `QoderCNAuthPlugin` for `qoder.cn`
  (Alibaba Cloud / phone accounts). It is not exported by default; add one
  entry to `providers.config.mjs` with `export: "QoderCNAuthPlugin"` when
  that account system is needed.
- Qoder's model calls use its COSY envelope, not an OpenAI-compatible API.
  Do not point another OpenAI-compatible vendor at `api3.qoder.sh`.

## 七牛云 Conatus

- Base URL: `https://api.qnaigc.com/v1`
- Protocol: OpenAI-compatible Chat Completions
  (`@ai-sdk/openai-compatible`), `Authorization: Bearer <API key>`
- Sign-in is the API key created in the Qiniu console (`sk-...`). The
  optional AccessKey / SecretKey prompts are only for reading today's token
  usage; they are not the model API key and can be left empty.
- Qiniu only returns today's consumed tokens, not a remaining balance. This
  local bundle defaults to the verified account tier
  (`activityTier: "verified"`, 100M free-model tokens/day), so the card shows
  remaining quota after the first usage sync. Use the `设置额度` button on the
  Qiniu card to change the tier, enter a custom `dailyQuota`, or switch back to
  used-only display. The activity tier expires on 2026-11-30.
- Qiniu has no public check-in endpoint, so this provider has no check-in
  action.

## Safety model

- Vendor code is imported lazily, inside each provider's own try/catch. A
  vendor that throws at import time loses only its own provider.
- Usage, models and check-in calls have per-provider timeouts; a hung vendor
  cannot stall the host.
- JSON request bodies are repaired at the shared loader boundary. This covers
  every bundled provider, including `Request` objects with an attached body,
  without touching binary or multipart requests.
- A fresh Magpie process restores secret-free quota/check-in metadata from the
  previous snapshot, then overlays only values fetched in this run.
- The page only reads a snapshot: provider ids, account counts, quota windows,
  check-in outcomes and a redacted error line. It shows only generic account
  labels or masked email/phone contacts; tokens and keys never enter a page file.
- The provider panel reads the same snapshot and catalog. It has no form, no
  login button and no network access; the native editor above it still owns
  sign-in and key storage.
- The page never starts a login and never calls a vendor. Sign-in stays in
  Magpie's native provider editor.
- Spark's and LongCat's API keys are stored only in Magpie's
  `plugin-auth.json`; no key is written to the page, snapshot, repository or
  logs. Spark's optional console session uses a one-shot browser profile that
  is deleted after login; the token or cookie is kept only in the account
  metadata.

## Known differences from the separate plugins

- MCP tools are named after the plugin folder: `minimax__generate_image`
  becomes `magpie-provider-bundle__generate_image`. Tool behavior is unchanged.
- Every provider uses an official product icon from
  `page/assets/provider-icons/`. The PNG assets share a 64×64 canvas with a
  56×56 safe area, so the overview page renders the same square visual box for
  portrait, square and wide logos. `index.mjs` embeds the bytes as data URIs;
  the page catalog uses the relative asset paths.
- Upstream packages no longer update one by one; update `vendor/<name>/` and
  run `npm test`.

## Add another provider

1. Copy its package from `%USERPROFILE%\.config\magpie\plugins\node_modules\<pkg>`
   into `vendor/<short-name>/` (keep `package.json`; drop tests and
   `opencode2.mjs`).
2. Add one entry to `providers.config.mjs` with the same provider `id` the
   upstream plugin uses.
3. Run `npm test` (generate, lock, verify, regression, smoke).
4. Reinstall the folder with `magpie plugin add <path>`.

## Switches and check-in

- The switch at the right of each overview row controls whether that provider
  is enabled in Magpie. It is not a sign-out or delete action: turning it off
  keeps the saved sign-in, API key and check-in history. Toggle the plugin
  off/on once for the change to take effect.
- The overview and provider panel share the same status language: green is
  signed in, amber needs sign-in, red is a read error and grey is disabled.
  Provider icons use one 44×44 frame with `object-fit: contain`, so square,
  portrait and wide official marks keep the same visual footprint.
- Providers are shown as one flat list ordered by catalog order instead of
  being split into categories. Multi-account providers show the first two
  account labels and a `+N` summary; the full list stays in the tooltip and
  in the provider panel.
- The page writes `providers.<id> = false` into the plugin options.
- The Qiniu quota editor writes `dailyQuota` or `activityTier` into the same
  plugin options. Toggle the plugin off/on once for the new limit to apply.
- Check-in is still Magpie calling the upstream `auth.checkin` by provider id;
  the vendored drivers are unchanged.
- The page cannot start a login or logout; use the provider card in Magpie's
  native provider editor.

## Update a provider

Replace its `vendor/<name>/` directory from a newer package, run `npm test`,
then reinstall the folder. Automatic per-plugin updates no longer apply to the
bundle.
