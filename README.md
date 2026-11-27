# magpie-provider-bundle

一个 Magpie 插件，收进 27 家第三方供应商，并提供一个额度与签到的总览页。

[English](README.en.md) | 简体中文

## 安装

```bash
magpie plugin add github:xymei144/magpie-provider-bundle
```

用 `github:` 规格安装（不要 clone 后加本地路径）：这样 Magpie 认得出它是 git 安装的插件，
以后能用它自己的更新功能升级。

## 更新

在 Magpie 的「插件 → 已安装」页点插件的更新（或命令行 `magpie plugin update`），
它会重新拉取仓库的最新提交，插件随即重载。

⚠️ 用本地路径（`magpie plugin add <文件夹>`）装的插件，Magpie 不会更新——需要更新就
重新拉一遍或改用上面的 `github:` 安装方式。

## 登录

装完只是多了供应商条目。打开 Magpie 的「供应商」页，对你要用的那几家登录或贴 Key。
凭证保存在你自己的 `~/.config/magpie/plugin-auth.json`，不进仓库，也不进页面快照。

## 总览页

侧边栏打开「供应商总览」，默认只显示已登录的。点开一行可以看到每个账号、每个额度窗口。
行尾的开关是启用/停用该供应商，不是退出登录，也不会删除凭证。签到在 Magpie 设置里按供应商勾选。

能显示什么取决于供应商自己的接口：有的给剩余额度，有的只给余额，LongCat 没有额度接口，
只按本机当天用量记账。

## 页面白屏（Windows）

部分 Magpie 版本（0.1.2983 起）把插件页放在沙箱 iframe 里，子资源被拦，页面空白并报
`ERR_CONNECTION_REFUSED`。带这两个参数启动即可：

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process
```

没有页面的纯供应商插件，以及不加载外部资源的页面，不受影响。

## 支持的供应商

ZCode、WorkBuddy AI、WorkBuddy、MiniMax Code（国内/国际）、MiniMax 工具、CodeArts、
OfficeAce、商汤小浣熊、商汤日日新、AStudio、Spark-X2.6、LongCat、ModelBest（面壁智能）、
腾讯 Marvis、Qoder、OpenCode Zen Free、BreezeBlue，以及 Providers Hub 的 10 个频道。

各家要点：

- **商汤日日新** —— 积分额度挂在控制台会话上，用「网页登录」捕获；密码登录已移除。
- **Spark-X2.6** —— 网页登录会自动填 Key 并读控制台免费额度；纯 API Key 仍可用。
- **LongCat** —— 没有额度也没有签到接口，页面显示本机当天用量。
- **ModelBest（面壁智能）** —— 推理走 `api.modelbest.cn/v1` 的 `sk-…` Key；
  积分余额和每日签到在控制台，需要控制台会话 token，所以「网页登录」会一次读齐。
  只用 API Key 时，可在可选栏粘贴控制台 Token。
- **Qoder** —— PKCE 设备码流程，失败可改用个人访问令牌。
- **腾讯 Marvis** —— QQ / 微信网页登录（独立浏览器窗口授权），或一键从已登录的
  本机 Marvis 客户端导入；没有 API Key。额度读的是控制台的令牌钱包。
- **BreezeBlue** —— 语音合成服务；网页会话读 credits 并领取每日免费额度，
  领取接口不接受 API Key。

## 目录

- `providers.config.mjs` —— 唯一的供应商清单。
- `runtime/` —— 按供应商懒加载、超时、JSON 请求体修复、脱敏快照。
- `page/` —— 总览页与供应商编辑面板，只读、不联网。
- `vendor/` —— 上游包原样引用，版本锁在 `vendor.lock.json`。
- `scripts/` —— generate、lock、verify、regression、smoke（`npm test`）。

## 安全

上游代码按供应商懒加载并各自 try/catch，一家坏掉不影响整体；额度、模型、签到调用都有
超时。页面只读快照：供应商 id、账号数、额度窗口、签到结果和脱敏后的错误行，不含任何
Key 或 token。

## 来源

`vendor/` 是上游代码，未改动；来源与版本见 `vendor.lock.json` 和 `NOTICE.md`。
本仓库只加了聚合层、页面和 `providers.config.mjs`。

## 加一个供应商

1. 把包复制到 `vendor/<短名>/`（保留 `package.json`）。
2. 在 `providers.config.mjs` 加一条，id 与上游一致。
3. `npm test`。
4. `magpie plugin add <本文件夹>`。
