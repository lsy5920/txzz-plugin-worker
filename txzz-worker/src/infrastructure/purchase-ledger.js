"use strict";

const LEDGER_STATES = ["pending", "charged", "resolved", "failed_before_charge", "uncertain"];
const BLOCKING_STATES = ["pending", "charged", "resolved", "uncertain"];

function createPurchaseLedgerRepository({ supabase }) {
  async function schemaReady(env) {
    try {
      const result = await supabase(env, "rpc/txzz_playback_schema_status", {
        method: "POST",
        body: "{}"
      });
      const status = Array.isArray(result) ? result[0] : result;
      if (status?.ready !== true || Number(status?.version || 0) < 3) {
        return { ready: false, version: Number(status?.version || 0), error: "播放 schema 版本低于 3" };
      }
      return { ready: true, version: Number(status.version) };
    } catch (error) {
      return { ready: false, version: 0, error: error?.message || String(error) };
    }
  }

  async function expireStale(env, movieId = "") {
    const result = await supabase(env, "rpc/txzz_expire_stale_purchase_attempts", {
      method: "POST",
      body: JSON.stringify({ p_movie_id: movieId || null, p_stale_seconds: 90 })
    });
    return Number(Array.isArray(result) ? result[0] : result) || 0;
  }

  async function findBlocking(env, movieId) {
    await expireStale(env, movieId);
    const states = BLOCKING_STATES.join(",");
    const rows = await supabase(
      env,
      `txzz_purchase_attempts?select=*&movie_id=eq.${encodeURIComponent(movieId)}&status=in.(${states})&order=updated_at.desc&limit=1`
    );
    return rows[0] || null;
  }

  async function findAttempt(env, attemptId) {
    const rows = await supabase(
      env,
      `txzz_purchase_attempts?select=*&attempt_id=eq.${encodeURIComponent(attemptId)}&limit=1`
    );
    return rows[0] || null;
  }

  async function begin(env, { requestId, movieId, accountId, price }) {
    const result = await supabase(env, "rpc/txzz_begin_purchase_attempt", {
      method: "POST",
      body: JSON.stringify({
        p_request_id: requestId,
        p_movie_id: movieId,
        p_account_id: accountId,
        p_price: Number(price || 0)
      })
    });
    const payload = Array.isArray(result) ? result[0] : result;
    return { action: payload?.action || "unknown", ...(payload?.attempt || {}) };
  }

  async function transition(env, { attemptId, movieId, accountId, status, error = "", detail = null }) {
    if (!LEDGER_STATES.includes(status)) throw new Error(`不支持的购买账本状态：${status}`);
    let id = String(attemptId || "").trim();
    if (!id) {
      const rows = await supabase(
        env,
        `txzz_purchase_attempts?select=attempt_id&movie_id=eq.${encodeURIComponent(movieId)}&account_id=eq.${encodeURIComponent(accountId)}&order=updated_at.desc&limit=1`
      );
      id = String(rows[0]?.attempt_id || "");
    }
    if (!id) throw new Error("购买账本尝试不存在");
    const result = await supabase(env, "rpc/txzz_transition_purchase_attempt", {
      method: "POST",
      body: JSON.stringify({
        p_attempt_id: id,
        p_status: status,
        p_error: error,
        p_detail: detail
      })
    });
    return Array.isArray(result) ? result[0] : result;
  }

  async function listReconciliation(env) {
    await expireStale(env);
    const rows = await supabase(
      env,
      "txzz_purchase_attempts?select=attempt_id,request_id,movie_id,account_id,status,price,error,created_at,updated_at&status=in.(pending,charged,uncertain)&order=updated_at.desc&limit=100"
    );
    return Array.isArray(rows) ? rows : [];
  }

  return { begin, expireStale, findAttempt, findBlocking, listReconciliation, schemaReady, transition };
}

export { BLOCKING_STATES, LEDGER_STATES, createPurchaseLedgerRepository };
