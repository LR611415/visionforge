// providers/qwen.js — 千问（DashScope）OpenAI 兼容端点适配
//
// 契约（保持）：POST {base}/chat/completions，Bearer 认证，stream:false；
// structuredOutput 开启时用 json_object 格式让网关返回完整 JSON。

import { JSON_TEMPLATE_INSTRUCTION, VISION_RESULT_SCHEMA, buildVisionPrompt, missingSchemaFields, normalizeVisionResult, visionResultSchemaJson } from '../schema.js';
import { apiFetch, readLocalImageBase64 } from '../net.js';
import { errorFromApiStatus, extractJson, mergeExtraBody, redactSecrets, splitApiKeys, truncate } from '../util.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const QWEN_DEFAULT_MODEL = 'qwen3.8-max';

const QWEN_RESERVED = ['model', 'messages', 'stream'];

async function executeQwenApi(options) {
    const apiKeys = splitApiKeys(options.settings?.apiKey);
    const apiKey = apiKeys[0];
    const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
    if (!apiKey) {
        throw new Error('qwen provider needs an API key. Run: visionforge config set qwen.apiKey and paste it at the hidden prompt');
    }
    const model = options.model || options.settings?.model || QWEN_DEFAULT_MODEL;
    const baseUrl = (options.settings?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const image =
        options.imageKind === 'remote'
            ? { mimeType: 'image/jpeg', data: undefined }
            : readLocalImageBase64(options.imageSource);
    const prompt = `${buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'inline', extraPrompt: options.extraPrompt })}

Return the required JSON object. ${JSON_TEMPLATE_INSTRUCTION}`;
    const body = {
        model,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: options.imageKind === 'remote' ? { url: options.imageSource } : { url: `data:${image.mimeType};base64,${image.data}` },
                    },
                    { type: 'text', text: prompt },
                ],
            },
        ],
        stream: false,
    };
    if (options.settings?.structuredOutput === true) {
        body.response_format = { type: 'json_object', schema: visionResultSchemaJson(VISION_RESULT_SCHEMA), name: 'vision_result' };
    }
    const startedAt = Date.now();
    const response = await apiFetch(
        `${baseUrl}/chat/completions`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(mergeExtraBody(body, options.settings?.extraBody, QWEN_RESERVED, 'qwen')),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.settings?.proxy,
    );
    if (!response.ok) {
        const raw = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(raw, apiKeySecrets);
        throw errorFromApiStatus(response.status, `Qwen API error ${response.status}: ${truncate(detail)}`, detail);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
        throw new Error(`Qwen returned an empty message (${typeof content}). Check the model name and endpoint.`);
    }
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(
            `Qwen returned no usable JSON. If the gateway supports it, enable qwen.structuredOutput to enforce the schema. (model: ${model}, baseUrl: ${baseUrl})`,
        );
    }
    const missing = missingSchemaFields(VISION_RESULT_SCHEMA, parsed);
    if (missing.length > 0) {
        throw new Error(
            `Qwen returned JSON missing required vision fields: ${missing.join(', ')}. If the gateway supports it, enable qwen.structuredOutput. (model: ${model}, baseUrl: ${baseUrl})`,
        );
    }
    return {
        result: normalizeVisionResult(VISION_RESULT_SCHEMA, parsed),
        meta: {
            conversationId: payload.id ?? null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usage ?? null,
        },
    };
}

export const qwenProvider = {
    name: 'qwen',
    defaultModel: QWEN_DEFAULT_MODEL,
    execute: executeQwenApi,
};
