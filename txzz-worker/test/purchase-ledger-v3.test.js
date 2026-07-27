import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPurchaseLedgerRepository } from "../src/infrastructure/purchase-ledger.js";

function repositoryHarness(responder) {
  const calls = [];
  const supabase = async (_env, path, options = {}) => {
    calls.push({ path, options });
    return responder(path, options);
  };
  return { calls, repository: createPurchaseLedgerRepository({ supabase }) };
}

test("schema v3 门禁拒绝旧版本并接受完整 v3", async () => {
  const oldHarness = repositoryHarness(() => ({ ready: true, version: 2 }));
  assert.deepEqual(await oldHarness.repository.schemaReady({}), {
    ready: false,
    version: 2,
    error: "播放 schema 版本低于 3"
  });

  const currentHarness = repositoryHarness(() => ({ ready: true, version: 3 }));
  assert.deepEqual(await currentHarness.repository.schemaReady({}), { ready: true, version: 3 });
});

test("购买开始只调用数据库原子 RPC 并保留幂等动作", async () => {
  const harness = repositoryHarness((path) => {
    assert.equal(path, "rpc/txzz_begin_purchase_attempt");
    return {
      action: "idempotent",
      attempt: { attempt_id: "attempt-1", status: "charged", account_id: "a" }
    };
  });
  const result = await harness.repository.begin({}, {
    requestId: "request-1",
    movieId: "movie-1",
    accountId: "a",
    price: 20
  });
  assert.equal(result.action, "idempotent");
  assert.equal(result.attempt_id, "attempt-1");
  assert.equal(JSON.parse(harness.calls[0].options.body).p_request_id, "request-1");
});

test("账本状态迁移必须携带 attemptId 且拒绝未知状态", async () => {
  const harness = repositoryHarness((path, options) => {
    assert.equal(path, "rpc/txzz_transition_purchase_attempt");
    return { attempt_id: "attempt-2", status: JSON.parse(options.body).p_status };
  });
  const result = await harness.repository.transition({}, { attemptId: "attempt-2", status: "charged" });
  assert.equal(result.status, "charged");
  await assert.rejects(
    harness.repository.transition({}, { attemptId: "attempt-2", status: "refunded" }),
    /不支持的购买账本状态/
  );
});

test("v3 迁移声明五态单向迁移、90 秒过期和完整 schema 门禁", async () => {
  const sql = await readFile(new URL("../migrations/2026-07-27-playback-v3.sql", import.meta.url), "utf8");
  assert.match(sql, /unique \(request_id, movie_id, account_id\)/i);
  assert.match(sql, /when 'pending' then p_to in \('charged', 'failed_before_charge', 'uncertain'\)/i);
  assert.match(sql, /when 'charged' then p_to in \('resolved', 'uncertain'\)/i);
  assert.match(sql, /when 'uncertain' then p_to in \('resolved', 'uncertain'\)/i);
  assert.match(sql, /p_stale_seconds integer default 90/i);
  assert.match(sql, /trigger_name = 'txzz_purchase_ledger_mirror_v3'/i);
  assert.match(sql, /contype = 'c'/i);
  assert.match(sql, /'version', 3/i);
});
