// request-template.js — 自定义请求模板（开发者选项兜底）
//
// 翻译器内置了四个协议族（openai-compatible / anthropic / gemini / raw-base64）。
// 当用户新增的引擎请求格式不在这些协议族内，或接口字段特殊时，可在开发者选项
// 粘贴官方请求/响应示例，本模块：
//   1. infer* — 从官方示例启发式推断占位符模板（用户可再手改）
//   2. renderTemplateRequest — 按模板 + 运行期值渲染 { url, method, headers, body }
//   3. getByPath / extractImages / extractReadContent — 点路径提取响应字段
//
// 占位符：
//   {{BASE_URL}} 引擎接口地址（去尾斜杠）   {{API_KEY}}   当前密钥
//   {{MODEL}}    模型名                     {{PROMPT}}   提示词
//   {{IMAGE1..3}} 参考图（本地→data URI，远程→原 URL；读图/编辑用）
//   {{SIZE}}     尺寸内部原文（如 1024*1024）  {{SIZE_X}}  x 格式尺寸（1024x1024，多数引擎用）
//   {{SIZE_STAR}} * 格式尺寸（1024*1024，千问系用）  {{COUNT}}  张数
//   类型保真：{{COUNT}}/{{SIZE}}/{{SIZE_X}}/{{SIZE_STAR}} 单独占满一个 JSON 节点时，
//   若引擎示例中该节点为数字类型，渲染为数字（不转成字符串）。

const PLACEHOLDER_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;
const NUMERIC_PLACEHOLDERS = new Set(['COUNT', 'SIZE', 'SIZE_X', 'SIZE_STAR']);

// ---------------------------------------------------------------------------
// 占位符渲染
// ---------------------------------------------------------------------------

function fillString(value, values) {
    return String(value).replace(PLACEHOLDER_RE, (_, key) => {
        const v = values[key];
        return v === undefined || v === null ? '' : String(v);
    });
}

/** 判断字符串是否整节点是单个数字型占位符（如 "{{COUNT}}"）。 */
function isNumericPlaceholderOnly(str) {
    const m = /^\{\{\s*([A-Z0-9_]+)\s*\}\}$/.exec(str);
    return m && NUMERIC_PLACEHOLDERS.has(m[1]) ? m[1] : null;
}

function deepFill(node, values) {
    if (Array.isArray(node)) {
        return node.map((item) => deepFill(item, values));
    }
    if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            out[k] = deepFill(v, values);
        }
        return out;
    }
    if (typeof node === 'string') {
        // 类型保真：整节点单个数字占位符 + 运行值为纯数字 → 输出数字类型
        const numericKey = isNumericPlaceholderOnly(node);
        if (numericKey) {
            const raw = values[numericKey];
            if (raw !== undefined && raw !== null && /^-?\d+(\.\d+)?$/.test(String(raw).trim())) {
                return Number(String(raw).trim());
            }
        }
        return fillString(node, values);
    }
    return node;
}

/**
 * 渲染请求模板。
 * ctx = { baseUrl, apiKey, model, prompt, images:[string], size, count, label? }
 * label = 模板段名（如 '读图' / '生图'），用于错误提示。
 * 返回 { url, method, headers, body }（body 为 JSON 字符串）。
 */
