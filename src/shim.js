// shim.js — Windows npm / pnpm 批处理 shim 解析（上游保留段）
//
// 本文件按用户拍板的方案 A 原样保留自 liustack/modlens（MIT，
// https://github.com/liustack/modlens，dist/main.js L2668-2987），
// 仅做了模块化封装与注释改写，未改动算法与行为：
// npm/pnpm 装在 Windows 上的可执行文件其实是一个 .cmd 批处理，
// 直接 spawn 它会经过 cmd.exe 的转义，易碎。这里解析批处理内容，
// 提取它真正要运行的程序（shim 目录里的 node.exe 或 PATH 上的 node）
// 与参数，并复刻批处理对 dp0 / PATHEXT / NODE_PATH 的环境修改。
// 高风险区，非本插件能力范围，保留致谢。

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function spawnHidden(command, args, options) {
    return spawn(command, args, { ...options, windowsHide: true });
}

export function execFileSyncHidden(file, args, options) {
    return execFileSync(file, args, { ...options, windowsHide: true });
}

// ---------------------------------------------------------------------------
// Windows 环境工具（大小写不敏感键处理）
// ---------------------------------------------------------------------------

function enumerateEnvKeys(env) {
    const keys = [];
    for (const key in env) {
        keys.push(key);
    }
    return keys;
}

function windowsKeyFor(env, name) {
    const folded = name.toUpperCase();
    return enumerateEnvKeys(env)
        .sort()
        .find((candidate) => candidate.toUpperCase() === folded);
}

function envValue(env, name, platform = process.platform) {
    if (platform !== 'win32') {
        return env[name];
    }
    const key = windowsKeyFor(env, name);
    return key === undefined ? undefined : env[key];
}

function canonicalWindowsEnv(env) {
    const seen = new Set();
    const entries = [];
    for (const key of enumerateEnvKeys(env).sort()) {
        const folded = key.toUpperCase();
        if (seen.has(folded)) {
            continue;
        }
        seen.add(folded);
        const value = env[key];
        if (value !== undefined) {
            entries.push([key, value]);
        }
    }
    return Object.fromEntries(entries);
}

function withWindowsEnvAssignment(env, name, value) {
    const canonical = canonicalWindowsEnv(env);
    const key = windowsKeyFor(canonical, name) ?? name;
    const folded = name.toUpperCase();
    const rest = Object.fromEntries(Object.entries(canonical).filter(([candidate]) => candidate.toUpperCase() !== folded));
    return { ...rest, [key]: value };
}

function withoutWindowsEnvVariable(env, name) {
    const folded = name.toUpperCase();
    return Object.fromEntries(Object.entries(canonicalWindowsEnv(env)).filter(([candidate]) => candidate.toUpperCase() !== folded));
}

// ---------------------------------------------------------------------------
// PATH 解析与 shim 识别
// ---------------------------------------------------------------------------

function existenceOf(target) {
    try {
        return fs.statSync(target).isDirectory() ? 'directory' : 'present';
    } catch (error) {
        return error.code === 'ENOENT' ? 'absent' : 'unknown';
    }
}

