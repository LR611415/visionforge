// imagegen.js — 生图 / 编辑引擎（VisionForge 自有能力，非上游代码）
//
// 方案 A 安全区自研重写，行为契约与 dist L5472-5781 对齐，并扩展 P5 翻译器：
//   - 内置引擎收敛到翻译器模板表：qwen → dashscope-image（原生多模态端点，
//     生图/编辑共用，默认 qwen-image-3.0）；glm → openai-image（/images/generations，
//     不支持编辑）。
//   - 自定义引擎（customProviders，见 src/custom-providers.js）：genFamily 模板渲染，
//     支持文生图 / 图生图 / 编辑；模型按 capabilities 选（generate/edit 能力）。
//   - 生成缓存：Windows 统一 D:\VisionForge\out（无 D 盘回退用户目录），
//     可被 config.outputDir 覆盖；缓存 TTL 3 天自动清理。
//   - 每次 generate 只产出用户要求数量（默认 1 张）；edit 支持 1-3 张输入、
//     count 1-6 变体。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { persistConfig } from './config.js';
import { resolveProviderSettings } from './config-resolve.js';
import { canonicalizeName, parseSizeCap, readCustomProviders } from './custom-providers.js';
import { classifyFailure, customGateError, formatCustomEngineFailure, markCustomFailed, markCustomVerified } from './diagnose.js';
import { apiFetch } from './net.js';
import { enhanceEditPrompt } from './prompt-enhancer.js';
import { resolveSize, ENGINE_SIZE_CAPS } from './size.js';
import { callRendered, canonicalizeImage, localImageToDataUrl, parseGenResponse, renderGenRequest } from './providers/translator.js';
import { extractGeneratedImages, renderTemplateRequest } from './request-template.js';
import { errorFromApiStatus, isApiKeyFailure, redactSecrets, splitApiKeys, truncate } from './util.js';

const DASHSCOPE_NATIVE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_QWEN_IMAGE_MODEL = 'qwen-image-3.0';
const DEFAULT_QWEN_IMAGE_EDIT_MODEL = 'qwen-image-3.0';

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_GLM_IMAGE_MODEL = 'glm-image';

const IMAGE_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 把用户可能输入的 1024x1024 / 1024×1024 / 1024*1024 统一成 Qwen 要求的 W*H。
 * （兼容测试引用的既有导出；运行时尺寸规范化由翻译器按协议族处理。）
 */
export function normalizeSize(size) {
    if (typeof size !== 'string' || size.trim() === '') return '1024*1024';
    const m = size.trim().toLowerCase().match(/^(\d+)\s*[x×*]\s*(\d+)$/);
    if (m) return `${m[1]}*${m[2]}`;
    return size.trim();
}

// ---------------------------------------------------------------------------
// 缓存目录（统一路径，不兼容旧位置）
// ---------------------------------------------------------------------------

export function imageGenOutDir(config) {
    const custom = config?.outputDir?.trim();
    if (custom) {
        return path.resolve(custom);
    }
    if (process.platform === 'win32') {
        return fs.existsSync('D:\\') ? path.resolve('D:\\VisionForge\\out') : path.join(os.homedir(), 'VisionForge', 'out');
    }
    return path.join(os.homedir(), '.visionforge', 'out');
}

/** 清理超过 3 天的生成缓存，返回清理数量。 */
function pruneImageCache(config) {
    const dir = imageGenOutDir(config);
    let removed = 0;
    try {
        const entries = fs.readdirSync(dir);
        const now = Date.now();
        for (const name of entries) {
            if (!name.startsWith('visionforge-')) {
                continue;
            }
            const full = path.join(dir, name);
            try {
                const st = fs.statSync(full);
                if (st.isFile() && now - st.mtimeMs > IMAGE_CACHE_MAX_AGE_MS) {
                    fs.unlinkSync(full);
                    removed++;
                }
            } catch {
            }
        }
    } catch {
    }
    return removed;
}

// ---------------------------------------------------------------------------
// 密钥解析
// ---------------------------------------------------------------------------

function qwenImageApiKey(config, env) {
    const keys = splitApiKeys(resolveProviderSettings('qwen', config, env).apiKey);
    return keys.length > 0 ? keys[0] : undefined;
}

