// custom-providers.js — 自定义引擎：名称护栏、schema 校验、域名识别
//
// 零依赖模块（只 import aliases.js 的字面量），供 providers/index.js、
// config-resolve.js、config.js、CLI、设置卡片共同引用，避免依赖环。
//
// 名称护栏（用户手打引擎名的四道防线）：
//   ① canonicalizeName：大小写/空格/连字符/下划线归一 → 内部 id
//   ② checkNameConflicts：内置引擎 / 别名折叠 / 已有自定义 → 冲突提示
//   ③ suggestBuiltinName：对内置引擎 Levenshtein ≤ 2 → "你是不是指 X？"（提示不静默）
//   ④ suggestFamilyFromBaseUrl：域名 → 协议族预填 + 显示名建议

import { providerAliases } from './providers/aliases.js';

/** 读图协议族枚举（翻译器格式模板表的主键）。 */
export const READ_FAMILIES = ['openai-compatible', 'anthropic', 'gemini', 'raw-base64'];

/** 生图协议族枚举（P5 生图翻译器主键）。 */
export const GEN_FAMILIES = ['dashscope-image', 'openai-image', 'chat-native', 'google-imagen'];

export const READ_FAMILY_LABELS = {
    'openai-compatible': 'OpenAI 兼容（默认，覆盖约 90% 厂商）',
    anthropic: 'Anthropic 风格（source 块）',
    gemini: 'Google Gemini（inline_data）',
    'raw-base64': '原生 Base64（私有端点）',
};

export const GEN_FAMILY_LABELS = {
    'dashscope-image': 'DashScope（Qwen-Image）',
    'openai-image': 'OpenAI 风格 /images/generations',
    'chat-native': '聊天式生成（Gemini 多模态，返回 inline_data）',
    'google-imagen': 'Google Imagen（:predict / :editImage）',
};

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u;

// ---------------------------------------------------------------------------
// ① 名称规范化
// ---------------------------------------------------------------------------

/**
 * 用户输入 → 内部 id。规则：trim → 全小写 → 空格/连字符/下划线统一为 '-'
 * → 只允许 [a-z0-9._-]（≤40 字符，首字符字母数字）。非法输入抛错。
 */
/**
 * 解析"分辨率能力上限"声明：'2K' / '4K' / '4096x4096' / '2048'（可选；留空=null=跟随协议族通用上限）。
 */
export function parseSizeCap(input) {
    const raw = String(input ?? '').trim().toLowerCase();
    if (!raw) return null;
    const words = new Map([
        ['2k', { supports2K: true, maxW: 2560, maxH: 1440 }],
        ['2.5k', { supports2K: true, maxW: 2560, maxH: 1440 }],
        ['4k', { supports2K: true, maxW: 4096, maxH: 4096 }],
    ]);
    const word = words.get(raw);
    if (word) return word;
    const m = raw.match(/^(\d{3,5})\s*[x×*]\s*(\d{3,5})$/);
    if (m) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        return { supports2K: w * h >= 2560 * 1440, maxW: w, maxH: h };
    }
    const m1 = raw.match(/^(\d{3,5})$/);
    if (m1) {
        const side = Number(m1[1]);
        return { supports2K: side >= 2048, maxW: side, maxH: side };
    }
    throw new Error(`分辨率能力 "${input}" 无法解析。支持：2K / 4K / 宽x高（如 4096x4096）/ 边长（如 2048）。`);
}

export function canonicalizeName(input) {
    const trimmed = String(input ?? '').trim();
    if (!trimmed) {
        throw new Error('引擎名称不能为空。');
    }
    const id = trimmed.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
    if (!NAME_PATTERN.test(id)) {
        throw new Error(
            `引擎名称 "${trimmed}" 不规范：只能使用字母（含中文等 Unicode 字符）、数字、点、下划线、连字符（自动统一为小写与连字符），长度 ≤ 40，且不能以点或连字符开头。`,
        );
    }
    return id;
}

// ---------------------------------------------------------------------------
// ② 冲突检测
// ---------------------------------------------------------------------------

/** 内置引擎标准名 + 全部别名（字面量，避免依赖环；与 aliases.js 保持一致）。 */
const BUILTIN_KEYS = [
    'qwen',
    'openai',
    'anthropic',
    'gemini-api',
    'antigravity-cli',
    'claude-cli',
    'kimi-cli',
    ...Object.keys(providerAliases()),
];

/** 检查名称冲突：返回冲突说明或 null。 */
export function checkNameConflicts(name, config) {
    const id = canonicalizeName(name);
    if (BUILTIN_KEYS.includes(id)) {
        const folded = providerAliases()[id] ?? id;
        const display = { qwen: 'Qwen（千问）', openai: 'OpenAI', anthropic: 'Anthropic', 'gemini-api': 'Gemini API', 'antigravity-cli': 'Antigravity CLI', 'claude-cli': 'Claude Code CLI', 'kimi-cli': 'Kimi CLI' }[folded] ?? folded;
        return { kind: 'builtin', message: `"${name}" 对应内置引擎「${display}」（${folded}）。内置引擎无需新增，直接在配置中填写即可。`, folded };
    }
    const customs = readCustomProviders(config);
    if (Object.hasOwn(customs, id)) {
        return { kind: 'duplicate', message: `已有同名自定义引擎 "${customs[id].displayName ?? id}"。是更新其配置，还是另起一个名称？` };
    }
    return null;
}