export function renderTemplateRequest(template, ctx) {
    if (!template || typeof template !== 'object') {
        throw new Error(`${ctx?.label || '请求'}模板为空`);
    }
    const sizeRaw = typeof ctx.size === 'string' ? ctx.size.trim() : '';
    const sizeX = sizeRaw.replace(/\s*[*x×]\s*/i, 'x');
    const sizeStar = sizeRaw.replace(/\s*[*x×]\s*/i, '*');
    const values = {
        BASE_URL: typeof ctx.baseUrl === 'string' ? ctx.baseUrl.replace(/\/+$/, '') : '',
        API_KEY: typeof ctx.apiKey === 'string' ? ctx.apiKey : '',
        MODEL: typeof ctx.model === 'string' ? ctx.model : '',
        PROMPT: typeof ctx.prompt === 'string' ? ctx.prompt : '',
        SIZE: sizeRaw,
        SIZE_X: sizeX,
        SIZE_STAR: sizeStar,
        COUNT: String(ctx.count ?? 1),
    };
    const images = Array.isArray(ctx.images) ? ctx.images : [];
    for (let i = 0; i < images.length; i++) {
        values[`IMAGE${i + 1}`] = images[i];
    }
    const url = fillString(template.url ?? '', values);
    if (!url) {
        throw new Error(`${ctx?.label || '请求'}模板缺少 url——模板 JSON 的 url 字段写 {{BASE_URL}}/路径 或完整地址（引擎设置里的接口地址会自动替换 {{BASE_URL}}）`);
    }
    const headers = template.headers && typeof template.headers === 'object' ? deepFill(template.headers, values) : {};
    const body = deepFill(template.body ?? {}, values);
    return {
        url,
        method: typeof template.method === 'string' && template.method.trim() ? template.method.trim().toUpperCase() : 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    };
}

// ---------------------------------------------------------------------------
// 响应提取（点路径）
// ---------------------------------------------------------------------------

/** 按点路径取值：'data.0.url' → obj.data[0].url。 */
export function getByPath(obj, path) {
    if (obj === null || obj === undefined || typeof path !== 'string' || !path) {
        return undefined;
    }
    return path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

const DATA_URI_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i;
const B64_RE = /^[A-Za-z0-9+/]{80,}={0,2}$/;

/** 判断一个值是否"像"图片源（URL / data URI / 纯 base64）。 */
export function isImageLike(value) {
    if (typeof value !== 'string') {
        return false;
    }
    if (DATA_URI_RE.test(value)) {
        return true;
    }
    if (IMG_EXT_RE.test(value) && /^https?:/i.test(value)) {
        return true;
    }
    return B64_RE.test(value);
}

/** 遍历对象找图片值，返回点路径数组（含提取出的值）。 */
export function findImagePaths(node, prefix = '') {
    const found = [];
    const walk = (current, path) => {
        if (current === null || current === undefined) {
            return;
        }
        if (Array.isArray(current)) {
            current.forEach((item, i) => walk(item, path ? `${path}.${i}` : `${i}`));
            return;
        }
        if (typeof current === 'object') {
            for (const [k, v] of Object.entries(current)) {
                walk(v, path ? `${path}.${k}` : k);
            }
            return;
        }
        if (typeof current === 'string' && isImageLike(current)) {
            found.push({ path: path || '', value: current });
        }
    };
    walk(node, prefix);
    return found;
}

/** 规范化图片值 → 统一 data URI 或 URL（供 imagegen 落盘）。 */
export function normalizeImageValue(value) {
    if (typeof value !== 'string' || !value) {
        return null;
    }
    if (DATA_URI_RE.test(value) || /^https?:/i.test(value)) {
        return value;
    }
    if (B64_RE.test(value)) {
        return `data:image/png;base64,${value}`;
    }
    return null;
}

/** 提取生图图片：extract.images.generate 路径数组依次尝试；
 *  单个路径命中：数组值全取 / 对象值遍历图片字段 / 字符串单张；
 *  再尝试"同级数组展开"（data.0.url → data 数组全部 url），一次取回多张。 */
export function extractGeneratedImages(payload, paths) {
    const list = Array.isArray(paths) ? paths : [];
    for (const p of list) {
        const value = getByPath(payload, p);
        if (value === undefined || value === null) {
            continue;
        }
        const direct = collectImageValues(value);
        // 同级数组展开：路径形如 data.0.url → 遍历 data 数组所有成员的 url（多图一次取回）
        const expanded = expandSiblingArray(payload, p);
        if (expanded.length > 0) {
            return expanded;
        }
        if (direct.length > 0) {
            return direct;
        }
    }
    return [];
}

function expandSiblingArray(payload, path) {
    const m = /^(.*\.)(\d+)\.([^.]+)$/.exec(path);
    if (!m) {
        return [];
    }
    const arr = getByPath(payload, m[1].replace(/\.$/, ''));
    if (!Array.isArray(arr)) {
        return [];
    }
    return arr.map((item) => normalizeImageValue(item?.[m[3]])).filter(Boolean);
}

function collectImageValues(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeImageValue).filter(Boolean);
    }
    if (typeof value === 'object') {
        return findImagePaths(value)
            .map((f) => normalizeImageValue(f.value))
            .filter(Boolean);
    }
    const norm = normalizeImageValue(value);
    return norm ? [norm] : [];
}

