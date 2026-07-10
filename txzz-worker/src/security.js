"use strict";

const encoder = new TextEncoder();

/**
 * 可安全返回给客户端的业务异常。
 * 内部异常统一在入口处转换，避免数据库地址、上游响应等细节泄漏。
 */
export class HttpError extends Error {
  constructor(message, status = 400, code = "BAD_REQUEST") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** 为每次请求生成便于排查的短编号。 */
export function createRequestId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

// 内置服务访问密钥：与插件后台中的同名常量保持一致，用户无需在界面手工填写。
export const BUILT_IN_ACCESS_TOKEN = "txzz_builtin_5b8d0ce4a7f341d99e6c2f183b704ad6_7c15f8a2";

/** 使用固定长度摘要比较密钥，避免普通字符串比较产生明显时序差异。 */
export async function constantTimeTextEqual(left = "", right = "") {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right)))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/** 提取标准 Bearer 访问密钥，同时兼容专用请求头。 */
export function readAccessToken(request) {
  const authorization = String(request.headers.get("authorization") || "").trim();
  const matched = authorization.match(/^Bearer\s+(.+)$/i);
  return String(matched?.[1] || request.headers.get("x-txzz-access-token") || "").trim();
}

/**
 * 业务接口接受插件内置密钥；如部署环境另设 TXZZ_ACCESS_TOKEN，也同时作为有效密钥。
 * 这样插件只填写地址即可使用，同时保留运维侧额外调用入口。
 */
export async function requireAccess(request, env) {
  const supplied = readAccessToken(request);
  const optionalToken = String(env.TXZZ_ACCESS_TOKEN || "").trim();
  const [builtInMatched, optionalMatched] = await Promise.all([
    constantTimeTextEqual(supplied, BUILT_IN_ACCESS_TOKEN),
    optionalToken ? constantTimeTextEqual(supplied, optionalToken) : Promise.resolve(false)
  ]);
  if (!supplied || (!builtInMatched && !optionalMatched)) {
    throw new HttpError("服务访问校验失败，请确认使用最新版插件", 401, "UNAUTHORIZED");
  }
}

/**
 * 限制请求体体积并统一解析 JSON，防止超大正文占用 Worker 内存。
 */
export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError("请求内容过大", 413, "PAYLOAD_TOO_LARGE");
  }
  const text = await request.text();
  if (encoder.encode(text).length > maxBytes) {
    throw new HttpError("请求内容过大", 413, "PAYLOAD_TOO_LARGE");
  }
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("正文必须是对象");
    }
    return data;
  } catch (_) {
    throw new HttpError("请求内容不是有效的 JSON 对象", 400, "INVALID_JSON");
  }
}

/** 为所有响应补齐安全头和请求编号。 */
export function secureResponse(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("cache-control", "no-store");
  headers.set("x-txzz-request-id", requestId);
  if (response.status === 401) headers.set("www-authenticate", 'Bearer realm="txzz-worker"');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/** 只把明确标记的业务异常暴露给客户端。 */
export function publicError(err, requestId) {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { ok: false, error: err.message, code: err.code, requestId }
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: "服务内部异常，请稍后重试；如持续出现，请使用请求编号排查",
      code: "INTERNAL_ERROR",
      requestId
    }
  };
}
