# magpie-provider-bundle

One Magpie plugin for 25 third-party providers, with a quota and check-in
overview page.

English | [简体中文](README.zh-CN.md)

## Install

```
magpie plugin add github:xymei144/magpie-provider-bundle
```

Or clone the folder and `magpie plugin add <folder>`. Update later with
`magpie plugin update`.

## Sign in

Installing only adds the provider entries. Open Magpie's Providers view and
sign in or paste a key for the ones you use. Credentials live in your own
`~/.config/magpie/plugin-auth.json` and are never part of this repo or the page
snapshot.

## Overview page

Open 供应商总览 in the sidebar. It opens on signed-in providers; click a row to
see every account and quota window. The row switch enables or disables a
provider — it does not sign out or delete anything. Check-in can be enabled per
provider in Magpie's settings.

What a row can show depends on the vendor: some report remaining quota, some
only a balance, and LongCat has no quota API at all, so it reports the tokens
this machine spent today.

## Blank plugin page (Windows)

Some Magpie builds from 0.1.2983 render plugin pages in a sandboxed frame whose
subresources are blocked: the page is blank and answers `ERR_CONNECTION_REFUSED`.
Start Magpie with

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process
```

Plugins with no page, and pages that load nothing external, are unaffected.

## Providers

ZCode, WorkBuddy AI, WorkBuddy, MiniMax Code (CN/Global), MiniMax tools,
CodeArts, OfficeAce, 商汤小浣熊, 商汤日日新, AStudio, Spark-X2.6, LongCat,
Qoder, OpenCode Zen Free, 七牛云 Conatus, and the 10 Providers Hub channels.

Per-provider notes:

- **七牛云** — API key only; returns today's tokens, not a balance. Defaults to
  the verified tier (100M free-model tokens/day, expires 2026-11-30). No
  check-in endpoint.
- **商汤日日新** — quota is account-level and needs the console session; the
  `web` sign-in captures it. Password sign-in is gone.
- **Spark-X2.6** — the `web` sign-in fills the key and reads the console's free
  quota; a plain API key still works.
- **LongCat** — no quota or check-in endpoint. The page reports local usage.
- **Qoder** — PKCE device flow, or a personal access token as a fallback.

## Layout

- `providers.config.mjs` — the only provider list.
- `runtime/` — per-provider lazy import, timeouts, JSON body repair and the
  secret-free snapshot.
- `page/` — the overview page and the provider editor panel; read-only, no
  network.
- `vendor/` — upstream packages, unchanged, pinned by `vendor.lock.json`.
- `scripts/` — generate, lock, verify, regression, smoke (`npm test`).

## Safety

Vendor code is imported lazily inside its own try/catch, so one broken driver
cannot take the bundle down. Usage, model and check-in calls have per-provider
timeouts. The page reads only a snapshot: provider ids, account counts, quota
windows, check-in outcomes and a redacted error line — never a key or token.

## Provenance

`vendor/` is upstream code, unmodified. Sources and versions are in
`vendor.lock.json` and `NOTICE.md`. This repository adds the aggregation layer,
the pages and `providers.config.mjs`.

## Add another provider

1. Copy the package into `vendor/<short-name>/` (keep `package.json`).
2. Add an entry to `providers.config.mjs` with the upstream provider id.
3. `npm test`.
4. `magpie plugin add <this folder>`.