/** 提取读图正文：extract.read.content 路径；命中对象则字符串化，字符串原样返回。 */
export function extractReadContent(payload, path) {
    if (typeof path !== 'string' || !path) {
        return null;
    }
    const value = getByPath(payload, path);
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        return value.length > 0 ? value : null;
    }
    if (Array.isArray(value)) {
        // 常见：content 是 part 数组（text 字段拼接）
        const text = value
            .map((part) => (part && typeof part === 'object' ? (part.text ?? '') : ''))
            .join('')
            .trim();
        return text.length > 0 ? text : JSON.stringify(value);
    }
    return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 从官方示例推断模板（启发式；结果供用户确认/修改）
// ---------------------------------------------------------------------------

const KNOWN_API_PATHS = [
    '/chat/completions',
    '/v1/messages',
    ':generateContent',
    '/images/generations',
    '/multimodal-generation/generation',
    ':predict',
];

function looksLikeBase64(value) {
    return typeof value === 'string' && B64_RE.test(value);
}
function looksLikeDataUri(value) {
    return typeof value === 'string' && DATA_URI_RE.test(value);
}
function looksLikeImageUrl(value) {
    return typeof value === 'string' && IMG_EXT_RE.test(value) && /^https?:/i.test(value);
}
function looksLikePrompt(value, seenKeys) {
    if (typeof value !== 'string') {
        return false;
    }
    const v = value.trim();
    if (v.length < 8 || v.length > 4000) {
        return false;
    }
    if (looksLikeBase64(v) || looksLikeDataUri(v) || looksLikeImageUrl(v)) {
        return false;
    }
    if (/^[A-Za-z0-9_\-]{8,64}$/.test(v)) {
        return false; // 可能是模型名/标识符
    }
    if (seenKeys.has(v)) {
        return false;
    }
    return true;
}

/** 拆完整 URL：origin + path（保留已知 API 路径，其余整段交给用户）。 */
function splitBaseUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
        return null;
    }
    try {
        const u = new URL(value);
        const origin = `${u.protocol}//${u.host}`;
        const rest = `${u.pathname}${u.search}`;
        return { base: origin, path: rest };
    } catch {
        return null;
    }
}

function maskObject(node, replacers) {
    // replacers: [{ key, when(value), to }]
    if (Array.isArray(node)) {
        return node.map((item) => maskObject(item, replacers));
    }
    if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            const matched = replacers.find((r) => k.toLowerCase().includes(r.key) && r.when(v));
            if (matched) {
                out[k] = matched.to;
            } else {
                out[k] = maskObject(v, replacers);
            }
        }
        return out;
    }
    return node;
}

/**
 * 推断读图请求模板。
 * sample = 官方示例请求 JSON（对象）。返回 { url, method, headers, body } 或 null。
 */
