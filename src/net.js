// net.js — 网络层：远程图 SSRF 防护 + apiFetch（Node 原生实现，不依赖第三方 undici）
//
// 行为契约（与上游 dist 对齐，重写为 Node 原生 http/https）：
//   - 远程图仅 http/https，禁内嵌凭据；
//   - 主机名字面黑名单 + DNS 全记录逐一私网判定（IPv4/IPv6 含 ::ffff: 映射）；
//   - 下载连接用固定解析结果的 lookup 防 rebinding；手工重定向链逐跳重新校验；
//   - 25 MiB 上限，流式读取封顶；
//   - apiFetch 负责代理解析（显式 proxy / HTTPS_PROXY 等环境变量 / 直连）
//     与连接失败的可读提示（ENOTFOUND/ECONNREFUSED/ETIMEDOUT 等）。
//
// 为什么不用 npm undici：DSH 只要求 node >= 22，而 Node 22/24/25 的 http/https
// 标准库 API 稳定不变；npm undici 的 dispatcher 必须与 Node 内置 undici 版本匹配，
// 版本不一致会报 UND_ERR_INVALID_ARG。插件不应对 Node 内部版本有任何耦合——
// 本文件全部使用 Node 标准库，插件只随 DSH（harness）大版本迭代维护。

import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { isIP } from 'net';
import { URL } from 'url';

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
// 原生 GET（带固定 lookup / 中止信号）
// ---------------------------------------------------------------------------

function rawGet(url, options) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            reject(error);
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error('Only http/https URLs are supported.'));
            return;
        }
        const mod = parsed.protocol === 'https:' ? https : http;
        const reqOptions = {
            method: 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: {},
        };
        if (options.lookup) {
            reqOptions.lookup = options.lookup;
        }
        const req = mod.request(reqOptions, (res) => resolve(res));
        req.on('error', (error) => reject(error));
        if (options.signal) {
            const onAbort = () => {
                const reason = options.signal.reason instanceof Error ? options.signal.reason : new Error('The operation was aborted due to timeout');
                req.destroy(reason);
            };
            if (options.signal.aborted) {
                onAbort();
            } else {
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
        }
        req.end();
    });
}

// ---------------------------------------------------------------------------
// 远程图下载：逐跳 SSRF 校验 + 固定解析结果防 rebinding
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

