// recover-paste.js — 从各 harness 会话存储恢复粘贴图（上游保留段）
//
// 本文件按用户拍板的方案 A 原样保留自 liustack/modlens（MIT，
// https://github.com/liustack/modlens，dist/main.js L4438-5053 与
// L5782-5958），仅做模块化封装与注释改写，未改动算法与行为：
// harness 检测（进程祖先 / 环境指纹）、claude/pi 的 JSONL 会话适配、
// opencode 的 SQLite 查询（node:sqlite）、模型嗅探，以及
// recover-paste 主流程（定位 → 提取 → 以 sha256 命名落盘 0600）。
// 高风险区（读取他人会话存储、扫描进程树），非本插件能力范围，保留致谢。

import { createRequire } from 'module';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { execFileSyncHidden } from './shim.js';

// ---------------------------------------------------------------------------
// harness 检测
// ---------------------------------------------------------------------------

const HARNESS_BY_BASENAME = {
    claude: 'claude-code',
    'claude-code': 'claude-code',
    pi: 'pi',
    opencode: 'opencode',
    codex: 'codex',
};

function harnessFromPsTable(psOutput, startPid) {
    const table = new Map();
    for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match) {
            table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
        }
    }
    let pid = table.get(startPid)?.ppid;
    for (let hops = 0; hops < 50 && pid !== undefined && pid > 1; hops++) {
        const proc = table.get(pid);
        if (!proc) {
            return null;
        }
        const tokens = proc.command.trim().split(/\s+/);
        const candidates = [tokens[0]];
        if (/^(node|bun|deno)$/.test(path.basename(tokens[0] ?? ''))) {
            const script = tokens.slice(1).find((token) => !token.startsWith('-') && /[/\\]|\.(m|c)?[jt]s$/.test(token));
            if (script) {
                candidates.push(script);
            }
        }
        for (const token of candidates) {
            const mapped = token ? HARNESS_BY_BASENAME[path.basename(token)] : undefined;
            if (mapped) {
                return mapped;
            }
        }
        pid = proc.ppid;
    }
    return null;
}

export function detectHarnessDetailed() {
    const override = process.env.VISIONFORGE_HARNESS;
    if (override) {
        return { harness: override === 'none' ? null : override, source: 'override' };
    }
    if (process.platform !== 'win32') {
        try {
            const ps = execFileSyncHidden('ps', ['-Ao', 'pid=,ppid=,command='], {
                encoding: 'utf-8',
                maxBuffer: 16 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const found = harnessFromPsTable(ps, process.pid);
            if (found) {
                return { harness: found, source: 'ancestry' };
            }
        } catch {
        }
    }
    const fromEnv = harnessFromEnv(process.env);
    if (fromEnv) {
        return { harness: fromEnv, source: 'env' };
    }
    return { harness: null, source: 'none' };
}

export function harnessFromEnv(env) {
    if (env.PI_CODING_AGENT) {
        return 'pi';
    }
    if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) {
        return 'codex';
    }
    if (env.OPENCODE || env.OPENCODE_PID || env.OPENCODE_BINARY) {
        return 'opencode';
    }
    if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) {
        return 'claude-code';
    }
    return null;
}

export function detectHarness() {
    return detectHarnessDetailed().harness;
}

// ---------------------------------------------------------------------------
// JSONL 会话适配（claude / pi）
// ---------------------------------------------------------------------------

function cwdMatches(recorded, wanted, bothDirections = false) {
    const resolvedRecorded = path.resolve(recorded);
    const resolvedWanted = path.resolve(wanted);
    if (resolvedRecorded === resolvedWanted || resolvedRecorded.startsWith(`${resolvedWanted}${path.sep}`)) {
        return true;
    }
    return bothDirections && resolvedWanted.startsWith(`${resolvedRecorded}${path.sep}`);
}

function transcriptBelongsTo(lines, cwd, bothDirections = false) {
    for (const line of lines) {
        if (!line.includes('"cwd"')) {
            continue;
        }
        try {
            const recorded = JSON.parse(line).cwd;
            if (typeof recorded !== 'string') {
                continue;
            }
            if (cwdMatches(recorded, cwd, bothDirections)) {
                return true;
            }
        } catch {
        }
    }
    return false;
}

function readLines(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8').split('\n');
    } catch {
        return null;
    }
}

function forEachJsonLine(filePath, visit) {
    const lines = readLines(filePath);
    if (!lines) {
        return;
    }
    forEachParsedLine(lines, visit);
}

