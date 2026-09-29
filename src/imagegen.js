// imagegen.js — 生图 / 编辑引擎（VisionForge 自有能力，非上游代码）
//
// 方案 A 安全区自研重写，行为契约与 dist L5472-5781 对齐：
//   - qwen：dashscope 原生多模态生成端点（services/aigc/multimodal-generation/generation），
//     生图与编辑共用；默认模型 qwen-image-3.0。
//   - glm：OpenAI 风格 /images/generations；不支持编辑。
//   - 生成缓存：Windows 统一 D:\visionforge\out，其他 ~/.visionforge/out，
//     可被 config.outputDir 覆盖；缓存 TTL 3 天自动清理。
//   - 每次 generate 只产出用户要求数量（默认 1 张）；edit 支持 1-3 张输入、
//     count 1-6 变体、仅 qwen。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveProviderSettings } from './config-resolve.js';
import { apiFetch } from './net.js';
import { errorFromApiStatus, redactSecrets, splitApiKeys, truncate } from './util.js';

const DASHSCOPE_NATIVE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_QWEN_IMAGE_MODEL = 'qwen-image-3.0';
const DEFAULT_QWEN_IMAGE_EDIT_MODEL = 'qwen-image-3.0';

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_GLM_IMAGE_MODEL = 'glm-image';

const IMAGE_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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
    'No image-generation provider is configured. Configure at least one key: visionforge config set qwen.apiKey <key> (千问, also powers Qwen-Image), or visionforge config set glm.apiKey <key> (智谱 GLM-Image, also honored from GLM_API_KEY/ZHIPU_API_KEY).';

function routeTextToImage(forced, qwenKey, glmKey) {
    if (forced) {
        if (forced === 'qwen' && !qwenKey) {
            throw new Error('qwen image generation needs qwen.apiKey (or VISIONFORGE_QWEN_API_KEY).');
        }
        if (forced === 'glm' && !glmKey) {
            throw new Error('glm image generation needs glm.apiKey (or GLM_API_KEY).');
        }
        return forced;
    }
    if (qwenKey) {
        return 'qwen';
    }
    if (glmKey) {
        return 'glm';
    }
    throw new Error(NO_KEY_MESSAGE);
}

// ---------------------------------------------------------------------------
// 厂商调用
// ---------------------------------------------------------------------------

/** 把用户可能输入的 1024x1024 / 1024×1024 / 1024*1024 统一成 Qwen 要求的 W*H。 */
export function normalizeSize(size) {
    if (typeof size !== 'string' || size.trim() === '') return '1024*1024'
    const m = size.trim().toLowerCase().match(/^(\d+)\s*[x×*]\s*(\d+)$/)
    if (m) return `${m[1]}*${m[2]}`
    return size.trim()
}

function localImageToDataUrl(filePath) {
    const mimeByExt = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
    };
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeByExt[ext] ?? 'image/png';
    const data = fs.readFileSync(filePath).toString('base64');
    return `data:${mime};base64,${data}`;
}

async function qwenImageCall(options) {
    const apiKeys = splitApiKeys(options.apiKey);
    const apiKey = apiKeys[0];
    const apiKeySecrets = apiKeys;
    const baseUrl = (options.baseUrl ?? DASHSCOPE_NATIVE_BASE_URL).replace(/\/$/, '');
    const model = options.model ?? DEFAULT_QWEN_IMAGE_MODEL;
    const content = [{ text: options.prompt }];
    for (const image of options.inputImages ?? []) {
        content.push({
            image: /^https?:\/\//i.test(image) ? image : localImageToDataUrl(image),
        });
    }
    const response = await apiFetch(
        `${baseUrl}/services/aigc/multimodal-generation/generation`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                input: {
                    messages: [{ role: 'user', content }],
                },
                parameters: {
                    size: normalizeSize(options.size),
                    n: options.count ?? 1,
                    watermark: false,
                },
            }),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.proxy,
    );
    const quote = (shown) => truncate(redactSecrets(shown, apiKeySecrets));
    if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(body, apiKeySecrets);
        const message = `Qwen image API error ${response.status}: ${truncate(detail)}`;
        throw errorFromApiStatus(response.status, message, detail);
    }
    const payload = await response.json();
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
    if (urls.length === 0) {
        throw new Error(`Qwen image API returned no image URL. Payload: ${quote(JSON.stringify(payload))}`);
    }
    return { urls, model };
}

