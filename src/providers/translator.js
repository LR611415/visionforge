// providers/translator.js — 引擎翻译器：Canonical Image + 格式模板表 + Resolver
//
// 把"图片怎么传给引擎"从每个 provider 手写，收敛为一张格式模板表：
//   - 读图（P2）：readFamily 渲染 chat 请求 + 解析回复（openai-compatible /
//     anthropic / gemini / raw-base64）
//   - 生图（P5）：genFamily 渲染生成请求 + 解析图片（dashscope-image /
//     openai-image / chat-native / google-imagen）
//
// 内部统一对象：
//   Canonical Image = { kind:'remote'|'local', source, mimeType, data? }
//   Canonical 生成请求 = { prompt, count?, size?, refImages:[CanonicalImage], mode:'text-to-image'|'image-to-image'|'edit' }
//
// 设计原则：本模块零业务逻辑（不读配置、不判可用性），只做
// "Canonical → 目标 family 请求体 / family 响应 → 结果" 的纯翻译。

import { apiFetch, readLocalImageBase64, fetchRemoteImageBase64 } from '../net.js';
import { VISION_RESULT_SCHEMA } from '../schema.js';
import { errorFromApiStatus, extractJson, mergeExtraBody, redactSecrets, splitApiKeys, truncate } from '../util.js';

// ---------------------------------------------------------------------------
// Canonical Image
// ---------------------------------------------------------------------------

/** 把输入（本地路径 / 远程 URL）归一化为 Canonical Image。 */
export function canonicalizeImage(kind, source, timeoutMs) {
    if (kind === 'remote') {
        return { kind: 'remote', source, mimeType: 'image/jpeg', data: undefined };
    }
    const image = readLocalImageBase64(source);
    return { kind: 'local', source, mimeType: image.mimeType, data: image.data };
}

/** 本地文件 → data URI（生图 refImages 用）。 */
export function localImageToDataUrl(filePath) {
    const image = readLocalImageBase64(filePath);
    return `data:${image.mimeType};base64,${image.data}`;
}

// ---------------------------------------------------------------------------
// 读图 family 模板表
// ---------------------------------------------------------------------------

const ANTHROPIC_TOOL_NAME = 'report_vision_evidence';

