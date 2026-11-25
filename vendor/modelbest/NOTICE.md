# ModelBest provider

Written for this bundle; there is no upstream Magpie plugin for ModelBest to
vendor.

Endpoints used:

- `POST https://api.modelbest.cn/v1/chat/completions` — OpenAI-compatible
  inference, authenticated with an `sk-…` API key.
- `GET https://platform.modelbest.cn/api/billing/account` — 积分余额.
- `GET https://platform.modelbest.cn/api/rewards` — daily check-in state.
- `POST https://platform.modelbest.cn/api/rewards/daily-checkins` — claim the
  daily check-in reward.
- `GET https://platform.modelbest.cn/api/me`,
  `GET /api/projects`, `GET /api/projects/{id}/keys`,
  `GET /api/keys/{id}/secret` — account label and the API key used after a web
  sign-in.

Console calls send `Authorization: Bearer <map_token>`; the token is the JWT
the console keeps in `localStorage.map_token`. It is read only in memory, never
logged, and never written outside Magpie's own auth record.