function readCappedNative(response, url) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        response.on('data', (chunk) => {
            if (settled) {
                return;
            }
            total += chunk.length;
            if (total > MAX_REMOTE_IMAGE_BYTES) {
                settled = true;
                response.destroy();
                reject(new Error(`Remote image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${safeUrl(url)}`));
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => {
            if (!settled) {
                settled = true;
                resolve(Buffer.concat(chunks));
            }
        });
        response.on('error', (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
    });
}

/** 拉取远程图并做魔数校验，返回 base64 + mimeType。直连（SSRF 防护优先，不走代理）。 */
export async function fetchRemoteImageBase64(url, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = normalizeRemoteImageUrl(url);
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const pinned = await assertSafeRemoteTarget(current);
            const lookup = (hostname, options, callback) => {
                const record = { address: pinned.address, family: pinned.family };
                if (options && options.all) {
                    callback(null, [record]);
                } else {
                    callback(null, pinned.address, pinned.family);
                }
            };
            const response = await rawGet(current.toString(), { signal, lookup });
            if (response.statusCode >= 300 && response.statusCode < 400) {
                const location = response.headers.location;
                response.destroy();
                if (!location) {
                    throw new Error(`Redirect response (${response.statusCode}) missing location header: ${safeUrl(current.toString())}`);
                }
                if (hop === MAX_REDIRECTS) {
                    throw new Error(`Too many redirects (max ${MAX_REDIRECTS}): ${safeUrl(url)}`);
                }
                current = normalizeRemoteImageUrl(new URL(location, current).toString());
                continue;
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.destroy();
                throw new Error(`Failed to download image (${response.statusCode}): ${safeUrl(current.toString())}`);
            }
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
                response.destroy();
                throw new Error(`Remote image is ${declaredLength} bytes, over the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${safeUrl(current.toString())}`);
            }
            const finalUrl = current.toString();
            const buffer = await readCappedNative(response, finalUrl);
            const mimeType = resolveImageMime(buffer, safeUrl(finalUrl));
            return { data: buffer.toString('base64'), mimeType };
        }
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS}): ${safeUrl(url)}`);
    } finally {
        signal.clear?.();
    }
}

// ---------------------------------------------------------------------------
// apiFetch：原生实现（显式 proxy > 环境变量代理 > 直连）
// ---------------------------------------------------------------------------

function resolveProxy(explicitProxy, env) {
    if (explicitProxy !== undefined) {
        const proxy = String(explicitProxy).trim();
        return proxy || undefined;
    }
    const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    return fromEnv && String(fromEnv).trim() ? String(fromEnv).trim() : undefined;
}

function toPlainHeaders(headers) {
    if (!headers) {
        return {};
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const out = {};
        headers.forEach((value, key) => {
            out[key] = value;
        });
        return out;
    }
    return { ...headers };
}

function proxyBasicAuth(proxyUrl) {
    if (proxyUrl.username || proxyUrl.password) {
        return 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64');
    }
    return null;
}

function attachAbortAndBody(req, init) {
    const signal = init.signal;
    if (signal) {
        const onAbort = () => {
            const reason = signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted due to timeout');
            req.destroy(reason);
        };
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    }
    const body = init.body;
    if (body != null) {
        req.write(Buffer.isBuffer(body) ? body : String(body));
    }
    req.end();
}

function wrapNativeResponse(res) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(key, item);
            }
        } else if (value !== undefined) {
            headers.set(key, String(value));
        }
    }
    const webBody = Readable.toWeb(res);
    return new Response(webBody, {
        status: res.statusCode || 0,
        statusText: res.statusMessage || '',
        headers,
    });
}

function rawApiRequest(url, init, proxy) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            reject(error);
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error('Only http/https URLs are supported.'));
            return;
        }
        const isHttps = parsed.protocol === 'https:';
        const method = init.method || 'GET';
        const headers = toPlainHeaders(init.headers);
        const body = init.body;
        if (body != null && !Object.prototype.hasOwnProperty.call(headers, 'Content-Length')) {
            const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
            headers['Content-Length'] = String(length);
        }
        const reqOptions = {
            method,
            headers,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
        };
        const handleResponse = (res) => {
            try {
                resolve(wrapNativeResponse(res));
            } catch (error) {
                res.destroy();
                reject(error);
            }
        };

        if (proxy) {
            let proxyParsed;
            try {
                proxyParsed = new URL(proxy);
            } catch (error) {
                reject(new Error(`Invalid proxy URL: ${proxy}`));
                return;
            }
            if (proxyParsed.protocol !== 'http:' && proxyParsed.protocol !== 'https:') {
                reject(new Error(`Unsupported proxy protocol: ${proxyParsed.protocol}`));
                return;
            }
            const proxyPort = Number(proxyParsed.port) || (proxyParsed.protocol === 'https:' ? 443 : 80);
            const auth = proxyBasicAuth(proxyParsed);
            if (isHttps) {
                // CONNECT 隧道
                const connectHeaders = { Host: `${parsed.hostname}:${parsed.port || 443}` };
                if (auth) {
                    connectHeaders['Proxy-Authorization'] = auth;
                }
                const connectReq = http.request({
                    hostname: proxyParsed.hostname,
                    port: proxyPort,
                    method: 'CONNECT',
                    path: `${parsed.hostname}:${parsed.port || 443}`,
                    headers: connectHeaders,
                });
                connectReq.on('connect', (res, socket) => {
                    if (res.statusCode !== 200) {
                        socket.destroy();
                        reject(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
                        return;
                    }
                    const req = https.request({
                        ...reqOptions,
                        agent: false,
                        createConnection: () => socket,
                    }, handleResponse);
                    req.on('error', (error) => reject(error));
                    attachAbortAndBody(req, init);
                });
                connectReq.on('error', (error) => reject(error));
                attachAbortAndBody(connectReq, { signal: init.signal });
            } else {
                // http 目标走代理：向代理发送绝对 URL
                const proxiedHeaders = { ...headers, Host: parsed.host };
                if (auth) {
                    proxiedHeaders['Proxy-Authorization'] = auth;
                }
                const req = http.request({
                    hostname: proxyParsed.hostname,
                    port: proxyPort,
                    method,
                    path: parsed.href,
                    headers: proxiedHeaders,
                }, handleResponse);
                req.on('error', (error) => reject(error));
                attachAbortAndBody(req, init);
            }
        } else {
            const mod = isHttps ? https : http;
            const req = mod.request(reqOptions, handleResponse);
            req.on('error', (error) => reject(error));
            attachAbortAndBody(req, init);
        }
    });
}

const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'EPROTO']);

function connectFailureHint(error, url) {
    const code = (error && error.code) || (error && error.cause && error.cause.code);
    if (!code || !CONNECT_CODES.has(code)) {
        return null;
    }
    let host;
    try {
        host = new URL(url).host;
    } catch {
        return null;
    }
    return `Could not connect to ${host} (${code}). The request never reached the network. If this machine reaches the internet through a proxy, set HTTPS_PROXY/HTTP_PROXY, or run: visionforge config set proxy <url>`;
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
    const effectiveProxy = resolveProxy(proxy, env);
    try {
        const response = await rawApiRequest(url, init, effectiveProxy);
        try {
            const buffered = Buffer.from(await response.arrayBuffer());
            return new Response(buffered, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (bodyError) {
            return bodyFailedResponse(response, bodyError);
        }
    } catch (error) {
        const hint = connectFailureHint(error, url);
        throw hint ? new Error(hint, { cause: error }) : error;
    }
}