const READ_FAMILY_TEMPLATES = {
    'openai-compatible': {
        auth: 'bearer',
        path: (baseUrl) => `${baseUrl}/chat/completions`,
        headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
        // 远程 URL 直传；本地 data URI
        renderContent: (image) => [
            {
                type: 'image_url',
                image_url: { url: image.kind === 'remote' ? image.source : `data:${image.mimeType};base64,${image.data}` },
            },
        ],
        renderBody: (ctx) => {
            const body = {
                model: ctx.model,
                messages: [{ role: 'user', content: [...ctx.content, { type: 'text', text: ctx.prompt }] }],
                stream: false,
            };
            if (ctx.settings?.structuredOutput === true) {
                body.response_format = { type: 'json_object' };
            }
            return body;
        },
        reserved: ['model', 'messages', 'stream'],
        parseContent: (payload) => {
            const content = payload.choices?.[0]?.message?.content;
            return typeof content === 'string' && content.length > 0 ? content : null;
        },
    },
    anthropic: {
        auth: 'x-api-key',
        path: (baseUrl) => `${baseUrl}/v1/messages`,
        headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }),
        renderContent: (image) => [
            {
                type: 'image',
                source:
                    image.kind === 'remote'
                        ? { type: 'url', url: image.source }
                        : { type: 'base64', media_type: image.mimeType, data: image.data },
            },
        ],
        renderBody: (ctx) => ({
            model: ctx.model,
            max_tokens: 4096,
            tools: [
                {
                    name: ANTHROPIC_TOOL_NAME,
                    description: 'Report the structured visual evidence extracted from the image.',
                    input_schema: VISION_RESULT_SCHEMA,
                },
            ],
            tool_choice: { type: 'tool', name: ANTHROPIC_TOOL_NAME },
            messages: [{ role: 'user', content: [...ctx.content, { type: 'text', text: ctx.prompt }] }],
        }),
        reserved: ['model', 'messages', 'tools', 'tool_choice', 'stream'],
        parseContent: (payload) => {
            const toolUse = payload.content?.find((block) => block.type === 'tool_use');
            return toolUse?.input ?? null;
        },
    },
    gemini: {
        auth: 'x-goog-api-key',
        path: (baseUrl, model) => `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: (key) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' }),
        // gemini 远程图也拉回 base64 内联（与内置 gemini.js 一致）
        renderContent: async (image, { timeoutMs }) => {
            const inline =
                image.kind === 'remote'
                    ? await fetchRemoteImageBase64(image.source, timeoutMs)
                    : { mime_type: image.mimeType, data: image.data };
            return [{ inline_data: { mime_type: inline.mime_type, data: inline.data } }];
        },
        renderBody: (ctx) => ({
            contents: [{ parts: [...ctx.content, { text: ctx.prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: VISION_RESULT_SCHEMA,
            },
        }),
        reserved: ['contents', 'generationConfig.responseMimeType', 'generationConfig.responseJsonSchema'],
        parseContent: (payload) => {
            const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
            return text || null;
        },
    },
    'raw-base64': {
        auth: 'bearer',
        path: (baseUrl) => `${baseUrl}/chat/completions`,
        headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
        // 私有端点：base64 直接放字段（远程 URL 也原样放 URL）
        renderContent: (image) => [
            image.kind === 'remote'
                ? { type: 'image', image_url: image.source }
                : { type: 'image', image_base64: image.data, media_type: image.mimeType },
        ],
        renderBody: (ctx) => ({
            model: ctx.model,
            messages: [{ role: 'user', content: [...ctx.content, { type: 'text', text: ctx.prompt }] }],
            stream: false,
        }),
        reserved: ['model', 'messages', 'stream'],
        parseContent: (payload) => {
            const content = payload.choices?.[0]?.message?.content;
            return typeof content === 'string' && content.length > 0 ? content : null;
        },
    },
};

/**
 * 渲染读图请求。返回 { url, headers, body }。
 * ctx = { family, model, baseUrl, apiKey, prompt, image: CanonicalImage, settings, timeoutMs }
 */
export async function renderReadRequest(ctx) {
    const template = READ_FAMILY_TEMPLATES[ctx.family];
    if (!template) {
        throw new Error(`未知读图协议族：${ctx.family}`);
    }
    const content = await (async () => {
        const rendered = template.renderContent(ctx.image, { timeoutMs: ctx.timeoutMs });
        return rendered instanceof Promise ? await rendered : rendered;
    })();
    const body = template.renderBody({ ...ctx, content });
    return {
        url: template.path(ctx.baseUrl, ctx.model),
        headers: template.headers(ctx.apiKey),
        body: JSON.stringify(mergeExtraBody(body, ctx.settings?.extraBody, template.reserved, ctx.family)),
    };
}

/** 解析读图回复：返回 { content }（字符串或对象）。 */
export function parseReadResponse(family, payload) {
    const template = READ_FAMILY_TEMPLATES[family];
    if (!template) {
        throw new Error(`未知读图协议族：${family}`);
    }
    return { content: template.parseContent(payload) };
}

// ---------------------------------------------------------------------------
// 生图 family 模板表（P5）
// ---------------------------------------------------------------------------

/** 尺寸 → 各 family 的格式。qwen/dashscope 用 W*H 星号（历史坑）；openai 用 WxH；imagen 用比例。 */
export function normalizeSizeFor(size, family) {
    const raw = typeof size === 'string' && size.trim() ? size.trim() : '';
    const m = raw.toLowerCase().match(/^(\d+)\s*[x×*]\s*(\d+)$/);
    if (!m) {
        return raw;
    }
    const [w, h] = [m[1], m[2]];
    if (family === 'dashscope-image' || family === 'chat-native') {
        return `${w}*${h}`;
    }
    if (family === 'google-imagen') {
        // Imagen 用 aspectRatio；1024*1024 → 1:1，1280*720 → 16:9
        const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
        const divisor = gcd(Number(w), Number(h));
        return `${w / divisor}:${h / divisor}`;
    }
    return `${w}x${h}`;
}

const GEN_FAMILY_TEMPLATES = {
    'dashscope-image': {
        auth: 'bearer',
        path: (baseUrl) => `${baseUrl}/services/aigc/multimodal-generation/generation`,
        headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
        renderBody: (ctx) => ({
            model: ctx.model,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { text: ctx.prompt },
                            ...ctx.refImages.map((img) => ({
                                image: img.kind === 'remote' ? img.source : localImageToDataUrl(img.source),
                            })),
                        ],
                    },
                ],
            },
            parameters: {
                size: normalizeSizeFor(ctx.size, 'dashscope-image'),
                n: ctx.count ?? 1,
                watermark: false,
            },
        }),
        reserved: ['model', 'input', 'parameters'],
        parseImages: (payload) => {
            const urls = [];
            for (const choice of payload.output?.choices ?? []) {
                const content2 = choice.message?.content;
                if (Array.isArray(content2)) {
                    for (const c of content2) {
                        if (c?.image) {
                            urls.push(c.image);
                        }
                    }
                }
            }
            return urls;
        },
    },
    'openai-image': {
        auth: 'bearer',
        path: (baseUrl) => `${baseUrl}/images/generations`,
        headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
        renderBody: (ctx) => {
            const body = {
                model: ctx.model,
                prompt: ctx.prompt,
                size: normalizeSizeFor(ctx.size, 'openai-image') || '1024x1024',
                n: ctx.count ?? 1,
            };
            if (ctx.refImages.length > 0) {
                // OpenAI 兼容 / 火山 Seedream 风格：image 字段（URL 或 data URL base64）。
                // 关键修复：Seedream（doubao-seedream-4.0）与国内 OpenAI 兼容中转认 image，
                // 不认 gpt-image-1 的 input_image——用错字段会被静默忽略，退化为纯文生图。
                body.image = ctx.refImages.map((img) =>
                    img.kind === 'remote' ? img.source : localImageToDataUrl(img.source),
                );
            }
            return body;
        },
        reserved: ['model', 'prompt', 'size', 'n', 'image'],
        parseImages: (payload) => (Array.isArray(payload.data) ? payload.data.map((d) => d.url).filter(Boolean) : []),
    },
    'chat-native': {
        // Gemini 多模态生成：generateContent，返回 parts[].inlineData（base64）
        auth: 'x-goog-api-key',
        path: (baseUrl, model) => `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: (key) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' }),
        renderBody: async (ctx) => {
            const parts = [];
            for (const img of ctx.refImages) {
                const inline =
                    img.kind === 'remote'
                        ? await fetchRemoteImageBase64(img.source, ctx.timeoutMs)
                        : { mime_type: img.mimeType, data: img.data };
                parts.push({ inline_data: { mime_type: inline.mime_type, data: inline.data } });
            }
            parts.push({ text: ctx.prompt });
            return {
                contents: [{ parts }],
                generationConfig: { responseModalities: ['IMAGE'] },
            };
        },
        reserved: ['contents', 'generationConfig'],
        parseImages: (payload) => {
            const images = [];
            for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
                const inline = part.inlineData;
                if (inline?.data) {
                    // base64 → data URI（统一为 imagegen 落盘的输入形态）
                    images.push(`data:${inline.mimeType ?? 'image/png'};base64,${inline.data}`);
                }
            }
            return images;
        },
    },
    'google-imagen': {
        auth: 'x-goog-api-key',
        path: (baseUrl, model) => `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:predict`,
        headers: (key) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' }),
        renderBody: (ctx) => {
            const aspectRatio = normalizeSizeFor(ctx.size, 'google-imagen');
            const parameters = { sampleCount: ctx.count ?? 1 };
            if (aspectRatio && /^\d+:\d+$/.test(aspectRatio)) {
                parameters.aspectRatio = aspectRatio;
            }
            if (ctx.mode === 'edit' || ctx.mode === 'image-to-image') {
                // 编辑：参考图 + prompt（简化：instances 逐个携带 referenceImages）
                return {
                    instances: ctx.refImages.map((img) => ({
                        prompt: ctx.prompt,
                        referenceImages: [
                            img.kind === 'remote' ? img.source : localImageToDataUrl(img.source),
                        ],
                    })),
                    parameters,
                };
            }
            return { instances: [{ prompt: ctx.prompt }], parameters };
        },
        reserved: ['instances', 'parameters'],
        parseImages: (payload) => {
            const images = [];
            for (const prediction of payload.predictions ?? []) {
                if (prediction.bytesBase64Encoded) {
                    images.push(`data:image/png;base64,${prediction.bytesBase64Encoded}`);
                } else if (prediction.url) {
                    images.push(prediction.url);
                }
            }
            return images;
        },
    },
};

