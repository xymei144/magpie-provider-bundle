/**
 * SenseNova（商汤 · 日日新）provider plugin for Magpie.
 *
 * Two things in one package, because the platform splits them across two hosts:
 *
 *   - **The provider.** Token Plan speaks the OpenAI dialect at
 *     `https://token.sensenova.cn/v1`, so serving requests is the ordinary
 *     `@ai-sdk/openai-compatible` path and the `fetch` hook forwards untouched.
 *
 *   - **The quota.** The 积分额度 that the console shows lives on a different
 *     API entirely — `platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`
 *     — behind an OAuth bearer token, not an API key. No API-key-accessible
 *     quota endpoint exists on this platform, so the two credentials are
 *     genuinely separate and both are collected at sign-in.
 *
 * The quota is reported through `auth.usage`, which is the only channel Magpie
 * offers: plugins cannot add panels or pages, and nothing feeds the 用量概览
 * analytics page. What `auth.usage` returns is rendered on the provider's
 * account row, in `magpie quota`, and at the gateway's `GET /v1/magpie/quotas`.
 *
 * This file exports **exactly one function, and nothing else**, so the module
 * also loads under OpenCode, which refuses an entry exporting any non-function
 * value. Helpers live in `internal.mjs`, `quota.mjs` and `models.mjs`.
 *
 * @module st-sensenova-magpie
 */

import { PROVIDER, ICON, apiKeyOf, consoleAuthOf, readAuth } from "./internal.mjs";
import { DEFAULT_BASE_URL, NPM, allModels, toConfigModel, toProviderModel } from "./models.mjs";
import { accountNameOf, QuotaError, readCredentials, readQuota, writeCredentials } from "./quota.mjs";
import { fill, resolveLocale, strings as tableFor } from "./i18n.mjs";
import {
  CONSOLE_URL,
  closeSession,
  fetchApiKeys,
  launchLoginBrowser,
  pickApiKey,
  readSession,
} from "./browser.mjs";
import {
  accountKey,
  activeCooldown,
  clearCooldown,
  credentialFingerprint,
  forgetStoredTokens,
  rememberCooldown,
  rememberStoredTokens,
  statePath,
  storedTokens,
} from "./state.mjs";

const DEFAULT_QUOTA_TTL_MS = 60_000;

/**
 * How long a failed quota read waits before being retried, doubling each time.
 *
 * The old behaviour retried 15 seconds after a failure. Without a cooldown, a
 * broken refresh token could become several renewal requests a minute — which
 * is what makes IAM start answering 403. One minute, doubling, is fast enough
 * for a transient blip and slow enough to look like a browser tab.
 *
 * A failure the whole renewal chain produced (`kind: "auth"`, i.e. the console
 * login itself was refused) backs off much further. That state does not heal
 * on its own — it heals when the user signs in again — so retrying it every
 * quarter of an hour is pure noise and, if IAM is rate-limiting, keeps the
 * account locked.
 */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
/**
 * A session renewal that was *refused* (expired refresh token, dead Cookie)
 * does not heal on its own, so it backs off much harder than a transient read
 * failure. Changing the Cookie resets this through the fingerprint in
 * `state.mjs`.
 */
const RETRY_AUTH_BASE_MS = 30 * 60_000;
const RETRY_AUTH_MAX_MS = 6 * 60 * 60_000;
/**
 * IAM's "operation too frequently" is a rate limit. Ten minutes lets a short
 * burst clear; doubling to two hours stops a restart loop (or an impatient
 * user) from extending the limit.
 */
const RETRY_RATE_BASE_MS = 10 * 60_000;
const RETRY_RATE_MAX_MS = 2 * 60 * 60_000;
const MAX_RETRY_SERVER_MS = 24 * 60 * 60_000;

const cleanText = (value) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";

function identityOf(accountName, userId) {
  const name = cleanText(accountName);
  const uid = cleanText(userId);
  return {
    ...(name || uid ? { accountId: name || uid } : {}),
    ...(uid ? { uid } : {}),
  };
}

