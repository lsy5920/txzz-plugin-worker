import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackService } from "../src/application/playback-service.js";
import { createPlaybackSession } from "../src/domain/playback.js";
import { LEDGER_STATES } from "../src/infrastructure/purchase-ledger.js";
import { HttpError } from "../src/security.js";

function account(id, coin) {
  return { id, label: `账号 ${id}`, enabled: true, status: "ok", user_info: { coin } };
}

function createHarness(options = {}) {
  const accounts = options.accounts || [account("a", 10)];
  const calls = { api: [], transitions: [], buys: [], blockingChecks: 0, audits: [] };
  const detailByAccount = options.detailByAccount || {};
  const sessions = new Map(accounts.map((item) => [item.id, { accountId: item.id, deviceId: item.id, userToken: "token" }]));
  const ledger = {
    schemaReady: async () => options.schemaStatus || ({ ready: true, version: 3 }),
    expireStale: async () => Number(options.expiredStale || 0),
    findBlocking: async () => {
      const index = calls.blockingChecks;
      calls.blockingChecks += 1;
      if (Array.isArray(options.blockingSequence)) {
        return options.blockingSequence[Math.min(index, options.blockingSequence.length - 1)] || null;
      }
      return options.blocking || null;
    },
    begin: async (_env, row) => {
      if (options.beginError) throw options.beginError;
      calls.transitions.push({ ...row, status: "pending" });
      return options.beginResult || { ...row, action: "created", attempt_id: "attempt-1", status: "pending" };
    },
    transition: async (_env, row) => {
      calls.transitions.push(row);
      return row;
    },
    findAttempt: async () => options.reconciliationAttempt || null,
    listReconciliation: async () => options.reconciliationRows || []
  };
  let detailCount = 0;
  const apiRequest = async (endpoint, _payload, session) => {
    calls.api.push({ endpoint, accountId: session.accountId });
    if (endpoint === "/movie/doBuy") {
      calls.buys.push(session.accountId);
      if (options.buyError) throw options.buyError;
      return { ok: true };
    }
    detailCount += 1;
    if (options.afterBuyDetailError && calls.buys.length) throw options.afterBuyDetailError;
    const configured = detailByAccount[session.accountId];
    return typeof configured === "function"
      ? configured({ detailCount, bought: calls.buys.includes(session.accountId) })
      : configured || { play_link: `https://media.example/${session.accountId}.m3u8`, has_buy: "y" };
  };
  const deps = {
    HttpError,
    absoluteUrl: (value) => new URL(value, "https://target.example").href,
    accountCoinValue: (item, fallback = Number.POSITIVE_INFINITY) => Number(item.user_info?.coin ?? fallback),
    accountName: () => "",
    acquireAccountSession: async (item) => sessions.get(item.id),
    acquirePurchaseLock: async () => options.lock || { acquired: true, owner: "owner" },
    apiRequest,
    audit: async (...args) => { calls.audits.push(args); },
    cacheGet: async () => options.cache || null,
    cacheSet: async () => true,
    isCredentialFailureMessage: () => false,
    isUsableAccountRow: (item) => item.enabled !== false,
    ledger,
    listAccountRows: async () => accounts,
    listAccounts: async () => accounts,
    lowestCoinRandomOrder: (items) => [...items].sort((left, right) => left.user_info.coin - right.user_info.coin),
    markAccountFailure: async () => {},
    nowIso: () => "2026-07-27T00:00:00.000Z",
    publicAccount: (item) => ({ id: item.id, label: item.label, coin: item.user_info?.coin }),
    releasePurchaseLock: async () => {},
    sortAccountsByCoin: (items) => [...items].sort((left, right) => left.user_info.coin - right.user_info.coin),
    statM3u8Quick: async (link) => {
      const stat = typeof options.probeByUrl === "function"
        ? await options.probeByUrl(link)
        : { ok: true, status: 200, segments: 8, duration: 48 };
      return {
        protocol: String(link).includes("m3u8") ? "hls" : "progressive",
        ...stat
      };
    },
    updateAccountAfterVerify: async (_env, item) => item
  };
  return { calls, service: createPlaybackService(deps) };
}

