#!/usr/bin/env node
// index.js — CLI 入口（命令面为契约层：analyze/generate/edit/recover-paste/guard/doctor/config/state）
//
// 方案 A 安全区自研重写，行为契约与 dist L6006-6281 对齐。
// 版本号在此统一声明，替换上游残留的 "3.26.3"。

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'node:readline';
import { Command } from 'commander';

import { analyzeImage } from './analyze.js';
import { buildCooldownController, clearAllCooldowns, currentStatePath } from './cooldown.js';
import {
    canonicalizeName,
    checkNameConflicts,
    GEN_FAMILIES,
    READ_FAMILIES,
    readCustomProviders,
    suggestBuiltinName,
    suggestFamilyFromBaseUrl,
} from './custom-providers.js';
import { buildDoctorReport, renderDoctorReport } from './doctor.js';
import { runGuard } from './guard.js';
import { editImage, generateImage } from './imagegen.js';
import { listProviders } from './providers/index.js';
import { recoverPastedImages } from './recover-paste.js';
import {
    CONFIG_PATH,
    initConfigFile,
    loadConfigFile,
    persistConfig,
    renderEffectiveConfig,
    saveProviderBundle,
    setConfigValue,
    useProviderBundle,
} from './config.js';
import { parseExtraBody } from './util.js';

const VERSION = '0.1.9';

function parsePositiveInt(raw, flag) {
    if (!/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) <= 0) {
        throw new Error(`Invalid ${flag}. Use a positive integer.`);
    }
    return Number.parseInt(raw, 10);
}

async function readSecret(promptText, stdin = process.stdin, stderr = process.stderr) {
    if (!stdin.isTTY) {
        stdin.setEncoding('utf8');
        let data = '';
        for await (const chunk of stdin) {
            data += chunk;
            if (data.includes('\n')) {
                break;
            }
        }
        const value = data.split('\n')[0].trim();
        if (value === '') {
            throw new Error('no key arrived on stdin (pipe one line, or run on a terminal)');
        }
        return value;
    }
    const rl = readline.createInterface({ input: stdin, output: stderr, terminal: true });
    const muted = rl;
    stderr.write(promptText);
    muted._writeToOutput = () => {};
    try {
        const value = await new Promise((resolve, reject) => {
            let settled = false;
            const settle = (action) => {
                if (!settled) {
                    settled = true;
                    action();
                }
            };
            rl.question('', (answer) => settle(() => resolve(answer)));
            rl.on('SIGINT', () => settle(() => reject(new Error('cancelled, nothing was saved'))));
            rl.on('close', () => settle(() => reject(new Error('input ended before a key was entered'))));
        });
        const trimmed = value.trim();
        if (trimmed === '') {
            throw new Error('no key entered');
        }
        return trimmed;
    } finally {
        stderr.write('\n');
        rl.close();
    }
}

const program = new Command();
program.name('visionforge').description('Plug-in vision for text-only LLMs: image in, structured JSON evidence out').version(VERSION);