export function inferReadRequestTemplate(sample) {
    if (!sample || typeof sample !== 'object') {
        return null;
    }
    const headers = {};
    let body = sample;
    let url = '';
    let method = 'POST';

    // url / method 可能出现在顶层（fetch 风格）或由调用方提供
    if (typeof sample.url === 'string') {
        url = sample.url;
    }
    if (typeof sample.method === 'string') {
        method = sample.method;
    }
    if (sample.headers && typeof sample.headers === 'object') {
        Object.assign(headers, sample.headers);
        body = sample.body !== undefined ? (typeof sample.body === 'string' ? safeParse(sample.body) : sample.body) : {};
    } else if (sample.body && typeof sample.body === 'object') {
        body = sample.body;
    }

    const apiKeyMatch = Object.entries(headers).find(
        ([k, v]) => /authorization|x-api-key|api[-_]?key/i.test(k) && typeof v === 'string',
    );
    const apiKeyHeader = apiKeyMatch ? apiKeyMatch[0] : '';
    if (apiKeyHeader) {
        if (/authorization/i.test(apiKeyHeader)) {
            headers[apiKeyHeader] = 'Bearer {{API_KEY}}';
        } else {
            headers[apiKeyHeader] = '{{API_KEY}}';
        }
    }

    // body 内联 key 字段（api_key / token）
    const replacers = [
        { key: 'prompt', when: (v) => looksLikePrompt(v, new Set()), to: '{{PROMPT}}' },
        { key: 'model', when: (v) => typeof v === 'string' && v.length > 0, to: '{{MODEL}}' },
        { key: 'image', when: (v) => looksLikeBase64(v) || looksLikeDataUri(v) || looksLikeImageUrl(v), to: '{{IMAGE1}}' },
        { key: 'api_key', when: (v) => typeof v === 'string', to: '{{API_KEY}}' },
        { key: 'token', when: (v) => typeof v === 'string', to: '{{API_KEY}}' },
        { key: 'key', when: (v) => typeof v === 'string' && looksLikeBase64(v), to: '{{API_KEY}}' },
    ];
    const masked = maskObject(body, replacers);

    // 若 prompt 未被掩码（字段名不含 prompt），找最长自然语言串
    if (!jsonHas(masked, '{{PROMPT}}')) {
        const promptField = findPromptField(body, apiKeyMatch ? apiKeyMatch[0] : '');
        if (promptField) {
            setPath(masked, promptField, '{{PROMPT}}');
        }
    }
    if (!jsonHas(masked, '{{IMAGE1}}')) {
        const imgField = findImageField(body);
        if (imgField) {
            setPath(masked, imgField, '{{IMAGE1}}');
        }
    }

    // url 拆 BASE_URL
    let finalUrl = url;
    if (url && /^https?:/i.test(url)) {
        const split = splitBaseUrl(url);
        if (split) {
            finalUrl = `{{BASE_URL}}${split.path}`;
        } else {
            finalUrl = '{{BASE_URL}}';
        }
    } else if (!url) {
        finalUrl = '{{BASE_URL}}';
    }

    return { url: finalUrl, method, headers, body: masked };
}

function safeParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return {};
    }
}

function jsonHas(node, marker) {
    return JSON.stringify(node).includes(marker);
}

function setPath(node, path, value) {
    const keys = path.split('.');
    let cur = node;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = /^\d+$/.test(keys[i]) ? Number(keys[i]) : keys[i];
        if (cur[k] === undefined || cur[k] === null) {
            cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
        }
        cur = cur[k];
    }
    const last = keys[keys.length - 1];
    cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function findPromptField(node, skipKey = '', prefix = '') {
    let best = null;
    let bestLen = 0;
    const walk = (current, path) => {
        if (current === null || typeof current !== 'object') {
            return;
        }
        if (Array.isArray(current)) {
            current.forEach((item, i) => walk(item, path ? `${path}.${i}` : `${i}`));
            return;
        }
        for (const [k, v] of Object.entries(current)) {
            const childPath = path ? `${path}.${k}` : k;
            if (typeof v === 'string') {
                const t = v.trim();
                if (t.length >= 8 && t.length <= 4000 && !looksLikeBase64(t) && !looksLikeDataUri(t) && !looksLikeImageUrl(t) && !/^[A-Za-z0-9_\-]{8,64}$/.test(t) && k.toLowerCase() !== skipKey.toLowerCase()) {
                    if (t.length > bestLen) {
                        bestLen = t.length;
                        best = childPath;
                    }
                }
            } else if (v && typeof v === 'object') {
                walk(v, childPath);
            }
        }
    };
    walk(node, prefix);
    return best;
}

