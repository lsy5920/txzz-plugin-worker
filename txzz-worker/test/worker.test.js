import test from "node:test";
import assert from "node:assert/strict";
import worker, { buildServiceDiagnostics, isLockedCoinVideo, normalizeAccount, slug } from "../src/worker.js";
import { BUILT_IN_ACCESS_TOKEN } from "../src/security.js";

const completeEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  TXZZ_API_AES_KEY: "1234567890abcdef",
  TXZZ_CREDENTIAL_KEY: "credential-key"
};

test("中文账号会生成稳定且互不冲突的账号编号", () => {
  const first = normalizeAccount({ username: "测试账号甲", password: "a" });
  const same = normalizeAccount({ username: "测试账号甲", password: "b" });
  const other = normalizeAccount({ username: "测试账号乙", password: "a" });
  assert.equal(first.id, same.id);
  assert.notEqual(first.id, other.id);
  assert.notEqual(first.id, "full-");
  assert.match(first.id, /^full-u-[a-f0-9]{8}$/);
  assert.equal(slug("普通用户"), slug("普通用户"));
});

test("VIP 已返回播放链接时绝不进入金币购买流程", () => {
  const vipDirect = {
    has_buy: "n",
    layer_type: "money",
    money: 20,
    play_link: "https://media.example/video/index.m3u8"
  };
  const vipBackup = {
    has_buy: "n",
    layer_type: "money",
    money: 20,
    backup_link: "https://media.example/video/backup.mp4"
  };
  const vipSignedLink = {
    has_buy: "n",
    layer_type: "money",
    money: 20,
    playUrl: "https://signed.example/secure?id=123&token=test"
  };
  const vipRelativeLink = {
    has_buy: "n",
    layer_type: "money",
    money: 20,
    backup_link: "/secure-stream?id=456"
  };
  const vipPlaceholderWithAlternate = {
    has_buy: "n",
    layer_type: "money",
    money: 20,
    play_link: "null",
    playUrl: "https://signed.example/alternate?id=789&token=test"
  };
  const vipNestedSignedLink = {
    has_buy: "n",
    layer_type: "money",
    money: 20,
    sources: [{ url: "https://signed.example/nested?id=999&token=test" }]
  };
  const trulyLocked = { has_buy: "n", layer_type: "money", money: 20, play_link: "" };
  const placeholderLocked = { has_buy: "n", layer_type: "money", money: 20, play_link: "null" };
  assert.equal(isLockedCoinVideo(vipDirect), false);
  assert.equal(isLockedCoinVideo(vipBackup), false);
  assert.equal(isLockedCoinVideo(vipSignedLink), false);
  assert.equal(isLockedCoinVideo(vipRelativeLink), false);
  assert.equal(isLockedCoinVideo(vipPlaceholderWithAlternate), false);
  assert.equal(isLockedCoinVideo(vipNestedSignedLink), false);
  assert.equal(isLockedCoinVideo(trulyLocked), true);
  assert.equal(isLockedCoinVideo(placeholderLocked), true);
});

test("公开健康接口不泄漏密钥名称并带安全响应头", async () => {
  const response = await worker.fetch(new Request("https://worker.example/v1/health"), completeEnv, {});
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.authRequired, true);
  assert.equal("envReady" in data, false);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("x-txzz-request-id"));
});

test("插件携带内置密钥后可按服务地址直接调用业务接口", async () => {
  const response = await worker.fetch(new Request("https://worker.example/v1/accounts", {
    method: "PUT",
    headers: { authorization: `Bearer ${BUILT_IN_ACCESS_TOKEN}` }
  }), completeEnv, {});
  const data = await response.json();
  assert.equal(response.status, 405);
  assert.equal(data.code, "METHOD_NOT_ALLOWED");
  assert.ok(data.requestId);
});

test("非插件请求缺少内置密钥时会被拒绝", async () => {
  const response = await worker.fetch(new Request("https://worker.example/v1/accounts", { method: "PUT" }), completeEnv, {});
  const data = await response.json();
  assert.equal(response.status, 401);
  assert.equal(data.code, "UNAUTHORIZED");
});

test("预检请求可直接通过", async () => {
  const response = await worker.fetch(new Request("https://worker.example/v1/accounts", { method: "OPTIONS" }), completeEnv, {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-headers")?.includes("authorization"), true);
});

test("诊断评分能区分正常、警告和错误", () => {
  const normal = buildServiceDiagnostics({
    envStatus: Object.fromEntries(Object.keys(completeEnv).map((key) => [key, true])),
    accountStats: { total: 2, enabled: 2, ok: 2, error: 0, unverified: 0, avgCoin: 10 }
  });
  assert.equal(normal.level, "ok");
  assert.equal(normal.score, 100);

  const failed = buildServiceDiagnostics({ envStatus: { TXZZ_CREDENTIAL_KEY: false }, accountError: "连接失败" });
  assert.equal(failed.level, "error");
  assert.ok(failed.score < normal.score);
});
