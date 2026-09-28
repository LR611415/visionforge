// net.js — 网络层：远程图 SSRF 防护 + apiFetch（方案 A 安全区自研重写）
//
// 行为契约与 dist L93-521 对齐：
//   - 远程图仅 http/https，禁内嵌凭据；
//   - 主机名字面黑名单 + DNS 全记录逐一私网判定（IPv4/IPv6 含 ::ffff: 映射）；
//   - 下载连接用固定解析结果的 dispatcher 防 rebinding；手工重定向链逐跳重新校验；
//   - 25 MiB 上限，流式读取封顶；
//   - apiFetch 负责代理解析（显式 proxy / HTTPS_PROXY 等环境变量 / 直连）
//     与连接失败的可读提示（UND_ERR_CONNECT_TIMEOUT 等）。

import * as dns from 'dns';
import * as fs from 'fs';
import { isIP } from 'net';
import { Agent, EnvHttpProxyAgent, ProxyAgent } from 'undici';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.amazonaws.com', 'metadata.azure.internal']);

const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif']);

// ---------------------------------------------------------------------------
// URL 规范化与主机名黑名单
// ---------------------------------------------------------------------------

function normalizeRemoteImageUrl(input) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Image URL is required.');
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`Invalid URL: ${trimmed}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https image URLs are supported.');
    }
    if (parsed.username || parsed.password) {
        throw new Error('URL with embedded credentials is not allowed.');
    }
    return parsed;
}

function isBlockedHostname(hostname) {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) {
        return true;
    }
    if (BLOCKED_HOSTNAMES.has(normalized)) {
        return true;
    }
    if (normalized.endsWith('.localhost')) {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// 私网地址判定（IPv4 / IPv6 / ::ffff: 映射）
// ---------------------------------------------------------------------------

function isPrivateIpAddress(ipAddress) {
    const normalized = ipAddress.trim().toLowerCase();
    const family = isIP(normalized);
    if (family === 4) {
        return isPrivateIPv4(normalized);
    }
    if (family === 6) {
        return isPrivateIPv6(normalized);
    }
    return true;
}

function isPrivateIPv4(ipAddress) {
    const octets = ipAddress.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
        return true;
    }
    const value = octets[0] * 256 ** 3 + octets[1] * 256 ** 2 + octets[2] * 256 + octets[3];
    return (
        inRange(value, '0.0.0.0', '0.255.255.255') ||
        inRange(value, '10.0.0.0', '10.255.255.255') ||
        inRange(value, '100.64.0.0', '100.127.255.255') ||
        inRange(value, '127.0.0.0', '127.255.255.255') ||
        inRange(value, '169.254.0.0', '169.254.255.255') ||
        inRange(value, '172.16.0.0', '172.31.255.255') ||
        inRange(value, '192.0.0.0', '192.0.0.255') ||
        inRange(value, '192.168.0.0', '192.168.255.255') ||
        inRange(value, '198.18.0.0', '198.19.255.255') ||
        inRange(value, '224.0.0.0', '255.255.255.255')
    );
}

function inRange(value, start, end) {
    return value >= ipv4ToNumber(start) && value <= ipv4ToNumber(end);
}

function ipv4ToNumber(ipAddress) {
    const octets = ipAddress.split('.').map((part) => Number.parseInt(part, 10));
    return octets[0] * 256 ** 3 + octets[1] * 256 ** 2 + octets[2] * 256 + octets[3];
}

function isPrivateIPv6(ipAddress) {
    const groups = expandIpv6(ipAddress);
    if (groups !== null && hasMappedV4Prefix(groups)) {
        const mapped2 = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
        return isPrivateIPv4(mapped2);
    }
    const normalized = ipAddress.split('%')[0];
    const mapped = extractMappedIpv4(normalized);
    if (mapped && isPrivateIPv4(mapped)) {
        return true;
    }
    const value = ipv6ToBigInt(normalized);
    if (value === null) {
        return true;
    }
    return (
        inIpv6Range(value, '::', 128) ||
        inIpv6Range(value, '::1', 128) ||
        inIpv6Range(value, 'fc00::', 7) ||
        inIpv6Range(value, 'fe80::', 10) ||
        inIpv6Range(value, 'ff00::', 8) ||
        inIpv6Range(value, '2001:db8::', 32)
    );
}

function hasMappedV4Prefix(groups) {
    return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
}

function extractMappedIpv4(ipAddress) {
    const lower = ipAddress.toLowerCase();
    const marker = '::ffff:';
    if (!lower.startsWith(marker)) {
        return null;
    }
    const candidate = lower.slice(marker.length);
    return isIP(candidate) === 4 ? candidate : null;
}

function inIpv6Range(value, start, prefixLength) {
    const startValue = ipv6ToBigInt(start);
    if (startValue === null) {
        return false;
    }
    const mask = prefixLength === 0 ? 0n : (((1n << BigInt(prefixLength)) - 1n) << BigInt(128 - prefixLength));
    return (value & mask) === (startValue & mask);
}

function ipv6ToBigInt(ipAddress) {
    const expanded = expandIpv6(ipAddress);
    if (!expanded) {
        return null;
    }
    return expanded.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n);
}

function expandIpv6(ipAddress) {
    const value = ipAddress.toLowerCase();
    if (value.includes('::')) {
        const [left, right] = value.split('::');
        const leftGroups = left ? left.split(':').filter(Boolean) : [];
        const rightGroups = right ? right.split(':').filter(Boolean) : [];
        if (leftGroups.length + rightGroups.length > 8) {
            return null;
        }
        const middle = new Array(8 - leftGroups.length - rightGroups.length).fill('0');
        const allGroups = [...leftGroups, ...middle, ...rightGroups];
        return parseIpv6Groups(allGroups);
    }
    return parseIpv6Groups(value.split(':'));
}

function parseIpv6Groups(groups) {
    if (groups.length !== 8) {
        return null;
    }
    const parsed = groups.map((group) => Number.parseInt(group || '0', 16));
    if (parsed.some((value) => !Number.isFinite(value) || value < 0 || value > 65535)) {
        return null;
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// 目标校验：黑名单 → DNS 全记录 → 私网判定 → 固定解析结果
// ---------------------------------------------------------------------------

function stripIpv6Brackets(hostname) {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        return hostname.slice(1, -1);
    }
    return hostname;
}

function blockedMessage(target) {
    return `Blocked private or reserved image target: ${target}. visionforge does not download from private addresses and upload the result to a vision provider. For a local or internal image, save it to a file and pass the path instead.`;
}

async function assertSafeRemoteTarget(url) {
    if (isBlockedHostname(url.hostname)) {
        throw new Error(blockedMessage(url.hostname));
    }
    const hostname = stripIpv6Brackets(url.hostname);
    const ipFamily = isIP(hostname);
    if (ipFamily > 0) {
        if (isPrivateIpAddress(hostname)) {
            throw new Error(blockedMessage(hostname));
        }
        return { hostname, address: hostname, family: ipFamily };
    }
    let resolved;
    try {
        resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
        throw new Error(`DNS lookup failed for host ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (resolved.length === 0) {
        throw new Error(`Host ${hostname} did not resolve to any IP address.`);
    }
    const blocked = resolved.find((record) => isPrivateIpAddress(record.address));
    if (blocked) {
        throw new Error(blockedMessage(`${hostname} -> ${blocked.address}`));
    }
    const [chosen] = resolved;
    return { hostname, address: chosen.address, family: chosen.family };
}

