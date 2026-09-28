// providers/claude-cli.js — Claude Code CLI 适配
//
// 契约（保持）：claude -p <prompt> --output-format json
// --json-schema <schema> --allowedTools Read --model <m>；
// 输出解析 envelope（is_error/subtype/structured_output/result）。

import * as path from 'path';

import { buildVisionPrompt, visionResultSchemaJson } from '../schema.js';
import { extractJson, parseJsonLoose, truncate } from '../util.js';

export const CLAUDE_CLI_DEFAULT_MODEL = 'haiku';

export function buildClaudeCliInvocation(options) {
    if (options.imageKind === 'remote') {
        throw new Error('claude-cli provider reads local files only. Download the image first, or use -p gemini-api for remote URLs.');
    }
    const prompt = buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'local', extraPrompt: options.extraPrompt });
    const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--json-schema',
        visionResultSchemaJson(),
        '--allowedTools',
        'Read',
        '--model',
        options.model || options.settings?.model || CLAUDE_CLI_DEFAULT_MODEL,
    ];
    return {
        command: options.providerBin || 'claude',
        args,
        cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
    };
}

export function parseClaudeCliOutput(stdout) {
    const envelope = parseEnvelope(stdout);
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success')) {
        throw new Error(`Claude CLI reported ${envelope.subtype ?? 'an error'}: ${truncate(envelope.result ?? '')}`);
    }
    if (envelope.structured_output === undefined && (typeof envelope.result !== 'string' || !envelope.result.trim())) {
        throw new Error('Claude CLI output contains no result. Check login state (run: claude).');
    }
    const result = envelope.structured_output ?? (typeof envelope.result === 'string' ? extractJson(envelope.result) : null);
    if (result === null || result === undefined) {
        throw new Error(`Claude CLI returned non-JSON result: ${truncate(envelope.result ?? '')}`);
    }
    return {
        result,
        meta: {
            conversationId: envelope.session_id ?? null,
            durationSeconds: typeof envelope.duration_ms === 'number' ? envelope.duration_ms / 1000 : null,
            usage: envelope.usage ?? null,
        },
    };
}

function parseEnvelope(stdout) {
    const parsed = parseJsonLoose(stdout);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Failed to parse Claude CLI JSON output.');
    }
    return parsed;
}

export const claudeCliProvider = {
    name: 'claude-cli',
    defaultModel: CLAUDE_CLI_DEFAULT_MODEL,
    buildInvocation: buildClaudeCliInvocation,
    parseOutput: parseClaudeCliOutput,
    isolateWorkdir: true,
};