function findImageField(node, prefix = '') {
    let best = null;
    const walk = (current, path) => {
        if (best) {
            return;
        }
        if (current === null || typeof current !== 'object') {
            return;
        }
        if (Array.isArray(current)) {
            for (let i = 0; i < current.length; i++) {
                walk(current[i], path ? `${path}.${i}` : `${i}`);
                if (best) {
                    return;
                }
            }
            return;
        }
        for (const [k, v] of Object.entries(current)) {
            const childPath = path ? `${path}.${k}` : k;
            if (typeof v === 'string' && (looksLikeBase64(v) || looksLikeDataUri(v) || looksLikeImageUrl(v))) {
                best = childPath;
                return;
            }
            if (v && typeof v === 'object') {
                walk(v, childPath);
                if (best) {
                    return;
                }
            }
        }
    };
    walk(node, prefix);
    return best;
}

/**
 * 推断生图请求模板。
 * sample = 官方生图示例 JSON。返回 { url, method, headers, body } 或 null。
 */
export function inferGenRequestTemplate(sample) {
    if (!sample || typeof sample !== 'object') {
        return null;
    }
    const headers = {};
    let body = sample;
    let url = '';
    let method = 'POST';
    if (typeof sample.url === 'string') {
        url = sample.url;
    }
    if (typeof sample.method === 'string') {
        method = sample.method;
    }
    if (sample.headers && typeof sample.headers === 'object') {
        Object.assign(headers, sample.headers);
        body = sample.body !== undefined ? (typeof sample.body === 'string' ? safeParse(sample.body) : sample.body) : {};
    } else if (sample.body && typeof sample.body === 'object') {
        body = sample.body;
    }
    const apiKeyMatch = Object.entries(headers).find(
        ([k, v]) => /authorization|x-api-key|api[-_]?key/i.test(k) && typeof v === 'string',
    );
    const apiKeyHeader = apiKeyMatch ? apiKeyMatch[0] : '';
    if (apiKeyHeader) {
        if (/authorization/i.test(apiKeyHeader)) {
            headers[apiKeyHeader] = 'Bearer {{API_KEY}}';
        } else {
            headers[apiKeyHeader] = '{{API_KEY}}';
        }
    }
    const replacers = [
        { key: 'prompt', when: (v) => looksLikePrompt(v, new Set()), to: '{{PROMPT}}' },
        { key: 'model', when: (v) => typeof v === 'string' && v.length > 0, to: '{{MODEL}}' },
        { key: 'size', when: (v) => typeof v === 'string' && /^\d+\s*[x×*]\s*\d+$/i.test(v.trim()), to: '{{SIZE}}' },
        { key: 'n', when: (v) => typeof v === 'number' || /^\d+$/.test(String(v)), to: '{{COUNT}}' },
        { key: 'count', when: (v) => typeof v === 'number' || /^\d+$/.test(String(v)), to: '{{COUNT}}' },
        { key: 'samplecount', when: (v) => typeof v === 'number' || /^\d+$/.test(String(v)), to: '{{COUNT}}' },
        { key: 'image', when: (v) => looksLikeBase64(v) || looksLikeDataUri(v) || looksLikeImageUrl(v), to: '{{IMAGE1}}' },
        { key: 'referenceimages', when: (v) => Array.isArray(v) && v.some((x) => looksLikeImageUrl(x) || looksLikeDataUri(x)), to: ['{{IMAGE1}}'] },
        { key: 'input_image', when: (v) => looksLikeBase64(v) || looksLikeDataUri(v) || looksLikeImageUrl(v), to: '{{IMAGE1}}' },
        { key: 'api_key', when: (v) => typeof v === 'string', to: '{{API_KEY}}' },
        { key: 'token', when: (v) => typeof v === 'string', to: '{{API_KEY}}' },
    ];
    const masked = maskObject(body, replacers);
    if (!jsonHas(masked, '{{PROMPT}}')) {
        const promptField = findPromptField(body, apiKeyMatch ? apiKeyMatch[0] : '');
        if (promptField) {
            setPath(masked, promptField, '{{PROMPT}}');
        }
    }
    if (!jsonHas(masked, '{{IMAGE1}}')) {
        const imgField = findImageField(body);
        if (imgField) {
            setPath(masked, imgField, '{{IMAGE1}}');
        }
    }
    let finalUrl = url;
    if (url && /^https?:/i.test(url)) {
        const split = splitBaseUrl(url);
        if (split) {
            finalUrl = `{{BASE_URL}}${split.path}`;
        } else {
            finalUrl = '{{BASE_URL}}';
        }
    } else if (!url) {
        finalUrl = '{{BASE_URL}}';
    }
    return { url: finalUrl, method, headers, body: masked };
}

