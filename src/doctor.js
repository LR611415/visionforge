// doctor.js — 本地体检：引擎可用性、failover 链、guard 判定、复用授权、配置与冷却状态
//
// 自研实现（方案 A 安全区），行为契约与 dist L5102-5471 对齐：
// 纯本地诊断，不发网络请求、不消耗任何引擎配额。

import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_PATH, REUSE_HARNESSES, assertReadableConfig, cooldownEnabled, knownApiKeys } from './config.js';
import { currentStatePath, loadCooldownState, parseCooldownStateKey, coolingEntry } from './cooldown.js';
import { readCustomProviders } from './custom-providers.js';
import { allowPatterns, denyPatterns, detectActiveModel, evaluateGuard } from './guard.js';
import { composeChain } from './analyze.js';
import { PROVIDER_DESCRIPTORS, findOnPath, resolveProvider } from './providers/index.js';
import { providerConfiguredInFile, resolveProviderSettings } from './config-resolve.js';
import { detectHarnessDetailed } from './recover-paste.js';
import { discoverAuto } from './reuse.js';
import { redactSecrets, splitApiKeys } from './util.js';

const SKILL_DIRS = [
    ['claude-code', '.claude/skills'],
    ['codex', '.codex/skills'],
    ['pi/opencode', '.agents/skills'],
    ['dsh', '.dsh/skills'],
];

const MIN_NODE = '22.19';

function versionParts(version) {
    const match = /(\d+)\.(\d+)/.exec(version.replace(/^v/, ''));
    if (!match) {
        return [0, 0];
    }
    return [Number(match[1]), Number(match[2])];
}

function meetsMinimum(version, minimum) {
    const [major, minor] = versionParts(version);
    const [minMajor, minMinor] = versionParts(minimum);
    return major > minMajor || (major === minMajor && minor >= minMinor);
}

function isOlder(pinned, current) {
    const parse = (v) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const [pa, pb, pc] = parse(pinned);
    const [ca, cb, cc] = parse(current);
    if (pa !== ca) {
        return pa < ca;
    }
    if (pb !== cb) {
        return pb < cb;
    }
    return pc < cc;
}

function readPinnedVersion(launcher) {
    return /^PINNED="([^"]+)"/m.exec(launcher)?.[1] ?? null;
}

function findSkillInstalls(currentVersion, home = os.homedir(), skillName = 'visionforge') {
    const installs = [];
    for (const [harness, relative] of SKILL_DIRS) {
        const launcher = path.join(home, relative, skillName, 'scripts', 'run.sh');
        let text;
        try {
            text = fs.readFileSync(launcher, 'utf-8');
        } catch {
            continue;
        }
        const pinned = readPinnedVersion(text);
        installs.push({
            harness,
            path: launcher,
            pinned,
            outdated: pinned !== null && isOlder(pinned, currentVersion),
        });
    }
    return installs;
}

function chainEntryName(provider) {
    return provider.reuseNote ? `${provider.name} (reused)` : provider.name;
}

function checkNodeSqlite() {
    const realEmit = process.emitWarning;
    process.emitWarning = () => {};
    try {
        const mod = createRequire(import.meta.url)('node:sqlite');
        if (mod?.DatabaseSync) {
            return { available: true, detail: 'node:sqlite is available (OpenCode paste recovery)' };
        }
        return { available: false, detail: 'node:sqlite loaded but DatabaseSync is missing' };
    } catch {
        return { available: false, detail: 'node:sqlite unavailable. Upgrade Node to 22.19+ for OpenCode paste recovery' };
    } finally {
        process.emitWarning = realEmit;
    }
}

