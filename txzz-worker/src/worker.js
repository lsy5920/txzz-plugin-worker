"use strict";

import {
  HttpError,
  createRequestId,
  publicError,
  readJsonBody,
  requireAccess,
  secureResponse
} from "./security.js";
import { buildServiceDiagnostics } from "./domain/diagnostics.js";
import { isLockedCoinVideo } from "./domain/playback.js";
import { createPlaybackService } from "./application/playback-service.js";
import { createPurchaseLedgerRepository } from "./infrastructure/purchase-ledger.js";

const DEFAULT_ACCOUNT_ID = "full-lsyhook";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-txzz-access-token",
  "access-control-max-age": "86400"
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const BUILD_TAG = "txzz-worker-20260727-1015";
const REQUIRED_SECRET_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TXZZ_API_AES_KEY",
  "TXZZ_CREDENTIAL_KEY"
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

function requireEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing Worker secret/env: ${key}`);
  return value;
}

function envReady(env) {
  return Object.fromEntries(REQUIRED_SECRET_KEYS.map((key) => [key, Boolean(env[key])]));
}

function nowIso() {
  return new Date().toISOString();
}

/** 为数据库和目标站请求设置统一超时，避免异常网络长期占用 Worker。 */
async function fetchWithTimeout(input, options = {}, timeoutMs = 10000) {
  const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 10000, 30000));
  try {
    return await fetch(input, { ...options, signal: options.signal || AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`请求超时（${timeout} 毫秒）`);
    }
    throw err;
  }
}

function isNonAccountFailureMessage(message = "") {
  const text = String(message || "");
  return /当前视频已经下架|视频已经下架|播放详情未返回可播放链接|购买后播放详情未返回|购买后仍显示未购买|\/movie\/detail failed|movie\/detail failed|\/movie\/doBuy failed|movie\/doBuy failed|\/system\/menu did not return visitor token|system\/menu did not return visitor token|fetch failed|network|timeout/i.test(text);
}

function isCredentialFailureMessage(message = "") {
  const text = String(message || "");
  if (!text || isNonAccountFailureMessage(text)) return false;
  return /account has no usable credential|授权过期|saved token invalid|账号身份不匹配|account login failed|账号密码登录失败|qrcode restore failed|账号凭证找回失败|\/user\/info failed|user\/info failed|findByAccount|findQrcode/i.test(text);
}

function mask(value, head = 10, tail = 6) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= head + tail + 3) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function absoluteUrl(link, env) {
  const value = String(link || "").trim();
  if (!value) return "";
  try {
    if (value.startsWith("//")) return `https:${value}`;
    return new URL(value, env.TXZZ_TARGET_BASE_URL || "https://txh068.com").href;
  } catch (_) {
    return value;
  }
}

function isEnabled(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function publicUserInfo(info = null) {
  if (!info || typeof info !== "object") return null;
  return {
    id: info.id,
    username: info.username,
    account_name: info.account_name,
    nickname: info.nickname,
    balance: info.balance,
    balance_income: info.balance_income,
    coin: info.coin,
    gold: info.gold,
    money: info.money,
    amount: info.amount,
    wallet: info.wallet,
    is_vip: info.is_vip,
    is_dark_vip: info.is_dark_vip,
    vip: info.vip,
    dark_vip: info.dark_vip,
    has_vip: info.has_vip,
    has_dark_vip: info.has_dark_vip,
    vip_end_time: info.vip_end_time,
    dark_vip_end_time: info.dark_vip_end_time,
    group_name: info.group_name,
    group_end_time: info.group_end_time,
    ticket: info.ticket
  };
}

function publicAccount(row = {}) {
  const secret = row.secret_box || {};
  const has = secret.has || {};
  const legacyPlain = secret && typeof secret === "object" && !secret.data && !secret.iv ? secret : {};
  return {
    id: row.id,
    label: row.label,
    username: row.username || "",
    role: row.role || "full",
    enabled: row.enabled !== false,
    source: row.source || "remote",
    cloudReadonly: true,
    remoteId: row.id,
    status: row.status || "idle",
    notes: row.notes || "",
    lastVerifiedAt: row.last_verified_at || "",
    lastError: row.last_error || "",
    hasPassword: Boolean(has.password || legacyPlain.password),
    hasQrcode: Boolean(has.qrcode || legacyPlain.qrcode),
    hasToken: Boolean(has.userToken || legacyPlain.userToken || legacyPlain.token),
    tokenMasked: secret.tokenMasked || "",
    userInfo: publicUserInfo(row.user_info)
  };
}

function firstFilled(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function toFiniteNumber(value) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function coinValueFromInfo(info = {}) {
  const value = firstFilled(info, ["coin", "gold", "balance", "balance_income", "money", "amount", "wallet", "ticket"]);
  return toFiniteNumber(value);
}

function accountCoinValue(account = {}, fallback = Number.POSITIVE_INFINITY) {
  const value = coinValueFromInfo(account.user_info || account.userInfo || account.info || {});
  return value === null ? fallback : value;
}

function compareByCoinThenName(a, b) {
  const av = accountCoinValue(a);
  const bv = accountCoinValue(b);
  if (av !== bv) return av - bv;
  return String(a.label || a.username || a.id || "").localeCompare(String(b.label || b.username || b.id || ""), "zh-CN");
}

function sortAccountsByCoin(rows = []) {
  return [...rows].sort(compareByCoinThenName);
}

function lowestCoinRandomOrder(rows = []) {
  const remaining = [...rows];
  const out = [];
  while (remaining.length) {
    const minCoin = Math.min(...remaining.map((row) => accountCoinValue(row)));
    const group = shuffle(remaining.filter((row) => accountCoinValue(row) === minCoin));
    out.push(...group);
    for (const row of group) {
      const index = remaining.findIndex((item) => item.id === row.id);
      if (index >= 0) remaining.splice(index, 1);
    }
  }
  return out;
}

/** 生成稳定短哈希，避免中文用户名被清洗为空后全部落到同一个账号编号。 */
function shortStableHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value || "")) {
    const codePoint = char.codePointAt(0) || 0;
    hash ^= codePoint;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function slug(value) {
  const normalized = String(value || "").trim().normalize("NFKC").toLowerCase();
  const ascii = normalized
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || (normalized ? `u-${shortStableHash(normalized)}` : "");
}

function normalizeAccount(raw = {}) {
  const username = String(raw.username || raw.account_name || "").trim();
  const requestedId = String(raw.id || "").trim();
  const requestedSlug = slug(requestedId);
  const usernameSlug = slug(username);
  const id = requestedSlug
    ? (requestedId === requestedSlug ? requestedId : `full-${requestedSlug}`)
    : usernameSlug
      ? `full-${usernameSlug}`
      : `full-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return {
    id,
    label: String(raw.label || username || id || "完整权限账号").trim(),
    username,
    password: String(raw.password || ""),
    qrcode: String(raw.qrcode || ""),
    role: "full",
    enabled: raw.enabled !== false,
    source: String(raw.source || "remote"),
    deviceId: String(raw.deviceId || ""),
    userToken: String(raw.userToken || raw.token || ""),
    notes: String(raw.notes || ""),
    userInfo: raw.userInfo || raw.user_info || null,
    status: raw.status || "idle"
  };
}