const locked = (price = 20) => ({ has_buy: "n", layer_type: "money", money: price, play_link: "" });

test("lines candidate duration selection", async () => {
  const { service } = createHarness({
    detailByAccount: {
      a: {
        has_buy: "y",
        play_link: "/preview-12m.m3u8",
        backup_link: "/preview-15m.m3u8",
        lines: [
          { id: "1", name: "preview", link: "/preview-12m.m3u8" },
          { id: "2", name: "full", link: "/full-42m.m3u8" },
          { id: "3", name: "backup", link: "/full-58m.m3u8" }
        ]
      }
    },
    probeByUrl: async (link) => String(link).includes("58m")
      ? { ok: true, status: 200, segments: 580, duration: 3_480 }
      : String(link).includes("42m")
        ? { ok: true, status: 200, segments: 420, duration: 2_520 }
        : { ok: true, status: 200, segments: 120, duration: 720 }
  });
  const result = await service.createSession({}, {}, { movieId: "lines-1", requestId: "req-lines-1" });
  const recommended = result.session.sources.find((source) => source.id === result.session.decision.recommendedSourceId);
  assert.equal(recommended.health.duration, 3_480);
  assert.match(result.detail.play_link, /full-58m/);
  assert.match(result.detail.backup_link, /full-42m/);
  assert.doesNotMatch(result.detail.backup_link, /preview-15m/);
});

test("v2 会话返回完整线路契约并以健康主线路为推荐", () => {
  const session = createPlaybackSession({
    movieId: "88",
    movieTitle: "糖果测试片",
    detail: { play_link: "/main.m3u8", backup_link: "https://cdn.example/backup.mp4" },
    summary: {
      fullStat: { status: 200, ok: true, segments: 12 },
      backupStat: { error: "down" }
    },
    account: { id: "a", label: "A" },
    absoluteUrl: (value) => new URL(value, "https://target.example").href,
    sessionId: "session-1",
    now: new Date("2026-07-27T00:00:00.000Z")
  });
  assert.equal(session.id, "session-1");
  assert.equal(session.phase, "ready");
  assert.equal(session.sources[0].url, "https://target.example/main.m3u8");
  assert.equal(session.sources[0].protocol, "hls");
  assert.equal(session.sources[1].protocol, "progressive");
  assert.equal(session.decision.recommendedSourceId, "primary");
  assert.ok(session.expiresAt > session.fetchedAt);
});

test("不同视频按主备清单相对时长选择完整版而不写死固定时长", async () => {
  const cachedDetail = {
    has_buy: "y",
    play_link: "/preview-17m.m3u8",
    backup_link: "/full-1h.m3u8"
  };
  const { service, calls } = createHarness({
    cache: {
      detail: cachedDetail,
      summary: {
        movieId: "vlog-1",
        session: createPlaybackSession({
          movieId: "vlog-1",
          detail: cachedDetail,
          account: account("a", 10),
          absoluteUrl: (value) => new URL(value, "https://target.example").href
        })
      }
    },
    probeByUrl: async (link) => String(link).includes("full-1h")
      ? { ok: true, status: 200, segments: 600, duration: 3_600 }
      : { ok: true, status: 200, segments: 170, duration: 1_020 }
  });

  const result = await service.createSession({}, {}, { movieId: "vlog-1", requestId: "req-vlog-1" });
  assert.equal(result.session.decision.recommendedSourceId, "backup");
  assert.ok(result.session.decision.reasonCodes.includes("longer-playlist-duration"));
  assert.equal(result.session.sources.find((source) => source.id === "backup").health.duration, 3_600);
  assert.deepEqual(calls.api, []);
});