function recordOf({ apiKey, session, accountName, userId }) {
  const identity = identityOf(accountName, userId);
  return {
    type: "success",
    key: apiKey,
    ...identity,
    metadata: {
      consoleToken: session.accessToken,
      ...(session.refreshToken ? { consoleRefreshToken: session.refreshToken } : {}),
      ...(session.idToken ? { consoleIdToken: session.idToken } : {}),
      ...(session.cookie ? { consoleCookie: session.cookie } : {}),
      ...identity,
      source: "web",
    },
  };
}

function storedRecordOf({ apiKey, session, accountName, userId }) {
  return { ...recordOf({ apiKey, session, accountName, userId }), type: "api" };
}

/**
 * Build the plugin.
 *
 * @param {{client?: object}} input - the plugin input the host passes.
 * @param {object} [options] - the `options` field from `plugins.json`.
 * @returns {Promise<object>} the hooks the host calls.
 */
export async function SenseNovaPlugin({ client } = {}, options = {}) {
  const locale = resolveLocale(options.locale);
  const t = tableFor(locale);
  const opts = {
    baseURL: options.baseURL ?? undefined,
    quotaTtlMs: Number(options.quotaTtlMs) > 0 ? Number(options.quotaTtlMs) : DEFAULT_QUOTA_TTL_MS,
    scopeModel: typeof options.scopeModel === "string" ? options.scopeModel : "flash-lite",
    credentialsFile: options.credentialsFile ?? undefined,
  };
  /**
   * Tokens and cooldowns that must survive a Magpie restart.
   *
   * Kept beside the credentials file so one SenseNova account has one place to
   * look. It is deliberately *not* the credentials file itself: that one may
   * belong to the `snquota` CLI, and this plugin only adds its own tokens.
   */
  const sessionFile = statePath(opts.credentialsFile);

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: "sensenova", level, message } });
    } catch {
      /* the host's logger is best-effort */
    }
  };

  /**
   * Console tokens minted during this run, per account.
   *
   * Without this, `credentialsFor` rebuilds the credentials from disk on every
   * poll, so a token that was just renewed is thrown away and the next poll
   * renews again. That is one refresh per `quotaTtlMs` (or per retry), which
   * the IAM eventually answers with 403.
   *
   * In memory for this run; the durable copy is the plugin's own session state
   * file (`state.mjs`), never the `snquota` CLI's credential file.
   */
  const tokenCache = new Map();
  /** Accounts whose current token set has already reached the state file. */
  const persistedState = new Set();

  /**
   * Console tokens the server refused, so a stale copy in Magpie's metadata
   * cannot be replayed on every poll after the state file has been cleared.
   * A new sign-in writes different tokens and therefore bypasses this filter.
   */
  const rejectedTokens = new Map();

  /** Keep a renewed token so the next poll starts from it instead of from disk. */
  const rememberTokens = (key, cfg) => {
    tokenCache.set(key, {
      access_token: cfg.access_token,
      refresh_token: cfg.refresh_token,
      id_token: cfg.id_token,
      expires_at: cfg.expires_at,
    });
  };

  /**
   * Models the upstream has refused for an account, per API key.
   *
   * `/v1/models` answers "what does the platform sell", not "what does this
   * plan include" — and it carries no field to tell them apart. Measured on a
   * Free Plan account: `deepseek-v4.1-flash` and `deepseek-flash` come back
   * with identical context, features and pricing, yet the first answers
   * `403 model is not available in the current token plan` while the second
   * works. The only trustworthy signal is the refusal itself, so it is
   * remembered here and the id is dropped from the next model list.
   *
   * Memory only, and keyed per account: a plan upgrade takes effect when the
   * process restarts, which is the right trade against storing a wrong "no"
   * on disk forever.
   */
  const refusedModels = new Map();

  /**
   * Note a model the upstream refused, without touching the response itself.
   *
   * The body is read off a clone — the original has to reach the host
   * untouched, stream included — and only the exact refusal counts, because a
   * 403 also covers reasons that are not about the plan at all.
   */
  const noteRefusedModel = (key, init, res) => {
    let model;
    try {
      model = JSON.parse(typeof init?.body === "string" ? init.body : "{}")?.model;
    } catch {
      return;
    }
    if (!key || typeof model !== "string" || !model) return;
    res
      .clone()
      .text()
      .then((body) => {
        if (!/not available in the current token plan|model is not found/i.test(body)) return;
        const blocked = refusedModels.get(key) ?? new Set();
        blocked.add(model);
        refusedModels.set(key, blocked);
        log("warn", `sensenova: ${model} is not in this account's plan; hiding it`);
      })
      .catch(() => {
        /* 读不到就算了，下次请求还有机会 */
      });
  };

  /**
   * Record why a 429 happened, once per model per code.
   *
   * All four throttle reasons arrive with the same message — "inference
   * exceeds tpm/rpm limit" — and only `error.code` separates "burst, retry in
   * a second" from "this model's quota is spent until it is topped up".
   * Magpie shows that message to the user, so without this line nothing
   * anywhere says which one it was. Log once per code so a flapping model
   * cannot flood the log.
   */
  const notedCodes = new Map();
  const noteRateLimit = (key, init, res) => {
    let model;
    try {
      model = JSON.parse(typeof init?.body === "string" ? init.body : "{}")?.model;
    } catch {
      return;
    }
    if (!key || typeof model !== "string" || !model) return;
    res
      .clone()
      .text()
      .then((body) => {
        let code;
        try {
          code = JSON.parse(body)?.error?.code;
        } catch {
          return;
        }
        if (typeof code !== "string" || !code || notedCodes.get(`${key}|${model}`) === code) return;
        notedCodes.set(`${key}|${model}`, code);
        log("warn", `sensenova: ${model} answered 429 ${code}`);
      })
      .catch(() => {
        /* 读不到就算了，本来只是诊断信息 */
      });
  };

  /**
   * The session credentials for one account.
   *
   * Only console tokens, a console Cookie and a readable `snquota` token file
   * are accepted. A password from an older sign-in is detected solely so the
   * account row can explain the migration; it is never handed to the quota
   * client and cannot reach IAM.
   */
  const credentialsFor = (auth, cacheKey) => {
    const fromAuth = consoleAuthOf(auth);
    const fromFile = readCredentials(opts.credentialsFile) ?? {};
    const fromState = storedTokens(sessionFile, accountKey(cacheKey));
    // A token renewed during this run outranks the file: it is the newest one
    // this process has, and for a prompted account it is the only one.
    const remembered = (cacheKey && tokenCache.get(cacheKey)) || {};
    const rejected = (cacheKey && rejectedTokens.get(cacheKey)) || {};
    const usable = (value) =>
      typeof value === "string" && value && value !== rejected.access_token && value !== rejected.refresh_token
        ? value
        : undefined;
    const authAccess = usable(fromAuth.accessToken);
    const authRefresh = usable(fromAuth.refreshToken);
    return {
      base: fromFile.base,
      client_id: fromFile.client_id,
      redirect_uri: fromFile.redirect_uri,
      access_token:
        remembered.access_token ??
        fromState.access_token ??
        authAccess ??
        usable(fromFile.access_token),
      refresh_token:
        remembered.refresh_token ??
        fromState.refresh_token ??
        authRefresh ??
        usable(fromFile.refresh_token),
      // Kept so `accountNameOf` can still name the account when the access
      // token is opaque rather than a JWT. `applyToken` writes this back to
      // the file, so dropping it here would make the stored copy dead weight
      // and lose the name on the next start.
      id_token:
        remembered.id_token ?? fromState.id_token ?? fromAuth.idToken ?? fromFile.id_token,
      expires_at: remembered.expires_at ?? fromState.expires_at ?? fromFile.expires_at,
      cookie: fromAuth.cookie ?? fromFile.cookie,
      username: fromAuth.username ?? fromFile.username,
      // Legacy only. Deliberately not named `password`: no code below may use
      // it to sign in. It exists so the UI can say "this old account must be
      // replaced with a browser sign-in" instead of silently retrying.
      __legacyPassword: Boolean(fromAuth.hasPassword || fromFile.password),
      // Only the snquota file is written back. A token minted for a Magpie
      // account belongs in state.mjs (or the account metadata), never in the
      // CLI's file, unless this account was actually read from that file.
      __writable:
        !fromAuth.username &&
        !fromAuth.hasPassword &&
        !fromAuth.cookie &&
        !fromAuth.accessToken &&
        !fromAuth.refreshToken,
      __fromState: Boolean(
        !remembered.access_token &&
          !remembered.refresh_token &&
          (fromState.access_token || fromState.refresh_token)
      ),
      __file: opts.credentialsFile,
    };
  };

  /**
   * Cache quota per account so a polled hook costs one request a minute.
   *
   * `nextAt` is when this account may be read again, and `streak` counts
   * consecutive failures so the wait can double. A success resets the streak;
   * a failure keeps serving the last error to every poll until `nextAt`, which
   * is what keeps a broken console login from being retried on every tick.
   */
  const quotaCache = new Map();
  /**
   * One in-flight quota read per account and credential fingerprint.
   *
   * Magpie can ask for usage several times while a refresh is still running.
   * Without this, each caller starts its own refresh with the same token; token
   * rotation makes all but the first fail, and that burst is exactly what IAM
   * sees as "operationTooFrequently". Callers now share one request.
   */
  const quotaInflight = new Map();

  /**
   * What Magpie puts on the account row.
   *
   * Magpie shows `user` when the hook supplies it and falls back to labelling the
   * account by its API key when it does not. The console tokens carry the
   * account's own display name, which is the name the console's header shows and
   * therefore the one a user recognises; the account typed at sign-in is a phone
   * number or an email, which is what the user logged in with rather than who
   * they are. So the token's name wins, the typed account is the fallback, and
   * only when neither exists does Magpie fall back to the API key.
   */
  const accountLabel = (cfg) => accountNameOf(cfg) ?? cfg.username;

  const cooldownValue = (cooldown, cfg, now) => {
    const minutes = Math.max(1, Math.ceil((cooldown.until - now) / 60_000));
    const detail = cooldown.detail || t.unknownError;
    const error =
      cooldown.reason === "rate"
        ? fill(t.rateLimitedPaused, { minutes })
        : cooldown.reason === "auth"
          ? fill(t.loginFailedPaused, { detail, minutes })
          : fill(t.readFailedPaused, { detail, minutes });
    const user = accountLabel(cfg);
    return {
      plan: t.planFallback,
      ...(user ? { user } : {}),
      error,
      signIn: "kept",
    };
  };

  const quotaFor = async (getAuth) => {
    const auth = await readAuth(getAuth);
    const cacheKey = apiKeyOf(auth) ?? consoleAuthOf(auth).username ?? "sensenova";
    const now = Date.now();
    const stateKey = accountKey(cacheKey);
    const cfg = credentialsFor(auth, cacheKey);
    const fingerprint = credentialFingerprint(cfg);

    // A legacy password is retained only as a migration signal. It must not
    // become a cooldown, a network request, or a reason to keep polling IAM.
    if (!cfg.access_token && !cfg.refresh_token && !cfg.cookie) {
      // `signIn: "kept"`: this is a missing-console-session problem, not a
      // rejected Magpie sign-in. The API key still serves model requests.
      const value = {
        error: cfg.__legacyPassword ? t.legacyPasswordRetired : t.noAccount,
        signIn: "kept",
      };
      quotaCache.set(cacheKey, {
        nextAt: now + opts.quotaTtlMs,
        streak: 0,
        fingerprint,
        value,
      });
      return value;
    }

    const hit = quotaCache.get(cacheKey);
    if (hit && now < hit.nextAt && hit.fingerprint === fingerprint) return hit.value;

    // A rate limit lives on disk: restarting Magpie is not a way to skip it.
    // The fingerprint is part of the key, so fixing the Cookie or account
    // identity makes the next poll retry immediately even while this process
    // still has the old failure cached.
    const cooldown = activeCooldown(sessionFile, stateKey, fingerprint, now);
    if (cooldown) {
      const value = cooldownValue(cooldown, cfg, now);
      quotaCache.set(cacheKey, {
        nextAt: cooldown.until,
        streak: cooldown.streak,
        fingerprint,
        value,
      });
      return value;
    }

    const flightKey = `${cacheKey}\u0000${fingerprint}`;
    const running = quotaInflight.get(flightKey);
    if (running) return running;

    const task = (async () => {
      try {
        const { quota, changed } = await readQuota(cfg, { scopeModel: opts.scopeModel, strings: t });
        if (changed) rememberTokens(cacheKey, cfg);
        if (changed || (!cfg.__fromState && !persistedState.has(cacheKey))) {
          if (rememberStoredTokens(sessionFile, stateKey, cfg)) persistedState.add(cacheKey);
        }
        if (changed && cfg.__writable) writeCredentials(cfg, cfg.__file);
        clearCooldown(sessionFile, stateKey);
        rejectedTokens.delete(cacheKey);
        // 套餐名用接口给的（实际是 "Free Plan"），拿不到才退回通用叫法。
        const { plan, ...rest } = quota;
        const user = accountLabel(cfg);
        const value = {
          plan: plan ?? t.planFallback,
          ...(user ? { user } : {}),
          ...rest,
        };
        quotaCache.set(cacheKey, {
          nextAt: Date.now() + opts.quotaTtlMs,
          streak: 0,
          fingerprint,
          value,
        });
        return value;
      } catch (error) {
        // A rejected or unreachable console token says nothing about the API
        // key that actually serves model requests, so every failure here is
        // reported with `signIn: "kept"` — see the note above.
        const quotaError = error instanceof QuotaError ? error : null;
        const rateLimited = quotaError?.rateLimited === true;
        const authFailed = quotaError?.kind === "auth" && !rateLimited;
        // A token the console refused is worse than useless: keeping it would
        // make the next attempt fail the same way without ever re-deriving the
        // credentials from metadata or the state file.
        if (authFailed) {
          tokenCache.delete(cacheKey);
          if (cfg.access_token || cfg.refresh_token) {
            rejectedTokens.set(cacheKey, {
              access_token: cfg.access_token,
              refresh_token: cfg.refresh_token,
            });
          }
          forgetStoredTokens(sessionFile, stateKey);
        }

        // A failed read must not be cached for the full TTL: the next poll is
        // exactly when a token that just expired should be retried. It must not
        // be retried hot either — a broken console session hammered every 15s
        // is what makes IAM answer 403 in the first place, so the wait doubles
        // and caps out at RETRY_MAX_MS (RETRY_AUTH_MAX_MS when renewal itself
        // is what failed).
        const previousStreak = hit?.fingerprint === fingerprint ? hit.streak : 0;
        const streak = previousStreak + 1;
        const base = rateLimited
          ? RETRY_RATE_BASE_MS
          : authFailed
            ? RETRY_AUTH_BASE_MS
            : RETRY_BASE_MS;
        const cap = rateLimited
          ? RETRY_RATE_MAX_MS
          : authFailed
            ? RETRY_AUTH_MAX_MS
            : RETRY_MAX_MS;
        const backoff = Math.min(base * 2 ** (streak - 1), cap);
        const serverWait = Number(quotaError?.retryAfterMs);
        const wait = Math.min(
          Math.max(backoff, Number.isFinite(serverWait) ? serverWait : 0),
          MAX_RETRY_SERVER_MS
        );
        const reason = rateLimited ? "rate" : authFailed ? "auth" : "read";
        const detail =
          quotaError?.message ||
          (error instanceof Error ? error.message : String(error)) ||
          t.unknownError;
        const failedAt = Date.now();
        const until = failedAt + wait;
        rememberCooldown(
          sessionFile,
          stateKey,
          { until, streak, fingerprint, reason, detail },
          now
        );
        const value = cooldownValue({ until, streak, reason, detail }, cfg, failedAt);
        quotaCache.set(cacheKey, { nextAt: until, streak, fingerprint, value });
        log("warn", `sensenova: quota read failed: ${detail}`);
        return value;
      } finally {
        quotaInflight.delete(flightKey);
      }
    })();

    quotaInflight.set(flightKey, task);
    return task;
  };

  /**
   * The browser flow, started by `authorize()` and awaited by `callback()`.
   *
   * Magpie may return from `authorize()` before its callback is called, so the
   * work starts immediately and the same promise is returned from the callback.
   * `client.auth.set` is also called here because the automatic flow does not
   * always invoke the callback (Spark has the same fallback).
   */
  const finishWebLogin = async (session, { signal } = {}) => {
    try {
      const consoleSession = await readSession(session, { signal });
      const consoleCfg = {
        access_token: consoleSession.accessToken,
        refresh_token: consoleSession.refreshToken,
        id_token: consoleSession.idToken,
      };
      const accountName =
        accountNameOf(consoleCfg) || consoleSession.username || consoleSession.userId;

      let apiKey = "";
      let keyError = "";
      try {
        apiKey = pickApiKey(await fetchApiKeys(consoleSession.accessToken));
      } catch (error) {
        keyError = error?.message ?? String(error);
      }
      if (!apiKey) {
        throw new Error(
          keyError
            ? fill(t.webLoginKeyFailed, { detail: keyError })
            : t.webLoginNoKey
        );
      }

      const key = accountKey(apiKey);
      tokenCache.set(apiKey, consoleCfg);
      rejectedTokens.delete(apiKey);
      quotaCache.delete(apiKey);
      if (rememberStoredTokens(sessionFile, key, consoleCfg)) persistedState.add(apiKey);
      clearCooldown(sessionFile, key);

      const record = recordOf({
        apiKey,
        session: consoleSession,
        accountName,
        userId: consoleSession.userId,
      });
      try {
        await client?.auth?.set?.({
          path: { id: PROVIDER },
          body: storedRecordOf({
            apiKey,
            session: consoleSession,
            accountName,
            userId: consoleSession.userId,
          }),
        });
      } catch {
        /* callback still returns the record */
      }
      return record;
    } finally {
      await closeSession(session);
    }
  };

  return {
    /**
     * Declare the provider and its models.
     *
     * The list is static (see `models.mjs`), so it is declared here as well as
     * returned from `provider.models`: that way the models are visible before
     * anyone signs in, and `magpie plugin --json` can list them.
     *
     * `...was` keeps whatever the user set in `plugins.json`, but the model
     * map is always this plugin's — it is the only thing that knows what the
     * ids are called.
     */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: "商汤日日新",
        npm: NPM,
        api: opts.baseURL ?? DEFAULT_BASE_URL,
        ...was,
        models: Object.fromEntries(allModels().map((m) => [m.id, toConfigModel(m)])),
      };
    },

    provider: {
      id: PROVIDER,
      /**
       * The models this account can use.
       *
       * The catalogue is static, so this hook does one job: drop the ids the
       * upstream has already refused for *this* account with `not available in
       * the current token plan`. The list is per plan, and the static one is
       * per platform — a Free account and a paid one get different subsets of
       * the same catalogue, and the only signal either way is the refusal.
       *
       * Image models are included. Their `capabilities.output.image` tells
       * Magpie which endpoint they belong to, and the request they produce
       * (`POST {baseURL}/images/generations`) is forwarded by the `fetch` hook
       * like any other.
       */
      async models(provider, { auth } = {}) {
        const id = provider?.id ?? PROVIDER;
        const baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
        const key = apiKeyOf(auth);
        const blocked = (key && refusedModels.get(key)) || null;
        return Object.fromEntries(
          allModels()
            .filter((m) => !blocked || !blocked.has(m.id))
            .map((m) => [m.id, toProviderModel(m, id, { baseURL })])
        );
      },
    },

    auth: {
      provider: PROVIDER,
      ...(ICON === undefined ? {} : { icon: ICON }),

      /**
       * The account, resolved into request routing.
       *
       * There is no body repair here — unlike a gateway that rejects an empty
       * `tools` array, Token Plan accepts the OpenAI shapes as sent.
       */
      async loader(getAuth) {
        const key = apiKeyOf(await readAuth(getAuth));
        return {
          baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
          apiKey: key,
          async fetch(input, init) {
            // Re-read per request so a sign-in that changes mid-session is
            // picked up without waiting for the loader to re-run.
            const current = apiKeyOf(await readAuth(getAuth));
            const source = input instanceof Request ? input : null;
            const headers = new Headers(init?.headers ?? source?.headers);
            if (current === undefined) headers.delete("authorization");
            else headers.set("authorization", `Bearer ${current}`);
            // A Request carries its own body, and re-issuing one by URL alone
            // silently drops it — so clone it instead of rebuilding the call.
            const res = source
              ? await fetch(new Request(source, { ...init, headers }))
              : await fetch(input, { ...init, headers });
            if (res.status === 403) noteRefusedModel(current, init, res);
            else if (res.status === 429) noteRateLimit(current, init, res);
            return res;
          },
        };
      },

      /**
       * The 积分额度, as the provider card shows it.
       *
       * SenseNova's pools map onto Magpie's window model directly: the 5-hour
       * window is 18000 seconds, the weekly one 604800, and the Flash-Lite pool
       * is scoped to its own model family. The 活动固定积分 balance has no
       * window, so it is reported as `balance`.
       */
      async usage(getAuth) {
        return quotaFor(getAuth);
      },

      /**
       * Two methods: a browser session that reads both credentials, and the
       * API-key fallback with an optional console Cookie.
       *
       * The key is **not** asked for here. Magpie gives an `api` method its own
       * key field, titled by `label`, and saves that value as `{type: "api",
       * key}` when the method has no `authorize` — a prompt for the key would
       * ask the same question a second time, which is exactly what it used to
       * do. The prompts below are only the extra questions, asked before
       * signing in; their answers land in `metadata`.
       *
       * The Cookie is optional and only asked for once, because the quota
       * endpoint has no API-key path. Leaving it blank falls back to whatever
       * `snquota` already stored on this machine.
       *
       * A pasted `Bearer …` prefix is stripped at request time by `apiKeyOf`,
       * so the stored value does not have to be cleaned up here.
       */
      methods: [
        {
          type: "oauth",
          label: t.webLoginLabel,
          async authorize(_inputs, { signal } = {}) {
            const session = await launchLoginBrowser(CONSOLE_URL);
            const controller = new AbortController();
            const abort = () => {
              if (!controller.signal.aborted) controller.abort();
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
            const result = finishWebLogin(session, { signal: controller.signal });
            result.catch((error) => {
              const message = error?.message ?? String(error);
              if (error?.name === "AbortError" || message === "登录已取消") return;
              try {
                void client?.tui?.showToast?.({
                  body: { message: fill(t.webLoginFailed, { detail: message }), variant: "error" },
                });
              } catch {
                /* toast is best effort */
              }
              log("error", `sensenova: web login failed: ${message}`);
            });
            return {
              url: CONSOLE_URL,
              method: "auto",
              opened: true,
              instructions: t.webLoginInstructions,
              async callback(_code, { signal: callbackSignal } = {}) {
                if (callbackSignal?.aborted) abort();
                else callbackSignal?.addEventListener("abort", abort, { once: true });
                try {
                  return await result;
                } catch (error) {
                  if (error?.name === "AbortError" || error?.message === "登录已取消") {
                    return { type: "failed", error: "登录已取消" };
                  }
                  return { type: "failed", error: error?.message ?? String(error) };
                }
              },
            };
          },
        },
        {
          type: "api",
          label: "商汤日日新 API key",
          placeholder: "sk-…",
          prompts: [
            {
              type: "password",
              key: "consoleCookie",
              message: t.promptCookie,
              placeholder: t.placeholderCookie,
            },
          ],
        },
      ],
    },
  };
}
