// util.js — VisionForge 引擎的共享工具层
//
// 本模块只承载纯函数与错误分类，不读配置、不发请求：
//  - API key 拆分 / 配额错误分类（ApiKeyFailureError 及其构造）
//  - 宽松 JSON 解析（fence、花括号切片、最长平衡对象）
//  - extraBody 解析与合并（保留字段防覆盖）
//  - 密钥脱敏（已知密钥精确替换 + 常见 token 形状正则 + URL 凭据掩码）
//  - 端点绑定防护（openai/anthropic 的 BASE_URL 环境变量退役检查）
//  - 只读错误消息改写（setErrorMessage）

// ---------------------------------------------------------------------------
// API key 工具
// ---------------------------------------------------------------------------

/** 把逗号分隔的 key 列表拆成非空数组。非字符串返回空数组。 */
export function splitApiKeys(value) {
    if (typeof value !== 'string') {
        return [];
    }
    return value
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key.length > 0);
}

/** 配额类失败：带冷却语义（default / monthly / none）与可选的引擎回报重置时间。 */
export class ApiKeyFailureError extends Error {
    constructor(message, opts) {
        super(message);
        this.name = 'ApiKeyFailureError';
        this.quotaCooldown = opts?.quotaCooldown ?? 'none';
        this.resetAfterMs = opts?.resetAfterMs ?? null;
    }
}

export function isApiKeyFailure(error) {
    return error instanceof ApiKeyFailureError;
}

/** 错误文本里的配额信号：命中任意一条即视为配额类。 */
const QUOTA_PATTERNS = [
    /\bquota\b/i,
    /\bpayment required\b/i,
    /\b(?:out of|insufficient|not enough)\s+(?:account\s+)?(?:balance|credits?)\b/i,
    /\b(?:balance|credits?)\s+(?:is\s+)?(?:insufficient|exhausted|depleted|empty|too low|used up)\b/i,
    /\b(?:credit|usage)\s+(?:limit|cap)\s+(?:reached|exceeded)\b/i,
];

export function isQuotaFailureMessage(message) {
    return QUOTA_PATTERNS.some((pattern) => pattern.test(message));
}