function inspectProvider(descriptor, config, env) {
    if (descriptor.kind === 'subprocess') {
        const binaryPath = findOnPath(descriptor.bin, env);
        return {
            name: descriptor.name,
            kind: 'subprocess',
            ready: binaryPath !== null,
            status: binaryPath !== null ? 'installed' : 'missing',
            // PATH 上存在只证明装好了，不代表登录态可用：doctor 离线运行、
            // 不花一分钱，所以登录态在此不验证，第一次真实读图才是鉴权检查。
            authUnverified: binaryPath !== null,
            binaryPath,
            detail: binaryPath ? `${descriptor.bin} found at ${binaryPath} (installed; sign-in not verified offline)` : `${descriptor.bin} not on PATH`,
            fix: binaryPath ? undefined : descriptor.install,
        };
    }
    const settings = resolveProviderSettings(descriptor.name, config, env);
    const settingsSource = providerConfiguredInFile(descriptor.name, config) ? 'file' : 'env';
    const statuses = (descriptor.required ?? []).map((req) => {
        if (req.field === 'apiKey') {
            const keys = splitApiKeys(settings.apiKey);
            return {
                field: req.field,
                present: keys.length > 0,
                source: keys.length > 0 ? settingsSource : 'missing',
                ...(keys.length > 0 ? { keyCount: keys.length } : {}),
            };
        }
        const value = settings[req.field]?.trim();
        return {
            field: req.field,
            present: Boolean(value),
            source: value ? settingsSource : 'missing',
        };
    });
    const missing = statuses.filter((s) => !s.present).map((s) => s.field);
    const ready = missing.length === 0;
    const detail = ready
        ? statuses
              .map((s) => {
                  if (s.field === 'apiKey' && s.present && s.keyCount) {
                      return `${s.field}: ${s.source} (${s.keyCount} ${s.keyCount === 1 ? 'key' : 'keys'})`;
                  }
                  return `${s.field}: ${s.source}`;
              })
              .join(', ')
        : `missing: ${missing.join(', ')}`;
    return {
        name: descriptor.name,
        kind: 'api',
        ready,
        status: ready ? 'ready' : 'missing',
        settings: statuses,
        detail,
        fix: ready ? undefined : descriptor.fix,
    };
}

function inspectCustomProvider(entry) {
    const keys = splitApiKeys(entry.apiKey);
    const hasKey = keys.length > 0;
    const hasBase = Boolean(entry.baseUrl?.trim());
    const ready = hasKey && hasBase;
    const caps = ['read', 'generate', 'edit'].filter((c) => entry.capabilities[c] || entry.models.some((m) => m.capabilities[c]));
    return {
        name: entry.id,
        displayName: entry.displayName,
        kind: 'custom',
        ready,
        status: ready ? 'ready' : 'missing',
        settings: [
            { field: 'baseUrl', present: hasBase, source: hasBase ? 'file' : 'missing' },
            { field: 'apiKey', present: hasKey, source: hasKey ? `file (${keys.length} ${keys.length === 1 ? 'key' : 'keys'})` : 'missing' },
            { field: 'readFamily', present: true, source: entry.readFamily },
        ],
        detail: ready
            ? `custom engine "${entry.displayName}" (read: ${entry.readFamily}${entry.genFamily ? `, generate: ${entry.genFamily}` : ''}; ${caps.join('/') || 'read'}) @ ${entry.baseUrl}`
            : `missing: ${[!hasBase && 'baseUrl', !hasKey && 'apiKey'].filter(Boolean).join(', ')}`,
        fix: ready
            ? undefined
            : `visionforge config set custom.${entry.id}.baseUrl <url> and custom.${entry.id}.apiKey (hidden prompt)`,
    };
}

function resolveSelection(config, providerFlag) {
    const raw = providerFlag?.trim() || config.provider?.trim() || 'antigravity-cli';
    const source = providerFlag?.trim() ? 'flag' : config.provider?.trim() ? 'config' : 'default';
    let canonical;
    try {
        canonical = resolveProvider(raw, config).name;
    } catch {
        canonical = null;
    }
    const reason =
        source === 'flag'
            ? `-p ${raw} on the command line`
            : source === 'config'
              ? 'provider set in the config file'
              : 'built-in default (no -p flag and no provider in the config file)';
    return { provider: raw, canonical, source, reason };
}

function inspectConfigFile(configPath) {
    try {
        const stat = fs.statSync(configPath);
        const mode = stat.mode & 511;
        const enforcesPosixPerms = typeof process.getuid === 'function';
        const permissionsOk = !enforcesPosixPerms || (mode & 63) === 0;
        return {
            path: configPath,
            exists: true,
            mode: mode.toString(8).padStart(3, '0'),
            permissionsOk,
            note: permissionsOk ? undefined : 'group/world can read this file. Run: chmod 600 to lock it down',
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                path: configPath,
                exists: false,
                mode: null,
                permissionsOk: true,
                note: 'no config file (using env vars and built-in defaults)',
            };
        }
        return {
            path: configPath,
            exists: true,
            mode: null,
            permissionsOk: false,
            note: `cannot stat: ${error.message}`,
        };
    }
}

