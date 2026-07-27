"use strict";

import {
  collectPlaybackCandidates,
  createPlaybackSession,
  hasPotentialPlaybackEntitlement,
  legacyResponseFromPlayback,
  normalizeFullDetail,
  playableDetailReady,
  isLockedCoinVideo
} from "../domain/playback.js";

function createPlaybackService(deps) {
  const {
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
    ledger,
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
  } = deps;

  function failureRow(account, error, stage = "detail") {
    return {
      accountId: account?.id,
      label: account?.label,
      stage,
      message: error?.message || String(error)
    };
  }

  function acquisition(mode, attempts, failed, purchase) {
    return { mode, attempts, failed: failed.slice(-8), purchase };
  }

  /**
   * 只有上游明确拒绝且原因确认发生在扣费前，才允许换下一个账号。
   * 超时、断网和未知响应都可能已经扣费，必须进入 uncertain 并立即停止。
   */
  function isConfirmedBeforeChargeFailure(error) {
    if (error?.upstreamRejected !== true) return false;
    return /余额不足|金币不足|insufficient|not enough|视频.*下架|参数.*(?:错误|无效)|invalid parameter/i
      .test(error?.message || String(error));
  }

  async function finish(env, ctx, options) {
    const { movieId, movieTitle, account, detail, mode, errors, attempts, purchase } = options;
    // 返回会话前并行探测主备清单。若先按“主线优先”返回，短预览线会在后台
    // 探测完成前被播放器锁定，正是 Vlog 17 分钟覆盖 1 小时完整版的根因。
    const explicitPrimaryUrl = absoluteUrl(detail?.play_link || options.summary?.playLink || "", env);
    const explicitBackupUrl = absoluteUrl(detail?.backup_link || options.summary?.backupLink || "", env);
    let alternateIndex = 1;
    const candidates = collectPlaybackCandidates(detail, options.summary || {})
      .map((candidate) => ({ ...candidate, url: absoluteUrl(candidate.url, env) }))
      .filter((candidate) => candidate.url)
      .map((candidate) => {
        if (candidate.url === explicitPrimaryUrl) return { ...candidate, id: "primary", role: "primary" };
        if (candidate.url === explicitBackupUrl) return { ...candidate, id: "backup", role: "backup" };
        const id = `alternate-${alternateIndex}`;
        alternateIndex += 1;
        return { ...candidate, id, role: "alternate" };
      })
      .slice(0, 12);
    const probed = await Promise.all(candidates.map(async (candidate) => ({
      ...candidate,
      stat: await statM3u8Quick(candidate.url, env)
    })));
    const confirmed = probed.filter((candidate) => (
      candidate.stat?.ok === true
      && !candidate.stat?.error
      && ["hls", "progressive"].includes(candidate.stat?.protocol)
    ));
    if (!confirmed.length) {
      // 疑似权益字段必须继续阻止购买，但只有探测确认的媒体才能进入 sources。
      const error = new HttpError("发现疑似播放权益字段，但响应不是可播放媒体", 502, "PLAYBACK_SOURCE_UNCONFIRMED");
      error.preventPurchase = true;
      throw error;
    }
    const ranked = [...confirmed].sort((left, right) => {
      const leftDuration = Number(left.stat?.duration || 0);
      const rightDuration = Number(right.stat?.duration || 0);
      if (leftDuration > 0 && rightDuration > 0 && leftDuration !== rightDuration) {
        const difference = Math.abs(leftDuration - rightDuration);
        if (difference >= Math.max(90, Math.min(leftDuration, rightDuration) * 0.08)) return rightDuration - leftDuration;
      }
      return (Number(right.stat?.score || 0) + Number(right.priority || 0))
        - (Number(left.stat?.score || 0) + Number(left.priority || 0));
    });
    const primary = ranked[0] || null;
    // backup 字段不天然代表完整版；真实接口可能把第二条试看线放在这里，
    // 完整线路则藏在 lines[]。备用位因此取探测后排名最高的不同 URL。
    const backup = ranked.find((candidate) => candidate.url !== primary?.url) || null;
    const resolvedDetail = {
      ...detail,
      play_link: primary?.url || detail?.play_link || "",
      backup_link: backup?.url || detail?.backup_link || ""
    };
    const primaryStat = primary?.stat || null;
    const backupStat = backup?.stat || null;
    const probedSummary = {
      movieId,
      movieTitle,
      playLink: resolvedDetail.play_link,
      backupLink: resolvedDetail.backup_link,
      fullStat: primaryStat,
      backupStat,
      recommendedPlayLink: primary?.url || "",
      recommendedSourceId: primary?.id || "",
      probedSources: ranked.map((candidate, index) => ({
        id: candidate.id,
        role: candidate.role,
        label: index === 0 ? "推荐线路" : index === 1 ? "备用线路" : `候选线路 ${index + 1}`,
        url: candidate.url,
        stat: candidate.stat
      }))
    };
    const session = createPlaybackSession({
      movieId,
      movieTitle,
      detail: resolvedDetail,
      summary: probedSummary,
      account,
      acquisition: acquisition(mode, attempts, errors, purchase),
      absoluteUrl: (value) => absoluteUrl(value, env)
    });
    await cacheSet(env, account.id, movieId, resolvedDetail, { schemaVersion: 3, session });
    await audit(env, "playback.session.ready", {
      accountId: account.id,
      movieId,
      ok: true,
      meta: {
        mode,
        attempts,
        sessionId: session.id,
        sourceCount: session.sources.length,
        recommendedSourceId: session.decision.recommendedSourceId,
        primaryDuration: Number(primaryStat?.duration || 0),
        backupDuration: Number(backupStat?.duration || 0)
      }
    });

    return {
      ok: true,
      session,
      detail: resolvedDetail,
      account: publicAccount(account),
      state: { accountPool: await listAccounts(env).catch(() => []), selectedFullAccountId: account.id }
    };
  }

  async function reconcileBlockingPurchase(env, ctx, blocking, options) {
    const { movieId, movieTitle, bootstrapSession, errors } = options;
    if (blocking.status === "pending") {
      throw new HttpError("该视频正在由另一请求解锁，请稍后重试", 409, "PURCHASE_IN_PROGRESS");
    }
    const rows = await listAccountRows(env);
    const account = rows.find((row) => row.id === blocking.account_id);
    if (!account) throw new HttpError("购买账本对应账号不存在，需要人工核对", 409, "PURCHASE_RECONCILIATION_REQUIRED");
    if (blocking.status === "resolved" && playableDetailReady(blocking.detail)) {
      return finish(env, ctx, {
        movieId,
        movieTitle,
        account,
        detail: normalizeFullDetail(blocking.detail),
        mode: "purchased",
        errors,
        attempts: errors.length + 1,
        purchase: { status: "resolved", accountId: account.id, price: Number(blocking.price || 0) }
      });
    }
    try {
      const session = await acquireAccountSession(account, env, bootstrapSession);
      const verified = await updateAccountAfterVerify(env, account, session);
      const detail = normalizeFullDetail(await apiRequest("/movie/detail", { id: movieId }, session, env));
      if (!playableDetailReady(detail)) {
        throw new Error("已扣费记录尚未取得可播放线路");
      }
      const playbackResult = await finish(env, ctx, {
        movieId,
        movieTitle,
        account: verified || account,
        detail,
        mode: "purchased",
        errors,
        attempts: errors.length + 1,
        purchase: { status: "resolved", accountId: account.id, price: Number(blocking.price || 0) }
      });
      // 只有线路探测确认媒体并成功生成会话后才能写 resolved；普通 HTML 200
      // 或损坏媒体仍保持 charged/uncertain，避免终态错误放行。
      if (blocking.status !== "resolved") {
        await ledger.transition(env, { attemptId: blocking.attempt_id, movieId, accountId: account.id, status: "resolved", detail });
      }
      return playbackResult;
    } catch (error) {
      if (blocking.status !== "resolved") {
        await ledger.transition(env, {
          movieId,
          accountId: account.id,
          attemptId: blocking.attempt_id,
          status: "uncertain",
          error: error?.message || String(error)
        }).catch(() => {});
      }
      throw new HttpError("该视频存在已扣费或待核对记录，已阻止再次购买", 409, "PURCHASE_RECONCILIATION_REQUIRED");
    }
  }

  async function createSession(env, ctx, body = {}) {
    const movieId = String(body.movieId || body.id || "").trim();
    const requestId = String(body.requestId || "").trim();
    if (!movieId) throw new HttpError("缺少视频编号", 400, "MOVIE_ID_REQUIRED");
    if (!requestId) throw new HttpError("缺少请求幂等编号", 400, "REQUEST_ID_REQUIRED");
    const movieTitle = String(body.movieTitle || "").trim();
    const bootstrapSession = body.bootstrapSession?.deviceId && body.bootstrapSession?.userToken
      ? body.bootstrapSession
      : null;
    const rows = await listAccountRows(env);
    const candidates = sortAccountsByCoin(rows.filter(isUsableAccountRow));
    if (!candidates.length) throw new HttpError("云端账号池没有可用账号", 409, "ACCOUNT_POOL_EMPTY");

    const errors = [];
    const lockedCandidates = [];
    let potentialEntitlementFound = false;
    for (const account of candidates) {
      if (!body.forceRefresh) {
        const cached = await cacheGet(env, account.id, movieId);
        if (cached?.detail && playableDetailReady(cached.detail)) {
          // 缓存只跳过账号/详情请求，线路覆盖时长仍需重新探测；旧缓存可能保存了
          // “短主线优先”的决定，直接复用会让问题持续到缓存过期。
          return finish(env, ctx, {
            movieId,
            movieTitle: movieTitle || cached.summary?.session?.title || cached.summary?.movieTitle || "",
            account,
            detail: normalizeFullDetail(cached.detail),
            mode: "cache",
            errors,
            attempts: errors.length + 1
          });
        }
      }

      try {
        const accountSession = await acquireAccountSession(account, env, bootstrapSession);
        const verified = await updateAccountAfterVerify(env, account, accountSession);
        const detail = normalizeFullDetail(await apiRequest("/movie/detail", { id: movieId }, accountSession, env));
        if (isLockedCoinVideo(detail)) {
          lockedCandidates.push({ account: verified || account, accountSession, detail });
          continue;
        }
        if (!playableDetailReady(detail)) {
          // 上游若返回普通网页 URL 或暂时失效的疑似权益字段，播放器不能使用它，
          // 但也绝不能因此把同一影片判为“未购买”并改用其他账号扣费。
          potentialEntitlementFound ||= hasPotentialPlaybackEntitlement(detail);
          throw new Error("发现疑似播放权益字段，但尚未确认可播放媒体");
        }
        return await finish(env, ctx, {
          movieId,
          movieTitle,
          account: verified || account,
          detail,
          mode: "direct",
          errors,
          attempts: errors.length + 1
        });
      } catch (error) {
        potentialEntitlementFound ||= error?.preventPurchase === true;
        errors.push(failureRow(account, error));
        await markAccountFailure(env, account, error, isCredentialFailureMessage(error?.message || String(error)));
        await audit(env, "playback.session.account_failed", {
          accountId: account.id,
          movieId,
          ok: false,
          message: error?.message || String(error)
        });
      }
    }

    if (!lockedCandidates.length || potentialEntitlementFound) {
      throw new HttpError("所有账号均未取得可播放线路", 502, "PLAYBACK_UNAVAILABLE");
    }

    const ledgerStatus = await ledger.schemaReady(env);
    if (!ledgerStatus.ready) {
      throw new HttpError("购买安全账本尚未完成迁移，已禁止自动扣费", 503, "PURCHASE_LEDGER_UNAVAILABLE");
    }
    const blocking = await ledger.findBlocking(env, movieId);
    if (blocking) {
      return reconcileBlockingPurchase(env, ctx, blocking, { movieId, movieTitle, bootstrapSession, errors });
    }

    const purchaseLock = await acquirePurchaseLock(env, movieId);
    if (!purchaseLock.acquired) throw new HttpError("该视频正在由另一请求解锁，请稍后重试", 409, "PURCHASE_IN_PROGRESS");
    try {
      // findBlocking 与获取数据库锁之间存在窗口；锁内必须再次读取，避免上一请求刚完成后
      // 本请求把 resolved/uncertain 账本覆盖成 pending 并重复购买。
      const blockingAfterLock = await ledger.findBlocking(env, movieId);
      if (blockingAfterLock) {
        return await reconcileBlockingPurchase(env, ctx, blockingAfterLock, {
          movieId,
          movieTitle,
          bootstrapSession,
          errors
        });
      }
      const ordered = lowestCoinRandomOrder(lockedCandidates.map((item) => item.account))
        .map((account) => lockedCandidates.find((item) => item.account.id === account.id))
        .filter(Boolean);
      for (const item of ordered) {
        let attempt;
        try {
          attempt = await ledger.begin(env, {
            requestId,
            movieId,
            accountId: item.account.id,
            price: Number(item.detail?.money || 0)
          });
        } catch (_) {
          // 没有成功写入 pending 前绝不能向上游发起购买。
          throw new HttpError("购买安全账本写入失败，已禁止自动扣费", 503, "PURCHASE_LEDGER_UNAVAILABLE");
        }
        // 账本写入错误与业务对账错误必须分开处理；后者需要保留准确的 409 错误码，
        // 不能被上面的数据库异常兜底误报为 PURCHASE_LEDGER_UNAVAILABLE。
        if (attempt.action === "blocked" || (attempt.action === "idempotent" && ["pending", "charged", "resolved", "uncertain"].includes(attempt.status))) {
          return await reconcileBlockingPurchase(env, ctx, attempt, {
            movieId,
            movieTitle,
            bootstrapSession,
            errors
          });
        }
        if (attempt.status === "failed_before_charge") continue;
        item.attempt = attempt;
        try {
          await apiRequest("/movie/doBuy", { id: movieId }, item.accountSession, env);
        } catch (error) {
          if (isConfirmedBeforeChargeFailure(error)) {
            errors.push(failureRow(item.account, error, "buy_before_charge"));
            await ledger.transition(env, {
              movieId,
              accountId: item.account.id,
              attemptId: item.attempt?.attempt_id,
              status: "failed_before_charge",
              error: error?.message || String(error)
            });
            continue;
          }
          await ledger.transition(env, {
            movieId,
            accountId: item.account.id,
            attemptId: item.attempt?.attempt_id,
            status: "uncertain",
            error: error?.message || String(error)
          }).catch(() => {});
          throw new HttpError("购买请求结果不确定，已阻止再次扣费", 409, "PURCHASE_RECONCILIATION_REQUIRED");
        }
        await ledger.transition(env, { attemptId: item.attempt?.attempt_id, movieId, accountId: item.account.id, status: "charged" });
        let purchasedDetail;
        let playbackResult;
        try {
          purchasedDetail = normalizeFullDetail(await apiRequest("/movie/detail", { id: movieId }, item.accountSession, env));
          if (isLockedCoinVideo(purchasedDetail) || !playableDetailReady(purchasedDetail)) {
            throw new Error("扣费后尚未取得可播放线路");
          }
          playbackResult = await finish(env, ctx, {
            movieId,
            movieTitle,
            account: item.account,
            detail: purchasedDetail,
            mode: "purchased",
            errors,
            attempts: candidates.length,
            purchase: {
              status: "resolved",
              accountId: item.account.id,
              price: Number(item.detail?.money || 0)
            }
          });
          await ledger.transition(env, {
            attemptId: item.attempt?.attempt_id,
            movieId,
            accountId: item.account.id,
            status: "resolved",
            detail: purchasedDetail
          });
        } catch (error) {
          await ledger.transition(env, {
            movieId,
            accountId: item.account.id,
            attemptId: item.attempt?.attempt_id,
            status: "uncertain",
            error: error?.message || String(error)
          }).catch(() => {});
          throw new HttpError("已完成扣费但播放详情需要人工核对，已阻止二次购买", 409, "PURCHASE_RECONCILIATION_REQUIRED");
        }
        // resolved 是终态；此处会话已生成且账本已落盘，后续不得回退为 uncertain。
        return playbackResult;
      }
    } finally {
      await releasePurchaseLock(env, movieId, purchaseLock.owner).catch(() => {});
    }
    throw new HttpError("没有账号能够完成视频解锁", 502, "PLAYBACK_UNAVAILABLE");
  }

  async function createLegacyResponse(env, ctx, body = {}) {
    const result = await createSession(env, ctx, {
      ...body,
      requestId: String(body.requestId || crypto.randomUUID())
    });
    await audit(env, "playback.v1.compat", {
      accountId: result.session?.account?.id,
      movieId: result.session?.movieId,
      ok: true,
      meta: { sunsetDays: 30 }
    });
    return legacyResponseFromPlayback(result);
  }

  function sanitizedReconciliationError(value = "") {
    return String(value || "")
      .replace(/https?:\/\/\S+/gi, "[链接已脱敏]")
      .replace(/(token|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=[已脱敏]")
      .slice(0, 180);
  }

  async function listReconciliation(env) {
    const [attempts, accounts] = await Promise.all([ledger.listReconciliation(env), listAccountRows(env)]);
    const accountMap = new Map(accounts.map((account) => {
      const safeAccount = publicAccount(account);
      return [account.id, {
        id: safeAccount.id,
        label: safeAccount.label,
        coin: Number(safeAccount.coin ?? accountCoinValue(account, 0) ?? 0)
      }];
    }));
    return {
      ok: true,
      items: attempts.map((attempt) => ({
        attemptId: attempt.attempt_id,
        requestId: attempt.request_id,
        movieId: attempt.movie_id,
        status: attempt.status,
        price: Number(attempt.price || 0),
        account: accountMap.get(attempt.account_id) || { id: attempt.account_id, label: "原购买账号" },
        error: sanitizedReconciliationError(attempt.error),
        createdAt: attempt.created_at,
        updatedAt: attempt.updated_at,
        canReconcile: ["charged", "uncertain"].includes(attempt.status)
      }))
    };
  }

  async function reconcileAttempt(env, ctx, body = {}) {
    const attemptId = String(body.attemptId || "").trim();
    const reconciliationId = String(body.reconciliationId || "").trim();
    if (!attemptId || !reconciliationId) {
      throw new HttpError("缺少对账编号", 400, "RECONCILIATION_ID_REQUIRED");
    }
    await ledger.expireStale(env);
    const attempt = await ledger.findAttempt(env, attemptId);
    if (!attempt) throw new HttpError("对账记录不存在", 404, "RECONCILIATION_NOT_FOUND");
    if (attempt.status === "failed_before_charge") {
      throw new HttpError("该记录确认未扣费，无需对账", 409, "RECONCILIATION_NOT_REQUIRED");
    }
    await audit(env, "playback.purchase.reconcile", {
      accountId: attempt.account_id,
      movieId: attempt.movie_id,
      ok: true,
      meta: { attemptId, reconciliationId, status: attempt.status }
    });
    return reconcileBlockingPurchase(env, ctx, attempt, {
      movieId: attempt.movie_id,
      movieTitle: String(body.movieTitle || ""),
      bootstrapSession: body.bootstrapSession || null,
      errors: []
    });
  }

  return {
    createLegacyResponse,
    createSession,
    isConfirmedBeforeChargeFailure,
    listReconciliation,
    reconcileAttempt
  };
}

export { createPlaybackService };
