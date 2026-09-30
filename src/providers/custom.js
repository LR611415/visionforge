// providers/custom.js — 自定义引擎的合成 provider（与内置 provider 完全同构）
//
// 用户在设置卡片 / config add-engine 里新增的引擎，经名称护栏后得到一个
// customProviders 条目（见 src/custom-providers.js）。本模块把它包装成
// analyze 链认识的 provider 对象（{ name, defaultModel, execute }），
// execute 内部用翻译器（src/providers/translator.js）按 readFamily 渲染请求、
// 按 family 解析回复，并复用内置的容错归一 —— 因此自定义引擎自动获得
// failover 链、cooldown、多 key 轮换等全部既有机制，行为与内置一致。

import { JSON_TEMPLATE_INSTRUCTION, buildVisionPrompt, missingSchemaFields, normalizeVisionResult } from '../schema.js';
import { extractJson, splitApiKeys } from '../util.js';
import { normalizeLooseVision } from './qwen.js';
import { callRendered, canonicalizeImage, parseReadResponse, renderReadRequest } from './translator.js';
import { extractReadContent, renderTemplateRequest } from '../request-template.js';

export function createCustomProvider(entry) {
    return {
        name: entry.id,
        displayName: entry.displayName,
        defaultModel: entry.model,
        visionDefaultModel: entry.model,
        isCustom: true,
        readFamily: entry.readFamily,
        async execute(options) {
            const apiKeys = splitApiKeys(entry.apiKey);
            const apiKey = apiKeys[0];
            const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
            if (!apiKey) {
                throw new Error(
                    `自定义引擎「${entry.displayName}」缺少 API key。请在 DSH 设置卡片或运行：visionforge config set custom.${entry.id}.apiKey`,
                );
            }
            const model = options.model || entry.model;
            if (!model) {
                throw new Error(
                    `自定义引擎「${entry.displayName}」尚未配置模型。请在 DSH 设置卡片或运行：visionforge config set custom.${entry.id}.model <模型名>`,
                );
            }
            const baseUrl = entry.baseUrl.replace(/\/+$/, '');
            const prompt = `${buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'inline', extraPrompt: options.extraPrompt })}

Return the required JSON object. ${JSON_TEMPLATE_INSTRUCTION}`;
            const image = canonicalizeImage(options.imageKind, options.imageSource, options.timeoutMs);
            const startedAt = Date.now();
            const readTemplate = entry.requestTemplate && entry.requestTemplate.enabled !== false && entry.requestTemplate.read && entry.requestTemplate.read.url
                ? entry.requestTemplate.read
                : null;
            const imageSrc = image.kind === 'remote' ? image.source : `data:${image.mimeType};base64,${image.data}`;
            let payload;
            if (readTemplate) {
                // 自定义请求模板兜底：请求格式按用户提供的官方示例构造
                const rendered = renderTemplateRequest(readTemplate, {
                    baseUrl,
                    apiKey,
                    model,
                    prompt,
                    images: [imageSrc],
                    size: '',
                    count: 1,
                    label: '读图',
                });
                payload = await callRendered(
                    rendered.url,
                    rendered.headers,
                    rendered.body,
                    entry.proxy,
                    options.timeoutMs,
                    apiKeySecrets,
                    entry.displayName,
                );
            } else {
                const { url, headers, body } = await renderReadRequest({
                    family: entry.readFamily,
                    model,
                    baseUrl,
                    apiKey,
                    prompt,
                    image,
                    settings: {
                        ...entry,
                        extraBody: entry.extraBody,
                        structuredOutput: entry.structuredOutput === true,
                    },
                    timeoutMs: options.timeoutMs,
                });
                payload = await callRendered(
                    url,
                    headers,
                    body,
                    entry.proxy,
                    options.timeoutMs,
                    apiKeySecrets,
                    entry.displayName,
                );
            }
            let content = null;
            if (readTemplate && entry.requestTemplate.extract?.read?.content) {
                content = extractReadContent(payload, entry.requestTemplate.extract.read.content);
                if (content === null) {
                    content = parseReadResponse(entry.readFamily, payload).content;
                }
            } else {
                content = parseReadResponse(entry.readFamily, payload).content;
            }
            if (content === null || (typeof content === 'string' && content.trim() === '')) {
                throw new Error(
                    `「${entry.displayName}」返回了空回复（model: ${model}, baseUrl: ${baseUrl}）。请检查模型名与接口地址是否正确。`,
                );
            }
            let parsed = typeof content === 'object' ? content : extractJson(content);
            if (!parsed || typeof parsed !== 'object') {
                throw new Error(
                    `「${entry.displayName}」没有返回可用的 JSON 结构。若该网关支持，可在配置中开启 structuredOutput 以强制结构化输出。`,
                );
            }
            const missing = missingSchemaFields(parsed);
            const normalized = missing.length > 0 ? normalizeLooseVision(parsed, missing) : parsed;
            return {
                result: normalizeVisionResult(normalized),
                meta: {
                    conversationId: payload.id ?? null,
                    durationSeconds: (Date.now() - startedAt) / 1000,
                    usage: payload.usage ?? null,
                    provider: entry.id,
                },
            };
        },
    };
}