/** 推断读图回复正文提取路径：常见路径优先，其次最长文本字段。 */
export function inferReadContentPath(sample) {
    if (!sample || typeof sample !== 'object') {
        return '';
    }
    const candidates = [
        'choices.0.message.content',
        'output.choices.0.message.content',
        'candidates.0.content.parts',
        'content',
    ];
    for (const c of candidates) {
        const v = getByPath(sample, c);
        if (typeof v === 'string' && v.trim().length > 0) {
            return c;
        }
        if (Array.isArray(v) && v.length > 0) {
            return c;
        }
    }
    // 兜底：找最长文本字符串字段路径
    let best = '';
    let bestLen = 0;
    const walk = (current, path) => {
        if (current === null || typeof current !== 'object') {
            return;
        }
        if (Array.isArray(current)) {
            current.forEach((item, i) => walk(item, path ? `${path}.${i}` : `${i}`));
            return;
        }
        for (const [k, v] of Object.entries(current)) {
            const childPath = path ? `${path}.${k}` : k;
            if (typeof v === 'string' && v.trim().length > 20 && !looksLikeBase64(v)) {
                if (v.trim().length > bestLen) {
                    bestLen = v.trim().length;
                    best = childPath;
                }
            } else if (v && typeof v === 'object') {
                walk(v, childPath);
            }
        }
    };
    walk(sample, '');
    return best;
}

/** 推断生图回复图片提取路径：返回候选路径数组。 */
export function inferGenImagePaths(sample) {
    if (!sample || typeof sample !== 'object') {
        return [];
    }
    const found = findImagePaths(sample);
    // 优先返回深路径中"数组型"（data.0.url 这类带索引）的完整路径，去重后取前 3 组
    const paths = [];
    const seen = new Set();
    for (const f of found) {
        if (!f.path) {
            continue;
        }
        const group = /^(.*\.\d+\.)([^.]+)$/.exec(f.path);
        const root = group ? group[1] : f.path;
        if (seen.has(root)) {
            continue;
        }
        seen.add(root);
        paths.push(f.path);
        if (paths.length >= 3) {
            break;
        }
    }
    return paths;
}

/** 合并模板 JSON（供 UI 展示与保存）。 */
export function buildRequestTemplate({ read, generate, extract }) {
    const out = { enabled: true };
    if (read && read.url) {
        out.read = read;
    }
    if (generate && generate.url) {
        out.generate = generate;
    }
    const ex = {};
    if (extract && typeof extract.read === 'string' && extract.read) {
        ex.read = { content: extract.read };
    }
    if (extract && Array.isArray(extract.generate) && extract.generate.length > 0) {
        ex.generate = { images: extract.generate };
    }
    if (Object.keys(ex).length > 0) {
        out.extract = ex;
    }
    return out;
}