program
    .command('analyze', { isDefault: true })
    .description('Analyze an image into structured JSON evidence (default command)')
    .requiredOption('-i, --input <path|url>', 'Input image path or https URL')
    .option('-o, --output <path>', 'Write result JSON to a file')
    .option('-m, --model <name>', 'Provider model name')
    .option('-p, --provider <name>', `Vision provider (${listProviders().join(', ')})`)
    .option('--prompt <text>', 'Extra focus for this image')
    .option('--timeout <ms>', 'Provider timeout in milliseconds', '180000')
    .option('--provider-bin <path>', 'Provider binary path (default: agy)')
    .option('--workdir <path>', 'Working directory for the provider')
    .option('--extra-body <json>', `JSON merged into the API request body, e.g. '{"thinking":{"type":"disabled"}}'`)
    .action(async (options) => {
        try {
            const timeoutMs = parsePositiveInt(options.timeout, '--timeout (milliseconds)');
            const config = loadConfigFile();
            if (process.env.VISIONFORGE_MODEL?.trim()) {
                const verdict = runGuard(config.guards, {
                    cwd: process.cwd(),
                    env: process.env,
                });
                if (verdict.guard === 'deny' && verdict.model) {
                    const cause = verdict.matched
                        ? `matches guards.denyModels pattern "${verdict.matched}". A model with native vision should read the image itself.`
                        : 'is not on guards.allowModels, which only lets listed models run the engine.';
                    throw new Error(`Invocation guard denied this read: active model "${verdict.model}" ${cause} To override, unset VISIONFORGE_MODEL or edit guards in ${CONFIG_PATH}.`);
                }
            }
            const result = await analyzeImage({
                input: options.input,
                provider: options.provider,
                model: options.model,
                prompt: options.prompt,
                timeoutMs,
                providerBin: options.providerBin,
                workdir: options.workdir,
                extraBody: options.extraBody ? parseExtraBody(options.extraBody, '--extra-body') : undefined,
                config,
                cooldown: buildCooldownController(config),
            });
            const output = JSON.stringify(result, null, 2);
            if (options.output) {
                const outputPath = path.resolve(options.output);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, output, 'utf-8');
            }
            process.stdout.write(`${output}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

program
    .command('generate')
    .description('Generate an image from text (Qwen-Image via qwen key, or GLM-Image via glm key). Requires at least one image-generation key: qwen.apiKey or glm.apiKey.')
    .requiredOption('-p, --prompt <text>', 'Text description of the image to generate')
    .option('-o, --output <path>', 'Save the image to this path (default: ~/.visionforge/out/ with a timestamped name)')
    .option('--size <wxh>', 'Output size: 4k / 2.5k / 2k / 1080p / WxH (default: engine-best 2048x2048)')
    .option('-m, --model <name>', 'Generation model name (default: qwen-image or glm-image)')
    .option('-e, --engine <name>', 'Force the provider: qwen, glm, or a custom engine id (default: qwen if configured, else glm)')
    .option('--provider <name>', 'Alias of --engine')
    .option('--timeout <ms>', 'Provider timeout in milliseconds', '120000')
    .action(async (options) => {
        try {
            const timeoutMs = parsePositiveInt(options.timeout, '--timeout (milliseconds)');
            const result = await generateImage({
                prompt: options.prompt,
                size: options.size,
                output: options.output,
                model: options.model,
                provider: options.provider ?? options.engine,
                config: loadConfigFile(),
                timeoutMs,
            });
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

program
    .command('edit')
    .description('Edit an existing image from a text instruction (Qwen-Image edit only; GLM-Image does not support editing). Requires the qwen key.')
    .requiredOption('-i, --input <path|url...>', 'Input image path(s) or https URL(s) to edit (1-3, space-separated)')
    .requiredOption('-p, --prompt <text>', 'Editing instruction')
    .option('-o, --output <path>', 'Save the edited image(s) to this path (default: ~/.visionforge/out/ with a timestamped name; for multiple outputs only the first is saved here)')
    .option('-n, --count <n>', 'Number of images to output (1-6, default 1)', '1')
    .option('--size <wxh>', 'Output size: 4k / 2.5k / 2k / 1080p / WxH (default: engine-best 2048x2048)')
    .option('-m, --model <name>', 'Editing model name (default: qwen-image-edit)')
    .option('-e, --engine <name>', 'Force the provider: qwen or a custom engine id (default: qwen)')
    .option('--provider <name>', 'Alias of --engine')
    .option('--no-enhance', 'Disable automatic edit-prompt enhancement (protective constraints)')
    .option('--timeout <ms>', 'Provider timeout in milliseconds', '120000')
    .action(async (options) => {
        try {
            const timeoutMs = parsePositiveInt(options.timeout, '--timeout (milliseconds)');
            const count = parsePositiveInt(options.count, '--count');
            const result = await editImage({
                prompt: options.prompt,
                input: options.input,
                count,
                size: options.size,
                output: options.output,
                model: options.model,
                provider: options.provider ?? options.engine,
                enhance: options.enhance !== false,
                config: loadConfigFile(),
                timeoutMs,
            });
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

program
    .command('recover-paste')
    .description('Recover images pasted into Claude Code, Pi, or OpenCode from local session storage (they never hit disk otherwise)')
    .option('--count <n>', 'How many recent pasted images to recover', '1')
    .option('--out-dir <path>', 'Directory to write recovered images to')
    .option('--session <id>', 'Claude Code session id for exact targeting (skills get it via ${CLAUDE_CODE_SESSION_ID})')
    .option('--transcript <path>', 'Explicit transcript .jsonl or .db (overrides --session)')
    .option('--harness <name>', 'Force the storage scope: claude-code, pi, opencode, or none (default: auto-detect via process ancestry and env)')
    .option('--cwd <path>', 'Project directory the image was pasted in', process.cwd())
    .action(async (options) => {
        try {
            const count = parsePositiveInt(options.count, '--count');
            const result = recoverPastedImages({
                count,
                outDir: options.outDir,
                transcript: options.transcript,
                session: options.session,
                cwd: options.cwd,
                harness: options.harness,
            });
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

program
    .command('guard')
    .description('Check whether the vision engine should run for the active model (exit 0 allow, 1 deny, 2 error)')
    .option('--model <name>', "The calling agent's own model name; weakest signal, used when env and session storage say nothing")
    .option('--cwd <path>', 'Project directory of the session', process.cwd())
    .action((options) => {
        try {
            const verdict = runGuard(loadConfigFile().guards, {
                cwd: options.cwd,
                env: process.env,
                selfReported: options.model,
            });
            process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
            process.exitCode = verdict.guard === 'deny' ? 1 : 0;
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 2;
        }
    });

program
    .command('doctor')
    .description('Diagnose local config and routing (Node, providers, selection, harness) without spending quota or hitting the network')
    .option('--json', 'Emit the report as JSON')
    .option('--uninstall-check', 'List every local footprint the plugin leaves behind (config, cache, dsh installs) for a clean uninstall')
    .option('-p, --provider <name>', 'Show which provider this -p value would select')
    .action((options) => {
        try {
            const report = buildDoctorReport({
                config: loadConfigFile(),
                env: process.env,
                providerFlag: options.provider,
                uninstallCheck: options.uninstallCheck === true,
                configPath: CONFIG_PATH,
                // 让 doctor 能点名比当前 CLI 更旧的已安装 skill 副本。
                version: VERSION,
            });
            const output = options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report);
            process.stdout.write(`${output}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

const config = program.command('config').description(`Manage ${CONFIG_PATH} (providers, keys, models, proxies)`);
config
    .command('init')
    .description(`Create a starter config at ${CONFIG_PATH}`)
    .option('--force', 'Overwrite an existing config file')
    .action((options) => {
        try {
            initConfigFile(CONFIG_PATH, Boolean(options.force));
            process.stdout.write(
                [
                    `Created ${CONFIG_PATH}`,
                    'Everything is optional. The usual ones:',
                    '  visionforge config set provider <name>                      which provider analyzes images',
                    '  visionforge config set cooldown on|off                       quota cooldown (on by default)',
                    '  visionforge config set <provider>.<apiKey|baseUrl|model|proxy> <value>   provider settings',
                    '  visionforge config set openai.proxy ""                  make one API provider connect directly',
                    `  visionforge config set <provider>.extraBody '{"thinking":{"type":"disabled"}}'   vendor request fields`,
                    '',
                ].join('\n'),
            );
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('save <slot> <label>')
    .description('Snapshot a provider slot under a label (openai only), so switching gateways never loses a key')
    .action((slot, label) => {
        try {
            const replaced = saveProviderBundle(slot, label);
            process.stdout.write(
                replaced
                    ? `Saved the ${slot} slot as "${label}", replacing the previous snapshot (${CONFIG_PATH})\n`
                    : `Saved the ${slot} slot as "${label}" in ${CONFIG_PATH}\n`,
            );
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('use <slot> <label>')
    .description('Replace a provider slot with a saved copy, whole. Refuses to drop unsaved settings without --discard')
    .option('--discard', 'Overwrite the current slot even though it is not saved under any label')
    .action((slot, label, options) => {
        try {
            useProviderBundle(slot, label, Boolean(options.discard));
            process.stdout.write(`The ${slot} slot now holds "${label}" (${CONFIG_PATH})\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('set <key> [value]')
    .description('Set a value. Omit the value for an apiKey to enter it at a hidden prompt (out of argv and shell history), or to read one piped line (out of argv; the command feeding the pipe is yours to keep out of history)')
    .action(async (key, value) => {
        try {
            let resolved = value;
            if (resolved === undefined) {
                if (!key.endsWith('.apiKey')) {
                    throw new Error(`${key} needs a value: visionforge config set ${key} <value>`);
                }
                resolved = await readSecret(`${key} (input hidden): `);
            }
            setConfigValue(key, resolved);
            process.stdout.write(`Saved ${key} to ${CONFIG_PATH}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('show')
    .description('Print the effective config (file merged with env vars), credentials masked')
    .action(() => {
        try {
            process.stdout.write(`${renderEffectiveConfig(loadConfigFile())}\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('add-engine <name>')
    .description(
        'Add a custom engine (Google Gemini, Imagen, or any vendor). The name is normalized automatically; built-in names are refused. Configure its key and models now or later in the DSH settings card.',
    )
    .requiredOption('--base-url <url>', 'Engine API base URL (e.g. https://generativelanguage.googleapis.com)')
    .option('--api-key <key>', 'API key (optional: leave it out and fill it in the settings card later)')
    .option('--display-name <name>', 'Display name shown in the UI (defaults to the engine id)')
    .option('--read-family <family>', `Vision request format (${READ_FAMILIES.join(', ')}; default: openai-compatible)`)
    .option('--gen-family <family>', `Image generation format (${GEN_FAMILIES.join(', ')}; omit to disable generation)`)
    .option('--model <name>', 'Default vision model (optional: fill it in the settings card later)')
    .option('--gen-model <name>', 'Image generation model (optional; enables generation when set)')
    .action(async (name, options) => {
        try {
            const id = canonicalizeName(name);
            const conflict = checkNameConflicts(id, loadConfigFile());
            if (conflict) {
                throw new Error(conflict.message);
            }
            const suggestion = suggestBuiltinName(id);
            if (suggestion && suggestion.suggestion !== id) {
                process.stdout.write(
                    `提示：「${name}」与内置引擎「${suggestion.folded}」拼写相近（编辑距离 ${suggestion.distance}）。如需使用内置引擎，请配置其字段而非新增；确认新增同名引擎可继续。\n`,
                );
            }
            const domainHint = suggestFamilyFromBaseUrl(options.baseUrl);
            const readFamily = options.readFamily || domainHint.family || 'openai-compatible';
            if (!options.readFamily && domainHint.family) {
                process.stdout.write(`已按接口域名识别读图协议族：${readFamily}（可用 --read-family 覆盖）\n`);
            }
            if (options.readFamily && !READ_FAMILIES.includes(options.readFamily)) {
                throw new Error(`Unknown --read-family: ${options.readFamily}. Use ${READ_FAMILIES.join(', ')}.`);
            }
            if (options.genFamily && !GEN_FAMILIES.includes(options.genFamily)) {
                throw new Error(`Unknown --gen-family: ${options.genFamily}. Use ${GEN_FAMILIES.join(', ')}.`);
            }
            const config = loadConfigFile();
            config.customProviders ??= {};
            const models = [];
            if (options.model) {
                models.push({ name: options.model, capabilities: { read: true, generate: false, edit: false } });
            }
            if (options.genModel) {
                models.push({ name: options.genModel, capabilities: { read: false, generate: true, edit: false } });
            }
            config.customProviders[id] = {
                displayName: options.displayName || id,
                baseUrl: options.baseUrl,
                ...(options.apiKey ? { apiKey: options.apiKey } : {}),
                readFamily,
                ...(options.genFamily ? { genFamily: options.genFamily } : options.genModel ? { genFamily: 'openai-image' } : {}),
                ...(models.length > 0 ? { models } : {}),
                ...(options.model ? { model: options.model } : {}),
            };
            persistConfig(config);
            process.stdout.write(
                [
                    `已添加自定义引擎「${id}」（显示名：${options.displayName || id}）到 ${CONFIG_PATH}`,
                    `  读图协议族: ${readFamily}${options.genFamily || options.genModel ? `；生图协议族: ${options.genFamily || (options.genModel ? 'openai-image' : '')}` : '（未启用生图）'}`,
                    options.apiKey ? '  API key: 已保存' : '  API key: 未配置 → 在 DSH 设置卡片或运行 visionforge config set custom.<name>.apiKey 填写',
                    options.model ? `  视觉模型: ${options.model}` : '  视觉模型: 未配置 → 在设置卡片或 config set custom.<name>.model 填写',
                    `  查看: visionforge config show / doctor；删除: visionforge config remove-engine ${id}`,
                ].join('\n') + '\n',
            );
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('remove-engine <name>')
    .description('Remove a custom engine you added. Built-in engines cannot be removed.')
    .action((name) => {
        try {
            const id = canonicalizeName(name);
            const config = loadConfigFile();
            const customs = readCustomProviders(config);
            if (!Object.hasOwn(customs, id)) {
                const conflict = checkNameConflicts(id, config);
                throw new Error(
                    conflict?.kind === 'builtin'
                        ? `「${name}」是内置引擎，不能删除。`
                        : `自定义引擎「${id}」不存在。运行 visionforge config list-custom 查看现有引擎。`,
                );
            }
            delete config.customProviders[id];
            if (config.provider === id) {
                config.provider = '';
            }
            persistConfig(config);
            process.stdout.write(`已删除自定义引擎「${id}」（${CONFIG_PATH}）。若已设为默认引擎，provider 已重置为空。\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

config
    .command('list-custom')
    .description('List custom engines you added, with their read/generate families')
    .action(() => {
        try {
            const customs = readCustomProviders(loadConfigFile());
            const names = Object.keys(customs);
            if (names.length === 0) {
                process.stdout.write('（暂无自定义引擎。用 visionforge config add-engine <name> --base-url <url> 添加。）\n');
                return;
            }
            process.stdout.write(
                names
                    .map((id) => {
                        const entry = customs[id];
                        const caps = ['read', 'generate', 'edit'].filter((c) => entry.capabilities[c] || entry.models.some((m) => m.capabilities[c]));
                        return `- ${id} (${entry.displayName}): read=${entry.readFamily}${entry.genFamily ? `, generate=${entry.genFamily}` : ''}; ${caps.join('/') || 'read'}; ${entry.apiKey ? 'key 已配置' : 'key 未配置'}${entry.model ? `; model=${entry.model}` : '; model 未配置'}`;
                    })
                    .join('\n') + '\n',
            );
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

// 1×1 PNG（透明），用于引擎连通性测试
function tinyPlaceholderPng() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
    );
}

config
    .command('test <engine>')
    .description('Test a custom engine end to end: upload a tiny placeholder image, read it back, report the result. Spends a negligible amount of quota.')
    .option('--model <name>', 'Model to test (default: the engine model)')
    .option('--timeout <ms>', 'Provider timeout in milliseconds', '180000')
    .action(async (engine, options) => {
        let tempPath = null;
        try {
            const timeoutMs = parsePositiveInt(options.timeout, '--timeout (milliseconds)');
            const config = loadConfigFile();
            const customs = readCustomProviders(config);
            const id = canonicalizeName(engine);
            if (!Object.hasOwn(customs, id)) {
                throw new Error(`自定义引擎「${id}」不存在。运行 visionforge config list-custom 查看现有引擎。`);
            }
            tempPath = path.join(process.cwd(), `.visionforge-test-${Date.now()}.png`);
            fs.writeFileSync(tempPath, tinyPlaceholderPng());
            const startedAt = Date.now();
            const result = await analyzeImage({
                input: tempPath,
                provider: id,
                model: options.model,
                config,
                cooldown: buildCooldownController(config),
                timeoutMs,
            });
            process.stdout.write(
                `${JSON.stringify(
                    {
                        ok: true,
                        engine: id,
                        provider: result.provider,
                        model: result.meta.model,
                        durationSeconds: result.meta.durationSeconds,
                        summary: result.result.summary?.slice(0, 200) ?? '',
                        usage: result.meta.usage ?? null,
                        elapsedMs: Date.now() - startedAt,
                    },
                    null,
                    2,
                )}\n`,
            );
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        } finally {
            if (tempPath) {
                try {
                    fs.unlinkSync(tempPath);
                } catch {
                }
            }
        }
    });

const state = program.command('state').description('Manage the quota cooldown state at ~/.visionforge/state.json');
state
    .command('clear')
    .description('Forget every provider cooldown, so all providers are tried at full priority again')
    .action(() => {
        try {
            const statePath = currentStatePath();
            clearAllCooldowns(statePath);
            process.stdout.write(`Cleared cooldown state (${statePath}).\n`);
        } catch (error) {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    });

await program.parseAsync(process.argv, { from: 'node' });
