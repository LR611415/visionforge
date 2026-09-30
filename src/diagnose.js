// diagnose.js — 自定义引擎失败归因 / 验证状态（首次使用验证方案）
//
// 思路（用户拍板）：
//   - 配置时不自测、默认成功（避免保存卡顿与超时问题）；
//   - 首次真实调用成功 → 标记 verified，后续不再重复检测；
//   - 首次真实调用失败 → 归因分类并输出明确指引（协议族/密钥/模型/网络/配额），
//     并标记 failed 进入失败冷却：修好配置（改字段）后自动解除。
//   - 错误原因必须完整输出给用户（引擎/模型/baseUrl/分类/API 消息/修复建议）。

import { persistConfig } from './config.js';
import { redactSecrets, splitApiKeys } from './util.js';

export function classifyFailure({ provider = '', model = '', baseUrl = '', status, bodyText = '', error, mode = '' }) {
    const raw = typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : String(bodyText ?? '');
    const low = raw.toLowerCase();
    const isTimeout = /timeout|timed out|etimedout/i.test(low) || Boolean(error && (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT'));
    const isNetwork = !isTimeout && /fetch failed|基础连接已经关闭|socket hang up|enotfound|econnrefused|econnreset|network error|connection/i.test(low);
    const isAuth = status === 401 || status === 403 || /invalid.{0,10}key|authentication|unauthorized|api.?key|鉴权|密钥/i.test(low);
    const isQuota = status === 429 || status === 432 || status === 433 || /quota|rate.?limit|限流|额度不足|insufficient/i.test(low);
    const isModel = /unknown model|model not found|model.?does.?not.?exist|模型不存在|invalid.?model/i.test(low);
    const isFamily = status === 404 || /expected format|invalidparameter|schema|结构不符|not a valid|unsupported parameter|请求体|body.*invalid/i.test(low);

    let category;
    let advice;
    if (isTimeout) {
        category = 'timeout';
        advice = '引擎响应超时（网络慢或引擎繁忙）。可稍后重试，或检查网络/代理设置。';
    } else if (isNetwork) {
        category = 'network';
        advice = '接口不可达（网络/代理/接口地址问题）。请检查 baseUrl、网络连接或代理设置。';
    } else if (isAuth) {
        category = 'auth';
        advice = '鉴权失败：API 密钥无效、缺失或过期。请在设置卡片重新填写该引擎的密钥。';
    } else if (isQuota) {
        category = 'quota';
        advice = '配额/限流：该引擎的密钥额度耗尽或请求过频。请检查配额，稍后重试。';
    } else if (isModel) {
        category = 'model';
        advice = '模型名可能不存在或拼写有误。模型名是发给 API 的真实名称（错一个字母会报错），请核对。';
    } else if (isFamily) {
        category = 'family';
        advice = '请求格式与引擎期望不符——通常是「协议族」选错（如把 Gemini 原生端点标成 OpenAI 兼容）。请在设置卡片核对读图/生图协议族，或改用该厂商的 OpenAI 兼容端点，或更换引擎。';
    } else {
        category = 'unknown';
        advice = '无法自动归因。请复制本条诊断信息反馈给插件开发者，或在文档中核对接口格式。';
    }
    const message = `${mode ? mode + '：' : ''}引擎「${provider || '?'}」调用失败 [${category}]${status ? `（HTTP ${status}）` : ''}：${redactSecrets(raw).slice(0, 300)}`;
    return { category, message, advice };
}

export function formatCustomEngineFailure(entry, diag) {
    const name = (entry && (entry.displayName || entry.id)) || '?';
    const known = (entry && typeof entry.apiKey === 'string' && entry.apiKey.trim() !== '') ? splitApiKeys(entry.apiKey) : [];
    return [
        `自定义引擎「${name}」${redactSecrets(diag.message, known)}`,
        `  ▸ 建议：${diag.advice}`,
        `  ▸ 排查：引擎=${name}，模型=${(entry && entry.model) || '未配置'}，baseUrl=${(entry && entry.baseUrl) || '未配置'}`,
        '  ▸ 修改配置（接口/协议族/密钥/模型）后，该引擎会自动解除失败标记并重新尝试。',
    ].join('\n');
}

export function customGateError(entry, providerId) {
    if (!entry || !entry.failed || !entry.failed.reason) return null;
    const name = (entry.displayName || entry.id || providerId);
    return [
        `自定义引擎「${name}」上次调用失败，已暂停自动重试以避免重复扣费：`,
        `  ▸ 上次失败：${redactSecrets(entry.failed.reason, typeof entry.apiKey === 'string' ? splitApiKeys(entry.apiKey) : [])}`,
        '  ▸ 请修正配置（接口地址 / 协议族 / 密钥 / 模型名）后重试；修改配置会自动清除该标记。',
    ].join('\n');
}

export function markCustomVerified(config, providerId) {
    if (!config || !config.customProviders || !config.customProviders[providerId]) return;
    delete config.customProviders[providerId].failed;
    config.customProviders[providerId].verified = true;
    try { persistConfig(config); } catch { /* best effort */ }
}

export function markCustomFailed(config, providerId, diag) {
    if (!config || !config.customProviders || !config.customProviders[providerId]) return;
    const entry = config.customProviders[providerId];
    const known = (entry && typeof entry.apiKey === 'string' && entry.apiKey.trim() !== '') ? splitApiKeys(entry.apiKey) : [];
    config.customProviders[providerId].failed = { at: new Date().toISOString(), reason: redactSecrets(diag.message, known) };
    config.customProviders[providerId].verified = false;
    try { persistConfig(config); } catch { /* best effort */ }
}
