"use strict";

import {
  HttpError,
  createRequestId,
  publicError,
  readJsonBody,
  requireAccess,
  secureResponse
} from "./security.js";

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
const BUILD_TAG = "txzz-worker-20260710-1010";
const REQUIRED_SECRET_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TXZZ_API_AES_KEY",
  "TXZZ_CREDENTIAL_KEY"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
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

function looksPlayableLink(value) {
  const text = String(value || "").trim();
  return /(?:\.m3u8|\.mp4|\/m3u8\/|\/h5\/m3u8\/|\/vod\/|\/video\/|\/media\/|\/link\/)/i.test(text);
}

/**
 * 判断明确的播放字段是否已经返回内容。
 * VIP 线路可能是无扩展名签名地址；为避免误扣金币，只排除空值与常见占位值。
 */
function hasReturnedPlayLink(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text && !/^(?:null|undefined|false|none|nil|0|n|no|暂无|无|未购买|未解锁)$/i.test(text));
}

function collectPlayableLinks(value, bucket = [], trail = []) {
  if (!value || bucket.length >= 16) return bucket;
  if (typeof value === "string") {
    const keyHint = trail.join(".").toLowerCase();
    const explicitPlaybackField = /play|backup|m3u8|mp4|video|media|source|src|link|file/.test(keyHint);
    const genericUrlField = /url/.test(keyHint);
    // 嵌套线路也可能是无扩展名签名地址；普通 url 字段仍要求具备明确视频特征，避免把封面当成线路。
    if ((explicitPlaybackField && hasReturnedPlayLink(value)) || (genericUrlField && looksPlayableLink(value))) {
      bucket.push({ key: keyHint, url: value.trim() });
    }
    return bucket;
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => collectPlayableLinks(item, bucket, [...trail, String(index)]));
    return bucket;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (bucket.length >= 16) break;
      collectPlayableLinks(item, bucket, [...trail, key]);
    }
  }
  return bucket;
}

function normalizeFullDetail(detail = null) {
  if (!detail || typeof detail !== "object") return detail;
  const links = collectPlayableLinks(detail);
  const directPlay = [
    detail.play_link,
    detail.playLink,
    detail.play_url,
    detail.playUrl,
    detail.m3u8,
    detail.m3u8_url,
    detail.m3u8Url,
    detail.video_url,
    detail.videoUrl,
    detail.media_url,
    detail.mediaUrl,
    detail.url,
    detail.src,
    detail.source,
    detail.file
  ].find(hasReturnedPlayLink);
  const directBackup = [
    detail.backup_link,
    detail.backupLink,
    detail.backup_url,
    detail.backupUrl,
    detail.second_play_link,
    detail.secondPlayLink
  ].find(hasReturnedPlayLink);
  // 必须先使用通过有效性判断的字段，不能让 "null" 等真值占位字符串覆盖其他真实线路。
  const playLink = directPlay || links.find((item) => /play|m3u8|mp4|video|media|source|src|url|link|file/.test(item.key))?.url || "";
  const backupLink = directBackup || links.find((item) => /backup|second|spare|mirror/.test(item.key))?.url || "";
  return {
    ...detail,
    play_link: playLink,
    backup_link: backupLink
  };
}

function normalizeFullSummary(summary = {}, detail = null) {
  return {
    ...summary,
    playLink: hasReturnedPlayLink(summary.playLink) ? summary.playLink : detail?.play_link || "",
    backupLink: hasReturnedPlayLink(summary.backupLink) ? summary.backupLink : detail?.backup_link || ""
  };
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

function playableDetailReady(detail = null) {
  const normalized = normalizeFullDetail(detail);
  return Boolean(hasReturnedPlayLink(normalized?.play_link) || hasReturnedPlayLink(normalized?.backup_link));
}

function isLockedCoinVideo(detail = null) {
  const normalized = normalizeFullDetail(detail);
  // VIP 等账号即使 has_buy 不是 y，也可能已经直接拿到播放地址；有地址时严禁触发购买。
  if (playableDetailReady(normalized)) return false;
  return normalized?.has_buy !== "y" && normalized?.layer_type === "money" && Number(normalized?.money || 0) > 0;
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
    throw new Error(`${endpoint} failed: ${msg}`);
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
  if (Date.now() - Date.parse(row.cached_at || 0) > ttl * 1000) return null;
  return row;
}

async function cacheSet(env, accountId, movieId, detail, summary) {
  await supabase(env, "txzz_full_detail_cache?on_conflict=account_id,movie_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      account_id: accountId,
      movie_id: movieId,
      detail,
      summary,
      cached_at: nowIso()
    }])
  });
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

