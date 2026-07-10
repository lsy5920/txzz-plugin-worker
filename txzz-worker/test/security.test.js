import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_ACCESS_TOKEN,
  HttpError,
  constantTimeTextEqual,
  publicError,
  readAccessToken,
  readJsonBody,
  requireAccess,
  secureResponse
} from "../src/security.js";

test("插件内置密钥和运维附加密钥都可通过校验", async () => {
  const builtInRequest = new Request("https://example.com/v1/accounts", {
    headers: { authorization: `Bearer ${BUILT_IN_ACCESS_TOKEN}` }
  });
  const optionalRequest = new Request("https://example.com/v1/accounts", {
    headers: { authorization: "Bearer optional-token" }
  });
  assert.equal(readAccessToken(builtInRequest), BUILT_IN_ACCESS_TOKEN);
  assert.equal(await constantTimeTextEqual(BUILT_IN_ACCESS_TOKEN, BUILT_IN_ACCESS_TOKEN), true);
  await assert.doesNotReject(requireAccess(builtInRequest, {}));
  await assert.doesNotReject(requireAccess(optionalRequest, { TXZZ_ACCESS_TOKEN: "optional-token" }));
  await assert.rejects(
    requireAccess(new Request("https://example.com/v1/accounts"), {}),
    (error) => error instanceof HttpError && error.status === 401 && error.code === "UNAUTHORIZED"
  );
});

test("请求体必须是大小受限的 JSON 对象", async () => {
  const valid = await readJsonBody(new Request("https://example.com", {
    method: "POST",
    body: JSON.stringify({ movieId: "123" })
  }));
  assert.deepEqual(valid, { movieId: "123" });

  await assert.rejects(
    readJsonBody(new Request("https://example.com", { method: "POST", body: "[1,2,3]" })),
    (error) => error instanceof HttpError && error.code === "INVALID_JSON"
  );

  await assert.rejects(
    readJsonBody(new Request("https://example.com", { method: "POST", body: "x".repeat(80) }), 32),
    (error) => error instanceof HttpError && error.status === 413
  );
});

test("安全响应包含请求编号并为鉴权失败返回标准提示头", async () => {
  const response = secureResponse(new Response("{}", { status: 200 }), "request-test-id");
  assert.equal(response.headers.get("x-txzz-request-id"), "request-test-id");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.has("www-authenticate"), false);
  const unauthorized = secureResponse(new Response("{}", { status: 401 }), "request-test-id");
  assert.match(unauthorized.headers.get("www-authenticate") || "", /^Bearer /);
});

test("内部异常只向客户端返回脱敏说明", () => {
  const exposed = publicError(new Error("数据库真实地址与内部错误"), "request-test-id");
  assert.equal(exposed.status, 500);
  assert.equal(exposed.body.code, "INTERNAL_ERROR");
  assert.equal(exposed.body.requestId, "request-test-id");
  assert.equal(JSON.stringify(exposed.body).includes("数据库真实地址"), false);
});
