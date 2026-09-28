// providers/kimi-cli.js — Kimi CLI 适配
//
// 契约（保持）：kimi -p <prompt> --output-format stream-json
// --skills-dir <空目录> [-m <model>]；空 skills 目录是为了防止 kimi
// 反过来加载本插件的 skill 再调用自己，形成环；KIMI_REENTRY_ENV 也是为此。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JSON_TEMPLATE_INSTRUCTION, buildVisionPrompt } from '../schema.js';
import { extractJson, truncate } from '../util.js';

const KIMI_REENTRY_ENV = 'VISIONFORGE_INSIDE_KIMI_CLI';
export const KIMI_CLI_DEFAULT_MODEL = '';

function freshEmptySkillsDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visionforge-kimi-skills-'));
    process.once('exit', () => {
        try {
            fs.rmdirSync(dir);
        } catch {
        }
    });
    return dir;
}

export function buildKimiCliInvocation(options) {
    if (process.env[KIMI_REENTRY_ENV] === '1') {
        throw new Error(
            'kimi-cli refused: this visionforge run was started by kimi itself, so calling kimi again would loop. Pick another provider for the nested read, or let the outer read answer.',
        );
    }
    if (options.imageKind === 'remote') {
        throw new Error('kimi-cli provider reads local files only. Download the image first, or use -p gemini-api for remote URLs.');
    }
    const prompt = `${buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: 'local',
        extraPrompt: options.extraPrompt,
    })}

${JSON_TEMPLATE_INSTRUCTION}`;
    const model = options.model || options.settings?.model;
    const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        // 不是偏好：没有它 kimi 可能加载 visionforge skill 并反过来跑
        // visionforge 读这张图，也就是本进程调用自己。实际观察到此现象，
        // 且是间歇性的——那种最糟。
        '--skills-dir',
        freshEmptySkillsDir(),
        ...(model ? ['-m', model] : []),
    ];
    return {
        command: options.providerBin || 'kimi',
        args,
        cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
        env: { [KIMI_REENTRY_ENV]: '1' },
    };
}

export function parseKimiCliOutput(stdout) {
    let answer = null;
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (entry.role === 'assistant' && typeof entry.content === 'string' && entry.content) {
            answer = entry.content;
        }
    }
    if (answer === null) {
        throw new Error(
            `Kimi CLI produced no answer. Check that it is signed in (run \`kimi\` and /login) and that its model accepts image input. Got: ${truncate(stdout)}`,
        );
    }
    const result = extractJson(answer);
    if (result === null) {
        throw new Error(`Kimi CLI returned non-JSON output: ${truncate(answer)}`);
    }
    return { result, meta: { conversationId: null, durationSeconds: null, usage: null } };
}

export const kimiCliProvider = {
    name: 'kimi-cli',
    defaultModel: KIMI_CLI_DEFAULT_MODEL,
    buildInvocation: buildKimiCliInvocation,
    parseOutput: parseKimiCliOutput,
    // 与 claude-cli 隔离同理：agent 带着真实工具集运行，
    // 给它一个只放着这张图的临时目录。
    isolateWorkdir: true,
};
