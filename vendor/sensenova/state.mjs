/**
 * Cross-process state for the console session.
 *
 * Two things live here, and both exist because a console sign-in is expensive:
 *
 *   - **Minted tokens.** Keeping the access/refresh token across restarts means
 *     a browser sign-in is reused instead of repeating the authorization flow.
 *   - **Cooldowns.** The old backoff was in memory, so restarting Magpie threw
 *     it away and immediately retried — during a limit, that is exactly what
 *     extends it.
 *
 * The file is separate from `~/.sensenova-quota.json` so it never rewrites the
 * `snquota` CLI's copy, and it stores only tokens/cooldown metadata — never the
 * password. Automatic password sign-in was removed entirely. `mode: 0o600` is
 * applied where the platform honors it.
 *
 * Nothing here throws: a corrupt or unwritable state file degrades to "no
 * state", which is the same behaviour as the previous in-memory-only code.
 *
 * @module st-sensenova-magpie/state
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const MAX_TOKEN_ENTRIES = 32;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Where the state lives; a sibling of the credentials file it belongs to. */
export function statePath(credentialsFile) {
  const base = credentialsFile || path.join(os.homedir(), ".sensenova-quota.json");
  return `${base}.session.json`;
}

/** Stable, non-reversible id for an account (API key or username). */
export function accountKey(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

/**
 * What a cooldown belongs to.
 *
 * Changing the account identity or Cookie means the user changed the way the
 * plugin signs in, so an old limit no longer applies and a fresh attempt is
 * justified. Tokens are deliberately *not* fingerprinted: refreshing a token
 * must keep the stored cooldown attached to the same account.
 *
 * Passwords are not part of this hash. Automatic password sign-in was removed,
 * so a password can never be the credential that is being rate-limited.
 */
export function credentialFingerprint(cfg) {
  const part = (value) => (typeof value === "string" ? value.trim() : "");
  return createHash("sha256")
    .update([part(cfg?.username), part(cfg?.cookie)].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

function emptyState() {
  return { v: VERSION, tokens: {}, cooldowns: {} };
}

/** Read the state, treating anything unreadable as empty. */
export function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      v: VERSION,
      tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
      cooldowns: parsed.cooldowns && typeof parsed.cooldowns === "object" ? parsed.cooldowns : {},
    };
  } catch {
    return emptyState();
  }
}

function prune(state, now) {
  for (const [key, entry] of Object.entries(state.cooldowns)) {
    const until = Number(entry?.until);
    const at = Date.parse(entry?.at ?? "");
    if (!Number.isFinite(until) || until <= now || (Number.isFinite(at) && now - at > MAX_AGE_MS)) {
      delete state.cooldowns[key];
    }
  }

  state.tokens = Object.fromEntries(
    Object.entries(state.tokens)
      .map(([key, entry]) => [key, entry, Date.parse(entry?.at ?? "") || 0])
      .sort((a, b) => b[2] - a[2])
      .filter(([, , at]) => !at || now - at <= MAX_AGE_MS)
      .slice(0, MAX_TOKEN_ENTRIES)
      .map(([key, entry]) => [key, entry])
  );
  return state;
}

/** Write through a temp file so a crash cannot leave half a JSON document. */
export function writeState(file, state) {
  let tmp;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows ignores POSIX modes */
    }
    return true;
  } catch {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
    return false;
  }
}

const text = (value) => (typeof value === "string" && value ? value : undefined);

/** Tokens minted for this account, if they are still recent enough to try. */
export function storedTokens(file, key, now = Date.now()) {
  const entry = readState(file).tokens[key];
  if (!entry || typeof entry !== "object") return {};
  const at = Date.parse(entry.at ?? "");
  if (Number.isFinite(at) && now - at > MAX_AGE_MS) return {};
  const expires = Number(entry.expires_at);
  return {
    ...(text(entry.at) ? { at: entry.at } : {}),
    ...(text(entry.access_token) ? { access_token: entry.access_token } : {}),
    ...(text(entry.refresh_token) ? { refresh_token: entry.refresh_token } : {}),
    ...(text(entry.id_token) ? { id_token: entry.id_token } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expires_at: expires } : {}),
  };
}

/** Remember what this run minted, so the next start does not need a login. */
export function rememberStoredTokens(file, key, cfg, now = Date.now()) {
  const access = text(cfg?.access_token);
  const refresh = text(cfg?.refresh_token);
  if (!access && !refresh) return false;
  const state = prune(readState(file), now);
  const expires = Number(cfg?.expires_at);
  state.tokens[key] = {
    at: new Date(now).toISOString(),
    ...(access ? { access_token: access } : {}),
    ...(refresh ? { refresh_token: refresh } : {}),
    ...(text(cfg?.id_token) ? { id_token: cfg.id_token } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expires_at: expires } : {}),
  };
  return writeState(file, state);
}

/** A token the console refused, or one tied to credentials that no longer work. */
export function forgetStoredTokens(file, key) {
  const state = readState(file);
  if (!(key in state.tokens)) return false;
  delete state.tokens[key];
  return writeState(file, state);
}

/**
 * An unexpired cooldown for this account, or null.
 *
 * A fingerprint mismatch means the user changed the credentials, so the old
 * limit is no longer considered blocking.
 */
export function activeCooldown(file, key, fingerprint, now = Date.now()) {
  const entry = readState(file).cooldowns[key];
  if (!entry || typeof entry !== "object") return null;
  const until = Number(entry.until);
  if (!Number.isFinite(until) || until <= now) return null;
  if (entry.fingerprint && fingerprint && entry.fingerprint !== fingerprint) return null;
  return {
    until,
    streak: Number(entry.streak) || 1,
    reason: typeof entry.reason === "string" ? entry.reason : "auth",
    ...(typeof entry.detail === "string" && entry.detail ? { detail: entry.detail } : {}),
  };
}

export function rememberCooldown(
  file,
  key,
  { until, streak, fingerprint, reason, detail },
  now = Date.now()
) {
  const state = prune(readState(file), now);
  state.cooldowns[key] = {
    until,
    streak: streak || 1,
    ...(fingerprint ? { fingerprint } : {}),
    ...(reason ? { reason } : {}),
    ...(typeof detail === "string" && detail ? { detail: detail.slice(0, 300) } : {}),
    at: new Date(now).toISOString(),
  };
  return writeState(file, state);
}

export function clearCooldown(file, key) {
  const state = readState(file);
  if (!(key in state.cooldowns)) return false;
  delete state.cooldowns[key];
  return writeState(file, state);
}