function forEachParsedLine(lines, visit) {
    for (const line of lines) {
        if (!line.includes('"image"')) {
            continue;
        }
        try {
            visit(JSON.parse(line));
        } catch {
        }
    }
}

function jsonlSource(harness, filePath, extractLine) {
    return {
        harness,
        location: filePath,
        extract: () => {
            const images = [];
            forEachJsonLine(filePath, (line) => {
                images.push(...extractLine(line));
            });
            return images;
        },
    };
}

function newestJsonlTimestamp(lines, extractLine) {
    let latest = null;
    forEachParsedLine(lines, (line) => {
        if (extractLine(line).length === 0) {
            return;
        }
        const ts = line.timestamp;
        const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
        if (Number.isFinite(ms) && (latest === null || ms > latest)) {
            latest = ms;
        }
    });
    return latest;
}

function listJsonl(dir) {
    try {
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

function listJsonlByMtimeDesc(dir) {
    return listJsonl(dir)
        .map((file) => {
            try {
                return { file, mtime: fs.statSync(file).mtimeMs };
            } catch {
                return null;
            }
        })
        .filter((entry) => entry !== null)
        .sort((a, b) => b.mtime - a.mtime)
        .map((entry) => entry.file);
}

function jsonlAdapter(options) {
    const { name, dirFor, matchesSession, extractLine } = options;
    return {
        name,
        describe: (cwd) => dirFor(cwd),
        findNewest: (cwd) => {
            let best = null;
            for (const file of listJsonl(dirFor(cwd))) {
                const lines = readLines(file);
                if (!lines || !transcriptBelongsTo(lines, cwd)) {
                    continue;
                }
                const timestamp = newestJsonlTimestamp(lines, extractLine);
                if (timestamp !== null && (!best || timestamp > best.timestamp)) {
                    best = { ref: jsonlSource(name, file, extractLine), timestamp };
                }
            }
            return best;
        },
        findSession: (cwd, sessionId) => {
            for (const file of listJsonl(dirFor(cwd))) {
                if (!matchesSession(path.basename(file), sessionId)) {
                    continue;
                }
                const lines = readLines(file);
                if (lines && transcriptBelongsTo(lines, cwd)) {
                    return jsonlSource(name, file, extractLine);
                }
            }
            return null;
        },
    };
}

function claudeProjectSlug(cwd) {
    return path.resolve(cwd).replace(/[/.]/g, '-');
}

function claudeExtractLine(line) {
    const message = line.message;
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
        return [];
    }
    const images = [];
    for (const block of message.content) {
        const source = block?.source;
        if (block?.type === 'image' && source?.type === 'base64' && source.data) {
            images.push({ mediaType: source.media_type ?? 'image/png', data: source.data });
        }
    }
    return images;
}

const claudeAdapter = jsonlAdapter({
    name: 'claude-code',
    dirFor: (cwd) => path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd)),
    matchesSession: (fileName, sessionId) => fileName === `${sessionId}.jsonl`,
    extractLine: claudeExtractLine,
});

// ---------------------------------------------------------------------------
// opencode SQLite 适配
// ---------------------------------------------------------------------------

