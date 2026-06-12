"use strict";

const DEFAULT_ACCOUNT_ID = "full-lsyhook";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const BUILD_TAG = "txzz-worker-20260613-0118";
const REQUIRED_SECRET_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TXZZ_API_AES_KEY",
  "TXZZ_CREDENTIAL_KEY",
  "TXZZ_SEED_ACCOUNTS_JSON"
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

function collectPlayableLinks(value, bucket = [], trail = []) {
  if (!value || bucket.length >= 16) return bucket;
  if (typeof value === "string") {
    const keyHint = trail.join(".").toLowerCase();
    if (looksPlayableLink(value) && /play|backup|m3u8|mp4|video|media|source|src|url|link|file/.test(keyHint)) {
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
  ].find(looksPlayableLink);
  const directBackup = [
    detail.backup_link,
    detail.backupLink,
    detail.backup_url,
    detail.backupUrl,
    detail.second_play_link,
    detail.secondPlayLink
  ].find(looksPlayableLink);
  const playLink = detail.play_link || directPlay || links.find((item) => /play|m3u8|mp4|video|media|source|src|url|link|file/.test(item.key))?.url || "";
  const backupLink = detail.backup_link || directBackup || links.find((item) => /backup|second|spare|mirror/.test(item.key))?.url || "";
  return {
    ...detail,
    play_link: playLink || detail.play_link || "",
    backup_link: backupLink || detail.backup_link || ""
  };
}

function normalizeFullSummary(summary = {}, detail = null) {
  return {
    ...summary,
    playLink: summary.playLink || detail?.play_link || "",
    backupLink: summary.backupLink || detail?.backup_link || ""
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
  return Boolean(looksPlayableLink(normalized?.play_link) || looksPlayableLink(normalized?.backup_link));
}

function isLockedCoinVideo(detail = null) {
  const normalized = normalizeFullDetail(detail);
  return normalized?.has_buy !== "y" && normalized?.layer_type === "money" && Number(normalized?.money || 0) > 0;
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeAccount(raw = {}) {
  const username = String(raw.username || raw.account_name || "").trim();
  const id = String(raw.id || (username ? `full-${slug(username)}` : `full-${Date.now()}`));
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
  if (!box?.iv || !box?.data) return {};
  const key = await importAesGcmKey(requireEnv(env, "TXZZ_CREDENTIAL_KEY"));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.iv) }, key, fromBase64(box.data));
  return JSON.parse(dec.decode(plain));
}