function base64(bytes) {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function fromBase64(text) {
  const bin = atob(String(text || "").trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256(text) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return new Uint8Array(hash);
}

async function importAesGcmKey(secret) {
  return crypto.subtle.importKey("raw", await sha256(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(value, env) {
  const plain = JSON.stringify(value || {});
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesGcmKey(requireEnv(env, "TXZZ_CREDENTIAL_KEY"));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  return { alg: "AES-GCM", iv: base64(iv), data: base64(cipher) };
}

async function decryptSecret(box, env) {
  if (!box || typeof box !== "object") return {};
  // 兼容早期明文结构；下次保存时会自动迁移为 AES-GCM 密文。
  if (!box.iv || !box.data) {
    return {
      password: String(box.password || ""),
      qrcode: String(box.qrcode || ""),
      deviceId: String(box.deviceId || ""),
      userToken: String(box.userToken || box.token || "")
    };
  }
  const key = await importAesGcmKey(requireEnv(env, "TXZZ_CREDENTIAL_KEY"));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.iv) }, key, fromBase64(box.data));
  return JSON.parse(dec.decode(plain));
}

async function supabase(env, path, options = {}) {
  const url = `${requireEnv(env, "SUPABASE_URL").replace(/\/+$/, "")}/rest/v1/${path}`;
  const res = await fetchWithTimeout(url, {
    ...options,
    headers: {
      apikey: requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
      authorization: `Bearer ${requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(options.headers || {})
    }
  }, Number(env.TXZZ_SUPABASE_TIMEOUT_MS || 9000));
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function audit(env, event, data = {}) {
  try {
    await supabase(env, "txzz_audit_logs", {
      method: "POST",
      body: JSON.stringify([{
        event,
        account_id: data.accountId || null,
        movie_id: data.movieId || null,
        ok: data.ok !== false,
        message: data.message || "",
        meta: data.meta || {}
      }])
    });
  } catch (_) {}
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function pkcs7(data) {
  let pad = 16 - (data.length % 16);
  if (pad === 0) pad = 16;
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function unpkcs7(data) {
  const pad = data[data.length - 1];
  if (!pad || pad > 16) return data;
  return data.slice(0, data.length - pad);
}

async function importTargetAesKey(env) {
  const normalized = normalizeAesKeyText(requireEnv(env, "TXZZ_API_AES_KEY"));
  return crypto.subtle.importKey("raw", enc.encode(normalized), "AES-CBC", false, ["encrypt", "decrypt"]);
}

function normalizeAesKeyText(value) {
  const text = String(value || "").trim();
  const direct = text.replace(/^["']|["']$/g, "");
  if ([16, 24, 32].includes(enc.encode(direct).length)) return direct;
  try {
    const parsed = JSON.parse(text);
    for (const key of ["aesKey", "apiAesKey", "TXZZ_API_AES_KEY", "key"]) {
      const hit = parsed?.[key] ? normalizeAesKeyText(parsed[key]) : "";
      if (hit) return hit;
    }
  } catch (_) {}
  for (const match of text.matchAll(/[A-Za-z0-9_-]{16,32}/g)) {
    const candidate = match[0];
    if ([16, 24, 32].includes(enc.encode(candidate).length)) return candidate;
  }
  throw new Error(`TXZZ_API_AES_KEY 字节长度无效：${enc.encode(text).length}，需要 16、24 或 32 字节`);
}

async function encryptBlock(key, block, iv = new Uint8Array(16)) {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, block));
  return out.slice(0, 16);
}

async function decryptBlock(key, block) {
  const padBlock = new Uint8Array(16);
  padBlock.fill(16);
  const encryptedPad = await encryptBlock(key, padBlock, block);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, concatBytes(block, encryptedPad))
  );
}

async function encryptJson(obj, env) {
  const key = await importTargetAesKey(env);
  const plain = pkcs7(enc.encode(JSON.stringify(obj)));
  let out = new Uint8Array();
  for (let i = 0; i < plain.length; i += 16) out = concatBytes(out, await encryptBlock(key, plain.slice(i, i + 16)));
  return base64(out);
}

async function decryptText(text, env) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const key = await importTargetAesKey(env);
    const bytes = fromBase64(text);
    let out = new Uint8Array();
    for (let i = 0; i < bytes.length; i += 16) out = concatBytes(out, await decryptBlock(key, bytes.slice(i, i + 16)));
    return JSON.parse(dec.decode(unpkcs7(out)));
  }
}

async function apiRequestRaw(endpoint, data, session, env) {
  const payload = {
    data: data ?? "",
    token: session.userToken || session.token || "",
    deviceId: session.deviceId || "",
    device: "Win32",
    source: env.TXZZ_API_SOURCE || "Apple Computer, Inc.",
    driver: true
  };
  const body = await encryptJson(payload, env);
  const res = await fetchWithTimeout(`${(env.TXZZ_TARGET_BASE_URL || "https://txh068.com").replace(/\/+$/, "")}/h5${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "accept": "application/json, text/plain, */*",
      "deviceType": "web",
      "time": String(Math.round(Date.now() / 1000)),
      "version": env.TXZZ_API_VERSION || "4.76"
    },
    body
  }, Number(env.TXZZ_TARGET_TIMEOUT_MS || 12000));
  const raw = await res.text();
  const parsed = await decryptText(raw, env);
  return { httpStatus: res.status, endpoint, data, response: parsed };
}

async function apiRequest(endpoint, data, session, env) {
  const result = await apiRequestRaw(endpoint, data, session, env);
  const response = result.response || {};
  if (!result.httpStatus || result.httpStatus >= 400 || response.status !== "y") {
    const msg = response.error || response.msg || response.message || JSON.stringify(response).slice(0, 240);
    const error = new Error(`${endpoint} failed: ${msg}`);
    error.httpStatus = result.httpStatus;
    // 收到上游完整的业务拒绝响应，才能区分“明确未扣费”和网络结果不确定。
    error.upstreamRejected = result.httpStatus > 0 && result.httpStatus < 400 && response.status !== "y";
    throw error;
  }
  return response.data;
}

function buildFullToken(data) {
  if (!data?.token || !data?.user_id) return "";
  return `${data.token}_${data.user_id}`;
}

function makeDeviceId() {
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  return `web_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 13)}`;
}

async function createVisitorSession(deviceId, env) {
  const session = { deviceId, userToken: "" };
  await apiRequest("/system/info", {}, session, env);
  const menu = await apiRequest("/system/menu", { channel_code: "", share_code: "" }, session, env);
  const userToken = buildFullToken(menu);
  if (!userToken) throw new Error(`/system/menu did not return visitor token for ${deviceId}`);
  return { deviceId, userToken, menu };
}

function accountName(info) {
  return String(info?.account_name || info?.username || info?.nickname || "");
}

function validateExpectedAccount(account, userInfo) {
  const expected = String(account.username || "").trim().toLowerCase();
  const candidates = [userInfo?.account_name, userInfo?.username, userInfo?.nickname]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (expected && candidates.length && !candidates.includes(expected)) {
    throw new Error(`account mismatch: expected ${account.username}, actual ${accountName(userInfo) || candidates.join("/")}`);
  }
}

async function verifySessionForAccount(account, session, env) {
  const info = await apiRequest("/user/info", {}, session, env);
  validateExpectedAccount(account, info);
  return { deviceId: session.deviceId, userToken: session.userToken, userInfo: publicUserInfo(info) };
}

async function loginByAccount(account, bootstrapSession, env) {
  const attempts = [];
  const candidateDeviceIds = [
    bootstrapSession?.deviceId,
    account.deviceId,
    "web_8c204a9995314",
    makeDeviceId(),
    makeDeviceId(),
    makeDeviceId(),
    makeDeviceId()
  ].filter(Boolean);
  for (const deviceId of [...new Set(candidateDeviceIds)]) {
    try {
      const visitor = bootstrapSession?.deviceId === deviceId && bootstrapSession?.userToken
        ? bootstrapSession
        : await createVisitorSession(deviceId, env);
      const data = await apiRequest("/user/findByAccount", {
        account_name: account.username,
        account_password: account.password,
        type: "login"
      }, visitor, env);
      const userToken = buildFullToken(data);
      if (!userToken) throw new Error("/user/findByAccount did not return token/user_id");
      return await verifySessionForAccount(account, { deviceId, userToken }, env);
    } catch (err) {
      attempts.push({ deviceId, error: err?.message || String(err) });
    }
  }
  throw new Error(`account login failed: ${JSON.stringify(attempts.slice(-4))}`);
}

async function restoreByQrcode(account, bootstrapSession, env) {
  const attempts = [];
  const candidateDeviceIds = [
    bootstrapSession?.deviceId,
    account.deviceId,
    "web_8c204a9995314",
    makeDeviceId(),
    makeDeviceId(),
    makeDeviceId(),
    makeDeviceId()
  ].filter(Boolean);
  for (const deviceId of [...new Set(candidateDeviceIds)]) {
    try {
      const visitor = bootstrapSession?.deviceId === deviceId && bootstrapSession?.userToken
        ? bootstrapSession
        : await createVisitorSession(deviceId, env);
      const data = await apiRequest("/user/findQrcode", { code: account.qrcode }, visitor, env);
      const userToken = buildFullToken(data);
      if (!userToken) throw new Error("/user/findQrcode did not return token/user_id");
      return await verifySessionForAccount(account, { deviceId, userToken }, env);
    } catch (err) {
      attempts.push({ deviceId, error: err?.message || String(err) });
    }
  }
  throw new Error(`qrcode restore failed: ${JSON.stringify(attempts.slice(-4))}`);
}

async function acquireAccountSession(row, env, bootstrapSession = null) {
  let secret = {};
  try {
    secret = await decryptSecret(row.secret_box, env);
  } catch (err) {
    throw new Error(`credential decrypt failed, please re-upload this cloud account: ${err?.message || err}`);
  }
  const account = { ...row, ...secret };
  const errors = [];
  if (account.userToken && account.deviceId) {
    try {
      return await verifySessionForAccount(account, { deviceId: account.deviceId, userToken: account.userToken }, env);
    } catch (err) {
      errors.push(`saved token invalid: ${err?.message || err}`);
    }
  }
  if (account.username && account.password) {
    try {
      return await loginByAccount(account, bootstrapSession, env);
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }
  if (account.qrcode) {
    try {
      return await restoreByQrcode(account, bootstrapSession, env);
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }
  throw new Error(errors.join("; ") || "account has no usable credential");
}

async function listAccounts(env) {
  const rows = await supabase(env, "txzz_accounts?select=*&enabled=eq.true&order=created_at.asc");
  return sortAccountsByCoin(rows).map(publicAccount);
}

async function listAccountRows(env) {
  return await supabase(env, "txzz_accounts?select=*&enabled=eq.true&order=created_at.asc");
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function isUsableAccountRow(row = {}) {
  if (row.enabled === false) return false;
  if (row.status !== "error") return true;
  if (isCredentialFailureMessage(row.last_error || "")) return false;
  return Boolean(row.last_verified_at || row.user_info);
}

async function getAccount(env, accountId = "") {
  let rows = [];
  if (accountId) {
    rows = await supabase(env, `txzz_accounts?select=*&id=eq.${encodeURIComponent(accountId)}&enabled=eq.true&limit=1`);
    if (!rows.length) throw new HttpError("指定账号不存在或未启用", 404, "ACCOUNT_NOT_FOUND");
  }
  if (!rows.length) rows = await supabase(env, `txzz_accounts?select=*&id=eq.${encodeURIComponent(DEFAULT_ACCOUNT_ID)}&enabled=eq.true&limit=1`);
  if (!rows.length) rows = await supabase(env, "txzz_accounts?select=*&enabled=eq.true&order=created_at.asc&limit=1");
  if (!rows.length) throw new HttpError("云端账号池为空或没有已启用账号", 409, "ACCOUNT_POOL_EMPTY");
  return rows[0];
}

async function saveAccount(env, raw) {
  const account = normalizeAccount(raw);
  if (account.label.length > 120 || account.username.length > 160 || account.notes.length > 1000) {
    throw new HttpError("账号名称、用户名或备注超过允许长度", 400, "ACCOUNT_FIELD_TOO_LONG");
  }
  let existingSecret = {};
  const existing = await supabase(env, `txzz_accounts?select=*&id=eq.${encodeURIComponent(account.id)}&limit=1`);
  const existingRow = existing[0] || null;
  if (existingRow?.secret_box) {
    try {
      existingSecret = await decryptSecret(existingRow.secret_box, env);
    } catch (_) {
      throw new HttpError(
        "已有账号凭据无法解密，已停止覆盖；请确认凭据加密密钥未被更换",
        409,
        "CREDENTIAL_DECRYPT_FAILED"
      );
    }
  }
  const secret = {
    password: account.password || existingSecret.password || "",
    qrcode: account.qrcode || existingSecret.qrcode || "",
    deviceId: account.deviceId || existingSecret.deviceId || "",
    userToken: account.userToken || existingSecret.userToken || ""
  };
  const username = account.username || existingRow?.username || "";
  if (!secret.password && !secret.qrcode && !(secret.deviceId && secret.userToken)) {
    throw new HttpError("账号至少需要密码、账号凭证或完整的 token/deviceId", 400, "CREDENTIAL_REQUIRED");
  }
  if (secret.password && !username) {
    throw new HttpError("密码凭据必须同时提供用户名", 400, "USERNAME_REQUIRED");
  }
  if (Boolean(secret.deviceId) !== Boolean(secret.userToken)) {
    throw new HttpError("token 与 deviceId 必须同时提供", 400, "TOKEN_PAIR_REQUIRED");
  }
  const secretBox = await encryptSecret(secret, env);
  secretBox.has = {
    password: Boolean(secret.password),
    qrcode: Boolean(secret.qrcode),
    userToken: Boolean(secret.userToken)
  };
  secretBox.tokenMasked = secret.userToken ? mask(secret.userToken, 12, 8) : "";
  const row = {
    id: account.id,
    label: String(raw?.label || "").trim() || existingRow?.label || account.label || username || account.id,
    username,
    role: "full",
    enabled: raw?.enabled === undefined ? existingRow?.enabled !== false : account.enabled,
    source: raw?.source ? account.source : existingRow?.source || account.source,
    secret_box: secretBox,
    user_info: account.userInfo || existingRow?.user_info || null,
    status: raw?.status || existingRow?.status || account.status,
    notes: raw?.notes !== undefined ? account.notes : existingRow?.notes || account.notes,
    last_error: ""
  };
  const rows = await supabase(env, "txzz_accounts?on_conflict=id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row])
  });
  await audit(env, "account.upsert", { accountId: account.id, ok: true });
  return publicAccount(rows[0]);
}

async function seedAccounts(env) {
  const seed = env.TXZZ_SEED_ACCOUNTS_JSON ? JSON.parse(env.TXZZ_SEED_ACCOUNTS_JSON) : [];
  const saved = [];
  for (const account of seed) saved.push(await saveAccount(env, { ...account, source: "seed" }));
  return saved;
}

async function updateAccountAfterVerify(env, row, session) {
  const secret = await decryptSecret(row.secret_box, env);
  const nextSecret = { ...secret, deviceId: session.deviceId, userToken: session.userToken };
  const box = await encryptSecret(nextSecret, env);
  box.has = {
    password: Boolean(nextSecret.password),
    qrcode: Boolean(nextSecret.qrcode),
    userToken: Boolean(nextSecret.userToken)
  };
  box.tokenMasked = mask(nextSecret.userToken, 12, 8);
  const rows = await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      secret_box: box,
      user_info: session.userInfo,
      status: "ok",
      last_error: "",
      last_verified_at: nowIso()
    })
  });
  return rows[0] || row;
}

async function cacheGet(env, accountId, movieId) {
  const ttl = Number(env.TXZZ_CACHE_TTL_SECONDS || 600);
  const rows = await supabase(env, `txzz_full_detail_cache?select=*&account_id=eq.${encodeURIComponent(accountId)}&movie_id=eq.${encodeURIComponent(movieId)}&limit=1`);
  const row = rows[0];
  if (!row) return null;
  const expiresAt = Date.parse(row.expires_at || "");
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
  if (!Number.isFinite(expiresAt) && Date.now() - Date.parse(row.cached_at || 0) > ttl * 1000) return null;
  return row;
}

async function cacheSet(env, accountId, movieId, detail, summary) {
  const cachedAt = nowIso();
  const expiresAt = new Date(Date.now() + Number(env.TXZZ_CACHE_TTL_SECONDS || 600) * 1000).toISOString();
  const write = (row) => supabase(env, "txzz_full_detail_cache?on_conflict=account_id,movie_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row])
  });
  const baseRow = { account_id: accountId, movie_id: movieId, detail, summary, cached_at: cachedAt };
  try {
    await write({ ...baseRow, schema_version: 2, expires_at: expiresAt });
    return true;
  } catch (error) {
    // 迁移窗口内兼容旧缓存表；缓存写入失败也不能阻止已经获得的直链播放。
    if (/schema_version|expires_at|column/i.test(error?.message || "")) {
      await write(baseRow).catch(() => {});
    }
    return false;
  }
}