function opencodeDbPath() {
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function opencodeDirectoryFilter(resolvedCwd, caseInsensitive = process.platform === 'win32') {
    const normalized = resolvedCwd.replace(/\\/g, '/');
    const cwd = caseInsensitive ? normalized.toLowerCase() : normalized;
    const prefix = `${cwd.replace(/\/+$/, '')}/`;
    const rawDir = `REPLACE(session.directory, '\\', '/')`;
    const dir = caseInsensitive ? `LOWER(${rawDir})` : rawDir;
    const dirPrefix = `RTRIM(${dir}, '/') || '/'`;
    return {
        // SQLite SUBSTR 按 Unicode 字符计数，JS .length 按 UTF-16 单元计数，
        // 所以长度参数按码点（[...str].length）计量，路径里的 emoji 才不会错位。
        clause: `(${dir} = ? OR SUBSTR(${dir}, 1, ?) = ? OR SUBSTR(?, 1, LENGTH(${dirPrefix})) = ${dirPrefix})`,
        params: [cwd, [...prefix].length, prefix, cwd],
    };
}

function buildOpencodeQuery(resolvedCwd, sessionId) {
    const directory = opencodeDirectoryFilter(resolvedCwd);
    const sessionFilter = sessionId ? `AND ${directory.clause} AND (session.id = ? OR session.slug = ?)` : `AND ${directory.clause}`;
    const params = sessionId ? [...directory.params, sessionId, sessionId] : directory.params;
    const sql = `SELECT part.data AS data, part.time_created AS time_created, part.session_id AS session_id
                 FROM part
                 JOIN message ON message.id = part.message_id
                 JOIN session ON session.id = part.session_id
                 WHERE part.data LIKE '{"type":"file"%'
                   AND json_extract(message.data, '$.role') = 'user'
                   ${sessionFilter}
                 ORDER BY part.time_created ASC`;
    return { sql, params };
}

function loadNodeSqlite() {
    try {
        const nodeRequire = createRequire(import.meta.url);
        return nodeRequire('node:sqlite').DatabaseSync;
    } catch {
        return null;
    }
}

function opencodeQuery(dbPath, cwd, sessionId) {
    const DatabaseSync = loadNodeSqlite();
    if (!DatabaseSync) {
        throw new Error('Reading opencode storage needs the node:sqlite module (unflagged on Node 22.13+). Upgrade Node, or pass --transcript/--session for a JSONL-based harness.');
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const { sql, params } = buildOpencodeQuery(path.resolve(cwd), sessionId);
        return db.prepare(sql).all(...params);
    } finally {
        db.close();
    }
}

function opencodeImagesFromRows(rows) {
    const images = [];
    for (const row of rows) {
        try {
            const part = JSON.parse(row.data);
            if (part.type !== 'file' || !part.mime?.startsWith('image/')) {
                continue;
            }
            const match = /^data:[^;]+;base64,(.+)$/.exec(part.url ?? '');
            if (match) {
                images.push({ mediaType: part.mime, data: match[1], filename: part.filename });
            }
        } catch {
        }
    }
    return images;
}

function opencodeSourceFor(dbPath, cwd) {
    return {
        harness: 'opencode',
        location: dbPath,
        extract: () => opencodeImagesFromRows(opencodeQuery(dbPath, cwd)),
    };
}

const opencodeAdapter = {
    name: 'opencode',
    describe: () => opencodeDbPath(),
    findNewest: (cwd) => {
        const dbPath = opencodeDbPath();
        if (!fs.existsSync(dbPath)) {
            return null;
        }
        const withImages = opencodeQuery(dbPath, cwd)
            .map((row) => ({ row, images: opencodeImagesFromRows([row]) }))
            .filter((entry) => entry.images.length > 0);
        if (withImages.length === 0) {
            return null;
        }
        const newest = withImages[withImages.length - 1];
        const scoped = withImages.filter((entry) => entry.row.session_id === newest.row.session_id);
        return {
            ref: {
                harness: 'opencode',
                location: dbPath,
                extract: () => scoped.flatMap((entry) => entry.images),
            },
            timestamp: newest.row.time_created,
        };
    },
    findSession: (cwd, sessionId) => {
        const dbPath = opencodeDbPath();
        if (!fs.existsSync(dbPath)) {
            return null;
        }
        const rows = opencodeQuery(dbPath, cwd, sessionId);
        if (opencodeImagesFromRows(rows).length === 0) {
            return null;
        }
        return {
            harness: 'opencode',
            location: dbPath,
            extract: () => opencodeImagesFromRows(opencodeQuery(dbPath, cwd, sessionId)),
        };
    },
};

// ---------------------------------------------------------------------------
// pi JSONL 适配
// ---------------------------------------------------------------------------

function piSessionSlug(cwd) {
    const resolved = path.resolve(cwd);
    return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function piExtractLine(line) {
    const message = line.message;
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
        return [];
    }
    const images = [];
    for (const block of message.content) {
        const typed = block;
        if (typed?.type === 'image' && typed.data) {
            images.push({ mediaType: typed.mimeType ?? 'image/png', data: typed.data });
        }
    }
    return images;
}

const piAdapter = jsonlAdapter({
    name: 'pi',
    dirFor: (cwd) => path.join(os.homedir(), '.pi', 'agent', 'sessions', piSessionSlug(cwd)),
    // pi 文件名形如 2026-08-03T14-18-04-595Z_<uuid>.jsonl
    matchesSession: (fileName, sessionId) => fileName.endsWith(`_${sessionId}.jsonl`),
    extractLine: piExtractLine,
});

// ---------------------------------------------------------------------------
// 窗口化读取 + 模型嗅探
// ---------------------------------------------------------------------------

const WINDOW_BYTES = 512 * 1024;

function readWindowedLines(file, maxBytes = WINDOW_BYTES) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch {
        return null;
    }
    try {
        const size = fs.fstatSync(fd).size;
        if (size <= 2 * maxBytes) {
            const whole = Buffer.alloc(size);
            fs.readSync(fd, whole, 0, size, 0);
            return whole.toString('utf-8').split('\n');
        }
        const head = Buffer.alloc(maxBytes);
        fs.readSync(fd, head, 0, maxBytes, 0);
        const tail2 = Buffer.alloc(maxBytes);
        fs.readSync(fd, tail2, 0, maxBytes, size - maxBytes);
        const headLines = head.toString('utf-8').split('\n');
        headLines.pop();
        const tailLines = tail2.toString('utf-8').split('\n');
        tailLines.shift();
        return [...headLines, ...tailLines];
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

function lastAssistantModelFromLines(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"model"')) {
            continue;
        }
        try {
            const message = JSON.parse(line).message;
            if (message?.role === 'assistant' && typeof message.model === 'string') {
                const found = { model: message.model };
                if (typeof message.provider === 'string') {
                    found.provider = message.provider;
                }
                return found;
            }
        } catch {
        }
    }
    return null;
}