function findOnPath(bin, env) {
    const dirs = envValue(env, 'PATH', 'win32')
        .split(path.delimiter)
        .filter(Boolean);
    const suffixes = [...(envValue(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''];
    for (const dir of dirs) {
        for (const suffix of suffixes) {
            const full = path.join(dir, bin + suffix);
            try {
                if (fs.statSync(full).isFile()) {
                    return full;
                }
            } catch {
            }
        }
    }
    return null;
}

function splitWindowsPath(pathValue) {
    const entries = [];
    let current = '';
    let inQuotes = false;
    for (const char of pathValue) {
        if (char === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (char === ';' && !inQuotes) {
            if (current) {
                entries.push(current);
            }
            current = '';
            continue;
        }
        current += char;
    }
    if (current) {
        entries.push(current);
    }
    return entries;
}

const REAL_DEPS = {
    platform: process.platform,
    readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
    resolveOnPath: findOnPath,
    existence: existenceOf,
};

const PATHEXT_EDIT = /^@?SET PATHEXT=%PATHEXT:;\.([A-Z]+);=;%$/;

function withPathextEdit(env, removed) {
    const canonical = canonicalWindowsEnv(env);
    const key = Object.keys(canonical).find((name) => name.toUpperCase() === 'PATHEXT');
    const current = key === undefined ? '' : canonical[key] ?? '';
    const needle = new RegExp(`;\\.${removed};`, 'gi');
    const edited = current.replace(needle, ';');
    if (edited === '') {
        return withoutWindowsEnvVariable(canonical, 'PATHEXT');
    }
    return withWindowsEnvAssignment(canonical, 'PATHEXT', edited);
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function resolveLikeCmd(name, env, cwd, deps) {
    const effectiveEnv = canonicalWindowsEnv(env);
    const exts = (Object.entries(effectiveEnv).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? DEFAULT_PATHEXT)
        .split(';')
        .map((ext) => ext.trim())
        .filter(Boolean);
    const skipCwd = Object.keys(effectiveEnv).some((key) => key.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH');
    const pathValue = Object.entries(effectiveEnv).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    const effectiveCwd = cwd ?? process.cwd();
    const dirs = [...(skipCwd ? [] : [effectiveCwd]), ...splitWindowsPath(pathValue).map((dir) => path.win32.resolve(effectiveCwd, dir))];
    for (const dir of dirs) {
        for (const suffix of [...exts, '']) {
            const candidate = path.win32.join(dir, `${name}${suffix}`);
            const found = deps.existence(candidate);
            if (found === 'unknown') {
                return null;
            }
            if (found === 'present') {
                return /\.(cmd|bat)$/i.test(candidate) ? null : candidate;
            }
        }
    }
    return null;
}

function templatePath(text, shimDir) {
    const rooted = /^%(?:dp0%|~dp0)\\?(.*)$/i.exec(text);
    if (!rooted) {
        return isFullyQualifiedLocalPath(text) && !text.includes('%') ? text : null;
    }
    const rest = rooted[1];
    if (rest.includes('%') || rest === '') {
        return null;
    }
    return path.win32.normalize(path.win32.join(shimDir, rest));
}

function isFullyQualifiedLocalPath(target) {
    return /^[A-Za-z]:[\\/]/.test(target);
}

const FLAG = /^--?[A-Za-z0-9][-A-Za-z0-9._]*(?:=[-A-Za-z0-9._/\\:]+)?$/;

function interpreterTail(middle, shimDir) {
    const tokens = middle.trim().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) {
        return null;
    }
    const quoted = /^"([^"]*)"$/.exec(tokens[tokens.length - 1]);
    if (!quoted) {
        return null;
    }
    const entry = templatePath(quoted[1], shimDir);
    if (entry === null) {
        return null;
    }
    const flags = tokens.slice(0, -1);
    return flags.every((flag) => FLAG.test(flag)) ? [...flags, entry] : null;
}

function nodeRecipe(shimDir, tail2, effective, env, cwd, deps) {
    const local = path.win32.join(shimDir, 'node.exe');
    const found = deps.existence(local);
    if (found === 'unknown') {
        return null;
    }
    if (found === 'present' || found === 'directory') {
        return {
            command: local,
            args: tail2,
            ...(effective.present === env ? {} : { env: effective.present }),
        };
    }
    const resolved = resolveLikeCmd('node', effective.absent, cwd, deps);
    return resolved === null
        ? null
        : {
              command: resolved,
              args: tail2,
              ...(effective.absent === env ? {} : { env: effective.absent }),
          };
}

const NPM_PROLOGUE = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0'];
const NPM_PREFIX = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ';
const NPM_EXEC_LEGACY = /^"%_prog%"(.*)\s%\*$/;
const NPM_EXEC_CURRENT = /^set PATHEXT=%PATHEXT:;\.([A-Z]+);=;% & "%_prog%"(.*)\s%\*$/;
const NPM_NATIVE_EXEC = /^"([^"]*)"\s+%\*$/;
const PNPM_NODE_PATH_IF = /^@IF NOT DEFINED NODE_PATH \($/;
const PNPM_NODE_PATH_SET = /^@SET "NODE_PATH=([^"%]+)"$/;
const PNPM_NODE_PATH_PREPEND = /^@SET "NODE_PATH=([^"%]+);%NODE_PATH%"$/;
const PNPM_IF = /^@IF EXIST "([^"]*)" \($/;
const PNPM_ARM = /^"([^"]*)"(.*)\s%\*$/;
const PNPM_BARE_ARM = /^node(.*)\s%\*$/;
const PNPM_ONELINE = /^@"([^"]*)"(.*)\s%\*$/;