async function markAccountFailure(env, account, error, credentialFailure = false) {
  const message = error?.message || String(error);
  await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(account.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(credentialFailure ? { status: "error" } : {}),
      last_error: message
    })
  }).catch(() => {});
}

/**
 * 获取单视频购买互斥锁，防止多个并发请求同时扣除不同账号金币。
 * 锁在数据库中保存，能覆盖多个 Worker 实例并带超时自动接管能力。
 */
async function acquirePurchaseLock(env, movieId) {
  const owner = crypto.randomUUID();
  const result = await supabase(env, "rpc/txzz_try_acquire_purchase_lock", {
    method: "POST",
    body: JSON.stringify({
      p_movie_id: movieId,
      p_owner: owner,
      p_ttl_seconds: 45
    })
  });
  const acquired = Array.isArray(result) ? result[0] : result;
  return { acquired: acquired === true, owner };
}

/** 仅释放当前请求自己持有的购买锁，避免误删后来接管的新锁。 */
async function releasePurchaseLock(env, movieId, owner) {
  if (!movieId || !owner) return;
  await supabase(
    env,
    `txzz_purchase_locks?movie_id=eq.${encodeURIComponent(movieId)}&owner=eq.${encodeURIComponent(owner)}`,
    { method: "DELETE" }
  );
}