async function statM3u8Quick(link, env, timeoutMs = 2500) {
  if (!link) return null;
  const url = absoluteUrl(link, env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map((match) => Number(match[1]));
    return {
      url,
      status: response.status,
      segments: durations.length,
      duration: Number(durations.reduce((sum, item) => sum + item, 0).toFixed(3))
    };
  } catch (err) {
    return { url, error: err?.name === "AbortError" ? `timeout ${timeoutMs}ms` : err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fullDetail(env, ctx, body = {}) {
  const movieId = String(body.movieId || body.id || "").trim();
  if (!movieId) throw new HttpError("缺少视频编号", 400, "MOVIE_ID_REQUIRED");
  const bootstrap = body.bootstrapSession?.deviceId && body.bootstrapSession?.userToken ? body.bootstrapSession : null;
  const rows = await listAccountRows(env);
  let candidates = sortAccountsByCoin(rows.filter(isUsableAccountRow));
  if (!candidates.length) throw new HttpError("云端账号池没有可用账号", 409, "ACCOUNT_POOL_EMPTY");

  const errors = [];
  const lockedCandidates = [];
  const checkedAccountIds = new Set();

  for (const account of candidates) {
    const cached = await cacheGet(env, account.id, movieId);
    if (cached && playableDetailReady(cached.detail)) {
      const cachedDetail = normalizeFullDetail(cached.detail);
      const cachedSummary = normalizeFullSummary(cached.summary, cachedDetail);
      return {
        ok: true,
        detail: cachedDetail,
        data: cachedDetail,
        summary: { ...cachedSummary, cacheHit: true, remote: true, rotation: { accountId: account.id, tried: errors.length + 1 } },
        account: publicAccount(account),
        state: { accountPool: await listAccounts(env), selectedFullAccountId: account.id, fullDetails: [cachedSummary] }
      };
    }

    let verified = null;
    let verifiedAccount = null;
    let detail = null;
    try {
      verified = await acquireAccountSession(account, env, bootstrap);
      verifiedAccount = await updateAccountAfterVerify(env, account, verified);
      detail = normalizeFullDetail(await apiRequest("/movie/detail", { id: movieId }, verified, env));
      checkedAccountIds.add(account.id);
      if (isLockedCoinVideo(detail)) {
        lockedCandidates.push({ account: verifiedAccount || account, session: verified, detail });
        await audit(env, "movie.full_detail.locked_coin", {
          accountId: account.id,
          movieId,
          ok: false,
          meta: { coin: accountCoinValue(verifiedAccount || account, null), money: detail?.money }
        }).catch(() => {});
        continue;
      }
      if (!playableDetailReady(detail)) {
        throw new Error("播放详情未返回可播放链接");
      }
    } catch (err) {
      const message = err?.message || String(err);
      errors.push({ accountId: account.id, label: account.label, error: message });
      if (isCredentialFailureMessage(message)) {
        await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(account.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "error", last_error: message })
        }).catch(() => {});
      } else {
        await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(account.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ last_error: message })
        }).catch(() => {});
      }
      await audit(env, "movie.full_detail", { accountId: account.id, movieId, ok: false, message });
      continue;
    }

    return await finishFullDetail(env, ctx, {
      movieId,
      action: "direct_full_detail",
      account: verifiedAccount || account,
      session: verified,
      detail,
      errors,
      checkedAccountIds
    });
  }

  if (lockedCandidates.length) {
    const purchaseLock = await acquirePurchaseLock(env, movieId);
    if (!purchaseLock.acquired) {
      throw new HttpError("该视频正在由另一请求解锁，请稍后重试", 409, "PURCHASE_IN_PROGRESS");
    }
    try {
      const buyCandidates = lowestCoinRandomOrder(lockedCandidates.map((item) => item.account))
        .map((account) => lockedCandidates.find((item) => item.account.id === account.id))
        .filter(Boolean);
      for (const item of buyCandidates) {
        let purchaseCompleted = false;
        try {
          await apiRequest("/movie/doBuy", { id: movieId }, item.session, env);
          purchaseCompleted = true;
          const detail = normalizeFullDetail(await apiRequest("/movie/detail", { id: movieId }, item.session, env));
          if (isLockedCoinVideo(detail)) throw new Error("购买后仍显示未购买");
          if (!playableDetailReady(detail)) throw new Error("购买后播放详情未返回可播放链接");
          return await finishFullDetail(env, ctx, {
            movieId,
            action: "buy_then_full_detail",
            account: item.account,
            session: item.session,
            detail,
            errors,
            checkedAccountIds,
            purchaseMeta: {
              purchasePolicy: "all_accounts_checked_then_lowest_coin",
              purchasedByCoin: accountCoinValue(item.account, null),
              lockedAccounts: lockedCandidates.length
            }
          });
        } catch (err) {
          const message = err?.message || String(err);
          errors.push({ accountId: item.account.id, label: item.account.label, error: message, stage: "buy" });
          if (isCredentialFailureMessage(message)) {
            await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(item.account.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ status: "error", last_error: message })
            }).catch(() => {});
          } else {
            await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(item.account.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ last_error: message })
            }).catch(() => {});
          }
          await audit(env, "movie.full_detail.buy", { accountId: item.account.id, movieId, ok: false, message }).catch(() => {});
          // 上游已确认扣款后不再尝试第二个账号，避免详情刷新异常造成重复消费。
          if (purchaseCompleted) break;
        }
      }
    } finally {
      await releasePurchaseLock(env, movieId, purchaseLock.owner).catch(() => {});
    }
  }

  await audit(env, "movie.full_detail.all_failed", {
    movieId,
    ok: false,
    message: "所有云端账号均未能获取播放详情",
    meta: { errors: errors.slice(-8) }
  }).catch(() => {});
  throw new HttpError("所有云端账号均未能获取播放详情，请检查账号状态后重试", 502, "ACCOUNT_ROTATION_FAILED");
}

