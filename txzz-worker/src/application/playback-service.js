"use strict";

import {
  collectPlaybackCandidates,
  createPlaybackSession,
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
    const candidates = collectPlaybackCandidates(detail, options.summary || {})
      .map((candidate) => ({ ...candidate, url: absoluteUrl(candidate.url, env) }))
      .filter((candidate) => candidate.url)
      .slice(0, 12);
    const probed = await Promise.all(candidates.map(async (candidate) => ({
      ...candidate,
      stat: await statM3u8Quick(candidate.url, env)
    })));
    const ranked = [...probed].sort((left, right) => {
      const leftDuration = Number(left.stat?.duration || 0);
      const rightDuration = Number(right.stat?.duration || 0);
      if (leftDuration > 0 && rightDuration > 0 && leftDuration !== rightDuration) {
        const difference = Math.abs(leftDuration - rightDuration);
        if (difference >= Math.max(90, Math.min(leftDuration, rightDuration) * 0.08)) return rightDuration - leftDuration;
      }
      return (Number(right.stat?.score || 0) + Number(right.priority || 0))
        - (Number(left.stat?.score || 0) + Number(left.priority || 0));
    });
    const explicitPrimaryUrl = absoluteUrl(detail?.play_link || options.summary?.playLink || "", env);
    const primary = ranked.find((candidate) => candidate.url === explicitPrimaryUrl) || ranked[0] || null;
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
      backupStat
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
      state: { accountPool: await listAccounts(env), selectedFullAccountId: account.id }
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
      await ledger.transition(env, { movieId, accountId: account.id, status: "resolved", detail });
      return finish(env, ctx, {
        movieId,
        movieTitle,
        account: verified || account,
        detail,
        mode: "purchased",
        errors,
        attempts: errors.length + 1,
        purchase: { status: "resolved", accountId: account.id, price: Number(blocking.price || 0) }
      });
    } catch (error) {
      await ledger.transition(env, {
        movieId,
        accountId: account.id,
        status: "uncertain",
        error: error?.message || String(error)
      }).catch(() => {});
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
        if (!playableDetailReady(detail)) throw new Error("播放详情未返回可播放链接");
        return finish(env, ctx, {
          movieId,
          movieTitle,
          account: verified || account,
          detail,
          mode: "direct",
          errors,
          attempts: errors.length + 1
        });
      } catch (error) {
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

    if (!lockedCandidates.length) {
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
        try {
          await ledger.begin(env, {
            requestId,
            movieId,
            accountId: item.account.id,
            price: Number(item.detail?.money || 0)
          });
        } catch (_) {
          // 没有成功写入 pending 前绝不能向上游发起购买。
          throw new HttpError("购买安全账本写入失败，已禁止自动扣费", 503, "PURCHASE_LEDGER_UNAVAILABLE");
        }
        try {
          await apiRequest("/movie/doBuy", { id: movieId }, item.accountSession, env);
        } catch (error) {
          if (isConfirmedBeforeChargeFailure(error)) {
            errors.push(failureRow(item.account, error, "buy_before_charge"));
            await ledger.transition(env, {
              movieId,
              accountId: item.account.id,
              status: "failed_before_charge",
              error: error?.message || String(error)
            });
            continue;
          }
          await ledger.transition(env, {
            movieId,
            accountId: item.account.id,
            status: "uncertain",
            error: error?.message || String(error)
          }).catch(() => {});
          throw new HttpError("购买请求结果不确定，已阻止再次扣费", 409, "PURCHASE_RECONCILIATION_REQUIRED");
        }
        await ledger.transition(env, { movieId, accountId: item.account.id, status: "charged" });
        try {
          const detail = normalizeFullDetail(await apiRequest("/movie/detail", { id: movieId }, item.accountSession, env));
          if (isLockedCoinVideo(detail) || !playableDetailReady(detail)) {
            throw new Error("扣费后尚未取得可播放线路");
          }
          await ledger.transition(env, { movieId, accountId: item.account.id, status: "resolved", detail });
          return finish(env, ctx, {
            movieId,
            movieTitle,
            account: item.account,
            detail,
            mode: "purchased",
            errors,
            attempts: candidates.length,
            purchase: {
              status: "resolved",
              accountId: item.account.id,
              price: Number(item.detail?.money || 0)
            }
          });
        } catch (error) {
          await ledger.transition(env, {
            movieId,
            accountId: item.account.id,
            status: "uncertain",
            error: error?.message || String(error)
          }).catch(() => {});
          throw new HttpError("已完成扣费但播放详情需要人工核对，已阻止二次购买", 409, "PURCHASE_RECONCILIATION_REQUIRED");
        }
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

  return { createLegacyResponse, createSession, isConfirmedBeforeChargeFailure };
}

export { createPlaybackService };