function lastCodexModelFromLines(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"turn_context"')) {
            continue;
        }
        try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'turn_context' && typeof parsed.payload?.model === 'string') {
                return parsed.payload.model;
            }
        } catch {
        }
    }
    return null;
}

function codexTranscriptBelongsTo(lines, cwd) {
    for (const line of lines) {
        if (!line.includes('"cwd"')) {
            continue;
        }
        try {
            const recorded = JSON.parse(line).payload?.cwd;
            if (typeof recorded === 'string' && cwdMatches(recorded, cwd, true)) {
                return true;
            }
        } catch {
        }
    }
    return false;
}

function* cwdAncestors(cwd) {
    let current = path.resolve(cwd);
    for (;;) {
        yield current;
        const parent = path.dirname(current);
        if (parent === current) {
            return;
        }
        current = parent;
    }
}

function newestAssistantModelInDir(dir, cwd) {
    for (const file of listJsonlByMtimeDesc(dir)) {
        const lines = readWindowedLines(file);
        if (!lines || !transcriptBelongsTo(lines, cwd, true)) {
            continue;
        }
        const found = lastAssistantModelFromLines(lines);
        if (found) {
            return found;
        }
    }
    return null;
}

function existingSlugDirs(root, cwd, slugFor) {
    const dirs = [];
    for (const ancestor of cwdAncestors(cwd)) {
        const dir = path.join(root, slugFor(ancestor));
        if (fs.existsSync(dir)) {
            dirs.push(dir);
        }
    }
    return dirs;
}

function sniffClaudeModel(cwd, env, projectsDir = path.join(os.homedir(), '.claude', 'projects')) {
    const dirs = existingSlugDirs(projectsDir, cwd, claudeProjectSlug);
    const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim();
    if (sessionId) {
        for (const dir of dirs) {
            const lines = readWindowedLines(path.join(dir, `${sessionId}.jsonl`));
            const pinned = lines ? lastAssistantModelFromLines(lines) : null;
            if (pinned) {
                return pinned;
            }
        }
    }
    for (const dir of dirs) {
        const found = newestAssistantModelInDir(dir, cwd);
        if (found) {
            return found;
        }
    }
    return null;
}

function sniffPiModel(cwd, sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions')) {
    for (const dir of existingSlugDirs(sessionsRoot, cwd, piSessionSlug)) {
        const found = newestAssistantModelInDir(dir, cwd);
        if (found) {
            return found;
        }
    }
    return null;
}

const CODEX_SCAN_LIMIT = 20;
const CODEX_STAT_LIMIT = 200;

