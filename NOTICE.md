# NOTICE

This package vendors the following MIT-licensed third-party plugins so Magpie
can load them as one plugin. The upstream code is unmodified apart from the
display-only label/icon changes noted below; `index.mjs` only wraps its
provider functions for isolation and snapshots. Every provider id stays the
same, so Magpie sign-ins, check-in settings, quota history and routing groups
are preserved.

| vendor/ | upstream package | source | license |
|---|---|---|---|
| `zcode` | `@magpie-community/opencode-zcode-auth` 0.1.44 | https://github.com/magpie-community/plugins (`packages/zcode`) | MIT |
| `workbuddy` | `@magpie-community/opencode-workbuddy-auth` 0.2.20 | https://github.com/magpie-community/plugins (`packages/workbuddy`) | MIT |
| `minimax` | `@magpie-community/opencode-minimax-auth` 0.2.1 | https://github.com/magpie-community/plugins (`packages/minimax`) | MIT |
| `codearts` | `@magpie-community/opencode-codearts-auth` 0.3.1 | https://github.com/magpie-community/plugins (`packages/codearts`) | MIT |
| `raccoon` | `@magpie-community/opencode-raccoon-auth` 0.1.6 | https://github.com/magpie-community/plugins (`packages/raccoon`) | MIT |
| `astudio` | `@magpie-community/opencode-astudio-auth` 0.1.3 | https://github.com/magpie-community/plugins (`packages/astudio`) | MIT |
| `zen-free` | `@magpie-community/opencode-zen-free-auth` 0.1.24 | https://github.com/magpie-community/plugins (`packages/zen-free`) | MIT |
| `sensenova` | `st-sensenova-magpie` 0.2.3 | https://github.com/xiaolietu/st-sensenova-magpie | MIT |
| `breezeblue` | first-party (this repo) 0.1.0 | written for this bundle | MIT |
| `hub` | `magpie-providers-hub` 0.7.1 | https://github.com/iJetLi/dsh-providers-hub (Magpie adaptation) | MIT |
| `qoder` | `@magpie-community/opencode-qoder-auth` 0.2.61 | https://github.com/magpie-community/plugins (`packages/qoder`) | MIT |
| `marvis` | `magpie-marvis` 0.2.57 | https://github.com/MYCF711/magpie-marvis | MIT |

`vendor/spark`, `vendor/longcat` and `vendor/modelbest` are locally written
adapters for OpenAI-compatible endpoints, not copied upstream packages.
`vendor/modelbest/NOTICE.md` records the console endpoints it calls.

`vendor/sensenova/NOTICE.md` and `vendor/hub/NOTICE.md` carry the upstream
notices, including trademark and endpoint caveats. Those notices still apply.

This bundle is an unaffiliated third-party client. It is not endorsed by any
of the services above, and all product names and trademarks belong to their
respective owners.