test("任一账号已有直链时绝不购买", async () => {
  const { service, calls } = createHarness({
    detailByAccount: { a: { has_buy: "n", layer_type: "money", money: 20, play_link: "/ready.m3u8" } }
  });
  const result = await service.createSession({}, {}, { movieId: "1", requestId: "req-1" });
  assert.equal(result.session.acquisition.mode, "direct");
  assert.deepEqual(calls.buys, []);
});

test("全部账号锁定后按最低金币账号购买一次", async () => {
  const { service, calls } = createHarness({
    accounts: [account("rich", 100), account("low", 5)],
    detailByAccount: {
      low: ({ bought }) => bought ? { has_buy: "y", play_link: "/low.m3u8" } : locked(),
      rich: locked()
    }
  });
  const result = await service.createSession({}, {}, { movieId: "2", requestId: "req-2" });
  assert.equal(result.session.acquisition.mode, "purchased");
  assert.deepEqual(calls.buys, ["low"]);
  assert.deepEqual(calls.transitions.map((row) => row.status), ["pending", "charged", "resolved"]);
});

test("并发购买锁失败时返回 PURCHASE_IN_PROGRESS", async () => {
  const { service, calls } = createHarness({ detailByAccount: { a: locked() }, lock: { acquired: false, owner: "other" } });
  await assert.rejects(
    service.createSession({}, {}, { movieId: "3", requestId: "req-3" }),
    (error) => error.code === "PURCHASE_IN_PROGRESS"
  );
  assert.deepEqual(calls.buys, []);
});

test("获取互斥锁后再次发现已解决账本时复用详情且不重复购买", async () => {
  const { service, calls } = createHarness({
    detailByAccount: { a: locked() },
    blockingSequence: [null, {
      movie_id: "3b",
      account_id: "a",
      status: "resolved",
      price: 20,
      detail: { has_buy: "y", play_link: "/already-resolved.m3u8" }
    }]
  });
  const result = await service.createSession({}, {}, { movieId: "3b", requestId: "req-3b" });
  assert.equal(result.session.sources[0].url, "https://target.example/already-resolved.m3u8");
  assert.deepEqual(calls.buys, []);
  assert.equal(calls.blockingChecks, 2);
});

test("扣费后详情失败进入 uncertain 且不尝试第二账号", async () => {
  const { service, calls } = createHarness({
    accounts: [account("low", 5), account("next", 10)],
    detailByAccount: { low: locked(), next: locked() },
    afterBuyDetailError: new Error("detail timeout")
  });
  await assert.rejects(
    service.createSession({}, {}, { movieId: "4", requestId: "req-4" }),
    (error) => error.code === "PURCHASE_RECONCILIATION_REQUIRED"
  );
  assert.deepEqual(calls.buys, ["low"]);
  assert.deepEqual(calls.transitions.map((row) => row.status), ["pending", "charged", "uncertain"]);
});

test("购买账本固定为五种状态且 v1 由同一服务映射", async () => {
  assert.deepEqual(LEDGER_STATES, ["pending", "charged", "resolved", "failed_before_charge", "uncertain"]);
  const { service } = createHarness();
  const legacy = await service.createLegacyResponse({}, {}, { movieId: "5" });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.summary.movieId, "5");
  assert.equal(legacy.summary.playLink, "https://media.example/a.m3u8");
  assert.equal(legacy.detail.play_link, "https://media.example/a.m3u8");
});

test("v2 必须携带 requestId", async () => {
  const { service } = createHarness();
  await assert.rejects(
    service.createSession({}, {}, { movieId: "6" }),
    (error) => error.code === "REQUEST_ID_REQUIRED"
  );
});

test("普通网页 URL 不是媒体源，但疑似权益存在时禁止切换账号购买", async () => {
  const { service, calls } = createHarness({
    accounts: [account("html", 5), account("locked", 10)],
    detailByAccount: {
      html: { has_buy: "y", url: "https://target.example/movie/123" },
      locked: locked()
    }
  });
  await assert.rejects(
    service.createSession({}, {}, { movieId: "html-url", requestId: "req-html-url" }),
    (error) => error.code === "PLAYBACK_UNAVAILABLE"
  );
  assert.deepEqual(calls.buys, []);
});