function sniffCodexModel(cwd, env, sessionsRoot = path.join(os.homedir(), '.codex', 'sessions')) {
    let names;
    try {
        names = fs
            .readdirSync(sessionsRoot, { recursive: true })
            .filter((name) => name.endsWith('.jsonl'))
            .sort()
            .reverse();
    } catch {
        return null;
    }
    const threadId = env.CODEX_THREAD_ID?.trim();
    if (threadId) {
        const pinned = names.find((name) => path.basename(name).endsWith(`-${threadId}.jsonl`));
        if (pinned) {
            const lines = readWindowedLines(path.join(sessionsRoot, pinned));
            const model = lines ? lastCodexModelFromLines(lines) : null;
            if (model) {
                return model;
            }
        }
    }
    const byMtimeDesc = names
        .slice(0, CODEX_STAT_LIMIT)
        .map((name) => {
            const file = path.join(sessionsRoot, name);
            try {
                return { file, mtime: fs.statSync(file).mtimeMs };
            } catch {
                return null;
            }
        })
        .filter((entry) => entry !== null)
        .sort((a, b) => b.mtime - a.mtime);
    for (const entry of byMtimeDesc.slice(0, CODEX_SCAN_LIMIT)) {
        const lines = readWindowedLines(entry.file);
        if (!lines || !codexTranscriptBelongsTo(lines, cwd)) {
            continue;
        }
        const model = lastCodexModelFromLines(lines);
        if (model) {
            return model;
        }
    }
    return null;
}

function opencodeModelForCwd(cwd, dbPath = opencodeDbPath()) {
    if (!fs.existsSync(dbPath)) {
        return null;
    }
    const DatabaseSync = loadNodeSqlite();
    if (!DatabaseSync) {
        return null;
    }
    const directory = opencodeDirectoryFilter(path.resolve(cwd));
    const sql = `SELECT message.data AS data
                 FROM message
                 JOIN session ON session.id = message.session_id
                 WHERE json_extract(message.data, '$.role') = 'assistant'
                   AND ${directory.clause}
                 ORDER BY message.time_created DESC
                 LIMIT 1`;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const rows = db.prepare(sql).all(...directory.params);
        if (rows.length === 0) {
            return null;
        }
        const data = JSON.parse(rows[0].data);
        if (typeof data.modelID !== 'string') {
            return null;
        }
        const found = { model: data.modelID };
        if (typeof data.providerID === 'string') {
            found.provider = data.providerID;
        }
        return found;
    } catch {
        return null;
    } finally {
        db.close();
    }
}

/** 嗅探当前 harness 最近使用的模型（guard 的存储信号来源）。 */
export function sniffModel(harness, cwd, env, roots = {}) {
    try {
        switch (harness) {
            case 'claude-code':
                return sniffClaudeModel(cwd, env, roots.claudeProjectsDir);
            case 'pi':
                return sniffPiModel(cwd, roots.piSessionsRoot);
            case 'codex': {
                const model = sniffCodexModel(cwd, env, roots.codexSessionsRoot);
                return model ? { model } : null;
            }
            case 'opencode':
                return opencodeModelForCwd(cwd, roots.opencodeDb);
            default:
                return null;
        }
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// recover-paste 主流程
// ---------------------------------------------------------------------------

function extensionFromMediaType(mediaType) {
    const subtype = mediaType.split('/')[1]?.split('+')[0]?.replace(/[^a-z0-9]/gi, '');
    return subtype ? subtype.toLowerCase() : 'bin';
}

const EXT_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

const ADAPTERS = [claudeAdapter, piAdapter, opencodeAdapter];

function prepareOutDir(explicit) {
    if (!explicit) {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'visionforge-paste-'));
    }
    const outDir = path.resolve(explicit);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(outDir, 0o700);
        } catch {
        }
        return outDir;
    }
    const stat = fs.lstatSync(outDir);
    if (stat.isSymbolicLink()) {
        throw new Error(`--out-dir is a symlink, refusing to use it: ${outDir}. A symlink could redirect recovered screenshots somewhere readable by others.`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`--out-dir exists but is not a directory: ${outDir}.`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined) {
        if (stat.uid !== uid) {
            throw new Error(`--out-dir is owned by another user (uid ${stat.uid}, not ${uid}): ${outDir}. On a shared machine that user could read the recovered images.`);
        }
        if (stat.mode & 63) {
            throw new Error(`--out-dir is group- or world-accessible (mode ${(stat.mode & 511).toString(8)}): ${outDir}. Recovered screenshots can hold anything; use a private directory (chmod 700).`);
        }
    }
    return outDir;
}

function sourceForExplicitPath(filePath, cwd, harness) {
    const declared = harness && harness !== 'none' ? harness : undefined;
    if (declared === 'opencode' || (!declared && filePath.endsWith('.db'))) {
        return opencodeSourceFor(filePath, cwd);
    }
    if (declared === 'pi' || (!declared && filePath.includes(`${path.sep}.pi${path.sep}`))) {
        return jsonlSource('pi', filePath, piExtractLine);
    }
    return jsonlSource('claude-code', filePath, claudeExtractLine);
}

