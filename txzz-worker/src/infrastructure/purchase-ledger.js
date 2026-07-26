"use strict";

const LEDGER_STATES = ["pending", "charged", "resolved", "failed_before_charge", "uncertain"];
const BLOCKING_STATES = ["pending", "charged", "resolved", "uncertain"];

function createPurchaseLedgerRepository({ supabase, nowIso }) {
  async function schemaReady(env) {
    try {
      const result = await supabase(env, "rpc/txzz_playback_schema_status", {
        method: "POST",
        body: "{}"
      });
      const status = Array.isArray(result) ? result[0] : result;
      if (status?.ready !== true || Number(status?.version || 0) < 2) {
        return { ready: false, version: Number(status?.version || 0), error: "播放 schema 版本低于 2" };
      }
      return { ready: true, version: Number(status.version) };
    } catch (error) {
      return { ready: false, error: error?.message || String(error) };
    }
  }

  async function findBlocking(env, movieId) {
    const states = BLOCKING_STATES.join(",");
    const rows = await supabase(
      env,
      `txzz_purchase_ledger?select=*&movie_id=eq.${encodeURIComponent(movieId)}&status=in.(${states})&order=updated_at.desc&limit=1`
    );
    return rows[0] || null;
  }

  async function begin(env, { requestId, movieId, accountId, price }) {
    const rows = await supabase(env, "txzz_purchase_ledger?on_conflict=movie_id,account_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([{
        request_id: requestId,
        movie_id: movieId,
        account_id: accountId,
        status: "pending",
        price: Number(price || 0),
        error: "",
        updated_at: nowIso()
      }])
    });
    return rows[0] || null;
  }

  async function transition(env, { movieId, accountId, status, error = "", detail = null }) {
    if (!LEDGER_STATES.includes(status)) throw new Error(`不支持的购买账本状态：${status}`);
    const rows = await supabase(
      env,
      `txzz_purchase_ledger?movie_id=eq.${encodeURIComponent(movieId)}&account_id=eq.${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status, error, detail, updated_at: nowIso() })
      }
    );
    return rows[0] || null;
  }

  return { begin, findBlocking, schemaReady, transition };
}

export { BLOCKING_STATES, LEDGER_STATES, createPurchaseLedgerRepository };
