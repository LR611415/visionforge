// providers/antigravity.js — Antigravity CLI 适配
//
// 契约（保持）：agy -p <prompt> --dangerously-skip-permissions
// --output-format json --json-schema <schema> --model <m> --print-timeout <Ns>；
// 失败时读 ~/.gemini/antigravity-cli/log 最近日志归类（quota / keyring / 空转）。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildVisionPrompt, visionResultSchemaJson } from '../schema.js';
import { ApiKeyFailureError, parseJsonLoose, parseResetDuration, truncate, tryParseJson } from '../util.js';

const DEFAULT_MODEL = 'gemini-3.6-flash-low';

const SWITCH_HINT = `Or switch to a provider with its own quota and no interactive login:
  visionforge config set gemini-api.apiKey <key>   # free key, no card: https://aistudio.google.com
  visionforge config set provider gemini-api`;

export function buildAntigravityInvocation(options) {
    const prompt = buildVisionPrompt({ imageSource: options.imageSource, imageKind: options.imageKind, extraPrompt: options.extraPrompt });
    const printTimeout = `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`;
    const args = [
        '-p',
        prompt,
        // 没有这个开关，print 模式会静默跳过工具调用，agent 永远读不到图。
        '--dangerously-skip-permissions',
        '--output-format',
        'json',
        '--json-schema',
        visionResultSchemaJson(),
        '--model',
        options.model || DEFAULT_MODEL,
        '--print-timeout',
        printTimeout,
    ];
    const cwd = options.workdir || (options.imageKind === 'local' ? path.dirname(options.imageSource) : os.tmpdir());
    return { command: options.providerBin || 'agy', args, cwd: path.resolve(cwd) };
}

export function parseAntigravityOutput(stdout) {
    const envelope = parseEnvelope(stdout);
    if (envelope.status && envelope.status !== 'SUCCESS') {
        throw new Error(`Antigravity CLI reported status ${envelope.status}.`);
    }
    const result = envelope.structured_output ?? (typeof envelope.response === 'string' ? tryParseJson(envelope.response) : null);
    if (result === null || result === undefined) {
        throw new Error('Antigravity CLI output contains no structured result. Check that the model finished the task (auth, quota, timeout).');
    }
    return {
        result,
        meta: {
            conversationId: envelope.conversation_id ?? null,
            durationSeconds: envelope.duration_seconds ?? null,
            usage: envelope.usage ?? null,
        },
    };
}

function parseEnvelope(stdout) {
    const parsed = parseJsonLoose(stdout);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Failed to parse Antigravity CLI JSON output.');
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// 失败归类
// ---------------------------------------------------------------------------

const LOG_FRESHNESS_MS = 2 * 60 * 1000;

function agyLogDir() {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
}

function parseAgyLogTime(line, now = new Date()) {
    const match = /\b[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
    if (!match) {
        return null;
    }
    const [, month, day, hour, minute, second, fraction] = match;
    const stamp = new Date(
        now.getFullYear(),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        fraction ? Number(fraction.slice(0, 3)) : 0,
    ).getTime();
    return stamp - now.getTime() > 24 * 60 * 60 * 1000 ? new Date(new Date(stamp).setFullYear(now.getFullYear() - 1)).getTime() : stamp;
}

function readRecentAgyLog(since) {
    try {
        const dir = agyLogDir();
        const newest = fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.log'))
            .map((name) => {
                const full = path.join(dir, name);
                return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime)[0];
        if (!newest || newest.mtime < since) {
            return '';
        }
        const recent = fs
            .readFileSync(newest.full, 'utf-8')
            .slice(-64 * 1024)
            .split('\n')
            .filter((line) => {
                const stamp = parseAgyLogTime(line);
                return stamp !== null && stamp >= since;
            });
        return recent.join('\n');
    } catch {
        return '';
    }
}

export function describeAntigravityFailure(context) {
    const since = context.startedAt ?? Date.now() - LOG_FRESHNESS_MS;
    let envelope = null;
    try {
        envelope = parseEnvelope(context.stdout);
    } catch {
        envelope = null;
    }
    if (!envelope) {
        return null;
    }
    const agyError = typeof envelope?.error === 'string' ? envelope.error.trim() : '';
    const evidence = `${agyError}\n${context.stderr}\n${readRecentAgyLog(since)}`.toLowerCase();
    if (evidence.includes('quota')) {
        const text = [
            agyError || 'Antigravity CLI reported a quota error.',
            "agy's free tier is one weekly bucket shared by the desktop app, the CLI, and the SDK, and subagents drain it in parallel. Wait for the reset shown above, or use a different provider.",
            SWITCH_HINT,
        ].join('\n\n');
        const resetSource = `${agyError}\n${context.stderr}\n${readRecentAgyLog(since)}`;
        return new ApiKeyFailureError(text, {
            quotaCooldown: 'default',
            resetAfterMs: parseResetDuration(resetSource) ?? parseResetDuration(text),
        });
    }
    if (
        evidence.includes('not logged into antigravity') ||
        evidence.includes('getting token source') ||
        evidence.includes('keyring') ||
        evidence.includes('failed to read token store')
    ) {
        return [
            'Antigravity CLI cannot read its stored login token.',
            'On Linux this usually means the OS keyring is locked, which is normal for headless sessions (agents, cron, systemd, SSH without a desktop login). agy then reports it as being signed out and tries a browser sign-in that cannot complete without a display. Unlock the keyring, or run visionforge from a desktop session, or sign in again with `agy`.',
            SWITCH_HINT,
        ].join('\n\n');
    }
    const totalTokens = envelope?.usage?.total_tokens;
    if (agyError || totalTokens === 0) {
        return [
            agyError || 'Antigravity CLI exited before doing any work (no tokens consumed).',
            `Usually auth or quota. Check \`agy\` interactively, and look at the newest log in ${agyLogDir()} for the real reason.`,
            SWITCH_HINT,
        ].join('\n\n');
    }
    return null;
}

export const antigravityCliProvider = {
    name: 'antigravity-cli',
    defaultModel: DEFAULT_MODEL,
    buildInvocation: buildAntigravityInvocation,
    parseOutput: parseAntigravityOutput,
    describeFailure: describeAntigravityFailure,
    hasInternalTimeout: true,
    isolateWorkdir: true,
};