function hlsDurations(text = "") {
  return [...String(text).matchAll(/#EXTINF:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function hlsVariantUrls(text = "", baseUrl = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim());
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF")) continue;
    const candidate = lines.slice(index + 1).find((line) => line && !line.startsWith("#"));
    if (!candidate) continue;
    try {
      variants.push(new URL(candidate, baseUrl).href);
    } catch (_) {}
  }
  return [...new Set(variants)].slice(0, 4);
}

function hlsProbeStat(url, status, responseOk, text, latencyMs) {
  const durations = hlsDurations(text);
  return {
    url,
    status,
    ok: responseOk && durations.length > 0,
    latencyMs,
    segments: durations.length,
    duration: Number(durations.reduce((sum, item) => sum + item, 0).toFixed(3)),
    checkedAt: nowIso()
  };
}

async function fetchPlaybackProbe(url, signal) {
  const urlLooksHls = /m3u8|mpegurl/i.test(String(url || ""));
  const headers = {
    accept: "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*;q=0.1",
    // 无扩展名地址可能实际是 MP4；限制读取量，避免探测时下载整个视频。
    ...(urlLooksHls ? {} : { range: "bytes=0-524287" })
  };
  let response = await fetch(url, {
    signal,
    headers
  });
  // 少数 HLS 网关拒绝 Range；已知清单地址安全回退为普通小文本请求。
  if (!response.ok && urlLooksHls) {
    await response.body?.cancel().catch(() => {});
    response = await fetch(url, { signal, headers: { accept: headers.accept } });
  }
  if (urlLooksHls && (response.status === 206 || response.headers.get("content-range"))) {
    await response.body?.cancel().catch(() => {});
    response = await fetch(url, { signal, headers: { accept: headers.accept } });
  }
  let contentType = String(response.headers.get("content-type") || "").toLowerCase();
  let contentLength = Number(response.headers.get("content-length") || 0);
  const definitelyLargeBinary = /video\/(?:mp4|webm|quicktime)|application\/mp4/.test(contentType)
    || (response.status !== 206 && contentLength > 8 * 1024 * 1024 && !urlLooksHls && !/mpegurl/.test(contentType));
  if (definitelyLargeBinary) {
    await response.body?.cancel().catch(() => {});
    return { response, text: "" };
  }
  let text = await response.text();
  const partialManifest = (response.status === 206 || response.headers.get("content-range"))
    && (/mpegurl/.test(contentType) || String(text).includes("#EXTM3U"));
  if (partialManifest) {
    // 无扩展名的签名地址只能在响应后确认是 HLS。确认后必须去掉 Range
    // 重取完整文本，否则大于 512 KiB 的 Vlog 会被稳定截成错误时长。
    response = await fetch(url, { signal, headers: { accept: headers.accept } });
    contentType = String(response.headers.get("content-type") || "").toLowerCase();
    contentLength = Number(response.headers.get("content-length") || 0);
    // 已由首段正文确认是 #EXTM3U；CDN 即使错报 octet-stream，也必须读取完整清单。
    if (/video\/(?:mp4|webm|quicktime)|application\/mp4/.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      return { response, text: "" };
    }
    text = await response.text();
  }
  return { response, text };
}

async function statM3u8Quick(link, env, timeoutMs = 10000) {
  if (!link) return null;
  const url = absoluteUrl(link, env);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { response, text } = await fetchPlaybackProbe(url, controller.signal);
    const latencyMs = Date.now() - startedAt;
    if (!String(text).includes("#EXTM3U")) {
      return {
        url,
        status: response.status,
        ok: response.ok,
        latencyMs,
        segments: 0,
        duration: 0,
        checkedAt: nowIso()
      };
    }
    const direct = hlsProbeStat(url, response.status, response.ok, text, latencyMs);
    if (direct.duration > 0) return direct;

    // 主清单本身没有 EXTINF；并行探测变体清单并取覆盖时长最长者。
    const variants = hlsVariantUrls(text, url);
    const rows = await Promise.allSettled(variants.map(async (variantUrl) => {
      const variant = await fetchPlaybackProbe(variantUrl, controller.signal);
      return hlsProbeStat(
        variantUrl,
        variant.response.status,
        variant.response.ok,
        variant.text,
        Date.now() - startedAt
      );
    }));
    const best = rows
      .filter((row) => row.status === "fulfilled")
      .map((row) => row.value)
      .sort((left, right) => right.duration - left.duration || right.segments - left.segments)[0];
    return best ? { ...best, url, resolvedPlaylistUrl: best.url, masterPlaylist: true } : direct;
  } catch (err) {
    return {
      url,
      error: err?.name === "AbortError" ? `timeout ${timeoutMs}ms` : err?.message || String(err),
      latencyMs: Date.now() - startedAt,
      checkedAt: nowIso()
    };
  } finally {
    clearTimeout(timer);
  }
}