async function glmImageCall(options) {
    const apiKeys = splitApiKeys(options.apiKey);
    const apiKey = apiKeys[0];
    const apiKeySecrets = apiKeys;
    const baseUrl = (options.baseUrl ?? GLM_BASE_URL).replace(/\/$/, '');
    const model = options.model ?? DEFAULT_GLM_IMAGE_MODEL;
    const response = await apiFetch(
        `${baseUrl}/images/generations`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                prompt: options.prompt,
                size: options.size ?? '1280x1280',
            }),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.proxy,
    );
    const quote = (shown) => truncate(redactSecrets(shown, apiKeySecrets));
    if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(body, apiKeySecrets);
        const message = `GLM image API error ${response.status}: ${truncate(detail)}`;
        throw errorFromApiStatus(response.status, message, detail);
    }
    const payload = await response.json();
    if (payload.error?.message) {
        throw new Error(`GLM image API error: ${quote(payload.error.message)}`);
    }
    const url = payload.data?.[0]?.url;
    if (!url) {
        throw new Error(`GLM image API returned no image URL. Payload: ${quote(JSON.stringify(payload))}`);
    }
    return { url, model };
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

function extensionFromUrl(url) {
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

/** 文生图：每次按用户要求的数量产出（默认 1 张），qwen / glm 二选一按配置路由。 */
export async function generateImage(options) {
    pruneImageCache(options.config);
    const env = options.env ?? process.env;
    const qwenKey = qwenImageApiKey(options.config, env);
    const glmKey = glmImageApiKey(options.config, env);
    const provider = routeTextToImage(options.provider, qwenKey, glmKey);
    const timeoutMs = options.timeoutMs ?? 120000;
    let callUrl;
    let model;
    if (provider === 'qwen') {
        const result = await qwenImageCall({
            apiKey: qwenKey,
            prompt: options.prompt,
            size: options.size,
            model: options.model,
            timeoutMs,
            proxy: resolveProviderSettings('qwen', options.config, env).proxy,
        });
        callUrl = result.urls[0];
        model = result.model;
    } else {
        const result = await glmImageCall({
            apiKey: glmKey,
            prompt: options.prompt,
            size: options.size,
            model: options.model,
            timeoutMs,
            proxy: options.config.proxy,
        });
        callUrl = result.url;
        model = result.model;
    }
    const filePath = await downloadTo(
        callUrl,
        resolveOutputPath(options.output, callUrl, options.config),
        provider === 'qwen' ? resolveProviderSettings('qwen', options.config, env).proxy : options.config.proxy,
        timeoutMs,
    );
    return { filePath, url: callUrl, provider, model, size: options.size };
}

/** 图生图 / 编辑：1-3 张输入，count 1-6 变体，仅 qwen 支持。 */
export async function editImage(options) {
    pruneImageCache(options.config);
    const env = options.env ?? process.env;
    if (options.provider === 'glm') {
        throw new Error('GLM-Image does not support image editing yet; use qwen (qwen-image-edit).');
    }
    const inputs = (Array.isArray(options.input) ? options.input : [options.input])
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => x.length > 0);
    if (inputs.length === 0) {
        throw new Error('editImage needs at least one non-empty "input" image path or URL.');
    }
    if (inputs.length > 3) {
        throw new Error(`Qwen-Image accepts at most 3 input images; got ${inputs.length}.`);
    }
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 6) {
        throw new Error('count must be an integer between 1 and 6.');
    }
    const qwenKey = qwenImageApiKey(options.config, env);
    if (!qwenKey) {
        throw new Error('Image editing needs the qwen provider: visionforge config set qwen.apiKey <key> (千问 qwen-image-edit). GLM-Image does not support editing.');
    }
    const timeoutMs = options.timeoutMs ?? 120000;
    const proxy = resolveProviderSettings('qwen', options.config, env).proxy;
    const result = await qwenImageCall({
        apiKey: qwenKey,
        prompt: options.prompt,
        inputImages: inputs,
        count,
        size: options.size,
        model: options.model ?? DEFAULT_QWEN_IMAGE_EDIT_MODEL,
        timeoutMs,
        proxy,
    });
    const filePaths = [];
    const explicitOutput = options.output?.trim();
    for (let i = 0; i < result.urls.length; i++) {
        const url = result.urls[i];
        const outPath = explicitOutput && i > 0 ? numberedSibling(explicitOutput, i + 1, url) : resolveOutputPath(explicitOutput, url, options.config);
        filePaths.push(await downloadTo(url, outPath, proxy, timeoutMs));
    }
    return {
        filePath: filePaths[0],
        url: result.urls[0],
        filePaths,
        urls: result.urls,
        provider: 'qwen',
        model: result.model,
        size: options.size,
    };
}
