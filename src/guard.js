// guard.js — 视觉引擎该不该跑：规则引擎 + 活动模型检测
//
// 决策顺序（保留）：
//  1. VISIONFORGE_MODEL 环境变量最强（"none" 视为未知）；
//  2. 其次嗅探 harness 会话存储里的最近模型；
//  3. --model 自报最弱。
// 规则上 deny 优先于 allow；未知模型默认放行（denyWhenUnknown 才拒绝）。

import { detectHarnessDetailed, sniffModel } from './recover-paste.js';

// ---------------------------------------------------------------------------
// 规则引擎
// ---------------------------------------------------------------------------

export function denyPatterns(guards) {
    return stringPatterns(guards?.denyModels);
}

export function allowPatterns(guards) {
    return stringPatterns(guards?.allowModels);
}

function stringPatterns(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((pattern) => typeof pattern === 'string');
}

/** glob：只支持 * 和 ?，锚定整串、大小写不敏感，其余字符转义。 */
export function globMatch(pattern, value) {
    const regex = pattern
        .split(/([*?])/)
        .map((part) => {
            if (part === '*') {
                return '.*';
            }
            if (part === '?') {
                return '.';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
    return new RegExp(`^${regex}$`, 'i').test(value);
}

/**
 * 判定：候选 = [model, provider/model]。
 * deny 命中 → 拒绝；allow 列表非空且未命中 → 拒绝；其余放行。
 */
export function evaluateGuard(guards, detection) {
    const deny = denyPatterns(guards);
    const allow = allowPatterns(guards);
    if (!detection.model) {
        if (guards?.denyWhenUnknown === true) {
            return { ...detection, guard: 'deny', reason: 'model unknown and denyWhenUnknown is set' };
        }
        return {
            ...detection,
            guard: 'allow',
            reason: deny.length === 0 && allow.length === 0 ? 'no deny rules configured' : 'model unknown, failing open',
        };
    }
    if (deny.length === 0 && allow.length === 0) {
        return { ...detection, guard: 'allow', reason: 'no deny rules configured' };
    }
    const candidates = [detection.model];
    if (detection.provider) {
        candidates.push(`${detection.provider}/${detection.model}`);
    }
    const firstMatch = (patterns) => patterns.find((pattern) => candidates.some((candidate) => globMatch(pattern, candidate)));
    const denied = firstMatch(deny);
    if (denied) {
        return { ...detection, guard: 'deny', matched: denied, reason: 'model has native vision per guards.denyModels' };
    }
    if (allow.length > 0) {
        const allowed = firstMatch(allow);
        if (allowed) {
            return { ...detection, guard: 'allow', matched: allowed, reason: 'model is on guards.allowModels' };
        }
        return { ...detection, guard: 'deny', reason: 'not on guards.allowModels: only listed models run the engine' };
    }
    return { ...detection, guard: 'allow', reason: 'not on the deny list' };
}

// ---------------------------------------------------------------------------
// 活动模型检测
// ---------------------------------------------------------------------------

/** 信号强度：环境变量 > harness 会话存储 > 自报。嗅探失败一律 null（放行）。 */
export function detectActiveModel(options) {
    const env = options.env ?? process.env;
    const envModel = env.VISIONFORGE_MODEL?.trim();
    if (envModel) {
        return envModel.toLowerCase() === 'none' ? { model: null, source: 'env' } : { model: envModel, source: 'env' };
    }
    const forced = env.VISIONFORGE_HARNESS;
    const harness = forced === 'none' ? null : forced || (options.harness !== undefined ? options.harness : detectHarnessDetailed().harness);
    const sniffed = harness ? sniffModel(harness, options.cwd, env, options.roots) : null;
    if (sniffed) {
        const detection = { model: sniffed.model, source: 'storage', harness };
        if (sniffed.provider) {
            detection.provider = sniffed.provider;
        }
        if (options.selfReported && options.selfReported.toLowerCase() !== sniffed.model.toLowerCase()) {
            detection.selfReported = options.selfReported;
        }
        return detection;
    }
    if (options.selfReported) {
        return { model: options.selfReported, source: 'self-report', harness };
    }
    return { model: null, source: 'none', harness };
}

export function runGuard(guards, options) {
    if (denyPatterns(guards).length === 0 && allowPatterns(guards).length === 0 && guards?.denyWhenUnknown !== true) {
        return { model: null, source: 'none', guard: 'allow', reason: 'no deny rules configured' };
    }
    return evaluateGuard(guards, detectActiveModel(options));
}
