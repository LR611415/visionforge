// providers/anthropic.js — Anthropic Messages API 适配
//
// 契约（保持）：POST {base}/v1/messages，x-api-key + anthropic-version，
// 用 tool_use 让模型把视觉证据填进固定 schema（TOOL_NAME 为契约）。

import { apiFetch, readLocalImageBase64 } from '../net.js';
import { buildVisionPrompt, VISION_RESULT_SCHEMA } from '../schema.js';
import { assertNoRetiredEndpointBinding, errorFromApiStatus, mergeExtraBody, redactSecrets, splitApiKeys, truncate } from '../util.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const TOOL_NAME = 'report_vision_evidence';

async function executeAnthropicApi(options) {
    assertNoRetiredEndpointBinding('anthropic', options.settings ?? {});
    const apiKeys = splitApiKeys(options.settings?.apiKey);
    const apiKey = apiKeys[0];
    const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
    if (!apiKey) {
        throw new Error('anthropic provider needs an API key. Run: visionforge config set anthropic.apiKey and paste it at the hidden prompt');
    }
    const model = options.model || options.settings?.model || ANTHROPIC_DEFAULT_MODEL;
    const baseUrl = (options.settings?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    const imageSource =
        options.imageKind === 'remote'
            ? { type: 'url', url: options.imageSource }
            : (() => {
                  const image = readLocalImageBase64(options.imageSource);
                  return { type: 'base64', media_type: image.mimeType, data: image.data };
              })();
    const prompt = `${buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'inline', extraPrompt: options.extraPrompt })}

Report your findings by calling the ${TOOL_NAME} tool.`;
    const startedAt = Date.now();
    const response = await apiFetch(
        `${baseUrl}/v1/messages`,
        {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(
                mergeExtraBody(
                    {
                        model,
                        max_tokens: 4096,
                        tools: [
                            {
                                name: TOOL_NAME,
                                description: 'Report the structured visual evidence extracted from the image.',
                                input_schema: VISION_RESULT_SCHEMA,
                            },
                        ],
                        tool_choice: { type: 'tool', name: TOOL_NAME },
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    { type: 'image', source: imageSource },
                                    { type: 'text', text: prompt },
                                ],
                            },
                        ],
                    },
                    options.settings?.extraBody,
                    ['model', 'messages', 'tools', 'tool_choice', 'stream'],
                    'anthropic',
                ),
            ),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.settings?.proxy,
    );
    if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        const detail = redactSecrets(body, apiKeySecrets);
        throw errorFromApiStatus(response.status, `Anthropic API error ${response.status}: ${truncate(detail)}`, detail);
    }
    const payload = await response.json();
    const toolUse = payload.content?.find((block) => block.type === 'tool_use');
    if (!toolUse?.input) {
        throw new Error('Anthropic API returned no tool_use block.');
    }
    return {
        result: toolUse.input,
        meta: {
            conversationId: null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usage ?? null,
        },
    };
}

export const anthropicApiProvider = {
    name: 'anthropic',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    execute: executeAnthropicApi,
};