async function supabase(env, path, options = {}) {
  const url = `${requireEnv(env, "SUPABASE_URL").replace(/\/+$/, "")}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
      authorization: `Bearer ${requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(options.headers || {})
    }
  });
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
  const res = await fetch(`${(env.TXZZ_TARGET_BASE_URL || "https://txh068.com").replace(/\/+$/, "")}/h5${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "accept": "application/json, text/plain, */*",
      "deviceType": "web",
      "time": String(Math.round(Date.now() / 1000)),
      "version": env.TXZZ_API_VERSION || "4.76"
    },
    body
  });
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
  return row.enabled !== false && row.status !== "error";
}

async function getAccount(env, accountId = "") {
  let rows = [];
  if (accountId) rows = await supabase(env, `txzz_accounts?select=*&id=eq.${encodeURIComponent(accountId)}&limit=1`);
  if (!rows.length) rows = await supabase(env, `txzz_accounts?select=*&id=eq.${encodeURIComponent(DEFAULT_ACCOUNT_ID)}&limit=1`);
  if (!rows.length) rows = await supabase(env, "txzz_accounts?select=*&enabled=eq.true&order=created_at.asc&limit=1");
  if (!rows.length) throw new Error("remote account pool is empty");
  return rows[0];
}

async function saveAccount(env, raw) {
  const account = normalizeAccount(raw);
  let existingSecret = {};
  try {
    const existing = await supabase(env, `txzz_accounts?select=secret_box&id=eq.${encodeURIComponent(account.id)}&limit=1`);
    if (existing[0]?.secret_box) existingSecret = await decryptSecret(existing[0].secret_box, env);
  } catch (_) {}
  const secret = {
    password: account.password || existingSecret.password || "",
    qrcode: account.qrcode || existingSecret.qrcode || "",
    deviceId: account.deviceId || existingSecret.deviceId || "",
    userToken: account.userToken || existingSecret.userToken || ""
  };
  const secretBox = await encryptSecret(secret, env);
  secretBox.has = {
    password: Boolean(secret.password),
    qrcode: Boolean(secret.qrcode),
    userToken: Boolean(secret.userToken)
  };
  secretBox.tokenMasked = secret.userToken ? mask(secret.userToken, 12, 8) : "";
  const row = {
    id: account.id,
    label: account.label,
    username: account.username,
    role: "full",
    enabled: account.enabled,
    source: account.source,
    secret_box: secretBox,
    user_info: account.userInfo || null,
    status: account.status,
    notes: account.notes,
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
  if (!movieId) throw new Error("missing movieId");
  const bootstrap = body.bootstrapSession?.deviceId && body.bootstrapSession?.userToken ? body.bootstrapSession : null;
  const rows = await listAccountRows(env);
  let candidates = sortAccountsByCoin(rows.filter(isUsableAccountRow));
  if (!candidates.length) throw new Error("remote account pool is empty");

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
      await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "error", last_error: message })
      }).catch(() => {});
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
    const buyCandidates = lowestCoinRandomOrder(lockedCandidates.map((item) => item.account))
      .map((account) => lockedCandidates.find((item) => item.account.id === account.id))
      .filter(Boolean);
    for (const item of buyCandidates) {
      try {
        await apiRequest("/movie/doBuy", { id: movieId }, item.session, env);
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
        await supabase(env, `txzz_accounts?id=eq.${encodeURIComponent(item.account.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "error", last_error: message })
        }).catch(() => {});
        await audit(env, "movie.full_detail.buy", { accountId: item.account.id, movieId, ok: false, message }).catch(() => {});
      }
    }
  }

  throw new Error(`all remote accounts failed: ${JSON.stringify(errors.slice(-8))}`);
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
  if (!isEnabled(env.TXZZ_PROXY_MEDIA, false)) return fail("media proxy disabled", 404);
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target || !/^https:\/\/txh068\.com\/h5\/m3u8\/link\//.test(target)) return fail("invalid proxy url", 400);
  const res = await fetch(target, { headers: { "user-agent": request.headers.get("user-agent") || "Mozilla/5.0" } });
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "private, max-age=120");
  return new Response(res.body, { status: res.status, headers });
}

async function handle(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/v1/health") {
    return json({ ok: true, service: "txzz-secure-pool", build: BUILD_TAG, envReady: envReady(env), time: nowIso() });
  }
  if (path === "/v1/accounts" && request.method === "GET") {
    return json({ ok: true, accounts: await listAccounts(env) });
  }
  if (path === "/v1/accounts" && request.method === "POST") {
    const body = await request.json();
    return json({ ok: true, account: await saveAccount(env, body.account || body) });
  }
  if (path === "/v1/accounts/client-upload" && request.method === "POST") {
    const body = await request.json();
    return json({ ok: true, account: await saveAccount(env, body.account || body) });
  }
  if (path === "/v1/accounts/seed" && request.method === "POST") {
    return json({ ok: true, accounts: await seedAccounts(env) });
  }
  if (path === "/v1/accounts/verify" && request.method === "POST") {
    const body = await request.json();
    const account = await getAccount(env, body.accountId || "");
    const session = await acquireAccountSession(account, env, body.bootstrapSession || null);
    const updated = await updateAccountAfterVerify(env, account, session);
    return json({ ok: true, account: publicAccount(updated), session: { deviceId: session.deviceId, userInfo: session.userInfo } });
  }
  if (path === "/v1/movie/full-detail" && request.method === "POST") {
    return json(await fullDetail(env, ctx, await request.json()));
  }
  if (path === "/v1/media/proxy" && request.method === "GET") {
    return await proxyMedia(request, env);
  }
  return fail("not found", 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      return fail(err?.message || String(err), err?.status || 500);
    }
  }
};
