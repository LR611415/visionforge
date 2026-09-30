// size.js — 分辨率词表 + 引擎能力表 + 默认画质决策（画质治理）
//
// 查证事实（各引擎官方文档，2026-09 复核）：
//   - qwen-image-3.0（dashscope-image）：总像素 512*512 ~ 2048*2048，宽高比 1:8~8:1，
//     未指定 size 时引擎自动推荐；显式指定则按 width*height。
//     2K（2560×1440 = 3.69MP）总像素与比例均合法 → 原生支持 2K。
//   - GLM-Image（openai-image 风格）：边长 512–2048、32 的倍数，推荐枚举 1280×1280 等；
//     2560 边长超上限 → 不支持 2K，最大为 2048×2048。
//   - Google Imagen 4 / Gemini（google-imagen / chat-native）：官方固定分辨率表，
//     含 1:1→2048²、16:9→2816×1536、4:3→2560×1792 等 → 支持 2K 及以上。
//   - OpenAI gpt-image-1（openai-image 风格官方端点）：size 枚举最大 1536×1024 / auto。
// 结论：未指定画质时——支持 2K 的引擎默认 2560×1440（2K），不支持 2K 的默认该引擎
// 最大分辨率（如 GLM 2048×2048）。真 4K 无引擎原生支持，超限按比例降级并给 note。

/** 引擎原生总像素上限（qwen-image-3.0 / 多数图像模型，保留旧导出）。 */
export const MAX_TOTAL_PIXELS = 2048 * 2048; // 4,194,304

/** 默认 1:1 最好画质（无引擎能力信息时的兜底，保留旧导出）。 */
export const DEFAULT_BEST_SIZE = { width: 2048, height: 2048 };

/** 2K 标准尺寸（QHD 2560×1440，16:9）。 */
export const DEFAULT_2K = { width: 2560, height: 1440 };

/**
 * 引擎能力表（按生图协议族）。
 * - supports2K：该族原生支持 2K（2560×1440 或官方表 ≥2K 级）→ 未指定时默认 2K。
 * - constraint：'pixels' = 总像素上限（qwen）；'side' = 每边上限（GLM/私有端点）；'table' = 官方固定表（Imagen，钳制按总像素近似，翻译器再按比例映射）。
 * - align：尺寸对齐粒度（GLM 要求 32 倍数）。
 */
export const ENGINE_SIZE_CAPS = {
    'dashscope-image': {
        supports2K: true,
        constraint: 'pixels',
        maxW: 2048,
        maxH: 2048,
        align: 8,
        note: 'qwen-image-3.0：总像素 512×512~2048×2048、宽高比 1:8~8:1，支持 2K（2560×1440）',
    },
    'openai-image': {
        supports2K: false,
        constraint: 'side',
        maxW: 2048,
        maxH: 2048,
        align: 32,
        note: 'GLM-Image：边长 512–2048、32 倍数（不支持 2K，默认最大 2048×2048；OpenAI gpt-image-1 官方枚举最大 1536×1024，可自行 --size 指定）',
    },
    'google-imagen': {
        supports2K: true,
        constraint: 'table',
        maxW: 2816,
        maxH: 1536,
        align: 8,
        note: 'Imagen 4 官方固定表：1:1→2048²、16:9→2816×1536、4:3→2560×1792 等，支持 2K',
    },
    'chat-native': {
        supports2K: true,
        constraint: 'table',
        maxW: 2816,
        maxH: 1536,
        align: 8,
        note: 'Gemini 多模态生成（官方表同 Imagen），支持 2K',
    },
    'raw-base64': {
        supports2K: true,
        constraint: 'side',
        maxW: 4096,
        maxH: 4096,
        align: 8,
        note: '私有端点无官方上限，按 2K 默认',
    },
};

/** 兜底能力（无匹配协议族时）：保守按 1:1 2048²，不默认 2K。 */
const GLOBAL_CAP = { supports2K: false, constraint: 'pixels', maxW: 2048, maxH: 2048, align: 8 };

// 口头分辨率词表（中文语境约定；2K 与 2.5K 均指 QHD 2560×1440）
const SIZE_WORDS = new Map([
    ['4k', [3840, 2160]],
    ['4k-uhd', [3840, 2160]],
    ['uhd', [3840, 2160]],
    ['2.5k', [2560, 1440]],
    ['2k', [2560, 1440]],
    ['qhd', [2560, 1440]],
    ['1080p', [1920, 1080]],
    ['fhd', [1920, 1080]],
    ['hd', [1920, 1080]],
    ['720p', [1280, 720]],
    ['高清', [1920, 1080]],
    ['超清', [2048, 2048]],
]);

/** 词条 → 面向用户的显示名（如 2k → 2K）。 */
const SIZE_WORD_LABEL = new Map([
    ['4k', '4K'],
    ['4k-uhd', '4K'],
    ['uhd', '4K'],
    ['2.5k', '2.5K'],
    ['2k', '2K'],
    ['qhd', '2K'],
    ['1080p', '1080P'],
    ['fhd', '1080P'],
    ['hd', '1080P'],
    ['720p', '720P'],
    ['高清', '1080P'],
    ['超清', '2048×2048'],
]);

/** 协议族 → 面向用户的引擎可读名（内置 vs 自定义）。 */
const FAMILY_READABLE = {
    'dashscope-image': 'Qwen（内置，config set qwen.apiKey 后可直接切换）',
    'google-imagen': 'Imagen 4（自定义引擎：config add-engine 添加）',
    'chat-native': 'Gemini（自定义引擎：config add-engine 添加）',
    'raw-base64': '私有端点（自定义引擎）',
};