/** 从 "Resets in 1h30m" 之类的子句里解析毫秒数，找不到返回 null。 */
export function parseResetDuration(message) {
    const match = /Resets? in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(message);
    if (!match || (!match[1] && !match[2] && !match[3])) {
        return null;
    }
    const hours = Number.parseInt(match[1] ?? '0', 10);
    const minutes = Number.parseInt(match[2] ?? '0', 10);
    const seconds = Number.parseInt(match[3] ?? '0', 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * 把 HTTP 状态码与响应体转换为可抛出错误。
 * 500+ 是一般错误；432/433 是月度配额；401/403/429 或文本命中配额信号时，
 * 按是否可定位为配额类决定冷却等级。
 */
export function errorFromApiStatus(status, message, detail = '') {
    const resetAfterMs = parseResetDuration(detail);
    if (status >= 500) {
        return new Error(message);
    }
    if (status === 432 || status === 433) {
        return new ApiKeyFailureError(message, { quotaCooldown: 'monthly', resetAfterMs });
    }
    if (status === 401 || status === 403 || status === 429 || isQuotaFailureMessage(detail)) {
        const quotaClass = isQuotaFailureMessage(detail) || resetAfterMs !== null;
        return new ApiKeyFailureError(message, {
            quotaCooldown: quotaClass ? 'default' : 'none',
            resetAfterMs,
        });
    }
    return new Error(message);
}

// ---------------------------------------------------------------------------
// 宽松 JSON 解析
// ---------------------------------------------------------------------------

export function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** 严格解析：失败即抛错并点名来源。 */
export function parseJsonOrExplain(raw, origin) {
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${origin} is not valid JSON: ${error.message}`);
    }
}

/** 先试直解析，不行再走花括号切片。 */
export function parseJsonLoose(text) {
    const trimmed = text.trim();
    const direct = tryParseJson(trimmed);
    if (direct !== null) {
        return direct;
    }
    return parseBraceSlice(trimmed);
}

/** 直解析 → 代码块 → 花括号切片 → 最长平衡对象，逐级兜底。 */
export function extractJson(text) {
    const trimmed = text.trim();
    const direct = tryParseJson(trimmed);
    if (direct !== null) {
        return direct;
    }
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced) {
        const parsed = tryParseJson(fenced[1].trim());
        if (parsed !== null) {
            return parsed;
        }
    }
    return parseBraceSlice(trimmed);
}

/** 取第一个 { 到最后一个 } 之间的子串试解析。 */
function parseBraceSlice(trimmed) {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        const whole = tryParseJson(trimmed.slice(first, last + 1));
        if (whole !== null) {
            return whole;
        }
    }
    return parseLongestBalancedObject(trimmed);
}

/** 扫描所有顶层平衡的 {...} 跨度，按长度降序试解析。 */
function parseLongestBalancedObject(text) {
    const spans = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            if (depth === 0) {
                start = i;
            }
            depth += 1;
        } else if (char === '}') {
            if (depth > 0) {
                depth -= 1;
                if (depth === 0 && start >= 0) {
                    spans.push([start, i + 1]);
                    start = -1;
                }
            }
        }
    }
    for (const [from, to] of spans.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))) {
        const parsed = tryParseJson(text.slice(from, to));
        if (parsed !== null) {
            return parsed;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 文本截断
// ---------------------------------------------------------------------------

export function truncate(text, max = 300) {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function tail(text, max = 300) {
    return text.length > max ? `...${text.slice(-max)}` : text;
}

// ---------------------------------------------------------------------------
// extraBody
// ---------------------------------------------------------------------------

export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseExtraBody(raw, origin) {
    const parsed = parseJsonOrExplain(raw, origin);
    if (!isPlainObject(parsed)) {
        throw new Error(`${origin} must be a JSON object, for example {"thinking":{"type":"disabled"}}`);
    }
    return parsed;
}

/** 把 extraBody 深合并进请求体；若触碰保留字段（图片/提示词/schema 载体）则拒绝。 */
export function mergeExtraBody(body, extra, reserved, providerName) {
    if (!extra || Object.keys(extra).length === 0) {
        return body;
    }
    for (const path of reserved) {
        if (hasPath(extra, path)) {
            throw new Error(
                `extraBody cannot override "${path}" for the ${providerName} provider: it carries the image, the prompt, or the schema this tool depends on. Remove that field from ${providerName}.extraBody (or --extra-body).`,
            );
        }
    }
    return deepMerge(body, extra);
}

function deepMerge(base, overlay) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        const current = merged[key];
        merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
    }
    return merged;
}

function hasPath(value, dottedPath) {
    let cursor = value;
    for (const segment of dottedPath.split('.')) {
        if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment)) {
            return false;
        }
        cursor = cursor[segment];
    }
    return true;
}

// ---------------------------------------------------------------------------
// 密钥脱敏
// ---------------------------------------------------------------------------

/** 常见凭据形状的正则清单（厂商前缀 key / JWT / 认证头 / 带标签的 key）。 */
const TOKEN_SHAPES = [
    /\b(?:sk|rk|pk|xox[a-z])-[A-Za-z0-9_-]{12,}\b/g,
    /\bAIza[A-Za-z0-9_-]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    /\b(?:bearer|authorization)\b[=:\s]+"?[A-Za-z0-9._~+/-]{12,}"?/gi,
    /\b(?:token|api[-_]?key)\b\s*[=:]\s*"?[A-Za-z0-9._~+/-]{12,}"?/gi,
];

const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]*:[^ ]*@[^ ]*/gi;
const RAW_USERINFO = /^([a-z][a-z0-9+.-]*:[\\/]{2,4})[^\s/?#]*@/i;

function parseUrl(candidate) {
    try {
        return new URL(candidate);
    } catch {
        return null;
    }
}

function rebuildMasked(url, replacement) {
    return `${url.protocol}//${replacement}@${url.host}${url.pathname}${url.search}${url.hash}`;
}

/** 掩码 URL 里的 userinfo（凭据也是秘密）。 */
export function maskUrlCredentials(url) {
    const parsed = parseUrl(url);
    if (parsed) {
        return parsed.username !== '' || parsed.password !== ''
            ? rebuildMasked(parsed, '***')
            : url;
    }
    return url.replace(RAW_USERINFO, '$1***@');
}

/**
 * 文本脱敏：已知密钥精确替换（最短 6 字符），再按常见形状正则兜底，
 * 最后处理带 userinfo 的 URL 候选。
 */
export function redactSecrets(text, knownSecrets = []) {
    let out = text;
    for (const secret of knownSecrets) {
        if (secret && secret.length >= 6) {
            out = out.split(secret).join('[redacted]');
        }
    }
    for (const shape of TOKEN_SHAPES) {
        out = out.replace(shape, '[redacted]');
    }
    out = out.replace(URL_CANDIDATE, (token) => {
        const pieces = token.split(/(?<=[^a-z0-9+.-])(?=[a-z][a-z0-9+.-]*:[\\/]{1,4})/i);
        if (pieces.length === 1) {
            const parsed = parseUrl(token);
            if (parsed) {
                return parsed.username !== '' || parsed.password !== ''
                    ? rebuildMasked(parsed, '[redacted]')
                    : token;
            }
            return token.replace(RAW_USERINFO, '$1[redacted]@');
        }
        return pieces
            .map((piece) => {
                const parsed = parseUrl(piece);
                if (parsed) {
                    return parsed.password !== '' ? rebuildMasked(parsed, '[redacted]') : piece;
                }
                return piece.replace(RAW_USERINFO, '$1[redacted]@');
            })
            .join('');
    });
    return out;
}

// ---------------------------------------------------------------------------
// 端点绑定防护（退役的 BASE_URL 环境变量）
// ---------------------------------------------------------------------------

/**
 * 当一个 API provider 由配置文件接管后，其端点环境变量停止生效。
 * 若变量仍被设置而文件里没有 baseUrl，请求会被送到一个没人配置过的端点，
 * 这里在发请求前直接报错并给出迁移命令。
 */
const ENDPOINT_BINDINGS = {
    openai: {
        variable: 'OPENAI_BASE_URL',
        consequence: 'this run has no endpoint left to send the image to',
    },
    anthropic: {
        variable: 'ANTHROPIC_BASE_URL',
        consequence: "this run would have sent your key and the image to Anthropic's own endpoint",
    },
};

export function assertNoRetiredEndpointBinding(providerName, settings, env = process.env) {
    const binding = ENDPOINT_BINDINGS[providerName];
    const variable = binding?.variable;
    if (!variable || settings.baseUrl?.trim() || !env[variable]?.trim()) {
        return;
    }
    const shown = maskUrlCredentials(env[variable]?.trim() ?? '');
    const reference = process.platform === 'win32' ? `$env:${variable}` : `"$${variable}"`;
    throw new Error(
        `${variable} is set (${shown}), but the config file configures ${providerName}, and since 3.17.0 a provider takes its settings from one place: the file, whole. ${providerName}.baseUrl is not in it, so ${binding.consequence}. To keep the endpoint you were using, run: visionforge config set ${providerName}.baseUrl ${reference}`,
    );
}

// ---------------------------------------------------------------------------
// 错误消息改写（只读属性保护）
// ---------------------------------------------------------------------------

export function setErrorMessage(error, message) {
    try {
        error.message = message;
    } catch (caught) {
        if (!(caught instanceof TypeError)) {
            throw caught;
        }
        Object.defineProperty(error, 'message', {
            value: message,
            configurable: true,
            writable: true,
        });
    }
}