function glmImageApiKey(config, env) {
    const fileKeys = splitApiKeys(config.providers?.glm?.apiKey);
    if (fileKeys.length > 0) {
        return fileKeys[0];
    }
    for (const variable of ['GLM_API_KEY', 'ZHIPU_API_KEY', 'ZAI_API_KEY']) {
        const value = env[variable]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}

const NO_KEY_MESSAGE =
    'No image-generation provider is configured. Configure at least one key: visionforge config set qwen.apiKey <key> (千问, also powers Qwen-Image), or visionforge config set glm.apiKey <key> (智谱 GLM-Image, also honored from GLM_API_KEY/ZHIPU_API_KEY), or add a custom engine with generation enabled (config add-engine <name> --base-url <url> --gen-family <family> --gen-model <model>).';

function assertCustomGenReady(entry, what) {
    if (!entry?.genFamily) {
        throw new Error(`${what}需要自定义引擎「${entry?.displayName ?? entry?.id ?? '?'}」已启用生图协议族。运行：visionforge config set custom.${entry?.id ?? '?'}.genFamily <family>`);
    }
    if (!entry?.apiKey || !entry?.baseUrl?.trim()) {
        throw new Error(`自定义引擎「${entry?.displayName ?? entry?.id}」缺少 apiKey 或 baseUrl，无法${what}。`);
    }
}

/** 有效生图能力上限：自定义引擎声明的 sizeCap 覆盖协议族通用上限。 */
function effectiveGenCap(family, entry) {
    const base = ENGINE_SIZE_CAPS[family];
    if (!base || !entry?.sizeCap) return base;
    let p = null;
    try { p = parseSizeCap(entry.sizeCap); } catch { p = null; }
    if (!p) return base;
    return {
        ...base,
        supports2K: base.supports2K || !!p.supports2K,
        maxW: Math.max(base.maxW, p.maxW),
        maxH: Math.max(base.maxH, p.maxH),
    };
}

/** 生图引擎路由：显式指定（qwen/glm/自定义名）或按配置顺序兜底。 */
function resolveGenProvider(forced, config, env, customs) {
    if (forced) {
        if (forced === 'qwen') {
            if (!qwenImageApiKey(config, env)) {
                throw new Error('qwen image generation needs qwen.apiKey (or VISIONFORGE_QWEN_API_KEY).');
            }
            return 'qwen';
        }
        if (forced === 'glm') {
            if (!glmImageApiKey(config, env)) {
                throw new Error('glm image generation needs glm.apiKey (or GLM_API_KEY).');
            }
            return 'glm';
        }
        const id = canonicalizeName(forced);
        if (!Object.hasOwn(customs, id)) {
            throw new Error(`Unknown generation provider: ${forced}. Use qwen, glm, or one of: ${Object.keys(customs).join(', ')}.`);
        }
        assertCustomGenReady(customs[id], '生图');
        return id;
    }
    // 无显式指定：优先用户默认引擎（config.provider），再按 qwen → glm → 自定义引擎兜底
    const preferred = typeof config.provider === 'string' ? config.provider.trim() : '';
    if (preferred) {
        if (preferred === 'qwen' && qwenImageApiKey(config, env)) return 'qwen';
        if (preferred === 'glm' && glmImageApiKey(config, env)) return 'glm';
        const pid = canonicalizeName(preferred);
        if (Object.hasOwn(customs, pid)) {
            const entry = customs[pid];
            if (entry.genFamily && entry.apiKey && entry.baseUrl?.trim() && entry.models.some((m) => m.capabilities.generate || m.capabilities.edit)) {
                return pid;
            }
        }
    }
    if (qwenImageApiKey(config, env)) {
        return 'qwen';
    }
    if (glmImageApiKey(config, env)) {
        return 'glm';
    }
    const genReady = Object.values(customs).filter((entry) => entry.genFamily && entry.apiKey && entry.baseUrl?.trim() && entry.models.some((m) => m.capabilities.generate || m.capabilities.edit));
    if (genReady.length > 0) {
        return genReady[0].id;
    }
    throw new Error(NO_KEY_MESSAGE);
}

function toRefImages(inputImages) {
    return (inputImages ?? []).map((image) =>
        typeof image === 'string' && /^https?:\/\//i.test(image.trim())
            ? canonicalizeImage('remote', image.trim())
            : canonicalizeImage('local', image),
    );
}

// ---------------------------------------------------------------------------
// 厂商调用（内置引擎收敛到翻译器模板，行为与错误前缀保持不变）
// ---------------------------------------------------------------------------

async function qwenImageCall(options) {
    const apiKeys = splitApiKeys(options.apiKey);
    const apiKeySecrets = apiKeys;
    const baseUrl = (options.baseUrl ?? DASHSCOPE_NATIVE_BASE_URL).replace(/\/$/, '');
    const model = options.model ?? DEFAULT_QWEN_IMAGE_MODEL;
    let lastError;
    for (const apiKey of apiKeys) {
        try {
            const { url, headers, body } = await renderGenRequest({
                family: 'dashscope-image',
                model,
                baseUrl,
                apiKey,
                prompt: options.prompt,
                size: options.size,
                count: options.count ?? 1,
                refImages: toRefImages(options.inputImages),
                mode: options.inputImages?.length ? 'image-to-image' : 'text-to-image',
                timeoutMs: options.timeoutMs,
            });
            const payload = await callRendered(url, headers, body, options.proxy, options.timeoutMs, apiKeySecrets, 'Qwen image');
            const urls = parseGenResponse('dashscope-image', payload);
            if (urls.length === 0) {
                throw new Error(`Qwen image API returned no image URL. Payload: ${truncate(redactSecrets(JSON.stringify(payload), apiKeySecrets))}`);
            }
            return { urls, model };
        } catch (error) {
            lastError = error;
            if (!isApiKeyFailure(error)) throw error; // 非鉴权/配额失败不换 key
        }
    }
    throw lastError;
}

async function glmImageCall(options) {
    const apiKeys = splitApiKeys(options.apiKey);
    const apiKeySecrets = apiKeys;
    const baseUrl = (options.baseUrl ?? GLM_BASE_URL).replace(/\/$/, '');
    const model = options.model ?? DEFAULT_GLM_IMAGE_MODEL;
    let lastError;
    for (const apiKey of apiKeys) {
        try {
            const { url, headers, body } = await renderGenRequest({
                family: 'openai-image',
                model,
                baseUrl,
                apiKey,
                prompt: options.prompt,
                size: options.size,
                count: 1,
                refImages: [],
                mode: 'text-to-image',
                timeoutMs: options.timeoutMs,
            });
            const payload = await callRendered(url, headers, body, options.proxy, options.timeoutMs, apiKeySecrets, 'GLM image');
            if (payload.error?.message) {
                throw new Error(`GLM image API error: ${truncate(redactSecrets(payload.error.message, apiKeySecrets))}`);
            }
            const urls = parseGenResponse('openai-image', payload);
            if (urls.length === 0) {
                throw new Error(`GLM image API returned no image URL. Payload: ${truncate(redactSecrets(JSON.stringify(payload), apiKeySecrets))}`);
            }
            return { url: urls[0], model };
        } catch (error) {
            lastError = error;
            if (!isApiKeyFailure(error)) throw error;
        }
    }
    throw lastError;
}

/** 自定义引擎生图/编辑：genFamily 模板渲染 + 解析。 */
async function customGenImageCall(entry, options, env) {
    assertCustomGenReady(entry, options.inputImages?.length ? '图生图/编辑' : '生图');
    const apiKeys = splitApiKeys(entry.apiKey);
    const generateModel = entry.models.find((m) => m.capabilities.generate || m.capabilities.edit)?.name;
    const model = options.model || generateModel || '';
    if (!model) {
        throw new Error(
            `自定义引擎「${entry.displayName}」没有生图模型。请在设置卡片或运行：visionforge config set custom.${entry.id}.genModel <模型名>（或 config set custom.${entry.id}.model 仅读图）`,
        );
    }
    let lastError;
    const genTemplate = entry.requestTemplate && entry.requestTemplate.enabled !== false && entry.requestTemplate.generate && entry.requestTemplate.generate.url
        ? entry.requestTemplate.generate
        : null;
    for (const apiKey of apiKeys) {
        try {
            let payload;
            if (genTemplate) {
                // 自定义请求模板兜底：按官方示例构造生图请求
                const refImages = toRefImages(options.inputImages);
                const images = refImages.map((img) => (img.kind === 'remote' ? img.source : localImageToDataUrl(img.source)));
                const rendered = renderTemplateRequest(genTemplate, {
                    baseUrl: entry.baseUrl.replace(/\/+$/, ''),
                    apiKey,
                    model,
                    prompt: options.prompt,
                    images,
                    size: options.size,
                    count: options.count ?? 1,
                    label: '生图',
                });
                payload = await callRendered(rendered.url, rendered.headers, rendered.body, entry.proxy, options.timeoutMs, [apiKey], entry.displayName);
            } else {
                const { url, headers, body } = await renderGenRequest({
                    family: entry.genFamily,
                    model,
                    baseUrl: entry.baseUrl.replace(/\/+$/, ''),
                    apiKey,
                    prompt: options.prompt,
                    size: options.size,
                    count: options.count ?? 1,
                    refImages: toRefImages(options.inputImages),
                    mode: options.inputImages?.length ? 'edit' : 'text-to-image',
                    settings: { extraBody: entry.extraBody },
                    timeoutMs: options.timeoutMs,
                });
                payload = await callRendered(url, headers, body, entry.proxy, options.timeoutMs, [apiKey], entry.displayName);
            }
            let images;
            if (genTemplate && entry.requestTemplate.extract?.generate?.images) {
                images = extractGeneratedImages(payload, entry.requestTemplate.extract.generate.images);
            } else {
                images = parseGenResponse(entry.genFamily, payload);
            }
            if (images.length === 0) {
                throw new Error(`「${entry.displayName}」生图接口没有返回图片。若该引擎请求格式特殊，请在设置卡片 → 开发者选项 → 自定义请求模板 核对「请求模板/响应提取」，或在协议族不适配时切换引擎。Payload: ${truncate(redactSecrets(JSON.stringify(payload), [apiKey]))}`);
            }
            return { images, model };
        } catch (error) {
            lastError = error;
            if (!isApiKeyFailure(error)) throw error;
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// 落盘（http(s) URL 与 data URI 统一处理）
// ---------------------------------------------------------------------------

function extensionFromUrl(url) {
    if (/^data:/i.test(url)) {
        return '.png';
    }
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        const match = /\.(png|jpe?g|webp|gif|bmp)$/.exec(pathname);
        return match ? `.${match[1].replace('jpeg', 'jpg')}` : '.png';
    } catch {
        return '.png';
    }
}

async function downloadTo(url, outputPath, proxy, timeoutMs) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const response = await apiFetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }, proxy);
    if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        throw new Error(`Failed to download generated image (${response.status}): ${truncate(body)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
}

/** 统一保存：http(s) URL 下载 / data URI 直接解码。 */
async function saveImageResult(imageSource, outputPath, proxy, timeoutMs) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
        const match = /^data:[^;]*;base64,(.*)$/s.exec(imageSource);
        if (!match) {
            throw new Error('Unsupported data URI (expected base64).');
        }
        const buffer = Buffer.from(match[1], 'base64');
        if (buffer.length === 0) {
            throw new Error('The engine returned an empty image payload.');
        }
        fs.writeFileSync(outputPath, buffer);
        return outputPath;
    }
    return downloadTo(imageSource, outputPath, proxy, timeoutMs);
}

function resolveOutputPath(output, url, config) {
    if (output?.trim()) {
        return path.resolve(output.trim());
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `visionforge-${ts}-${Math.random().toString(36).slice(2, 6)}${extensionFromUrl(url)}`;
    return path.join(imageGenOutDir(config), name);
}

function numberedSibling(output, n, url) {
    const ext = path.extname(output) || extensionFromUrl(url);
    const stem = ext ? output.slice(0, output.length - ext.length) : output;
    return `${stem}-${n}${ext}`;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/** 文生图：每次按用户要求的数量产出（默认 1 张）。引擎：qwen / glm / 自定义。 */
export async function generateImage(options) {
    pruneImageCache(options.config);
    const env = options.env ?? process.env;
    const customs = readCustomProviders(options.config ?? {});
    const provider = resolveGenProvider(options.provider, options.config, env, customs);
    const timeoutMs = options.timeoutMs ?? 120000;
    // 文生图同样自动增强（保护性边界约束；提示词细节由宿主撰写，插件不代写）
    // （--no-enhance 或 config.enhanceEditPrompt=false 关闭）
    const enhanced = enhanceEditPrompt(options.prompt, {
        enabled: options.enhance !== false && options.config?.enhanceEditPrompt !== false,
        mode: 'generate',
    });
    const genPrompt = enhanced.prompt;
    const family = provider === 'qwen' ? 'dashscope-image' : provider === 'glm' ? 'openai-image' : (customs[provider]?.genFamily || 'openai-image');
    const genCap = provider === 'qwen' || provider === 'glm' ? ENGINE_SIZE_CAPS[family] : effectiveGenCap(family, customs[provider]);
    const sizeResolved = resolveSize(options.size, genCap);
    let images;
    let model;
    let proxy;
    if (provider === 'qwen') {
        const result = await qwenImageCall({
            apiKey: qwenImageApiKey(options.config, env),
            prompt: genPrompt,
            size: sizeResolved.size,
            model: options.model,
            timeoutMs,
            proxy: resolveProviderSettings('qwen', options.config, env).proxy,
        });
        images = result.urls;
        model = result.model;
        proxy = resolveProviderSettings('qwen', options.config, env).proxy;
    } else if (provider === 'glm') {
        const result = await glmImageCall({
            apiKey: glmImageApiKey(options.config, env),
            prompt: genPrompt,
            size: sizeResolved.size,
            model: options.model,
            timeoutMs,
            proxy: options.config.proxy,
        });
        images = [result.url];
        model = result.model;
        proxy = options.config.proxy;
    } else {
        const entry = customs[provider];
        const gate = customGateError(entry, provider);
        if (gate) throw new Error(gate);
        try {
            const result = await customGenImageCall(entry, { ...options, prompt: genPrompt, size: sizeResolved.size, _preEnhanced: true }, env);
            images = result.images;
            model = result.model;
            proxy = entry.proxy;
            markCustomVerified(options.config, provider);
        } catch (error) {
            const diag = classifyFailure({ provider, model: entry?.model || options.model, baseUrl: entry?.baseUrl, error, mode: '生图' });
            markCustomFailed(options.config, provider, diag);
            throw new Error(formatCustomEngineFailure(entry, diag));
        }
    }
    const filePath = await saveImageResult(images[0], resolveOutputPath(options.output, images[0], options.config), proxy, timeoutMs);
    return { filePath, url: images[0], provider, model, size: sizeResolved.size, ...(sizeResolved.note ? { sizeNote: sizeResolved.note } : {}), ...(enhanced.notice ? { enhanceNotice: enhanced.notice } : {}) };
}

/** 图生图 / 编辑：1-3 张输入，count 1-6 变体。qwen（原生）或自定义引擎（genFamily）。 */
export async function editImage(options) {
    pruneImageCache(options.config);
    const env = options.env ?? process.env;
    const inputs = (Array.isArray(options.input) ? options.input : [options.input])
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => x.length > 0);
    if (inputs.length === 0) {
        throw new Error('editImage needs at least one non-empty "input" image path or URL.');
    }
    if (inputs.length > 3) {
        throw new Error(`Image editing accepts at most 3 input images; got ${inputs.length}.`);
    }
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 6) {
        throw new Error('count must be an integer between 1 and 6.');
    }
    const customs = readCustomProviders(options.config ?? {});
    let provider;
    if (options.provider && options.provider !== 'glm') {
        if (options.provider === 'qwen') {
            provider = 'qwen';
        } else {
            const id = canonicalizeName(options.provider);
            if (!Object.hasOwn(customs, id)) {
                throw new Error(`Unknown editing provider: ${options.provider}. Use qwen or a custom engine with generation enabled.`);
            }
            provider = id;
        }
    } else if (options.provider === 'glm') {
        throw new Error('GLM-Image does not support image editing yet; use qwen (qwen-image-edit) or a custom engine that supports it.');
    } else {
        const qwenKey = qwenImageApiKey(options.config, env);
        // 优先用户默认引擎（config.provider），再按 qwen → 自定义引擎兜底
        const preferred = typeof options.config.provider === 'string' ? options.config.provider.trim() : '';
        if (preferred === 'qwen' && qwenKey) {
            provider = 'qwen';
        } else if (preferred !== '' && preferred !== 'qwen' && preferred !== 'glm') {
            const pid = canonicalizeName(preferred);
            if (Object.hasOwn(customs, pid)) {
                const entry = customs[pid];
                if (entry.genFamily && entry.apiKey && entry.baseUrl?.trim()) {
                    provider = pid;
                }
            }
        }
        if (!provider) {
            if (qwenKey) {
                provider = 'qwen';
            } else {
                const firstCustom = Object.keys(customs).find((id) => {
                    const entry = customs[id];
                    return entry.genFamily && entry.apiKey && entry.baseUrl?.trim();
                });
                if (firstCustom) {
                    provider = firstCustom;
                } else {
                    throw new Error(
                        'Image editing needs the qwen provider (visionforge config set qwen.apiKey <key>) or a custom engine with generation enabled.',
                    );
                }
            }
        }
    }
    const timeoutMs = options.timeoutMs ?? 120000;
    // 提示词自动增强（保护性约束；--no-enhance 或 config.enhanceEditPrompt=false 关闭）
    // generateImage 已预先增强（_preEnhanced）时跳过，避免二次增强重复约束
    const enhanced = enhanceEditPrompt(options.prompt, {
        enabled: options.enhance !== false && options._preEnhanced !== true && options.config?.enhanceEditPrompt !== false,
    });
    const finalPrompt = enhanced.prompt;
    const family = provider === 'qwen' ? 'dashscope-image' : (customs[provider]?.genFamily || 'openai-image');
    const genCap = provider === 'qwen' ? ENGINE_SIZE_CAPS[family] : effectiveGenCap(family, customs[provider]);
    const sizeResolved = resolveSize(options.size, genCap);
    let images;
    let model;
    let proxy;
    if (provider === 'qwen') {
        const qwenKey = qwenImageApiKey(options.config, env);
        if (!qwenKey) {
            throw new Error('Image editing needs the qwen provider: visionforge config set qwen.apiKey <key> (千问 qwen-image-edit).');
        }
        proxy = resolveProviderSettings('qwen', options.config, env).proxy;
        const result = await qwenImageCall({
            apiKey: qwenKey,
            prompt: finalPrompt,
            inputImages: inputs,
            count,
            size: sizeResolved.size,
            model: options.model ?? DEFAULT_QWEN_IMAGE_EDIT_MODEL,
            timeoutMs,
            proxy,
        });
        images = result.urls;
        model = result.model;
    } else {
        const entry = customs[provider];
        proxy = entry.proxy;
        const gate = customGateError(entry, provider);
        if (gate) throw new Error(gate);
        try {
            const result = await customGenImageCall(entry, { ...options, prompt: finalPrompt, inputImages: inputs, count, size: sizeResolved.size }, env);
            images = result.images;
            model = result.model;
            markCustomVerified(options.config, provider);
        } catch (error) {
            const diag = classifyFailure({ provider, model: entry?.model || options.model, baseUrl: entry?.baseUrl, error, mode: '编辑' });
            markCustomFailed(options.config, provider, diag);
            throw new Error(formatCustomEngineFailure(entry, diag));
        }
    }
    const filePaths = [];
    const explicitOutput = options.output?.trim();
    for (let i = 0; i < images.length; i++) {
        const image = images[i];
        const outPath = explicitOutput && i > 0 ? numberedSibling(explicitOutput, i + 1, image) : resolveOutputPath(explicitOutput, image, options.config);
        filePaths.push(await saveImageResult(image, outPath, proxy, timeoutMs));
    }
    return {
        filePath: filePaths[0],
        url: images[0],
        filePaths,
        urls: images,
        provider,
        model,
        size: sizeResolved.size,
        ...(sizeResolved.note ? { sizeNote: sizeResolved.note } : {}),
        ...(enhanced.enhanced ? { enhanced: true, skippedConstraints: enhanced.skipped } : {}),
        ...(enhanced.notice ? { enhanceNotice: enhanced.notice } : {}),
    };
}