// ---------------------------------------------------------------------------
// 图片字节嗅探与本地读取
// ---------------------------------------------------------------------------

const SNIFFERS = [
    { mime: 'image/png', test: (b) => b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10 },
    { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
    { mime: 'image/gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
    { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
    // ISO BMFF: bytes 4-8 是 "ftyp"，品牌名决定格式。这封死了最后一个
    // 信任扩展名的漏洞：heic/heif 必须像其他类型一样用文件头自证。
    { mime: 'image/heic', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12)) },
    { mime: 'image/heif', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12)) },
];

function sniffImageMime(buffer) {
    for (const { mime, test } of SNIFFERS) {
        if (test(buffer)) {
            return mime;
        }
    }
    return null;
}

function safeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return '<unparseable url>';
    }
}

function resolveImageMime(buffer, source) {
    const sniffed = sniffImageMime(buffer);
    if (sniffed) {
        return sniffed;
    }
    throw new Error(`Content of ${source} does not look like a supported image (its bytes match no known image header). Allowed types: ${[...ALLOWED_MIME].join(', ')}.`);
}

export function readLocalImageBase64(filePath) {
    const size = fs.statSync(filePath).size;
    if (size > MAX_REMOTE_IMAGE_BYTES) {
        throw new Error(`Image is ${size} bytes, over the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${filePath}`);
    }
    const buffer = fs.readFileSync(filePath);
    const mimeType = resolveImageMime(buffer, filePath);
    return { data: buffer.toString('base64'), mimeType };
}