const purchaseLedger = createPurchaseLedgerRepository({ supabase, nowIso });
const playbackService = createPlaybackService({
  HttpError,
  absoluteUrl,
  accountCoinValue,
  accountName,
  acquireAccountSession,
  acquirePurchaseLock,
  apiRequest,
  audit,
  cacheGet,
  cacheSet,
  isCredentialFailureMessage,
  isUsableAccountRow,
  ledger: purchaseLedger,
  listAccountRows,
  listAccounts,
  lowestCoinRandomOrder,
  markAccountFailure,
  nowIso,
  publicAccount,
  releasePurchaseLock,
  sortAccountsByCoin,
  statM3u8Quick,
  updateAccountAfterVerify
});

async function proxyMedia(request, env) {
  if (!isEnabled(env.TXZZ_PROXY_MEDIA, false)) return fail("媒体代理未启用", 404);
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target || !/^https:\/\/txh068\.com\/h5\/m3u8\/link\//.test(target)) return fail("媒体代理地址无效", 400);
  const res = await fetchWithTimeout(
    target,
    { headers: { "user-agent": request.headers.get("user-agent") || "Mozilla/5.0" } },
    Number(env.TXZZ_TARGET_TIMEOUT_MS || 12000)
  );
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "private, max-age=120");
  return new Response(res.body, { status: res.status, headers });
}