/**
 * 渲染生图请求。返回 { url, headers, body }。
 * ctx = { family, model, baseUrl, apiKey, prompt, count?, size?, refImages:[CanonicalImage], mode, timeoutMs }
 */
export async function renderGenRequest(ctx) {
    const template = GEN_FAMILY_TEMPLATES[ctx.family];
    if (!template) {
        throw new Error(`未知生图协议族：${ctx.family}`);
    }
    const refImages = Array.isArray(ctx.refImages) ? ctx.refImages : [];
    const rendered = template.renderBody({ ...ctx, refImages });
    const body = rendered instanceof Promise ? await rendered : rendered;
    return {
        url: template.path(ctx.baseUrl, ctx.model),
        headers: template.headers(ctx.apiKey),
        body: JSON.stringify(mergeExtraBody(body, ctx.settings?.extraBody, template.reserved, ctx.family)),
    };
}

/** 解析生图回复：返回图片源数组（http(s) URL 或 data URI）。 */
export function parseGenResponse(family, payload) {
    const template = GEN_FAMILY_TEMPLATES[family];
    if (!template) {
        throw new Error(`未知生图协议族：${family}`);
    }
    return template.parseImages(payload);
}

/** 读图 family 的 auth 头模板（设置卡片展示用）。 */
export function readFamilyAuthLabel(family) {
    return { 'openai-compatible': 'Bearer', anthropic: 'x-api-key', gemini: 'x-goog-api-key', 'raw-base64': 'Bearer' }[family] ?? 'Bearer';
}

/** 发起渲染好的请求，返回解析后的 content / images。 */
export async function callRendered(url, headers, body, proxy, timeoutMs, secrets, errorLabel) {
    const response = await apiFetch(
        url,
        { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) },
        proxy,
    );
    if (!response.ok) {
        const raw = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(raw, secrets);
        throw errorFromApiStatus(response.status, `${errorLabel} API error ${response.status}: ${truncate(detail)}`, detail);
    }
    return response.json();
}

/** 供 analyze 链使用的统一错误（把 secrets 从错误信息中抹掉）。 */
export function redactMessage(error, secrets) {
    return error instanceof Error ? redactSecrets(error.message, secrets) : String(error);
}