function locateSource(cwd, adapters = ADAPTERS) {
    let best = null;
    const blockers = [];
    for (const adapter of adapters) {
        let candidate = null;
        try {
            candidate = adapter.findNewest(cwd);
        } catch (error) {
            blockers.push(`${adapter.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (candidate && (!best || candidate.timestamp > best.timestamp)) {
            best = candidate;
        }
    }
    if (!best) {
        const dirs = adapters.map((a) => a.describe(cwd)).join(' , ');
        const blocked = blockers.length > 0 ? `\nBlocked: ${blockers.join(' | ')}` : '';
        throw new Error(
            `No pasted images found in any session storage for this directory (looked in: ${dirs}). The user may not have pasted any, the storage format changed, or a legacy transcript records no cwd (ownership cannot be proven; an explicit --transcript path bypasses that check). Ask for a file path instead.${blocked}`,
        );
    }
    return best.ref;
}

function sourceForSession(cwd, sessionId, adapters = ADAPTERS) {
    const blockers = [];
    for (const adapter of adapters) {
        try {
            const ref = adapter.findSession(cwd, sessionId);
            if (ref) {
                return ref;
            }
        } catch (error) {
            blockers.push(`${adapter.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const dirs = adapters.map((a) => a.describe(cwd)).join(' , ');
    const blocked = blockers.length > 0 ? `\nBlocked: ${blockers.join(' | ')}` : '';
    throw new Error(
        `No session ${sessionId} with pasted images under this project (looked in: ${dirs}). Check --cwd, or drop --session to auto-locate by newest pasted image.${blocked}`,
    );
}

export function recoverPastedImages(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const detected = options.transcript ? null : options.harness ?? detectHarness();
    if (detected === 'codex') {
        throw new Error('This is a Codex session: pasted images already exist as temp files, and each image tag in the message carries its path. Read the path from the tag instead of running recover-paste.');
    }
    const requested = options.harness?.trim();
    if (requested && requested !== 'none' && !ADAPTERS.some((a) => a.name === requested)) {
        throw new Error(`Unknown harness "${requested}". Supported: ${ADAPTERS.map((a) => a.name).join(', ')} (or none to scan all).`);
    }
    const scoped = detected && detected !== 'none' ? detected : null;
    if (scoped && !ADAPTERS.some((adapter) => adapter.name === scoped)) {
        throw new Error(`Unknown harness "${scoped}". Supported: claude-code, pi, opencode (or none to scan all).`);
    }
    const adapters = scoped ? ADAPTERS.filter((adapter) => adapter.name === scoped) : ADAPTERS;
    let source = null;
    if (options.transcript) {
        source = sourceForExplicitPath(options.transcript, cwd, options.harness);
    } else if (options.session) {
        source = sourceForSession(cwd, options.session, adapters);
    } else {
        const envSession = detected === 'claude-code' ? process.env.CLAUDE_CODE_SESSION_ID : undefined;
        if (envSession) {
            try {
                source = sourceForSession(cwd, envSession, adapters);
            } catch {
                source = null;
            }
        }
        source ??= locateSource(cwd, adapters);
    }
    const count = Math.min(Math.max(1, options.count ?? 1), 20);
    const all = source.extract();
    if (all.length === 0) {
        throw new Error(
            `No pasted images found in ${source.location}. The user may not have pasted any, the storage format changed, or a legacy transcript records no cwd (ownership cannot be proven; an explicit --transcript path bypasses that check). Ask for a file path instead.`,
        );
    }
    const outDir = prepareOutDir(options.outDir);
    const picked = all.slice(-count);
    const images = picked.map((image) => {
        const buffer = Buffer.from(image.data, 'base64');
        const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
        const ext = EXT_BY_MIME[image.mediaType] ?? extensionFromMediaType(image.mediaType);
        const filePath = path.join(outDir, `paste-${hash}.${ext}`);
        fs.writeFileSync(filePath, buffer, { mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        } catch {
        }
        const recovered = { path: filePath, mediaType: image.mediaType, bytes: buffer.length };
        if (image.filename) {
            recovered.filename = image.filename;
        }
        return recovered;
    });
    const result = { harness: source.harness, transcript: source.location, images };
    if (scoped) {
        result.detected = scoped;
    }
    return result;
}
