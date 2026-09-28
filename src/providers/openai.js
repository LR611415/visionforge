// providers/openai.js — OpenAI 兼容 /chat/completions 适配
//
// 契约（保持）：POST {base}/chat/completions，Bearer 认证，stream:false；
// response_format 派生：structuredOutput → json_schema 严格模式，
// 否则 json_object；模型没带出 schema 时提示可开 structuredOutput。

import { JSON_TEMPLATE_INSTRUCTION, VISION_RESULT_SCHEMA, buildVisionPrompt, missingSchemaFields, normalizeVisionResult, visionResponseFormat, visionResultSchemaJson } from '../schema.js';
import { apiFetch, readLocalImageBase64 } from '../net.js';
import { assertNoRetiredEndpointBinding, errorFromApiStatus, extractJson, mergeExtraBody, redactSecrets, splitApiKeys, truncate } from '../util.js';

export const OPENAI_DEFAULT_MODEL = 'gpt-5.2-mini';

const OPENAI_RESERVED = ['model', 'messages', 'stream'];

async function executeOpenAiCompat(options) {
    assertNoRetiredEndpointBinding('openai', options.settings ?? {});
    const apiKeys = splitApiKeys(options.settings?.apiKey);
    const apiKey = apiKeys[0];
    const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
    if (!apiKey) {
        throw new Error('openai provider needs an API key. Run: visionforge config set openai.apiKey and paste it at the hidden prompt');
    }
    if (!options.settings?.baseUrl?.trim()) {
        throw new Error('openai provider needs a baseUrl (it is an OpenAI-compatible gateway). Run: visionforge config set openai.baseUrl <url>');
    }
    const model = options.model || options.settings?.model || OPENAI_DEFAULT_MODEL;
    const baseUrl = options.settings.baseUrl.replace(/\/$/, '');
    const image =
        options.imageKind === 'remote'
            ? { mimeType: 'image/jpeg', data: undefined }
            : readLocalImageBase64(options.imageSource);
    const prompt = buildOpenAiPrompt(options, model);
    const responseFormat = (() => {
        if (options.settings?.structuredOutput === true) {
            return visionResponseFormat(VISION_RESULT_SCHEMA);
        }
        const resultJson = visionResultSchemaJson(VISION_RESULT_SCHEMA);
        return { type: 'json_object', schema: resultJson, name: 'vision_result' };
    })();
    const startedAt = Date.now();
    const response = await apiFetch(
        `${baseUrl}/chat/completions`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(
                mergeExtraBody(
                    {
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
                        ...(options.settings?.extraBody?.response_format
                            ? {}
                            : { response_format: responseFormat }),
                    },
                    options.settings?.extraBody,
                    OPENAI_RESERVED,
                    'openai',
                ),
            ),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.settings?.proxy,
    );
    if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(body, apiKeySecrets);
        throw errorFromApiStatus(response.status, `OpenAI-compatible API error ${response.status}: ${truncate(detail)}`, detail);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
        throw new Error(
            `The OpenAI-compatible endpoint returned an empty message (${typeof content}). Check that the model name is valid and the endpoint is reachable.`,
        );
    }
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
        const advice = `The endpoint returned no usable JSON. ${
            options.settings?.structuredOutput
                ? 'Your endpoint may not honor response_format; try disabling openai.structuredOutput.'
                : 'If the gateway supports it, enable openai.structuredOutput to make it enforce the schema.'
        } (model: ${model}, baseUrl: ${options.settings.baseUrl})`;
        throw new Error(advice);
    }
    const missing = missingSchemaFields(parsed);
    if (missing.length > 0) {
        const advice = `The endpoint returned JSON missing required vision fields: ${missing.join(', ')}. ${
            options.settings?.structuredOutput
                ? 'Your endpoint may not honor response_format; try disabling openai.structuredOutput.'
                : 'If the gateway supports it, enable openai.structuredOutput to make it enforce the schema.'
        } (model: ${model}, baseUrl: ${options.settings.baseUrl})`;
        throw new Error(advice);
    }
    return {
        result: normalizeVisionResult(parsed),
        meta: {
            conversationId: payload.id ?? null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usage ?? null,
        },
    };
}

function buildOpenAiPrompt(options, model) {
    const base = buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'inline', extraPrompt: options.extraPrompt });
    const format = options.settings?.structuredOutput === true ? 'a strict JSON object matching the required schema' : 'the required JSON object';
    return `${base}

Return ${format}. ${JSON_TEMPLATE_INSTRUCTION}`;
}

export const openAiProvider = {
    name: 'openai',
    defaultModel: OPENAI_DEFAULT_MODEL,
    execute: executeOpenAiCompat,
};