// ---------------------------------------------------------------------------
// ③ 拼写容错（仅对内置引擎）
// ---------------------------------------------------------------------------

export function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[n];
}

/**
 * 对内置引擎名做拼写建议（编辑距离 ≤ 2）。返回 {suggestion, distance, folded} 或 null。
 * 只给"提示"，绝不静默改名——用户可能真的想要一个近似名的新引擎。
 */
export function suggestBuiltinName(name, maxDistance = 2) {
    const id = canonicalizeName(name);
    let best = null;
    for (const key of new Set(BUILTIN_KEYS)) {
        const distance = levenshtein(id, key);
        if (distance <= maxDistance && (best === null || distance < best.distance)) {
            best = { suggestion: key, distance };
        }
    }
    if (!best) {
        return null;
    }
    const folded = providerAliases()[best.suggestion] ?? best.suggestion;
    return { ...best, folded };
}

// ---------------------------------------------------------------------------
// ④ 域名 → 协议族识别（粘贴 baseUrl 后自动预填，可手动改）
// ---------------------------------------------------------------------------

const DOMAIN_HINTS = [
    { match: /(^|\.)openai\.com$/i, family: 'openai-compatible', displayName: 'OpenAI' },
    { match: /(^|\.)anthropic\.com$/i, family: 'anthropic', displayName: 'Anthropic' },
    { match: /generativelanguage\.googleapis\.com$/i, family: 'gemini', displayName: 'Google Gemini' },
    { match: /(^|\.)googleapis\.com$/i, family: 'gemini', displayName: 'Google' },
    { match: /(^|\.)dashscope\.aliyuncs\.com$/i, family: 'openai-compatible', displayName: 'Qwen（通义千问）' },
    { match: /(^|\.)aliyuncs\.com$/i, family: 'openai-compatible', displayName: '阿里云 DashScope' },
    { match: /(^|\.)moonshot\.cn$/i, family: 'openai-compatible', displayName: 'Moonshot（月之暗面）' },
    { match: /(^|\.)deepseek\.com$/i, family: 'openai-compatible', displayName: 'DeepSeek' },
    { match: /(^|\.)mistral\.ai$/i, family: 'openai-compatible', displayName: 'Mistral' },
    { match: /(^|\.)bigmodel\.cn$/i, family: 'openai-compatible', displayName: 'GLM（智谱）' },
    { match: /(^|\.)z\.ai$/i, family: 'openai-compatible', displayName: 'GLM（智谱）' },
    { match: /(^|\.)x\.ai$/i, family: 'openai-compatible', displayName: 'Grok（xAI）' },
    { match: /(^|\.)groq\.com$/i, family: 'openai-compatible', displayName: 'Groq' },
    { match: /(^|\.)together\.xyz$/i, family: 'openai-compatible', displayName: 'Together AI' },
    { match: /(^|\.)fireworks\.ai$/i, family: 'openai-compatible', displayName: 'Fireworks AI' },
    { match: /(^|\.)perplexity\.ai$/i, family: 'openai-compatible', displayName: 'Perplexity' },
    { match: /(^|\.)cerebras\.ai$/i, family: 'openai-compatible', displayName: 'Cerebras' },
    { match: /(^|\.)volces\.com$/i, family: 'openai-compatible', displayName: '火山方舟' },
    { match: /(^|\.)baidu\.com$/i, family: 'openai-compatible', displayName: '百度千帆' },
    { match: /(^|\.)sensenova\.cn$/i, family: 'openai-compatible', displayName: '商汤日日新' },
    { match: /(^|\.)minimax\.chat$/i, family: 'openai-compatible', displayName: 'MiniMax' },
    { match: /(^|\.)step\.fun$/i, family: 'openai-compatible', displayName: '阶跃星辰' },
    { match: /(^|\.)github\.com$/i, family: 'openai-compatible', displayName: 'GitHub Models' },
];

/** baseUrl → {family, displayName} 建议；无命中 → openai-compatible 兜底。 */
export function suggestFamilyFromBaseUrl(baseUrl) {
    const trimmed = String(baseUrl ?? '').trim();
    let hostname = '';
    try {
        hostname = new URL(trimmed).hostname;
    } catch {
        hostname = trimmed;
    }
    for (const hint of DOMAIN_HINTS) {
        if (hint.match.test(hostname)) {
            return { family: hint.family, displayName: hint.displayName };
        }
    }
    return { family: 'openai-compatible', displayName: '' };
}

// ---------------------------------------------------------------------------
// customProviders schema：读取 / 校验 / 规范化
// ---------------------------------------------------------------------------

const VALID_CAPABILITIES = ['read', 'generate', 'edit'];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCapabilities(raw) {
    const out = { read: false, generate: false, edit: false };
    if (isPlainObject(raw)) {
        for (const key of VALID_CAPABILITIES) {
            if (raw[key] !== undefined) {
                out[key] = Boolean(raw[key]);
            }
        }
    }
    return out;
}