function formatRemaining(ms) {
    if (ms <= 0) {
        return '0m';
    }
    const totalMinutes = Math.round(ms / 6e4);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function diagnoseCooldown(config, statePath, now, env) {
    if (!cooldownEnabled(config)) {
        return { enabled: false, statePath, providers: [] };
    }
    const state = loadCooldownState(statePath);
    const secrets = knownApiKeys(config, env);
    const providers = [];
    for (const stateKey of Object.keys(state.engineCooldowns)) {
        const target = parseCooldownStateKey(stateKey);
        const entry = coolingEntry(state, target.engine, now, target.keyIndex);
        if (entry) {
            providers.push({
                provider: target.engine,
                ...(target.keyIndex === undefined ? {} : { keyIndex: target.keyIndex }),
                until: entry.until,
                remaining: formatRemaining(Date.parse(entry.until) - now.getTime()),
                reason: redactSecrets(entry.reason, secrets).split('\n')[0].slice(0, 120),
            });
        }
    }
    providers.sort((a, b) => a.provider.localeCompare(b.provider) || (a.keyIndex ?? -1) - (b.keyIndex ?? -1));
    return { enabled: true, statePath, providers };
}

function dirStats(dir) {
    let size = 0;
    let count = 0;
    try {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
                const sub = dirStats(full);
                size += sub.size;
                count += sub.count;
            } else {
                size += fs.statSync(full).size;
                count++;
            }
        }
    } catch { /* missing/unreadable dir counts as empty */ }
    return { size, count };
}

/** E2：卸载残留检查 —— 列出插件在本机留下的全部足迹（config/缓存/dsh 安装/env）。 */
export function uninstallFootprint(input = {}) {
    const home = input.home ?? os.homedir();
    const config = input.config ?? {};
    const configDir = path.join(home, '.visionforge');
    const entries = [];
    const add = (label, dir) => {
        let exists = false;
        let size = 0;
        let count = 0;
        try {
            const s = dirStats(dir);
            exists = true;
            size = s.size;
            count = s.count;
        } catch { /* not present */ }
        entries.push({ label, path: dir, exists, count, size });
    };
    add('config dir', configDir);
    const configuredOutput = typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir : '';
    if (process.platform === 'win32') {
        if (configuredOutput) {
            const root = path.dirname(configuredOutput);
            add('output/cache dir (configured)', root);
            add('features dir', path.join(root, 'features'));
        } else {
            add('default cache root (D:\VisionForge)', 'D:\VisionForge');
            add('features dir', path.join('D:\VisionForge', 'features'));
        }
        add('fallback cache root (~/VisionForge)', path.join(home, 'VisionForge'));
    } else {
        add('output dir', path.join(configDir, 'out'));
    }
    // DSH profile 安装足迹（node_modules 包 + package.json 依赖/ bundles 条目）
    const profiles = [];
    try {
        const profilesDir = path.join(home, '.dsh', 'profiles');
        for (const profile of fs.readdirSync(profilesDir, { withFileTypes: true })) {
            if (!profile.isDirectory()) continue;
            const pkgPath = path.join(profilesDir, profile.name, 'package.json');
            let pkg;
            try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { continue; }
            const dependency = Object.keys(pkg.dependencies ?? {}).includes('@lr611/visionforge');
            const bundle = (pkg.dsh?.profile?.bundles ?? []).includes('@lr611/visionforge');
            const installedDir = path.join(profilesDir, profile.name, 'node_modules', '@lr611', 'visionforge');
            const installed = fs.existsSync(installedDir);
            if (dependency || bundle || installed) {
                profiles.push({ profile: profile.name, dependency, bundle, installedDir: installed ? installedDir : null });
            }
        }
    } catch { /* no dsh profiles */ }
    const envVars = Object.keys(input.env ?? process.env).filter((k) => k.startsWith('VISIONFORGE_'));
    return { entries, profiles, envVars };
}