async function finishFullDetail(env, ctx, options = {}) {
  const { movieId, action, account, session, detail, errors = [], checkedAccountIds = new Set(), purchaseMeta = {} } = options;
  const publicInfo = publicUserInfo(session?.userInfo || account?.user_info || account?.userInfo || null);
  const summary = {
    movieId,
    action,
    accountId: account.id,
    accountLabel: account.label,
    accountUser: account.username || accountName(publicInfo),
    hasBuy: detail?.has_buy,
    layerType: detail?.layer_type,
    money: detail?.money,
    oldMoney: detail?.old_money,
    balance: detail?.balance,
    playLink: detail?.play_link,
    backupLink: detail?.backup_link,
    fullStat: detail?.play_link ? { url: absoluteUrl(detail.play_link, env), pending: true } : null,
    backupStat: detail?.backup_link ? { url: absoluteUrl(detail.backup_link, env), pending: true } : null,
    fetchedAt: nowIso(),
    remote: true,
    rotation: {
      accountId: account.id,
      tried: checkedAccountIds.size || errors.length + 1,
      failed: errors,
      coinSort: true,
      ...purchaseMeta
    }
  };
  await cacheSet(env, account.id, movieId, detail, summary);
  ctxWaitUntilStat(ctx, env, account.id, movieId, detail, summary);
  await audit(env, "movie.full_detail", { accountId: account.id, movieId, ok: true, meta: { action, tried: summary.rotation.tried } });
  return {
    ok: true,
    detail,
    data: detail,
    summary,
    account: publicAccount({ ...account, status: "ok", user_info: publicInfo || account.user_info }),
    state: { accountPool: await listAccounts(env), selectedFullAccountId: account.id, fullDetails: [summary] }
  };
}

