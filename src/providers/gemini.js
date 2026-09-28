// providers/gemini.js — Google Gemini generateContent API 适配
//
// 契约（保持）：POST {base}/v1beta/models/{model}:generateContent，
// 认证走 x-goog-api-key 头；本地图 inline_data，远程图先拉回 base64
// 再内联；schema 走 generationConfig.responseMimeType + responseJsonSchema。

import { buildVisionPrompt, VISION_RESULT_SCHEMA } from '../schema.js';
import { apiFetch, fetchRemoteImageBase64, readLocalImageBase64 } from '../net.js';
import { errorFromApiStatus, mergeExtraBody, redactSecrets, splitApiKeys, truncate } from '../util.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';

async function executeGeminiApi(options) {
    const apiKeys = splitApiKeys(options.settings?.apiKey);
    const apiKey = apiKeys[0];
    const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
    if (!apiKey) {
        throw new Error('gemini-api provider needs an API key. Run: visionforge config set gemini-api.apiKey and paste it at the hidden prompt (free key: https://aistudio.google.com)');
    }
    const model = options.model || options.settings?.model || GEMINI_DEFAULT_MODEL;
    const baseUrl = (options.settings?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const image =
        options.imageKind === 'remote'
            ? await fetchRemoteImageBase64(options.imageSource, options.timeoutMs)
            : readLocalImageBase64(options.imageSource);
    const prompt = buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'inline', extraPrompt: options.extraPrompt });
    const startedAt = Date.now();
    const response = await apiFetch(
        `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
            method: 'POST',
            headers: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(
                mergeExtraBody(
                    {
                        contents: [
                            {
                                parts: [{ inline_data: { mime_type: image.mimeType, data: image.data } }, { text: prompt }],
                            },
                        ],
                        generationConfig: {
                            responseMimeType: 'application/json',
                            responseJsonSchema: VISION_RESULT_SCHEMA,
                        },
                    },
                    options.settings?.extraBody,
                    ['contents', 'generationConfig.responseMimeType', 'generationConfig.responseJsonSchema'],
                    'gemini-api',
                ),
            ),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.settings?.proxy,
    );
    if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(body, apiKeySecrets);
        throw errorFromApiStatus(response.status, `Gemini API error ${response.status}: ${truncate(detail)}`, detail);
    }
    const payload = await response.json();
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
    if (!text) {
        throw new Error('Gemini API returned no text candidate.');
    }
    let result;
    try {
        result = JSON.parse(text);
    } catch {
        throw new Error(`Gemini API returned non-JSON output: ${truncate(text)}`);
    }
    return {
        result,
        meta: {
            conversationId: null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usageMetadata ?? null,
        },
    };
}

export const geminiApiProvider = {
    name: 'gemini-api',
    defaultModel: GEMINI_DEFAULT_MODEL,
    execute: executeGeminiApi,
};