export function buildDoctorReport(input) {
    const env = input.env ?? process.env;
    const configPath = input.configPath ?? CONFIG_PATH;
    const statePath = input.statePath ?? currentStatePath();
    const now = input.now ?? new Date();
    assertReadableConfig(input.config, configPath);
    const harnessDetection = detectHarnessDetailed();
    const guardDetection = detectActiveModel({
        cwd: process.cwd(),
        env,
        harness: harnessDetection.harness,
    });
    const guardVerdict = evaluateGuard(input.config.guards, guardDetection);
    const reuseDiscovery = discoverAuto({ env, fresh: true, ...input.auto });
    const reuseOptions = { env, ...input.auto, discovery: reuseDiscovery };
    const cooldown = cooldownEnabled(input.config) ? { state: loadCooldownState(statePath), now } : undefined;
    return {
        node: {
            version: process.version,
            minimum: MIN_NODE,
            meetsMinimum: meetsMinimum(process.version, MIN_NODE),
        },
        nodeSqlite: checkNodeSqlite(),
        providers: [
            ...PROVIDER_DESCRIPTORS.map((d) => inspectProvider(d, input.config, env)),
            ...Object.values(readCustomProviders(input.config)).map((entry) => inspectCustomProvider(entry)),
        ],
        selection: resolveSelection(input.config, input.providerFlag),
        // 一次运行真正会用的链（含被复用的路由并标注），
        // 这样一台全靠授权登录跑活的机器不会在 Reuse 已授权的情况下被误读成"无引擎"。
        chains: {
            local: composeChain('local', input.config, reuseOptions, cooldown).map(chainEntryName),
            remote: composeChain('remote', input.config, reuseOptions, cooldown).map(chainEntryName),
        },
        harness: { detected: harnessDetection.harness, source: harnessDetection.source },
        skillInstalls: input.version ? findSkillInstalls(input.version, input.home) : [],
        guard: {
            rules: denyPatterns(input.config.guards).length,
            allowRules: allowPatterns(input.config.guards).length,
            denyWhenUnknown: input.config.guards?.denyWhenUnknown ?? false,
            model: guardVerdict.model,
            source: guardVerdict.source,
            verdict: guardVerdict.guard,
            matched: guardVerdict.matched,
            reason: guardVerdict.reason,
        },
        config: inspectConfigFile(configPath),
        cooldown: diagnoseCooldown(input.config, statePath, now, env),
        uninstall: input.uninstallCheck ? uninstallFootprint({ home: input.home, config: input.config, env }) : undefined,
        reuse: {
            decisions: Object.fromEntries(
                REUSE_HARNESSES.map((harness) => {
                    const decision = input.config.reuse?.[harness];
                    const fallback = harness === 'claude' ? 'granted' : 'not asked';
                    return [harness, decision === true ? 'granted' : decision === false ? 'refused' : fallback];
                }),
            ),
            probes: reuseDiscovery.probes,
        },
    };
}

function mark(ok) {
    return ok ? '[ok]' : '[!!]';
}