/** 统计账号池基本数字，供 /v1/accounts/stats 使用 */
async function accountPoolStats(env) {
  const rows = await supabase(env, "txzz_accounts?select=id,enabled,status,last_verified_at,user_info&order=created_at.asc");
  const total = rows.length;
  const enabled = rows.filter((r) => r.enabled !== false);
  const ok = enabled.filter((r) => r.status === "ok");
  const error = enabled.filter((r) => r.status === "error");
  const unverified = enabled.filter((r) => !r.status || r.status === "idle");
  const coinValues = enabled.map((r) => accountCoinValue(r)).filter((v) => v !== Number.POSITIVE_INFINITY);
  const totalCoin = coinValues.reduce((s, v) => s + v, 0);
  return {
    total,
    enabled: enabled.length,
    ok: ok.length,
    error: error.length,
    unverified: unverified.length,
    totalCoin: Number.isFinite(totalCoin) ? Number(totalCoin.toFixed(2)) : null,
    avgCoin: coinValues.length ? Number((totalCoin / coinValues.length).toFixed(2)) : null,
    time: nowIso()
  };
}

/** 汇总服务整体状态，供 /v1/status 使用 */
async function detailedStatus(env) {
  const envStatus = envReady(env);
  const allConfigured = Object.values(envStatus).every(Boolean);
  let accountStats = null;
  let accountError = null;
  const playbackSchema = allConfigured
    ? await purchaseLedger.schemaReady(env)
    : { ready: false, version: 0, error: "运行密钥不完整，尚未检查播放 schema" };
  try {
    accountStats = await accountPoolStats(env);
  } catch (err) {
    accountError = err?.message || String(err);
  }
  const diagnostics = buildServiceDiagnostics({ envStatus, accountStats, accountError, playbackSchema });
  return {
    ok: allConfigured && !accountError && playbackSchema.ready && diagnostics.level !== "error",
    service: "txzz-secure-pool",
    build: BUILD_TAG,
    env: envStatus,
    accounts: accountStats,
    accountError: accountError || undefined,
    playbackSchema,
    diagnostics,
    time: nowIso()
  };
}