function normalizeLines(content) {
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

function matchNpm(lines, shimDir, env, cwd, deps) {
    if (lines.length < NPM_PROLOGUE.length) {
        return null;
    }
    if (!NPM_PROLOGUE.every((expected, index) => lines[index] === expected)) {
        return null;
    }
    const body = lines.slice(NPM_PROLOGUE.length).filter((line) => line !== '');
    if (body.length === 1) {
        const native = NPM_NATIVE_EXEC.exec(body[0]);
        if (!native) {
            return null;
        }
        const target = templatePath(native[1], shimDir);
        if (target === null || !/\.exe$/i.test(target)) {
            return null;
        }
        const normalizedDir = path.win32.normalize(shimDir);
        const dp0 = normalizedDir.endsWith('\\') ? normalizedDir : `${normalizedDir}\\`;
        return {
            command: target,
            args: [],
            env: withWindowsEnvAssignment(env, 'dp0', dp0),
        };
    }
    if (body[0] !== 'IF EXIST "%dp0%\\node.exe" (') {
        return null;
    }
    if (body[1] !== 'SET "_prog=%dp0%\\node.exe"') {
        return null;
    }
    if (body[2] !== ') ELSE (') {
        return null;
    }
    if (body[3] !== 'SET "_prog=node"') {
        return null;
    }
    if (body.length === 7) {
        if (!PATHEXT_EDIT.test(body[4])) {
            return null;
        }
        if (body[5] !== ')') {
            return null;
        }
        if (!body[6].startsWith(NPM_PREFIX)) {
            return null;
        }
        const exec = NPM_EXEC_LEGACY.exec(body[6].slice(NPM_PREFIX.length));
        if (!exec) {
            return null;
        }
        const tail2 = interpreterTail(exec[1], shimDir);
        return tail2 === null ? null : nodeRecipe(shimDir, tail2, { present: env, absent: env }, env, cwd, deps);
    }
    if (body.length === 6) {
        if (body[4] !== ')') {
            return null;
        }
        if (!body[5].startsWith(NPM_PREFIX)) {
            return null;
        }
        const exec = NPM_EXEC_CURRENT.exec(body[5].slice(NPM_PREFIX.length));
        if (!exec) {
            return null;
        }
        const tail2 = interpreterTail(exec[2], shimDir);
        if (tail2 === null) {
            return null;
        }
        const edited = withPathextEdit(env, exec[1]);
        return nodeRecipe(shimDir, tail2, { present: edited, absent: edited }, env, cwd, deps);
    }
    return null;
}

function matchPnpm(lines, shimDir, env, cwd, deps) {
    if (lines[0] !== '@SETLOCAL') {
        return null;
    }
    let body = lines.slice(1).filter((line) => line !== '');
    let baseEnv = env;
    if (body.length > 0 && PNPM_NODE_PATH_IF.test(body[0])) {
        if (body.length < 5) {
            return null;
        }
        const set = PNPM_NODE_PATH_SET.exec(body[1]);
        const prepend = PNPM_NODE_PATH_PREPEND.exec(body[3]);
        if (!set || body[2] !== ') ELSE (' || !prepend || body[4] !== ')') {
            return null;
        }
        if (set[1] !== prepend[1]) {
            return null;
        }
        const currentValue = envValue(env, 'NODE_PATH', 'win32');
        const defined = currentValue !== undefined && currentValue !== '';
        baseEnv = withWindowsEnvAssignment(env, 'NODE_PATH', defined ? `${set[1]};${currentValue}` : set[1]);
        body = body.slice(5);
    }
    if (body.length === 1) {
        const one = PNPM_ONELINE.exec(body[0]);
        if (!one) {
            return null;
        }
        const program2 = templatePath(one[1], shimDir);
        if (program2 === null) {
            return null;
        }
        const onelineEnv = baseEnv === env ? {} : { env: baseEnv };
        if (one[2].trim() === '') {
            return /\.exe$/i.test(program2) ? { command: program2, args: [], ...onelineEnv } : null;
        }
        const tail22 = interpreterTail(one[2], shimDir);
        return tail22 === null || /\.(cmd|bat)$/i.test(program2) ? null : { command: program2, args: tail22, ...onelineEnv };
    }
    if (body.length !== 6) {
        return null;
    }
    const opened = PNPM_IF.exec(body[0]);
    if (!opened) {
        return null;
    }
    const local = path.win32.join(shimDir, 'node.exe');
    const candidate = templatePath(opened[1], shimDir);
    if (candidate === null || candidate.toLowerCase() !== local.toLowerCase()) {
        return null;
    }
    const present = PNPM_ARM.exec(body[1]);
    if (!present) {
        return null;
    }
    const presentProgram = templatePath(present[1], shimDir);
    if (presentProgram === null || presentProgram.toLowerCase() !== local.toLowerCase()) {
        return null;
    }
    if (body[2] !== ') ELSE (') {
        return null;
    }
    const edit = PATHEXT_EDIT.exec(body[3]);
    if (!edit) {
        return null;
    }
    const absent = PNPM_BARE_ARM.exec(body[4]);
    if (!absent) {
        return null;
    }
    if (body[5] !== ')') {
        return null;
    }
    const tail2 = interpreterTail(present[2], shimDir);
    const otherTail = interpreterTail(absent[1], shimDir);
    if (tail2 === null || otherTail === null || tail2.join(' ') !== otherTail.join(' ')) {
        return null;
    }
    return nodeRecipe(shimDir, tail2, { present: baseEnv, absent: withPathextEdit(baseEnv, edit[1]) }, env, cwd, deps);
}

function recognizeShim(cmdPath, content, env, cwd, deps = REAL_DEPS) {
    if (!isFullyQualifiedLocalPath(cmdPath)) {
        return null;
    }
    const shimDir = path.win32.dirname(cmdPath);
    const lines = normalizeLines(content);
    if (lines.length === 0) {
        return null;
    }
    return matchNpm(lines, shimDir, env, cwd, deps) ?? matchPnpm(lines, shimDir, env, cwd, deps);
}

/**
 * 把 spawn 用的 command/args 解析成真正要执行的程序与参数。
 * 非 win32 或非 .cmd/.bat 直接原样返回；能识别出 npm/pnpm shim
 * 时，返回其真实 node 入口并附带批处理会施加的环境修改。
 */
export function resolveSpawnPlan(command, args, env = process.env, cwd, deps = REAL_DEPS) {
    if (deps.platform !== 'win32') {
        return { command, args };
    }
    let resolved = command;
    if (!command.includes('/') && !command.includes('\\')) {
        resolved = deps.resolveOnPath(command, env) ?? command;
    }
    if (!/\.(cmd|bat)$/i.test(path.win32.basename(resolved))) {
        return { command: resolved, args };
    }
    if (!isFullyQualifiedLocalPath(resolved)) {
        return { command: resolved, args };
    }
    let content;
    try {
        content = deps.readFileSync(resolved);
    } catch {
        return { command: resolved, args };
    }
    const recipe = recognizeShim(resolved, content, env, cwd, deps);
    if (recipe === null) {
        return { command: resolved, args };
    }
    return {
        command: recipe.command,
        args: [...recipe.args, ...args],
        ...(recipe.env ? { env: recipe.env } : {}),
    };
}