/**
 * 把配置里的一份自定义引擎条目规范化为内部描述符。
 * 不校验 name（由 readCustomProviders 用键名保证）；校验 family/baseUrl。
 */
export function normalizeCustomProviderEntry(name, raw) {
    if (!isPlainObject(raw)) {
        throw new Error(`customProviders.${name} 不是对象，请修正或移除后再试。`);
    }
    const readFamily = raw.readFamily ?? raw.family ?? 'openai-compatible';
    if (!READ_FAMILIES.includes(readFamily)) {
        throw new Error(
            `customProviders.${name} 的 readFamily "${readFamily}" 未知。可选：${READ_FAMILIES.join(', ')}。`,
        );
    }
    const genFamily = raw.genFamily ?? raw.imageFamily ?? null;
    if (genFamily !== null && !GEN_FAMILIES.includes(genFamily)) {
        throw new Error(`customProviders.${name} 的 genFamily "${genFamily}" 未知。可选：${GEN_FAMILIES.join(', ')}。`);
    }
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        throw new Error(`customProviders.${name} 的 baseUrl "${baseUrl}" 必须以 http:// 或 https:// 开头。`);
    }
    if (!baseUrl && raw.apiKey) {
        // 有 key 但没地址：允许（failover 链可用性检查会拦），但给出明确提示
        throw new Error(`customProviders.${name} 缺少 baseUrl（接口地址）。请填写引擎接口地址。`);
    }
    const models = Array.isArray(raw.models)
        ? raw.models
              .map((m) => (typeof m === 'string' ? { name: m.trim(), capabilities: { read: true, generate: false, edit: false } } : isPlainObject(m) ? { name: String(m.name ?? '').trim(), capabilities: normalizeCapabilities(m.capabilities) } : null))
              .filter((m) => m && m.name)
        : [];
    // 顶层 model（字符串）兼容：视为一个读图模型
    if (typeof raw.model === 'string' && raw.model.trim() && !models.some((m) => m.name === raw.model.trim())) {
        models.unshift({ name: raw.model.trim(), capabilities: { read: true, generate: false, edit: false } });
    }
    // 允许骨架引擎（models 为空）：用户可先建条目、后在设置卡片补填模型名。
    // 可用性检查与 execute 会给出"请配置模型"的明确提示，而不是悄悄用错模型。
    const capabilities = normalizeCapabilities(raw.capabilities);
    const hasGenCapability = models.some((m) => m.capabilities.generate || m.capabilities.edit) || capabilities.generate || capabilities.edit;
    let sizeCap = null;
    if (raw.sizeCap !== undefined && raw.sizeCap !== null && String(raw.sizeCap).trim() !== '') {
        sizeCap = parseSizeCap(raw.sizeCap);
        if (sizeCap === null) throw new Error(`customProviders.${name} 的 sizeCap 无法解析：${raw.sizeCap}`);
    }
    return {
        id: name,
        displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : name,
        sizeCap: typeof raw.sizeCap === 'string' && raw.sizeCap.trim() !== '' ? raw.sizeCap.trim() : undefined,
        verified: raw.verified === true ? true : undefined,
        failed:
            isPlainObject(raw.failed) && typeof raw.failed.reason === 'string' && raw.failed.reason.trim()
                ? { at: String(raw.failed.at ?? ''), reason: raw.failed.reason.slice(0, 500) }
                : undefined,
        readFamily,
        genFamily: genFamily ?? (hasGenCapability ? (raw.family === 'gemini' ? 'chat-native' : 'dashscope-image') : null),
        baseUrl,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        model: models.find((m) => m.capabilities.read)?.name ?? models[0]?.name ?? '',
        models,
        capabilities,
        imageProtocol: isPlainObject(raw.imageProtocol) ? raw.imageProtocol : {},
        auth: typeof raw.auth === 'string' ? raw.auth : 'bearer',
        extraBody: isPlainObject(raw.extraBody) ? raw.extraBody : {},
        structuredOutput: raw.structuredOutput === true,
        proxy: typeof raw.proxy === 'string' ? raw.proxy : undefined,
    };
}

/** 读取并规范化 config.customProviders；坏条目点名报错（不让坏配置静默生效）。 */
export function readCustomProviders(config) {
    if (config.customProviders === undefined) {
        return {};
    }
    if (!isPlainObject(config.customProviders)) {
        throw new Error('配置中的 customProviders 不是对象。请修正或移除后再试。');
    }
    const out = {};
    for (const [name, entry] of Object.entries(config.customProviders)) {
        const id = canonicalizeName(name);
        const normalized = normalizeCustomProviderEntry(id, entry);
        out[id] = normalized;
    }
    return out;
}

/** 判断某名字是否为已配置的自定义引擎。 */
export function isCustomProviderName(name, config) {
    if (!config || !isPlainObject(config.customProviders)) {
        return false;
    }
    const id = canonicalizeName(name);
    return Object.hasOwn(config.customProviders, id);
}