async function handle(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/v1/health" || path === "/v2/health") {
    if (request.method !== "GET") throw new HttpError("请求方法不受支持", 405, "METHOD_NOT_ALLOWED");
    const envConfigured = Object.values(envReady(env)).every(Boolean);
    const playbackSchema = path === "/v2/health" && envConfigured
      ? await purchaseLedger.schemaReady(env)
      : { ready: envConfigured, version: path === "/v2/health" ? 0 : 1 };
    const ready = envConfigured && playbackSchema.ready;
    return json({
      ok: ready,
      service: "txzz-secure-pool",
      build: BUILD_TAG,
      ready,
      apiVersion: path === "/v2/health" ? 2 : 1,
      playbackSchema,
      authRequired: true,
      time: nowIso()
    }, ready ? 200 : 503);
  }
  await requireAccess(request, env);
  if (path === "/v1/accounts" && request.method === "GET") {
    return json({ ok: true, accounts: await listAccounts(env) });
  }
  if (path === "/v1/accounts" && request.method === "POST") {
    const body = await readJsonBody(request);
    return json({ ok: true, account: await saveAccount(env, body.account || body) });
  }
  if (path === "/v1/accounts/client-upload" && request.method === "POST") {
    const body = await readJsonBody(request);
    return json({ ok: true, account: await saveAccount(env, body.account || body) });
  }
  if (path === "/v1/accounts/seed" && request.method === "POST") {
    return json({ ok: true, accounts: await seedAccounts(env) });
  }
  if (path === "/v1/accounts/verify" && request.method === "POST") {
    const body = await readJsonBody(request);
    const account = await getAccount(env, body.accountId || "");
    const session = await acquireAccountSession(account, env, body.bootstrapSession || null);
    const updated = await updateAccountAfterVerify(env, account, session);
    return json({ ok: true, account: publicAccount(updated), session: { deviceId: session.deviceId, userInfo: session.userInfo } });
  }
  if (path === "/v1/accounts/stats" && request.method === "GET") {
    return json({ ok: true, stats: await accountPoolStats(env) });
  }
  if (path === "/v2/playback/session" && request.method === "POST") {
    return json(await playbackService.createSession(env, ctx, await readJsonBody(request)));
  }
  if (path === "/v1/movie/full-detail" && request.method === "POST") {
    return json(
      await playbackService.createLegacyResponse(env, ctx, await readJsonBody(request)),
      200,
      {
        Deprecation: "true",
        Sunset: "Wed, 26 Aug 2026 00:00:00 GMT",
        Link: '</v2/playback/session>; rel="successor-version"'
      }
    );
  }
  if (path === "/v1/media/proxy" && request.method === "GET") {
    return await proxyMedia(request, env);
  }
  if (path === "/v1/status" && request.method === "GET") {
    return json(await detailedStatus(env));
  }
  if (path === "/v1/diagnostics" && request.method === "GET") {
    const status = await detailedStatus(env);
    return json({ ok: status.ok, diagnostics: status.diagnostics, status });
  }
  const knownPath = [
    "/v1/accounts",
    "/v1/accounts/client-upload",
    "/v1/accounts/seed",
    "/v1/accounts/verify",
    "/v1/accounts/stats",
    "/v2/playback/session",
    "/v1/movie/full-detail",
    "/v1/media/proxy",
    "/v1/status",
    "/v1/diagnostics"
  ].includes(path);
  if (knownPath) throw new HttpError("请求方法不受支持", 405, "METHOD_NOT_ALLOWED");
  throw new HttpError("接口不存在", 404, "NOT_FOUND");
}

export default {
  async fetch(request, env, ctx) {
    const requestId = createRequestId();
    try {
      return secureResponse(await handle(request, env, ctx), requestId);
    } catch (err) {
      const exposed = publicError(err, requestId);
      if (exposed.status >= 500) {
        console.error("糖心志者 Worker 请求失败", {
          requestId,
          path: new URL(request.url).pathname,
          message: err?.message || String(err)
        });
      }
      return secureResponse(json(exposed.body, exposed.status), requestId);
    }
  }
};

// 仅导出纯函数供自动化测试使用，不影响 Cloudflare Worker 默认入口。
export {
  buildServiceDiagnostics,
  envReady,
  hlsDurations,
  hlsVariantUrls,
  isLockedCoinVideo,
  normalizeAccount,
  shortStableHash,
  statM3u8Quick,
  slug
};