function ctxWaitUntilStat(ctx, env, accountId, movieId, detail, summary) {
  if (!ctx) return;
  ctx.waitUntil((async () => {
    const [fullStat, backupStat] = await Promise.all([
      statM3u8Quick(detail?.play_link, env),
      statM3u8Quick(detail?.backup_link, env)
    ]);
    const next = { ...summary, fullStat: fullStat || summary.fullStat, backupStat: backupStat || summary.backupStat };
    await cacheSet(env, accountId, movieId, detail, next);
  })().catch(() => {}));
}

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

/** 生成用户可直接理解的云端服务诊断建议，避免只返回冷冰冰的状态码 */
function buildServiceDiagnostics({ envStatus = {}, accountStats = null, accountError = "" } = {}) {
  const checks = [];
  const suggestions = [];
  const nextActions = [];
  const addCheck = (key, label, level, message) => {
    checks.push({ key, label, level, message });
  };
  const addSuggestion = (text) => {
    if (text && !suggestions.includes(text)) suggestions.push(text);
  };
  const addAction = (id, label, priority, detail) => {
    if (!nextActions.some((item) => item.id === id)) nextActions.push({ id, label, priority, detail });
  };

  const missingEnv = Object.entries(envStatus)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);
  if (missingEnv.length) {
    addCheck("env", "运行密钥", "error", `缺少 ${missingEnv.join("、")}`);
    addSuggestion("先在 Cloudflare 或本地 .dev.vars 中补齐缺失密钥，然后重新部署或重启本地服务。");
    addAction("fix-env", "补齐运行密钥", "high", `缺少 ${missingEnv.join("、")}，请先补齐后重新部署。`);
  } else {
    addCheck("env", "运行密钥", "ok", "必填密钥已配置完整。");
  }

  if (accountError) {
    addCheck("database", "数据库连接", "error", accountError);
    addSuggestion("检查 Supabase 地址、service_role 密钥和 schema.sql 是否已经正确执行。");
    addAction("check-database", "检查数据库连接", "high", "确认 Supabase 地址、service_role 密钥和 schema.sql 表结构。");
  } else if (accountStats) {
    addCheck("database", "数据库连接", "ok", "Supabase 读取正常。");
  } else {
    addCheck("database", "数据库连接", "warn", "暂未读取到账号池统计。");
    addSuggestion("访问 /v1/accounts/stats 查看账号池统计接口是否可用。");
    addAction("check-stats", "检查账号统计接口", "medium", "访问 /v1/accounts/stats 确认账号池统计是否能正常返回。");
  }

  if (accountStats) {
    if (!accountStats.total) {
      addCheck("accounts", "账号池数量", "error", "云端账号池为空。");
      addSuggestion("在插件账号池页面上传本地账号，或调用 /v1/accounts/seed 写入种子账号。");
      addAction("seed-accounts", "写入或上传账号", "high", "在插件账号池页面上传本地账号，或调用 /v1/accounts/seed 写入种子账号。");
    } else if (!accountStats.enabled) {
      addCheck("accounts", "账号池数量", "error", `共有 ${accountStats.total} 个账号，但没有启用账号。`);
      addSuggestion("在 Supabase 中启用至少一个账号，或重新上传可用账号。");
      addAction("enable-account", "启用可用账号", "high", "在 Supabase 中启用至少一个账号，或重新上传可用账号。");
    } else {
      addCheck("accounts", "账号池数量", "ok", `共有 ${accountStats.total} 个账号，启用 ${accountStats.enabled} 个。`);
    }

    if (accountStats.ok > 0) {
      addCheck("usable", "可用账号", "ok", `${accountStats.ok} 个账号最近验证正常。`);
    } else if (accountStats.enabled > 0) {
      addCheck("usable", "可用账号", "warn", "启用账号还没有成功验证记录。");
      addSuggestion("在插件账号池页面点击账号检查，确认账号凭据是否仍然可用。");
      addAction("verify-accounts", "验证云端账号", "medium", "在插件账号池页面点击账号检查，确认账号凭据是否仍然可用。");
    }

    if (accountStats.error > 0) {
      addCheck("risk", "异常账号", "warn", `${accountStats.error} 个启用账号最近验证异常。`);
      addSuggestion("打开插件账号池页面的失效账号开关，查看失败原因并重新上传凭据。");
      addAction("fix-error-accounts", "处理异常账号", "medium", "打开插件账号池页面的失效账号开关，查看失败原因并重新上传凭据。");
    } else if (accountStats.enabled > 0) {
      addCheck("risk", "异常账号", "ok", "当前没有启用账号处于异常状态。");
    }

    if (accountStats.unverified > 0) {
      addCheck("unverified", "待验证账号", "info", `${accountStats.unverified} 个账号仍待验证。`);
      addSuggestion("建议空闲时逐个验证云端账号，减少播放时临时轮换等待。");
      addAction("reduce-unverified", "减少待验证账号", "low", "空闲时逐个验证云端账号，减少播放时临时轮换等待。");
    }
  }

  const score = Math.max(0, checks.reduce((value, item) => {
    if (item.level === "error") return value - 34;
    if (item.level === "warn") return value - 16;
    if (item.level === "info") return value - 5;
    return value;
  }, 100));
  const level = checks.some((item) => item.level === "error")
    ? "error"
    : checks.some((item) => item.level === "warn")
      ? "warn"
      : "ok";
  const summary = level === "ok"
    ? "云端服务状态良好，可以正常同步账号池和获取播放详情。"
    : level === "warn"
      ? "云端服务可访问，但仍有账号池细节建议处理。"
      : "云端服务存在关键配置或账号池问题，需要先处理后再使用。";

  return {
    level,
    score,
    summary,
    checks,
    suggestions,
    nextActions,
    accountsSummary: accountStats ? {
      total: accountStats.total,
      enabled: accountStats.enabled,
      ok: accountStats.ok,
      error: accountStats.error,
      unverified: accountStats.unverified,
      avgCoin: accountStats.avgCoin
    } : null,
    checkedAt: nowIso()
  };
}

