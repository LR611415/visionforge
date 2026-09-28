// cooldown.js — 配额冷却状态机
//
// 语义（保留）：state.json 只是缓存，损坏/缺失一律静默当无状态；
// 写入走临时文件 + rename 的原子路径（0600 文件 / 0700 目录）；
// 冷却分默认档（45 分钟）与月度档（24 小时），引擎回报的
// "Resets in ..." 子句优先；只有配额类失败才记录；写失败只警告、
// 绝不阻断 failover。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { foldProviderName } from './providers/index.js';
import { ApiKeyFailureError, redactSecrets } from './util.js';

export const DEFAULT_COOLDOWN_MS = 45 * 60 * 1000;
export const MONTHLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const KEY_COOLDOWN_SUFFIX = /^(.*)::key:(\d+)$/;

export function cooldownStateKey(engine, keyIndex) {
    const canonical = foldProviderName(engine);
    return keyIndex === undefined ? canonical : `${canonical}::key:${keyIndex}`;
}

export function parseCooldownStateKey(stateKey) {
    const match = KEY_COOLDOWN_SUFFIX.exec(stateKey);
    if (!match) {
        return { engine: foldProviderName(stateKey) };
    }
    return { engine: foldProviderName(match[1]), keyIndex: Number.parseInt(match[2], 10) };
}

export function currentStatePath() {
    return path.join(os.homedir(), '.visionforge', 'state.json');
}

function emptyCooldownState() {
    return { engineCooldowns: {} };
}

function laterEntry(existing, incoming) {
    if (!existing) {
        return incoming;
    }
    const existingUntil = Date.parse(existing.until);
    const incomingUntil = Date.parse(incoming.until);
    return Number.isFinite(existingUntil) && existingUntil > incomingUntil ? existing : incoming;
}

export function loadCooldownState(statePath = currentStatePath()) {
    let raw;
    try {
        raw = fs.readFileSync(statePath, 'utf-8');
    } catch {
        return emptyCooldownState();
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.engineCooldowns !== 'object') {
            return emptyCooldownState();
        }
        const cooldowns = parsed.engineCooldowns;
        const clean = {};
        for (const [stateKey, entry] of Object.entries(cooldowns)) {
            if (entry && typeof entry === 'object' && typeof entry.until === 'string') {
                const target = parseCooldownStateKey(stateKey);
                const key = cooldownStateKey(target.engine, target.keyIndex);
                const normalized = {
                    until: entry.until,
                    reason: typeof entry.reason === 'string' ? entry.reason : '',
                    observedAt: typeof entry.observedAt === 'string' ? entry.observedAt : '',
                };
                clean[key] = clean[key] ? laterEntry(clean[key], normalized) : normalized;
            }
        }
        return { engineCooldowns: clean };
    } catch {
        return emptyCooldownState();
    }
}

function updateStateOnDisk(statePath, mutate) {
    const merged = loadCooldownState(statePath);
    const before = JSON.stringify(merged);
    mutate(merged);
    if (JSON.stringify(merged) === before) {
        return merged;
    }
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(dir, 0o700);
        } catch {
        }
    }
    const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const tmp = path.join(dir, `.state.${unique}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, statePath);
    try {
        fs.chmodSync(statePath, 0o600);
    } catch {
    }
    return merged;
}

/** 查询某引擎（可到 key 级）当前是否在冷却；过期的视为不存在。 */
function coolingEntry(state, engine, now, keyIndex) {
    const active = (stateKey) => {
        const entry = state.engineCooldowns[stateKey];
        if (!entry) {
            return undefined;
        }
        const until = Date.parse(entry.until);
        return Number.isFinite(until) && until > now.getTime() ? entry : undefined;
    };
    const entry = active(cooldownStateKey(engine, keyIndex));
    if (entry || keyIndex === undefined) {
        return entry;
    }
    return active(cooldownStateKey(engine));
}

/** 引擎整体是否冷却：有 key 列表时全部 key 都在冷却才算。 */
function coolingEngineEntry(state, engine, keyCount, now) {
    if (keyCount <= 0) {
        return coolingEntry(state, engine, now);
    }
    let representative;
    for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
        const entry = coolingEntry(state, engine, now, keyIndex);
        if (!entry) {
            return undefined;
        }
        representative = laterEntry(representative, entry);
    }
    return representative;
}

function classifyQuota(error, now) {
    if (!(error instanceof ApiKeyFailureError) || error.quotaCooldown === 'none') {
        return null;
    }
    const fallbackMs = error.quotaCooldown === 'monthly' ? MONTHLY_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
    return new Date(now.getTime() + (error.resetAfterMs ?? fallbackMs));
}

function recordQuotaCooldown(state, engine, error, now, statePath, onPersistError, keyIndex, knownSecrets = []) {
    const until = classifyQuota(error, now);
    if (!until) {
        return null;
    }
    const reason = redactSecrets(error instanceof Error ? error.message : String(error), knownSecrets).slice(0, 300);
    const entry = { until: until.toISOString(), reason, observedAt: now.toISOString() };
    const stateKey = cooldownStateKey(engine, keyIndex);
    try {
        const merged = updateStateOnDisk(statePath, (disk) => {
            disk.engineCooldowns[stateKey] = laterEntry(disk.engineCooldowns[stateKey], entry);
        });
        const persisted = merged.engineCooldowns[stateKey];
        state.engineCooldowns[stateKey] = persisted;
        return persisted;
    } catch (persistError) {
        state.engineCooldowns[stateKey] = entry;
        onPersistError?.(persistError);
        return entry;
    }
}

function clearEngineCooldown(state, engine, statePath, onPersistError, keyIndex) {
    const stateKey = cooldownStateKey(engine, keyIndex);
    const legacyKey = cooldownStateKey(engine);
    const keysToDelete = keyIndex === undefined ? [stateKey] : [stateKey, legacyKey];
    const hadInMemory = keysToDelete.some((key) => key in state.engineCooldowns);
    for (const key of keysToDelete) {
        delete state.engineCooldowns[key];
    }
    try {
        updateStateOnDisk(statePath, (disk) => {
            for (const key of keysToDelete) {
                delete disk.engineCooldowns[key];
            }
        });
        return hadInMemory;
    } catch (persistError) {
        onPersistError?.(persistError);
        return hadInMemory;
    }
}

export function clearAllCooldowns(statePath = currentStatePath()) {
    fs.rmSync(statePath, { force: true });
}

/**
 * 构建冷却控制器。cooldown 关闭时返回 undefined（读与写都跳过）。
 * 控制器持有内存态 + 持久化回调，供 analyze 编排查询与记录。
 */
export function buildCooldownController(config, opts = {}) {
    if (config.cooldown?.trim().toLowerCase() === 'off') {
        return undefined;
    }
    const statePath = opts.statePath ?? currentStatePath();
    const now = opts.now ?? new Date();
    const state = loadCooldownState(statePath);
    const warnings = [];
    const persistNote = (persistError) => {
        const message = persistError instanceof Error ? persistError.message : String(persistError);
        warnings.push(
            `Cooldown state could not be saved (${message}); failover still works, but the next run will rediscover this quota wall.`,
        );
    };
    return {
        state,
        now,
        warnings,
        record: (engine, error, keyIndex, knownSecrets) => recordQuotaCooldown(state, engine, error, now, statePath, persistNote, keyIndex, knownSecrets),
        clear: (engine, keyIndex) => {
            clearEngineCooldown(state, engine, statePath, persistNote, keyIndex);
        },
    };
}

export { coolingEngineEntry, coolingEntry, classifyQuota };