/**
 * 找出原生支持 (dw, dh) 分辨率的所有引擎（按能力表，返回可读名列表）。
 * 用于"该引擎不支持需求分辨率"时建议可切换的引擎。
 */
export function enginesSupporting(dw, dh) {
    const names = [];
    for (const [family, cap] of Object.entries(ENGINE_SIZE_CAPS)) {
        const ok = cap.constraint === 'side' ? dw <= cap.maxW && dh <= cap.maxH : dw * dh <= cap.maxW * cap.maxH;
        if (ok && FAMILY_READABLE[family]) names.push(FAMILY_READABLE[family]);
    }
    return names;
}

/** 按尺寸反查词条显示名（WxH 分支降级时复用词表语义）。 */
function labelFor(rawW, rawH) {
    for (const [word, [w, h]] of SIZE_WORDS) {
        if (w === rawW && h === rawH) return SIZE_WORD_LABEL.get(word) ?? word;
    }
    return undefined;
}

/** 归一化口头词（去空格、小写、统一连字符）。 */
function normalizeWord(word) {
    return word.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * 保持宽高比把 (w, h) 钳制到引擎能力之内。
 * - constraint 'side'：每边 ≤ cap.maxW / cap.maxH（GLM 等边长上限）。
 * - constraint 'pixels' | 'table'：总像素 ≤ cap.maxW * cap.maxH（qwen / Imagen 近似）。
 * 对齐到 cap.align（默认 8）；未超限时原样返回。
 */
export function clampSize(width, height, cap = GLOBAL_CAP) {
    const c = cap ?? GLOBAL_CAP;
    const w = Math.max(1, Math.floor(Number(width)));
    const h = Math.max(1, Math.floor(Number(height)));
    const align = (n) => Math.max(c.align || 8, Math.floor(n / (c.align || 8)) * (c.align || 8));
    if (c.constraint === 'side') {
        if (w <= c.maxW && h <= c.maxH) {
            return [w, h];
        }
        const scale = Math.min(c.maxW / w, c.maxH / h);
        return [align(w * scale), align(h * scale)];
    }
    const maxPixels = c.maxW * c.maxH;
    if (w * h <= maxPixels) {
        return [w, h];
    }
    const scale = Math.sqrt(maxPixels / (w * h));
    return [align(w * scale), align(h * scale)];
}

function noteFor(cap, w, h, rawW, rawH, demandLabel) {
    const dem = demandLabel ?? `${rawW}×${rawH}`;
    const support = enginesSupporting(rawW, rawH);
    const head =
        cap.constraint === 'side'
            ? `引擎边长上限 ${cap.maxW}px（${cap.note}）`
            : `引擎原生总像素上限 ${((cap.maxW * cap.maxH) / 1e6).toFixed(2)}MP`;
    const common = support.filter((n) => !n.includes('私有端点'));
    if (common.length > 0) {
        return `${head}，该引擎不支持 ${dem}（${rawW}×${rawH}），已按本引擎最大分辨率生成 ${w}×${h}。支持 ${dem} 的引擎：${common.join('、')}。切换后重新生成即可。`;
    }
    if (support.length > 0) {
        return `${head}，该引擎不支持 ${dem}（${rawW}×${rawH}），已按本引擎最大分辨率生成 ${w}×${h}。常见引擎暂无原生支持 ${dem}，仅自定义私有端点可直出；如确需该分辨率，请使用外部超分放大。`;
    }
    return `${head}，当前没有引擎原生支持 ${dem}（${rawW}×${rawH}），已按本引擎最大分辨率生成 ${w}×${h}；如确需该分辨率，请使用外部超分放大。`;
}

/**
 * 解析用户给出的画质要求（undefined / 词表 / WxH），按引擎能力决定默认。
 * 返回 { size: 'W*H', note?: string }——size 为内部标准格式（翻译器按协议族再转换）。
 * - 未指定 → 支持 2K 的引擎默认 2560*1440（2K）；不支持 2K 的默认该引擎最大分辨率
 * - 词表（4k / 2.5k / 2k / 1080p / 高清 / 超清…）→ 映射并钳制到引擎能力
 * - WxH / W×H / W*H → 解析并钳制
 * - 无法识别 → 原样返回（错误交给引擎可见）
 */
export function resolveSize(size, cap = GLOBAL_CAP) {
    const c = cap ?? GLOBAL_CAP;
    const raw = typeof size === 'string' ? size.trim() : '';
    if (raw === '' || /^(auto|default|best|最好|最佳)$/i.test(raw)) {
        if (c.supports2K) {
            return { size: `${DEFAULT_2K.width}*${DEFAULT_2K.height}` };
        }
        const [w, h] = clampSize(c.maxW, c.maxH, c);
        return { size: `${w}*${h}` };
    }
    const word = normalizeWord(raw);
    const mapped = SIZE_WORDS.get(word);
    if (mapped) {
        const rawW = mapped[0];
        const rawH = mapped[1];
        const [w, h] = clampSize(rawW, rawH, c);
        if (w !== rawW || h !== rawH) {
            return { size: `${w}*${h}`, note: noteFor(c, w, h, rawW, rawH, SIZE_WORD_LABEL.get(word)) };
        }
        return { size: `${w}*${h}` };
    }
    const m = raw.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i);
    if (m) {
        const rawW = Number(m[1]);
        const rawH = Number(m[2]);
        const [w, h] = clampSize(rawW, rawH, c);
        const exceeded = c.constraint === 'side' ? rawW > c.maxW || rawH > c.maxH : rawW * rawH > c.maxW * c.maxH;
        return {
            size: `${w}*${h}`,
            ...(exceeded ? { note: noteFor(c, w, h, rawW, rawH, labelFor(rawW, rawH)) } : {}),
        };
    }
    return { size: raw };
}
