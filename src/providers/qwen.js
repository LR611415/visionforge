// providers/qwen.js — 千问（DashScope）OpenAI 兼容端点适配
//
// 契约（保持）：POST {base}/chat/completions，Bearer 认证，stream:false；
// structuredOutput 开启时用 json_object 格式让网关返回完整 JSON。

import { JSON_TEMPLATE_INSTRUCTION, VISION_RESULT_SCHEMA, buildVisionPrompt, missingSchemaFields, normalizeVisionResult, visionResultSchemaJson } from '../schema.js';
import { apiFetch, readLocalImageBase64 } from '../net.js';
import { errorFromApiStatus, extractJson, mergeExtraBody, redactSecrets, splitApiKeys, truncate } from '../util.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const QWEN_DEFAULT_MODEL = 'qwen3.8-max';
// 读图（analyze）专用视觉模型：qwen3.8-max 是纯文本模型，不能理解图片。
// 读图默认走视觉模型，用户可用 providers.qwen.visionModel 覆盖（config set qwen.visionModel <name>）。
export const QWEN_VISION_DEFAULT_MODEL = 'qwen3-vl-plus';

const QWEN_RESERVED = ['model', 'messages', 'stream'];

/**
 * 自由 JSON → vision 结构容错归一。
 * 兼容网关 + qwen-vl 系列模型常不按 vision schema 的字段名返回（自由发挥
 * image_analysis/scene/subject/attire 之类）。此函数把可用信息归纳成
 * VISION_RESULT_SCHEMA 结构，不丢内容、不抛错，保证 analyze 有结果可用。
 */
export function normalizeLooseVision(free, missingFields) {
    const result = {
        summary: '',
        ocr: { full_text: '', lines: [] },
        layout: { regions: [] },
        semantics: { scene: '', intent: '', entities: [], relations: [] },
        visual: { dominant_colors: [], style: '', notes: [] },
        uncertainty: [],
    };
    const pick = (keys) => {
        for (const k of keys) {
            const v = free?.[k];
            if (v !== undefined && v !== null) return v;
        }
        return undefined;
    };
    const asString = (v) =>
        typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : v !== undefined && v !== null ? String(v) : '';
    // summary：优先语义文本字段；否则递归收集全部字符串值拼接
    let summary = pick(['summary', 'description', 'caption', 'scene', 'image_analysis', 'analysis']);
    if (typeof summary === 'object') summary = JSON.stringify(summary);
    if (typeof summary !== 'string' || !summary.trim()) {
        const parts = [];
        const walk = (v, depth) => {
            if (depth > 4 || parts.length >= 24) return;
            if (typeof v === 'string') {
                if (v.trim()) parts.push(v.trim());
            } else if (Array.isArray(v)) {
                for (const x of v) walk(x, depth + 1);
            } else if (v && typeof v === 'object') {
                for (const x of Object.values(v)) walk(x, depth + 1);
            }
        };
        walk(free, 0);
        summary = parts.join('; ');
    }
    result.summary = truncate(summary, 3000);
    // ocr：找 full_text / visible_text / text
    const ocrText = pick(['full_text', 'visible_text', 'ocr_text', 'text', 'ocr']);
    result.ocr.full_text = typeof ocrText === 'string' ? ocrText : typeof ocrText === 'object' ? JSON.stringify(ocrText) : '';
    if (Array.isArray(free?.ocr?.lines) || Array.isArray(free?.lines)) {
        result.ocr.lines = (free.ocr?.lines ?? free.lines ?? []).map((l) => ({ text: asString(l.text ?? l), language: 'unknown' }));
    }
    // layout：找 regions / textual_elements
    const regions = pick(['regions', 'textual_elements', 'layout_regions']);
    if (Array.isArray(regions)) {
        result.layout.regions = regions.map((r, i) => ({
            type: asString(r.type ?? r.kind ?? 'text') || 'text',
            reading_order: typeof r.reading_order === 'number' ? r.reading_order : i + 1,
            text: asString(r.text ?? r.content ?? ''),
        }));
    }
    // semantics
    result.semantics.scene = asString(pick(['scene', 'environment', 'setting']));
    result.semantics.intent = asString(pick(['intent', 'purpose']));
    const entities = pick(['entities', 'objects', 'subject']);
    if (Array.isArray(entities)) {
        result.semantics.entities = entities.map((e) => ({
            name: asString(e.name ?? e.label ?? e),
            type: asString(e.type ?? 'object'),
            evidence: asString(e.evidence ?? ''),
        }));
    }
    // visual
    const colors = pick(['dominant_colors', 'colors', 'color_palette', 'palette']);
    if (Array.isArray(colors)) result.visual.dominant_colors = colors.map(asString);
    result.visual.style = asString(pick(['style', 'visual_style', 'aesthetic']));
    const notes = pick(['notes', 'visual_notes', 'notable_visual_detail']);
    if (Array.isArray(notes)) result.visual.notes = notes.map(asString);
    // uncertainty
    const unc = pick(['uncertainty', 'uncertain_text', 'ambiguous']);
    if (Array.isArray(unc)) result.uncertainty = unc.map(asString);
    else if (typeof unc === 'string' && unc) result.uncertainty = [unc];
    // 仍缺失的字段给空结构兜底
    for (const f of missingFields) {
        if (!result[f]) {
            result[f] =
                f === 'ocr'
                    ? { full_text: '', lines: [] }
                    : f === 'layout'
                      ? { regions: [] }
                      : f === 'semantics'
                        ? { scene: '', intent: '', entities: [], relations: [] }
                        : f === 'visual'
                          ? { dominant_colors: [], style: '', notes: [] }
                          : f === 'uncertainty'
                            ? []
                            : '';
        }
    }
    return result;
}

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
        body.response_format = { type: 'json_object' };
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
    const missing = missingSchemaFields(parsed);
    let normalized = parsed;
    if (missing.length > 0) {
        // 兼容网关 + qwen-vl 系列模型常不按 vision schema 返回字段名（自由 JSON）。
        // 容错归一：把可用信息归纳成 vision 结构，不丢内容、不抛错，附 warning。
        normalized = normalizeLooseVision(parsed, missing);
    }
    return {
        result: normalizeVisionResult(normalized),
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
    visionDefaultModel: QWEN_VISION_DEFAULT_MODEL,
    execute: executeQwenApi,
};