// ---------------------------------------------------------------------------
// 远程图下载：逐跳 SSRF 校验 + 固定解析结果防 rebinding
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

function pinnedDispatcher(pinned) {
    return new Agent({
        connect: {
            lookup: (_hostname, options, callback) => {
                const record = { address: pinned.address, family: pinned.family };
                if (options && options.all) {
                    callback(null, [record]);
                } else {
                    callback(null, pinned.address, pinned.family);
                }
            },
        },
    });
}

async function readCapped(response, url) {
    const body = response.body;
    if (!body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error(`Remote image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${safeUrl(url)}`);
        }
        return buffer;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > MAX_REMOTE_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error(`Remote image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${safeUrl(url)}`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/** 拉取远程图并做魔数校验，返回 base64 + mimeType。 */
export async function fetchRemoteImageBase64(url, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = normalizeRemoteImageUrl(url);
    const dispatchers = [];
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const pinned = await assertSafeRemoteTarget(current);
            const dispatcher = pinnedDispatcher(pinned);
            dispatchers.push(dispatcher);
            const response = await fetch(current, { method: 'GET', redirect: 'manual', signal, dispatcher });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location) {
                    await response.body?.cancel().catch(() => {});
                    throw new Error(`Redirect response (${response.status}) missing location header: ${safeUrl(current.toString())}`);
                }
                await response.body?.cancel();
                if (hop === MAX_REDIRECTS) {
                    throw new Error(`Too many redirects (max ${MAX_REDIRECTS}): ${safeUrl(url)}`);
                }
                current = normalizeRemoteImageUrl(new URL(location, current).toString());
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new Error(`Failed to download image (${response.status}): ${safeUrl(current.toString())}`);
            }
            const declaredLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
                await response.body?.cancel().catch(() => {});
                throw new Error(`Remote image is ${declaredLength} bytes, over the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${safeUrl(current.toString())}`);
            }
            const finalUrl = current.toString();
            const buffer = await readCapped(response, finalUrl);
            const mimeType = resolveImageMime(buffer, safeUrl(finalUrl));
            return { data: buffer.toString('base64'), mimeType };
        }
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS}): ${safeUrl(url)}`);
    } finally {
        await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.close()));
    }
}

// ---------------------------------------------------------------------------
// apiFetch：代理解析 + 连接失败提示
// ---------------------------------------------------------------------------

function apiProxyDispatcher(explicitProxy, env) {
    if (explicitProxy !== undefined) {
        const proxy = explicitProxy.trim();
        return proxy ? new ProxyAgent(proxy) : undefined;
    }
    if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        return new EnvHttpProxyAgent();
    }
    return undefined;
}

const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']);

function connectFailureHint(error, url) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!cause?.code || !CONNECT_CODES.has(cause.code)) {
        return null;
    }
    let host;
    try {
        host = new URL(url).host;
    } catch {
        return null;
    }
    return `Could not connect to ${host} (${cause.code}). The request never reached the network. If this machine reaches the internet through a proxy, set HTTPS_PROXY/HTTP_PROXY, or run: visionforge config set proxy <url>`;
}

function bodyFailedResponse(response, error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    return new Response(
        new ReadableStream({
            start(controller) {
                controller.error(cause);
            },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
    );
}

/** 统一 API 调用：显式 proxy > 环境变量代理 > 直连；连接失败给可读提示。 */
export async function apiFetch(url, init, proxy, env = process.env) {
    const dispatcher = apiProxyDispatcher(proxy, env) ?? new Agent();
    try {
        const response = await fetch(url, { ...init, dispatcher });
        try {
            const buffered = Buffer.from(await response.arrayBuffer());
            await dispatcher.close();
            return new Response(buffered, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (bodyError) {
            await dispatcher.close().catch(() => {});
            return bodyFailedResponse(response, bodyError);
        }
    } catch (error) {
        await dispatcher.close().catch(() => {});
        const hint = connectFailureHint(error, url);
        throw hint ? new Error(hint, { cause: error }) : error;
    }
}
