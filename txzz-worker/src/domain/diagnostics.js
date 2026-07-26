"use strict";

/** 生成可直接展示给用户的服务诊断；输入只包含脱敏配置状态与账号统计。 */
function buildServiceDiagnostics({ envStatus = {}, accountStats = null, accountError = "" } = {}) {
  const checks = [];
  const suggestions = [];
  const nextActions = [];
  const addCheck = (key, label, level, message) => checks.push({ key, label, level, message });
  const addSuggestion = (text) => {
    if (text && !suggestions.includes(text)) suggestions.push(text);
  };
  const addAction = (id, label, priority, detail) => {
    if (!nextActions.some((item) => item.id === id)) nextActions.push({ id, label, priority, detail });
  };

  const missingEnv = Object.entries(envStatus)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);
  if (missingEnv.length) {
    addCheck("env", "运行密钥", "error", `缺少 ${missingEnv.join("、")}`);
    addSuggestion("先在 Cloudflare 或本地 .dev.vars 中补齐缺失密钥，然后重新部署或重启本地服务。");
    addAction("fix-env", "补齐运行密钥", "high", `缺少 ${missingEnv.join("、")}，请先补齐后重新部署。`);
  } else {
    addCheck("env", "运行密钥", "ok", "必填密钥已配置完整。");
  }

  if (accountError) {
    addCheck("database", "数据库连接", "error", accountError);
    addSuggestion("检查 Supabase 地址、service_role 密钥和 schema.sql 是否已经正确执行。");
    addAction("check-database", "检查数据库连接", "high", "确认 Supabase 地址、service_role 密钥和 schema.sql 表结构。");
  } else if (accountStats) {
    addCheck("database", "数据库连接", "ok", "Supabase 读取正常。");
  } else {
    addCheck("database", "数据库连接", "warn", "暂未读取到账号池统计。");
    addSuggestion("访问 /v1/accounts/stats 查看账号池统计接口是否可用。");
    addAction("check-stats", "检查账号统计接口", "medium", "访问 /v1/accounts/stats 确认账号池统计是否能正常返回。");
  }

  if (accountStats) {
    if (!accountStats.total) {
      addCheck("accounts", "账号池数量", "error", "云端账号池为空。");
      addSuggestion("在插件账号池页面上传本地账号，或调用 /v1/accounts/seed 写入种子账号。");
      addAction("seed-accounts", "写入或上传账号", "high", "在插件账号池页面上传本地账号，或调用 /v1/accounts/seed 写入种子账号。");
    } else if (!accountStats.enabled) {
      addCheck("accounts", "账号池数量", "error", `共有 ${accountStats.total} 个账号，但没有启用账号。`);
      addSuggestion("在 Supabase 中启用至少一个账号，或重新上传可用账号。");
      addAction("enable-account", "启用可用账号", "high", "在 Supabase 中启用至少一个账号，或重新上传可用账号。");
    } else {
      addCheck("accounts", "账号池数量", "ok", `共有 ${accountStats.total} 个账号，启用 ${accountStats.enabled} 个。`);
    }

    if (accountStats.ok > 0) {
      addCheck("usable", "可用账号", "ok", `${accountStats.ok} 个账号最近验证正常。`);
    } else if (accountStats.enabled > 0) {
      addCheck("usable", "可用账号", "warn", "启用账号还没有成功验证记录。");
      addSuggestion("在插件账号池页面点击账号检查，确认账号凭据是否仍然可用。");
      addAction("verify-accounts", "验证云端账号", "medium", "在插件账号池页面点击账号检查，确认账号凭据是否仍然可用。");
    }

    if (accountStats.error > 0) {
      addCheck("risk", "异常账号", "warn", `${accountStats.error} 个启用账号最近验证异常。`);
      addSuggestion("打开插件账号池页面的失效账号开关，查看失败原因并重新上传凭据。");
      addAction("fix-error-accounts", "处理异常账号", "medium", "打开插件账号池页面的失效账号开关，查看失败原因并重新上传凭据。");
    } else if (accountStats.enabled > 0) {
      addCheck("risk", "异常账号", "ok", "当前没有启用账号处于异常状态。");
    }

    if (accountStats.unverified > 0) {
      addCheck("unverified", "待验证账号", "info", `${accountStats.unverified} 个账号仍待验证。`);
      addSuggestion("建议空闲时逐个验证云端账号，减少播放时临时轮换等待。");
      addAction("reduce-unverified", "减少待验证账号", "low", "空闲时逐个验证云端账号，减少播放时临时轮换等待。");
    }
  }

  const score = Math.max(0, checks.reduce((value, item) => {
    if (item.level === "error") return value - 34;
    if (item.level === "warn") return value - 16;
    if (item.level === "info") return value - 5;
    return value;
  }, 100));
  const level = checks.some((item) => item.level === "error")
    ? "error"
    : checks.some((item) => item.level === "warn")
      ? "warn"
      : "ok";
  const summary = level === "ok"
    ? "云端服务状态良好，可以正常同步账号池和获取播放详情。"
    : level === "warn"
      ? "云端服务可访问，但仍有账号池细节建议处理。"
      : "云端服务存在关键配置或账号池问题，需要先处理后再使用。";

  return {
    level,
    score,
    summary,
    checks,
    suggestions,
    nextActions,
    accountsSummary: accountStats ? {
      total: accountStats.total,
      enabled: accountStats.enabled,
      ok: accountStats.ok,
      error: accountStats.error,
      unverified: accountStats.unverified,
      avgCoin: accountStats.avgCoin
    } : null,
    checkedAt: new Date().toISOString()
  };
}

export { buildServiceDiagnostics };