export function renderDoctorReport(report) {
    const lines = [];
    lines.push('visionforge doctor');
    lines.push('(local diagnostics only: no network calls, no provider quota spent)');
    lines.push('');
    lines.push('Node');
    lines.push(`  ${mark(report.node.meetsMinimum)} ${report.node.version} (minimum ${report.node.minimum})`);
    lines.push(`  ${mark(report.nodeSqlite.available)} ${report.nodeSqlite.detail}`);
    lines.push('');
    lines.push('Providers');
    for (const provider of report.providers) {
        const providerMark = provider.ready && provider.authUnverified ? '[ok?]' : mark(provider.ready);
        lines.push(`  ${providerMark} ${provider.name}: ${provider.detail}`);
        if (provider.fix) {
            lines.push(`       fix: ${provider.fix}`);
        }
    }
    lines.push('');
    lines.push('Selected provider');
    const canonicalNote =
        report.selection.canonical && report.selection.canonical !== report.selection.provider
            ? ` (canonical: ${report.selection.canonical})`
            : report.selection.canonical === null
              ? ' (unknown provider name)'
              : '';
    lines.push(`  ${report.selection.provider}${canonicalNote}`);
    lines.push(`  reason: ${report.selection.reason}`);
    lines.push('');
    lines.push('Failover chains (what a run tries, in order)');
    const chainLine = (chain) => (chain.length > 0 ? chain.join(' -> ') : '(none available)');
    lines.push(`  local:  ${chainLine(report.chains.local)}`);
    lines.push(`  remote: ${chainLine(report.chains.remote)}`);
    lines.push('');
    lines.push('Cooldown');
    if (!report.cooldown.enabled) {
        lines.push('  switch: off (state not consulted)');
    } else if (report.cooldown.providers.length === 0) {
        lines.push('  switch: on');
        lines.push('  no providers are cooling right now');
    } else {
        lines.push('  switch: on');
        for (const c of report.cooldown.providers) {
            const label = c.keyIndex === undefined ? c.provider : `${c.provider} key ${c.keyIndex + 1}`;
            lines.push(`  - ${label.padEnd(16)} cooling, ${c.remaining} left (until ${c.until})`);
            if (c.reason) {
                lines.push(`      reason: ${c.reason}`);
            }
        }
    }
    lines.push('');
    lines.push('Harness');
    lines.push(report.harness.detected ? `  ${report.harness.detected} (via ${report.harness.source})` : `  none detected (${report.harness.source})`);
    lines.push('');
    if (report.skillInstalls.length > 0) {
        lines.push('Installed skill copies (a copy keeps its install-time version)');
        for (const install of report.skillInstalls) {
            const state = install.pinned === null ? 'no pin found' : `pins ${install.pinned}`;
            lines.push(`  ${install.harness}: ${state}${install.outdated ? '  [outdated]' : ''}`);
        }
        if (report.skillInstalls.some((install) => install.outdated)) {
            lines.push('  Refresh an outdated copy by re-running the install: it overwrites in');
            lines.push('  place. See https://github.com/LR611415/visionforge/blob/main/INSTALL.md');
        }
        lines.push('');
    }
    lines.push('Guard (should the vision engine run for the active model?)');
    lines.push(`  rules: ${report.guard.rules} deny pattern(s), ${report.guard.allowRules} allow pattern(s)${report.guard.allowRules > 0 ? ' (allowlist mode)' : ''}, denyWhenUnknown: ${report.guard.denyWhenUnknown}`);
    lines.push(`  active model: ${report.guard.model ?? 'unknown'} (via ${report.guard.source})`);
    lines.push(`  verdict: ${report.guard.verdict}${report.guard.matched ? ` (matched "${report.guard.matched}")` : ''}, ${report.guard.reason}`);
    lines.push('');
    lines.push('Reuse (may visionforge reuse other local logins? config "reuse.<harness>")');
    lines.push(`  decisions: ${Object.entries(report.reuse.decisions).map(([harness, decision]) => `${harness} ${decision}`).join(', ')}`);
    for (const probe of report.reuse.probes) {
        if (!probe.cliFound) {
            lines.push(`  ${probe.harness}: cli not found`);
            continue;
        }
        const parts = [];
        const shown = probe.visionModels.slice(0, 3).join(', ');
        parts.push(probe.visionModels.length === 0 ? 'no vision models' : `${probe.visionModels.length} vision model(s): ${shown}${probe.visionModels.length > 3 ? ', ...' : ''}`);
        if (probe.loggedIn !== undefined) {
            parts.push(probe.loggedIn ? 'logged in' : 'no credentials found');
        }
        parts.push(`via ${probe.source}, ${probe.elapsedMs}ms`);
        if (probe.error) {
            parts.push(`error: ${probe.error}`);
        }
        lines.push(`  ${probe.harness}: ${parts.join(', ')}`);
    }
    lines.push('');
    if (report.uninstall) {
        lines.push('Uninstall footprint (what uninstalling leaves behind)');
        for (const entry of report.uninstall.entries) {
            const size = entry.size >= 1048576 ? `${(entry.size / 1048576).toFixed(1)} MB` : entry.size >= 1024 ? `${(entry.size / 1024).toFixed(1)} KB` : `${entry.size} B`;
            lines.push(`  ${entry.exists ? '[found]' : '[none] '} ${entry.label}: ${entry.path}${entry.exists ? ` (${entry.count} file(s), ${size})` : ''}`);
        }
        if (report.uninstall.profiles.length > 0) {
            lines.push('  dsh profiles:');
            for (const p of report.uninstall.profiles) {
                lines.push(`    - ${p.profile}: dependency=${p.dependency}, bundle=${p.bundle}${p.installedDir ? `, installed dir=${p.installedDir}` : ''}`);
            }
        }
        if (report.uninstall.envVars.length > 0) {
            lines.push(`  env vars: ${report.uninstall.envVars.join(', ')}`);
        }
        lines.push('  To remove everything: delete the entries above (config dir, cache root, and the');
        lines.push('  dsh profile dependency/bundle lines), then restart DSH.');
        lines.push('');
    }
    lines.push('Config file');
    lines.push(`  path: ${report.config.path}`);
    if (report.config.exists) {
        lines.push(`  ${mark(report.config.permissionsOk)} exists, mode ${report.config.mode ?? '?'}`);
    } else {
        lines.push('  not present');
    }
    if (report.config.note) {
        lines.push(`  note: ${report.config.note}`);
    }
    return lines.join('\n');
}