/** 汇总服务整体状态，供 /v1/status 使用 */
async function detailedStatus(env) {
  const envStatus = envReady(env);
  const allConfigured = Object.values(envStatus).every(Boolean);
  let accountStats = null;
  let accountError = null;
  try {
    accountStats = await accountPoolStats(env);
  } catch (err) {
    accountError = err?.message || String(err);
  }
  const diagnostics = buildServiceDiagnostics({ envStatus, accountStats, accountError });
  return {
    ok: allConfigured && !accountError && diagnostics.level !== "error",
    service: "txzz-secure-pool",
    build: BUILD_TAG,
    env: envStatus,
    accounts: accountStats,
    accountError: accountError || undefined,
    diagnostics,
    time: nowIso()
  };
}

async function handle(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/v1/health") {
    if (request.method !== "GET") throw new HttpError("请求方法不受支持", 405, "METHOD_NOT_ALLOWED");
    const ready = Object.values(envReady(env)).every(Boolean);
    return json({
      ok: ready,
      service: "txzz-secure-pool",
      build: BUILD_TAG,
      ready,
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
  if (path === "/v1/movie/full-detail" && request.method === "POST") {
    return json(await fullDetail(env, ctx, await readJsonBody(request)));
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
  isLockedCoinVideo,
  normalizeAccount,
  shortStableHash,
  slug
};