test("显式 play_url 返回 HTML 时不进入 sources 且仍禁止购买", async () => {
  const { service, calls } = createHarness({
    accounts: [account("html", 5), account("locked", 10)],
    detailByAccount: {
      html: { has_buy: "y", play_url: "https://target.example/movie/123" },
      locked: locked()
    },
    probeByUrl: async () => ({
      ok: false,
      status: 200,
      protocol: "unknown",
      error: "响应不是可播放媒体（text/html）"
    })
  });
  await assert.rejects(
    service.createSession({}, {}, { movieId: "html-play-url", requestId: "req-html-play-url" }),
    (error) => error.code === "PLAYBACK_UNAVAILABLE"
  );
  assert.deepEqual(calls.buys, []);
});

test("幂等 begin 返回 pending 时保留 PURCHASE_IN_PROGRESS 而不是误报账本不可用", async () => {
  const { service, calls } = createHarness({
    detailByAccount: { a: locked() },
    beginResult: {
      action: "idempotent",
      attempt_id: "attempt-existing",
      movie_id: "idem",
      account_id: "a",
      status: "pending"
    }
  });
  await assert.rejects(
    service.createSession({}, {}, { movieId: "idem", requestId: "req-idem" }),
    (error) => error.code === "PURCHASE_IN_PROGRESS" && error.status === 409
  );
  assert.deepEqual(calls.buys, []);
});

test("购买安全账本未达到 schema v3 时禁止扣费", async () => {
  const { service, calls } = createHarness({
    detailByAccount: { a: locked() },
    schemaStatus: { ready: false, version: 2 }
  });
  await assert.rejects(
    service.createSession({}, {}, { movieId: "schema-v2", requestId: "req-schema-v2" }),
    (error) => error.code === "PURCHASE_LEDGER_UNAVAILABLE"
  );
  assert.deepEqual(calls.buys, []);
});

test("安全对账只使用原账号重新取详情且绝不调用 doBuy", async () => {
  const attempt = {
    attempt_id: "attempt-reconcile",
    request_id: "request-reconcile",
    movie_id: "movie-reconcile",
    account_id: "original",
    status: "uncertain",
    price: 20
  };
  const { service, calls } = createHarness({
    accounts: [account("original", 8), account("other", 5)],
    reconciliationAttempt: attempt,
    detailByAccount: {
      original: { has_buy: "y", play_link: "/reconciled.m3u8" },
      other: locked()
    }
  });
  const result = await service.reconcileAttempt({}, {}, {
    attemptId: attempt.attempt_id,
    reconciliationId: "ui-action-1"
  });
  assert.equal(result.session.account.id, "original");
  assert.deepEqual(calls.buys, []);
  assert.ok(calls.transitions.some((row) => row.status === "resolved" && row.attemptId === attempt.attempt_id));
});

test("对账列表只返回脱敏错误和公开账号摘要", async () => {
  const { service } = createHarness({
    reconciliationRows: [{
      attempt_id: "attempt-list",
      request_id: "request-list",
      movie_id: "movie-list",
      account_id: "a",
      status: "uncertain",
      price: 18,
      error: "token=secret https://cdn.example/video.m3u8?signature=raw",
      created_at: "2026-07-27T00:00:00.000Z",
      updated_at: "2026-07-27T00:01:00.000Z",
      detail: { play_link: "https://must-not-leak.example/video.m3u8" }
    }]
  });
  const result = await service.listReconciliation({});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].error.includes("secret"), false);
  assert.equal(result.items[0].error.includes("cdn.example"), false);
  assert.deepEqual(Object.keys(result.items[0].account).sort(), ["coin", "id", "label"]);
  assert.equal("detail" in result.items[0], false);
});
