// ==UserScript==
// @name         17Lands 中文卡图替换 + 卡组构筑器
// @namespace    https://github.com/tttyz9/17lands-cn-userscript
// @version      0.42
// @description  卡图中文替换 + 卡组构筑器 + 牌表导出 + 卡图打印
// @author       阿T
// @match        https://www.17lands.com/*
// @match        https://17lands.com/*
// @icon         https://www.17lands.com/static/favicon-32x32.png
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      images.mtgch.com
// @connect      api.scryfall.com
// @connect      www.17lands.com
// @connect      17lands.com
// @connect      cards.scryfall.io
// @run-at       document-start
// @license      MIT
// @homepageURL  https://github.com/tttyz9/17lands-cn-userscript
// @supportURL   https://github.com/tttyz9/17lands-cn-userscript/issues
// @updateURL    https://github.com/tttyz9/17lands-cn-userscript/raw/main/17lands-cn.user.js
// @downloadURL  https://github.com/tttyz9/17lands-cn-userscript/raw/main/17lands-cn.user.js
// ==/UserScript==


(function() {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // ================================================================
    //  全局错误可视化（仅显示本脚本报错，便于定位；不改变任何逻辑）
    // ================================================================
    function mcIsOurs(err) {
        const s = (err && (err.stack || err.message || String(err))) || '';
        return /mtgcn|mc-|fetchDraftPool|openBuilder|buildUI|rerender|renderCard|renderStats|injectButtons|webpToPng|exportWord|exportTTS|gmFetch|collectTokens|scryGet/.test(s);
    }
    function mcShowErr(where, err) {
        console.error('[17Lands-CN] ' + where + ':', err);
        try {
            if (!mcIsOurs(err)) return; // 忽略 17lands 页面自身报错
            const s = (err && (err.stack || err.message || String(err))) || String(err);
            let box = document.getElementById('mc-err-box');
            if (!box) {
                box = document.createElement('div'); box.id = 'mc-err-box';
                box.style.cssText = 'position:fixed;left:8px;bottom:8px;max-width:92vw;max-height:60vh;overflow:auto;z-index:2147483649;background:#712B13;color:#fff;padding:10px 14px;border-radius:8px;font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;box-shadow:0 6px 24px rgba(0,0,0,.5)';
                (document.body || document.documentElement).appendChild(box);
            }
            box.textContent = '[17Lands-CN 出错] ' + where + ':\n' + s;
        } catch (e) {}
    }
    W.addEventListener('error', e => mcShowErr('window.error', e.error || e.message));
    W.addEventListener('unhandledrejection', e => mcShowErr('unhandledrejection', e.reason));

    // ================================================================
    //  通用工具
    // ================================================================
    const RE = /https:\/\/cards\.scryfall\.io\/[a-z_]+\/front\/[a-f0-9]\/[a-f0-9]\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg/gi;
    const REPLAY_RE = /\/site_draft_replay\/([a-f0-9]{32})/i;
    const POOL_PREFIX = 'mtgcn_pool_';
    const DATA_URL = 'https://www.17lands.com/data/site_draft_replay?draft_id=';

    function uuidFromUrl(url) {
        if (!url) return null;
        const m = String(url).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        return m ? m[1] : null;
    }
    function replaceUrl(text) {
        // 先收集基本地 UUID（按卡名判断，基本地不替换卡图）
        try { const p = JSON.parse(text); if (p) collectBasics(p); } catch (e) {}
        return text.replace(RE, function(match) {
            const uuid = uuidFromUrl(match);
            if (!uuid || BASIC_UUIDS.has(uuid)) return match; // 基本地不替换，保留 Scryfall 原图
            return 'https://images.mtgch.com/zhs/large/front/' + uuid[0] + '/' + uuid[1] + '/' + uuid + '.webp';
        });
    }
    function cnImg(uuid) {
        if (!uuid) return '';
        return 'https://images.mtgch.com/zhs/large/front/' + uuid[0] + '/' + uuid[1] + '/' + uuid + '.webp';
    }
    function gmFetch(url, opts) {
        opts = opts || {};
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET', url, headers: opts.headers || {},
                data: opts.data || null, responseType: opts.responseType || 'text',
                onload: r => resolve(r), onerror: e => reject(e), ontimeout: () => reject(new Error('timeout ' + url))
            });
        });
    }
    function currentDraftId() {
        const m = location.pathname.match(REPLAY_RE);
        return m ? m[1] : null;
    }
    function parseManaCost(mc) {
        let cmc = 0; const colors = new Set();
        if (!mc) return { cmc: 0, colors: [] };
        const re = /\{([^}]+)\}/g; let m;
        while ((m = re.exec(mc))) {
            const s = m[1].toUpperCase();
            if (/^\d+$/.test(s)) cmc += parseInt(s);
            else if (s === 'X' || s === 'Y' || s === 'Z') {}
            else if (/^[WUBRG]$/.test(s)) { cmc += 1; colors.add(s); }
            else if (/^[WUBRG]\/[WUBRG]$/.test(s)) { cmc += 1; s.split('/').forEach(c => colors.add(c)); }
            else if (/^[WUBRG]\/P$/.test(s)) { cmc += 1; colors.add(s[0]); }
            else if (s === 'S' || s === 'C') cmc += 1;
            else cmc += 1;
        }
        return { cmc, colors: [...colors] };
    }

    const CARDS = {};
    try { Object.assign(CARDS, JSON.parse(GM_getValue('mtgcn_meta_cache_v1', '{}'))); } catch (e) {}
    function saveMeta() { try { GM_setValue('mtgcn_meta_cache_v1', JSON.stringify(CARDS)); } catch (e) {} }
    function cardOf(key) {
        if (CARDS[key]) return CARDS[key];
        if (key.indexOf('name::') === 0) return { uuid: '', name: key.slice(6), set: '', cmc: 0, colors: [], type_line: 'Land', img: '' };
        return { name: '(未知)', cmc: 0, colors: [], type_line: '', img: '' };
    }
    // 基本地名称集合（images.mtgch.com/zhs 无中文卡图，需回退 Scryfall 原图）
    const BASIC_LANDS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', '平原', '海岛', '沼泽', '山脉', '森林']);
    function isBasicLand(key) {
        const c = cardOf(key);
        return BASIC_LANDS.has(c.name) || BASIC_LANDS.has(key.replace(/^name::/, ''));
    }
    // 所有地（含非基本地）：按 type_line 含 land 或卡名为基本地
    function isLand(key) {
        const c = cardOf(key);
        const t = (c.type_line || '').toLowerCase();
        return t.includes('land') || isBasicLand(key);
    }
    // 基本地 UUID 集合：从卡牌数据接口收集（参考 v0.1 思路——按卡名判断基本地，不替换其卡图）
    const BASIC_UUIDS = new Set();
    // 基本地可靠卡图缓存：name → Scryfall 大图 URL（从 cards/named 预取，避免 17lands 基本地 image_url 缺失/失效导致空白）
    const BASIC_IMG = {};
    function collectBasics(obj) {
        try {
            if (Array.isArray(obj)) { obj.forEach(collectBasics); return; }
            if (obj && typeof obj === 'object') {
                if (typeof obj.name === 'string' && BASIC_LANDS.has(obj.name) && typeof obj.image_url === 'string') {
                    const u = uuidFromUrl(obj.image_url); if (u) BASIC_UUIDS.add(u);
                }
                if (obj.pick && typeof obj.pick === 'object') collectBasics(obj.pick);
                for (const k in obj) { if (obj[k] && typeof obj[k] === 'object') collectBasics(obj[k]); }
            }
        } catch (e) {}
    }
    function imgFor(key) {
        const c = cardOf(key);
        if (isBasicLand(key)) {
            // 基本地：用 Scryfall 按名取得的可靠卡图（中文站 images.mtgch.com/zhs 无基本地卡图；17lands 基本地 image_url 常缺失/失效）。
            // 绝不替换为中文 webp，避免 404 空白；其 uuid 已加入 BASIC_UUIDS，fixImg 会跳过替换。
            if (BASIC_IMG[c.name]) return BASIC_IMG[c.name];        // 预取的 Scryfall 大图（最可靠）
            if (c.orig_url) return c.orig_url;                      // 兜底：17lands 原始 image_url
            if (c.uuid) return 'https://cards.scryfall.io/large/front/' + c.uuid[0] + '/' + c.uuid[1] + '/' + c.uuid + '.jpg';
            return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
        }
        return c.uuid ? cnImg(c.uuid) : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
    }

    // ================================================================
    //  模块 1 — 卡图替换
    // ================================================================
    const _fetch = W.fetch;
    W.fetch = async function(input, init) {
        const response = await _fetch.call(this, input, init);
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('json')) {
            const text = await response.clone().text();
            if (text.includes('scryfall.io')) {
                try { const p = JSON.parse(text); if (p) collectBasics(p); } catch (e) {}
                return new Response(replaceUrl(text), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
        }
        return response;
    };
    const XHRopen = W.XMLHttpRequest.prototype.open;
    const XHRsend = W.XMLHttpRequest.prototype.send;
    W.XMLHttpRequest.prototype.open = function(method, url) { this._zhUrl = url; XHRopen.apply(this, arguments); };
    W.XMLHttpRequest.prototype.send = function() {
        const xhr = this;
        xhr.addEventListener('load', function() {
            try {
                const text = xhr.responseText;
                if (text && text.includes('scryfall.io')) {
                    try { const p = JSON.parse(text); if (p) collectBasics(p); } catch (e) {}
                    Object.defineProperty(xhr, 'responseText', { value: replaceUrl(text), configurable: true });
                }
            } catch (e) {}
        });
        XHRsend.apply(this, arguments);
    };
    function fixImg(img) {
        if (img._fixed) return;
        const src = img.src;
        if (src && src.includes('scryfall.io')) { img._fixed = true; img.src = replaceUrl(src); }
    }
    function fixBg(el) {
        if (el._bgFixed) return;
        const bg = getComputedStyle(el).backgroundImage || '';
        if (bg && bg.includes('scryfall.io')) { el._bgFixed = true; el.style.backgroundImage = replaceUrl(bg); }
    }
    function scan(root) {
        root.querySelectorAll('img').forEach(fixImg);
        root.querySelectorAll('[style*="background"], .card, [class*="card"]').forEach(fixBg);
    }
    new MutationObserver(function(mutations) {
        for (const m of mutations) for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.tagName === 'IMG') fixImg(node);
            scan(node);
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (document.body) scan(document);

    // ================================================================
    //  模块 2 — 拉取轮抓卡池
    // ================================================================
    async function fetchDraftPool(draftId, seat) {
        let url = DATA_URL + draftId;
        if (seat && /^[0-9]+$/.test(String(seat))) url += '&seat=' + encodeURIComponent(seat);
        const r = await gmFetch(url);
        const data = JSON.parse(r.responseText);
        const expansion = data.expansion || 'LTR';
        // 清空旧系列基本地缓存（避免跨系列串图），稍后预取本次系列的全部 5 种基本地
        BASIC_UUIDS.clear();
        Object.keys(BASIC_IMG).forEach(k => delete BASIC_IMG[k]);
        const pool = {};
        (data.picks || []).forEach(p => {
            const card = p.pick;
            if (!card || !card.name) return;
            const uuid = uuidFromUrl(card.image_url);
            const key = uuid || ('name::' + card.name);
            if (!CARDS[key]) {
                const mc = card.mana_cost || '';
                const { cmc, colors } = parseManaCost(mc);
                const types = card.types || [];
                const isBasic = BASIC_LANDS.has(card.name);
                if (isBasic && uuid) BASIC_UUIDS.add(uuid); // 基本地不替换卡图
                CARDS[key] = { uuid: uuid || '', name: card.name, set: expansion, type_line: types.join(' '), types, mana_cost: mc, cmc, colors, rarity: '', collector_number: '', img: uuid ? cnImg(uuid) : '', orig_url: card.image_url || '' };
            }
            pool[key] = (pool[key] || 0) + 1;
        });
        // 预取全部 5 种基本地可靠卡图（Scryfall 按名，set 优先），保证「加地」时主牌 0 费列必有基本地卡图；
        // 同时把其 uuid 加入 BASIC_UUIDS，使 fixImg 不会把基本地卡图替换成中文 webp（mtgch 无基本地→404）
        const basicNames = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
        await Promise.all(basicNames.map(async (name) => {
            const tryFetch = async (url) => { const r = await gmFetch(url); const j = JSON.parse(r.responseText); if (!j.image_uris && j.card_faces && j.card_faces[0]) return j.card_faces[0]; return j; };
            let j = null;
            try { j = await tryFetch('https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(name) + '&set=' + expansion.toLowerCase()); }
            catch (e) { try { j = await tryFetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name)); } catch (e2) {} }
            if (j && j.image_uris && j.image_uris.large) {
                BASIC_IMG[name] = j.image_uris.large;
                const u = uuidFromUrl(j.image_uris.large); if (u) BASIC_UUIDS.add(u);
            } else {
                // 兜底：用 17lands 原始 image_url 对应的 scryfall 大图
                const pk = (data.picks || []).find(p => p.pick && p.pick.name === name && p.pick.image_url);
                if (pk) { const u = uuidFromUrl(pk.pick.image_url); if (u) { BASIC_UUIDS.add(u); BASIC_IMG[name] = 'https://cards.scryfall.io/large/front/' + u[0] + '/' + u[1] + '/' + u + '.jpg'; } }
            }
        }));
        saveMeta();
        // 不再缓存池数据到本地（用户要求每次重新拉取）
        console.log('[17Lands-CN] 卡池已获取 draftId=' + draftId + ' expansion=' + expansion + ' picks=' + (data.picks || []).length + ' unique=' + Object.keys(pool).length);
        return { pool, expansion };
    }

    // ================================================================
    //  模块 3 — 历史页注入按钮（紧跟链接）
    // ================================================================
    // 全局样式（按钮在页面内、不在 #mtgcn-builder 内，需独立注入）
    function injectGlobalStyle() {
        if (document.getElementById('mc-global-style')) return;
        const s = document.createElement('style'); s.id = 'mc-global-style';
        s.textContent = [
            '.mc-build-btn{display:inline-flex;align-items:center;gap:6px;margin:0 0 0 6px;padding:3px 13px;',
            'font:600 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;',
            'background:linear-gradient(135deg,#6b5ce7,#3C3489);border:1px solid rgba(255,255,255,.18);',
            'border-radius:14px;cursor:pointer;vertical-align:middle;box-shadow:0 1px 4px rgba(60,52,137,.4);',
            'transition:filter .15s,transform .1s,box-shadow .15s}',
            '.mc-build-btn:hover{filter:brightness(1.1);box-shadow:0 2px 9px rgba(60,52,137,.5)}',
            '.mc-build-btn:active{transform:translateY(1px)}',
            '.mc-build-btn .mc-bspin{width:12px;height:12px;border:2px solid rgba(255,255,255,.4);',
            'border-top-color:#fff;border-radius:50%;animation:mcspin .7s linear infinite;display:none}',
            '.mc-build-btn.is-loading{pointer-events:none;opacity:.85}',
            '.mc-build-btn.is-loading .mc-bspin{display:inline-block}',
            '@keyframes mcspin{to{transform:rotate(360deg)}}'
        ].join('');
        (document.head || document.documentElement).appendChild(s);
    }
    function injectButtons() {
        injectGlobalStyle();
        document.querySelectorAll('a[href*="/site_draft_replay/"]').forEach(a => {
            if (a._mtgcnBtn) return;
            const m = a.getAttribute('href').match(REPLAY_RE);
            if (!m) return;
            a._mtgcnBtn = true;
            const seat = new URL(a.href, location.href).searchParams.get('seat');
            const btn = document.createElement('button');
            btn.className = 'mc-build-btn';
            btn.dataset.draftId = m[1];
            if (seat) btn.dataset.seat = seat;
            btn.innerHTML = '<span class="mc-bspin"></span><span>构筑牌组</span>';
            btn.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (btn.classList.contains('is-loading')) return;
                btn.classList.add('is-loading');
                openBuilder(m[1], seat).finally(() => btn.classList.remove('is-loading'));
            };
            a.after(btn);
        });
    }
    new MutationObserver(() => { try { injectButtons(); } catch (e) {} }).observe(document.documentElement, { childList: true, subtree: true });

    // ================================================================
    //  模块 4 — MTGA Possible Maindeck 风格构筑器（原始卡图 · 堆叠展开 · 深浅主题切换）
    // ================================================================
    // 数据模型：main = Array<{key,col}>（每张卡为独立实例，col=显示列0..7，可跨列自由拖拽/同列重排），side = Array<{key,n}>，pool = Array<{key}>
    let STATE = { main: [], side: [], pool: [], lands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 }, landSet: 'LTR', mainSort: 'cmc', poolSort: 'cmc', includeTokens: true };
    let CUR_DRAFT = null;
    let FILTERS = { colors: [], cmc: 'all', type: 'all', q: '' };
    let DRAG = null; // {key, zone, entry}
    let CARD_SCALE = 1; // 卡图缩放系数（滑块控制）
    // 兜底：拖拽若被打断（拖出窗口 / 按 ESC / 浏览器失焦），卡片的 dragend 可能不触发，
    // 导致 DRAG 卡死 → 之后所有卡图 hover 被 `if (DRAG) return` 拦截，悬浮放大再也不显示。
    // 用全局监听强制清空（只挂一次）。
    if (!window.__mtgcnDragGuard) {
        window.__mtgcnDragGuard = true;
        document.addEventListener('dragend', () => { DRAG = null; }, true);
        document.addEventListener('drop',   () => { DRAG = null; }, true);
        window.addEventListener('blur',    () => { DRAG = null; });
    }

    function deckKey(id) { return 'mtgcn_deck_' + id; }
    function loadState(id) {
        try {
            const v = JSON.parse(GM_getValue(deckKey(id), 'null'));
            if (v) STATE = Object.assign(STATE, v);
        } catch (e) {}
        // 旧 Object 形态迁移 → Array（主牌带 col 列号，每张卡独立实例）
        // 兼容新旧格式：旧格式 {key,n,col}（n>1 展开为多个独立实例）；新格式 {key,col}
        // 对脏数据免疫：跳过 null / 缺 key 的残留项
        function toArray(obj) {
            if (Array.isArray(obj)) {
                const out = [];
                obj.forEach(e => {
                    if (!e || typeof e !== 'object' || typeof e.key !== 'string' || !e.key.length) return;
                    const cnt = (typeof e.n === 'number' && e.n > 0) ? e.n : 1;
                    const col = (e.col != null ? e.col : cmcCol(e.key));
                    for (let i = 0; i < cnt; i++) out.push({ key: e.key, col });
                });
                return out;
            }
            if (obj && typeof obj === 'object') {
                const out = [];
                Object.keys(obj).forEach(k => {
                    const cnt = (typeof obj[k] === 'number' && obj[k] > 0) ? obj[k] : 1;
                    const col = cmcCol(k);
                    for (let i = 0; i < cnt; i++) out.push({ key: k, col });
                });
                return out.sort((a, b) => (cardOf(a.key).cmc || 0) - (cardOf(b.key).cmc || 0));
            }
            return [];
        }
        STATE.main = toArray(STATE.main);
        STATE.side = toArray(STATE.side);
        if (!Array.isArray(STATE.pool)) STATE.pool = [];
        if (!STATE.lands) STATE.lands = { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 };
        if (!STATE.mainSort) STATE.mainSort = 'cmc';
        if (!STATE.poolSort) STATE.poolSort = 'cmc';
    }
    function saveState() { /* v0.20: 不再本地存档牌组状态（用户要求每次重新拉取） */ }

    // —— 数组操作 ——
    function arrFind(arr, key) { return arr.findIndex(x => x.key === key); }
    function arrInc(arr, key, idx) { // 在 idx 处插入或合并 +1
        const i = arrFind(arr, key);
        if (i >= 0) { arr[i].n++; return; }
        arr.splice(idx == null || idx > arr.length ? arr.length : idx, 0, { key, n: 1 });
    }
    function arrDec(arr, key) { // 减 1，n<=0 删
        const i = arrFind(arr, key);
        if (i < 0) return;
        arr[i].n--;
        if (arr[i].n <= 0) arr.splice(i, 1);
    }
    function arrCount(arr) { return arr.reduce((a, x) => a + x.n, 0); }
    function poolCount() { return STATE.pool.length; }
    function mainCount() { return STATE.main.length; }

    // —— 主牌：STATE.main = Array<{key,col}>（每张卡为独立实例，可跨列自由拖拽/同列重排）——
    function cmcCol(key) { const c = cardOf(key); return Math.min(Math.max(c.cmc || 0, 0), 7); }
    // 把一个主牌实例插入到某列的 idx 位置（idx 为列内序号；省略则追加到列尾）
    function insertMainAtCol(entry, col, idx) {
        entry.col = col;
        const colEntries = STATE.main.filter(x => x.col === col && x !== entry);
        if (idx == null || idx >= colEntries.length) {
            let lastIdx = -1; STATE.main.forEach((x, i) => { if (x.col === col) lastIdx = i; });
            if (lastIdx < 0) STATE.main.push(entry); else STATE.main.splice(lastIdx + 1, 0, entry);
        } else {
            const ref = colEntries[idx];
            STATE.main.splice(STATE.main.indexOf(ref), 0, entry);
        }
    }
    // 新增一张（默认落入其费用列；或指定 col/idx）
    function addToMain(key, col, idx) {
        const c = (col == null ? cmcCol(key) : col);
        insertMainAtCol({ key, col: c }, c, idx);
    }
    function removeFromMain(entry) { const i = STATE.main.indexOf(entry); if (i >= 0) STATE.main.splice(i, 1); }
    // 把已存在的主牌实例移动到目标列/位置（跨列拖拽 + 同列重排 通用，每张卡独立，不再按卡名绑定）
    function relocateMain(entry, targetCol, idx) {
        const from = STATE.main.indexOf(entry);
        if (from >= 0) STATE.main.splice(from, 1);
        insertMainAtCol(entry, targetCol, idx);
    }

    // —— 地卡：基本地作为「主牌 0 费列」里的卡实例（带卡图），STATE.lands 由其派生（单一真源 = STATE.main）——
    const COLOR_LAND = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
    const LAND_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
    const LAND_CN = { Plains: '平原', Island: '海岛', Swamp: '沼泽', Mountain: '山脉', Forest: '森林' };
    function landKeyOf(name) { return 'name::' + name; }
    // 由主牌中的基本地实例刷新 STATE.lands 计数（加/减地、自动配置、拖拽后都同步）
    function syncLandsFromMain() {
        const have = { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 };
        STATE.main.forEach(x => { if (isBasicLand(x.key)) { const n = cardOf(x.key).name; if (have[n] !== undefined) have[n]++; } });
        STATE.lands = have;
    }
    // 按比例分配整数（最大余数法，保证总和恰为 total）
    function allocate(weights, total) {
        const keys = Object.keys(weights);
        const sum = keys.reduce((a, k) => a + (weights[k] || 0), 0);
        const out = {}; keys.forEach(k => out[k] = 0);
        if (sum <= 0) return out;
        const raw = {}; let used = 0;
        keys.forEach(k => { raw[k] = weights[k] / sum * total; out[k] = Math.floor(raw[k]); used += out[k]; });
        let rem = total - used;
        const fracs = keys.map(k => ({ k, f: raw[k] - Math.floor(raw[k]) })).sort((a, b) => b.f - a.f);
        for (let i = 0; i < rem; i++) out[fracs[i % fracs.length].k]++;
        return out;
    }
    // 刷新地卡面板 + 主牌（加/减/自动配置共用）。地卡数字由 rerender() 内 syncLandsFromMain() 统一派生，此处只需保存并重渲染。
    function refreshLands() {
        saveState(); rerender();
    }
    // 加地：往主牌 0 费列推入一张该系列基本地卡实例（卡图随之出现在 0 费列）
    function addLand(name) { STATE.main.push({ key: landKeyOf(name), col: 0 }); refreshLands(); }
    // 减地：从主牌中移除一张该基本地实例；找不到（已为 0）则不动——地卡绝不减到负数
    function decLand(name) {
        for (let i = STATE.main.length - 1; i >= 0; i--) {
            const x = STATE.main[i];
            if (isBasicLand(x.key) && cardOf(x.key).name === name) { STATE.main.splice(i, 1); break; }
        }
        refreshLands();
    }
    // 渲染右侧「基本地」+/- 面板（加/减即向主牌 0 费列推入/移除基本地卡实例，因此主牌 0 费列会显示对应卡图）
    function renderLandsPanel(root) {
        const landsEl = root.querySelector('#mc-lands'); if (!landsEl) return;
        const LANDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
        landsEl.innerHTML = '';
        LANDS.forEach(name => {
            const d = document.createElement('div'); d.className = 'mc-land'; d.innerHTML = '<b>' + (LAND_CN[name] || name) + '</b>';
            const m = document.createElement('span'); m.textContent = STATE.lands[name] || 0;
            const mi = document.createElement('button'); mi.textContent = '−'; const pl = document.createElement('button'); pl.textContent = '+';
            mi.onclick = () => decLand(name);
            pl.onclick = () => addLand(name);
            d.appendChild(mi); d.appendChild(m); d.appendChild(pl); landsEl.appendChild(d);
        });
    }
    // 自动配置地卡：按主牌非地牌的颜色符号数量 + 曲线权重分配各色地，并扣除已存在于主牌里的地（避免重复）
    function autoLand(totalLands) {
        const TOTAL = Math.max(0, Math.min(40, totalLands | 0));
        // 已存在于主牌里的所有地（基本地+非基本地）都要从目标总数中扣除，避免重复
        const existingLandCount = STATE.main.filter(x => isLand(x.key)).length;
        const targetBasics = Math.max(0, TOTAL - existingLandCount);
        // 颜色需求权重：按费用中实际颜色符号计数，并给低费咒语更高权重（因为它们更早需要颜色）
        const w = { W: 0, U: 0, B: 0, R: 0, G: 0 };
        STATE.main.forEach(x => {
            if (isLand(x.key)) return;
            const c = cardOf(x.key);
            if (!c.mana_cost) return;
            // 曲线因子：1费≈1.75，2费≈1.5，3费≈1.25，5费≈0.75，高费递减
            const factor = Math.min(2.0, Math.max(0.6, 2.0 - (c.cmc || 0) * 0.25));
            const re = /\{([^}]+)\}/g; let m;
            while ((m = re.exec(c.mana_cost))) {
                const s = m[1].toUpperCase();
                if (/^[WUBRG]$/.test(s)) w[s] += factor;
                else if (/^[WUBRG]\/[WUBRG]$/.test(s)) s.split('/').forEach(col => { if (w[col] !== undefined) w[col] += factor * 0.5; });
                else if (/^[WUBRG]\/P$/.test(s)) { if (w[s[0]] !== undefined) w[s[0]] += factor * 0.5; }
            }
        });
        // 已存在于主牌里的基本地（按可产颜色统计）—— 这些「已能生产的费用」要扣除，不重复配置
        const have = { W: 0, U: 0, B: 0, R: 0, G: 0 };
        STATE.main.forEach(x => { if (isBasicLand(x.key)) { const c = LAND_COLOR[cardOf(x.key).name]; if (c) have[c]++; } });
        const sumW = Object.values(w).reduce((a, b) => a + b, 0);
        let targets;
        if (sumW > 0) targets = allocate(w, targetBasics);
        else {
            const sumHave = Object.values(have).reduce((a, b) => a + b, 0);
            targets = sumHave > 0 ? allocate(have, targetBasics) : allocate({ W: 1, U: 1, B: 1, R: 1, G: 1 }, targetBasics);
        }
        // 应用净增/净减
        ['W', 'U', 'B', 'R', 'G'].forEach(c => {
            const name = COLOR_LAND[c];
            const net = (targets[c] || 0) - have[c];
            if (net > 0) { for (let i = 0; i < net; i++) STATE.main.push({ key: landKeyOf(name), col: 0 }); }
            else if (net < 0) { for (let i = 0; i < -net; i++) { for (let j = STATE.main.length - 1; j >= 0; j--) { if (isBasicLand(STATE.main[j].key) && LAND_COLOR[cardOf(STATE.main[j].key).name] === c) { STATE.main.splice(j, 1); break; } } } }
        });
        refreshLands();
    }

    // —— 筛选 ——
    function passFilter(key) {
        const c = cardOf(key);
        if (FILTERS.colors.length && !FILTERS.colors.every(x => (c.colors || []).includes(x))) return false;
        if (FILTERS.cmc !== 'all') { const v = c.cmc || 0; if (FILTERS.cmc === '7+') { if (v < 7) return false; } else if (v !== parseInt(FILTERS.cmc)) return false; }
        if (FILTERS.type !== 'all') { const t = (c.type_line || '').toLowerCase(); const map = { creature: 'creature', instant: 'instant', sorcery: 'sorcery', artifact: 'artifact', enchantment: 'enchantment', planeswalker: 'planeswalker', land: 'land' }; if (!t.includes(map[FILTERS.type])) return false; }
        if (FILTERS.q && !(c.name || '').toLowerCase().includes(FILTERS.q.toLowerCase())) return false;
        return true;
    }

    // —— 排序 ——
    function sortCmp(keyA, keyB, sortKey) {
        const a = cardOf(keyA), b = cardOf(keyB);
        if (sortKey === 'name') return (a.name || '').localeCompare(b.name || '');
        if (sortKey === 'cmc') return (a.cmc || 0) - (b.cmc || 0) || (a.name || '').localeCompare(b.name || '');
        if (sortKey === 'type') return (a.type_line || '').localeCompare(b.type_line || '');
        if (sortKey === 'color') { const ca = (a.colors || []).join('') || 'Z', cb = (b.colors || []).join('') || 'Z'; return ca.localeCompare(cb) || (a.cmc || 0) - (b.cmc || 0); }
        return 0;
    }

    // —— MTGA Possible Maindeck 风格：原始卡图渲染 ——
    // 同名多张 = 多张独立卡图（不合并）；相邻同名卡堆叠（扑克牌效果）
    // 只显示原始中文 webp 卡图（自带完整卡框：卡名/费用/类型/描述）
    function renderCard(key, n, zone, entry, stackOffset) {
        const c = cardOf(key);
        const card = document.createElement('div');
        card.className = 'mc-card';
        card.dataset.key = key; card.dataset.zone = zone;
        if (entry && entry.col != null) card.dataset.col = entry.col;
        // 原始中文卡图（images.mtgch.com/zhs webp，带完整 MTG 卡框）
        const img = document.createElement('img'); img.src = imgFor(key); img.alt = c.name || '';
        img.onerror = () => { img.style.opacity = .2; };
        card.appendChild(img);
        // 堆叠偏移（同名第2张起向上偏移，露出下面卡的边缘）— 偏移量由 CSS .mc-stacked 按缩放比例计算
        if (stackOffset > 0) { card.classList.add('mc-stacked'); }
        // hover 金色高亮 + 浮出大图预览（拖拽中不显示）
        card.addEventListener('mouseenter', () => { if (DRAG) return; showHoverZoom(imgFor(card.dataset.key), 'card', card.getBoundingClientRect(), [370 * CARD_SCALE, 518 * CARD_SCALE]); });
        card.addEventListener('mouseleave', hideHoverZoom);
        // HTML5 拖拽
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
            hideHoverZoom(); // 拖拽开始时立即隐藏大图
            DRAG = { key, zone, entry: entry || null };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', key);
            card.classList.add('mc-dragging');
        });
        card.addEventListener('dragend', () => { DRAG = null; card.classList.remove('mc-dragging'); clearDropIndicators(); });
        return card;
    }

    // —— 悬浮放大卡图：构筑器卡图 + token 弹窗小图 共用同一套逻辑 ——
    // 仅存在一个全局浮层 #mc-hover-zoom，避免重复实现。
    let _mcHz = null;
    function mcHoverEl() {
        // 若浮层被移除（buildUI 在切换历史/座位时会删 #mc-hover-zoom）而 _mcHz 仍指向游离节点，
        // 需重建并重新挂回 document.body，否则 hover 大图永远显示不出来。
        if (!_mcHz || !document.body.contains(_mcHz)) {
            if (_mcHz && _mcHz.parentNode) _mcHz.parentNode.removeChild(_mcHz);
            _mcHz = document.createElement('div');
            _mcHz.id = 'mc-hover-zoom';
            _mcHz.innerHTML = '<img>';
            document.body.appendChild(_mcHz);
        }
        return _mcHz;
    }
    // mode: 'card' 锚定到 rect（默认卡图右侧）；'mouse' 跟随鼠标 event
    function showHoverZoom(src, mode, ref, size) {
        try {
            const el = mcHoverEl();
            el.querySelector('img').src = src;
            if (size) { el.style.width = size[0] + 'px'; el.style.height = size[1] + 'px'; }
            el.style.display = 'block';
            posHoverZoom(el, mode, ref);
        } catch (e) { /* 静默忽略预览异常 */ }
    }
    function posHoverZoom(el, mode, ref) {
        const w = el.offsetWidth, h = el.offsetHeight;
        let x, y;
        if (mode === 'mouse') {
            const e = ref;
            x = e.clientX + 18; y = e.clientY - h / 2;
            if (x + w > window.innerWidth - 8) x = e.clientX - w - 18; // 右侧放不下翻到左侧
        } else {
            const r = ref;
            x = r.right + 12; y = r.top;                              // 默认贴在卡图右侧
            if (x + w > window.innerWidth - 8) x = r.left - w - 12;   // 右侧放不下翻到左侧
        }
        if (x < 8) x = 8;
        if (y < 8) y = 8;
        if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8; // 底部夹住
        el.style.left = x + 'px'; el.style.top = y + 'px';
    }
    function hideHoverZoom() { if (_mcHz) _mcHz.style.display = 'none'; }
    function poolTakeOne(entry) {
        if (!entry) return;
        const i = STATE.pool.indexOf(entry);
        if (i >= 0) { STATE.pool.splice(i, 1); return; }
        const j = STATE.pool.findIndex(e => e && e.key === entry.key);
        if (j >= 0) STATE.pool.splice(j, 1);
    }

    // —— drop indicator ——
    function clearDropIndicators() { document.querySelectorAll('.mc-drop-line').forEach(e => e.remove()); }
    function showDropLine(container, idx) {
        clearDropIndicators();
        const line = document.createElement('div'); line.className = 'mc-drop-line';
        const children = [...container.children].filter(c => !c.classList.contains('mc-drop-line'));
        if (idx >= children.length) container.appendChild(line);
        else container.insertBefore(line, children[idx]);
    }

    // zone 容器拖拽接收（zone: pool/main/side；col 仅主牌列用到）
    function wireDropZone(container, zone, col) {
        container.addEventListener('dragover', (e) => {
            if (!DRAG) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const after = getDropIndex(container, e.clientX, e.clientY);
            showDropLine(container, after);
        });
        container.addEventListener('drop', (e) => {
            if (!DRAG) return;
            e.preventDefault();
            const idx = getDropIndex(container, e.clientX, e.clientY);
            clearDropIndicators();
            handleDrop(zone, col, idx);
        });
    }
    function getDropIndex(container, x, y) {
        const children = [...container.children].filter(c => !c.classList.contains('mc-drop-line') && !c.classList.contains('mc-dragging'));
        for (let i = 0; i < children.length; i++) {
            const r = children[i].getBoundingClientRect();
            if (y < r.top + r.height / 2 && (y < r.top || x < r.left + r.width / 2)) return i;
        }
        return children.length;
    }
    function handleDrop(targetZone, targetCol, idx) {
        if (!DRAG) return;
        const { key, zone: src, entry: srcEntry } = DRAG;
        if (targetZone === 'main') {
            if (src === 'main' && srcEntry) {
                // 主牌实例移动到目标列/位置：跨列自由拖拽 + 同列重排 通用（每张卡独立，不再按卡名绑定为一摞）
                relocateMain(srcEntry, targetCol, idx);
            } else if (src === 'pool') { poolTakeOne(srcEntry); addToMain(key, targetCol, idx); }
            else if (src === 'side') { arrDec(STATE.side, key); addToMain(key, targetCol, idx); }
        } else if (targetZone === 'pool') {
            if (src === 'main' && srcEntry) { removeFromMain(srcEntry); STATE.pool.push({ key }); }
            else if (src === 'side') { arrDec(STATE.side, key); STATE.pool.push({ key }); }
        } else if (targetZone === 'side') {
            if (src === 'main' && srcEntry) { removeFromMain(srcEntry); arrInc(STATE.side, key); }
            else if (src === 'pool') { poolTakeOne(srcEntry); arrInc(STATE.side, key); }
        }
        saveState(); rerender();
    }

    // —— 统计卡片 ——
    function renderStats(panel) {
        const mainCount = STATE.main.length;
        const mainCards = [];
        STATE.main.forEach(x => { mainCards.push(cardOf(x.key)); });
        const curve = {}; for (let i = 0; i <= 7; i++) curve[i] = 0;
        const colors = { W: 0, U: 0, B: 0, R: 0, G: 0 };
        const types = { Creature: 0, Instant: 0, Sorcery: 0, Artifact: 0, Enchantment: 0, Land: 0, Other: 0 };
        mainCards.forEach(c => {
            curve[Math.min(c.cmc || 0, 7)]++;
            (c.colors || []).forEach(x => { if (colors[x] !== undefined) colors[x]++; });
            const t = (c.type_line || '').toLowerCase();
            if (t.includes('creature')) types.Creature++; else if (t.includes('instant')) types.Instant++; else if (t.includes('sorcery')) types.Sorcery++;
            else if (t.includes('artifact')) types.Artifact++; else if (t.includes('enchantment')) types.Enchantment++; else if (t.includes('land')) types.Land++; else types.Other++;
        });
        // 地张数：所有 type_line 含 land 的卡（包括轮抓中抓到的非基本地，如多色地/神器地）
        const landN = mainCards.filter(c => (c.type_line || '').toLowerCase().includes('land')).length;
        const nonLandN = Math.max(0, mainCount - landN);
        const total = mainCount + arrCount(STATE.side);
        const warn = (total > 0 && total !== 40);
        let html = '<div class="mc-stat-card"><b>张数</b><div class="mc-stat-val' + (warn ? ' mc-warn' : '') + '">主牌(含地) ' + mainCount + ' = 非地 ' + nonLandN + ' + 地 ' + landN + '，备 ' + arrCount(STATE.side) + '</div></div>';
        // 法术力曲线：最高柱 = 满高(MAX_H)，其余按“张数/最多张数”比例缩放
        // 例：仅 2 费 1 张 → 2 费满高；2 费 2 张 + 1 费 1 张 → 2 费满高、1 费半高
        const MAX_H = 200;
        const counts = []; for (let i = 0; i <= 7; i++) counts.push(curve[i]);
        const maxC = Math.max(1, ...counts);
        let bars = '';
        for (let i = 0; i <= 7; i++) {
            const c = curve[i];
            const h = c > 0 ? Math.max(3, Math.round(c / maxC * MAX_H)) : 0;
            bars += '<div class="mc-bar"><span class="mc-bar-n">' + c + '</span><div class="mc-bar-fill" style="height:' + h + 'px"></div><span class="mc-bar-x">' + (i === 7 ? '7+' : i) + '</span></div>';
        }
        html += '<div class="mc-stat-card"><b>法术力曲线</b><span class="mc-curve-note">满高 = ' + maxC + ' 张</span><div class="mc-curve"><div class="mc-cgrid"></div>' + bars + '</div></div>';
        html += '<div class="mc-stat-card"><b>颜色</b><div class="mc-colors">' + ['W', 'U', 'B', 'R', 'G'].map(x => '<span class="mc-c mc-c' + x + '">' + x + '<b>' + colors[x] + '</b></span>').join('') + '</div></div>';
        html += '<div class="mc-stat-card"><b>类型</b><div class="mc-stat-val">' + Object.entries(types).filter(e => e[1]).map(e => e[0] + '×' + e[1]).join(' · ') + '</div></div>';
        panel.innerHTML = html;
    }

    // —— 渲染（主牌=单一自由拖拽区，卡池/备牌=紧凑卡图网格）——
    function rerender() {
        const root = document.getElementById('mtgcn-builder'); if (!root) return;
        // 基本地数字以「主牌中实际基本地卡实例」为唯一真源：每次重渲染都重新派生并刷新面板，
        // 这样把地卡拖出/拖入主牌、减地、自动配置后，面板数字与实际卡图永远同步（修复拖出地卡数字不变）。
        syncLandsFromMain();
        renderLandsPanel(root);
        // 卡池：每张卡独立显示（同名也拆成单张），按位置紧凑堆叠
        const poolList = root.querySelector('#mc-pool-list');
        poolList.innerHTML = '';
        let poolPos = 0;
        STATE.pool.filter(e => passFilter(e.key)).sort((a, b) => sortCmp(a.key, b.key, STATE.poolSort)).forEach(e => {
            poolList.appendChild(renderCard(e.key, 1, 'pool', e, poolPos > 0 ? 1 : 0));
            poolPos++;
        });
        // 主牌：按费用分 8 列（0..7+），每列独立拖拽区；每张卡为独立实例，可跨列自由拖拽、同列内自由重排（同名不再绑定为一摞）
        const mainCols = root.querySelector('#mc-main-cols');
        mainCols.innerHTML = '';
        for (let col = 0; col < 8; col++) {
            const colEl = document.createElement('div'); colEl.className = 'mc-mcol';
            const h = document.createElement('div'); h.className = 'mc-mcol-h'; h.textContent = (col === 7 ? '7+' : String(col));
            colEl.appendChild(h);
            const list = document.createElement('div'); list.className = 'mc-mcol-list';
            const colEntries = STATE.main.filter(x => x.col === col && (isBasicLand(x.key) || passFilter(x.key)));
            colEntries.forEach((entry, pos) => {
                // 每张卡独立渲染（stackOffset 仅做紧凑堆叠观感，不影响独立拖拽）
                list.appendChild(renderCard(entry.key, 1, 'main', entry, pos > 0 ? 1 : 0));
            });
            colEl.appendChild(list);
            mainCols.appendChild(colEl);
            wireDropZone(list, 'main', col);
        }
        // 备牌：每张独立显示，按位置紧凑堆叠
        const sideList = root.querySelector('#mc-side-list');
        sideList.innerHTML = '';
        let sidePos = 0;
        STATE.side.filter(x => passFilter(x.key)).forEach(x => {
            for (let s = 0; s < x.n; s++) {
                sideList.appendChild(renderCard(x.key, x.n, 'side', x, sidePos > 0 ? 1 : 0));
                sidePos++;
            }
        });

        root.querySelector('#mc-pool-h').textContent = '卡池 (' + poolCount() + ')';
        root.querySelector('#mc-main-h').textContent = '主牌 (' + mainCount() + ')';
        root.querySelector('#mc-side-h').textContent = '备牌 (' + arrCount(STATE.side) + ')';
        renderStats(root.querySelector('#mc-stats'));
    }

    async function openBuilder(draftId, seat) {
        // 每次全新开始：不读本地存档，清空 STATE
        STATE = { main: [], side: [], pool: [], lands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 }, landSet: 'LTR', mainSort: 'cmc', poolSort: 'cmc', includeTokens: true };
        CUR_DRAFT = draftId;
        showLoading('正在拉取轮抓卡池…');
        try {
            const { pool, expansion } = await fetchDraftPool(draftId, seat);
            STATE.landSet = expansion;
            Object.keys(pool).forEach(k => {
                if (arrFind(STATE.main, k) < 0 && arrFind(STATE.side, k) < 0) {
                    for (let i = 0; i < pool[k]; i++) STATE.pool.push({ key: k });
                }
            });
            // 不 saveState（用户要求每次全新拉取）
        } catch (e) { console.warn('[17Lands-CN] 拉取卡池失败', e); alert('拉取卡池失败: ' + e + '\n可改用搜索加卡手动构筑。'); }
        hideLoading();
        try { buildUI(); rerender(); }
        catch (e) { mcShowErr('openBuilder→buildUI', e); alert('构筑器渲染出错：\n' + (e && e.stack ? e.stack : e) + '\n\n请把这段发我，我好定位问题。'); }
    }

    function buildUI() {
        let root = document.getElementById('mtgcn-builder'); if (root) root.remove();
        // 清理上一次的悬浮预览层（避免切换历史/座位后预览失效）
        const oldPreview = document.getElementById('mc-hover-zoom');
        if (oldPreview) oldPreview.remove();
        _mcHz = null; // 同步清空模块级引用，否则 mcHoverEl 会返回已脱离文档的游离节点导致 hover 失效
        root = document.createElement('div'); root.id = 'mtgcn-builder';
        root.innerHTML = `
<style>
/* ===== MTGA Possible Maindeck — 主题变量 + 原始卡图网格 + 深浅切换 ===== */
#mtgcn-builder{position:fixed;inset:0;z-index:2147483647;
  --bg:#1a1a1c;--bg2:#222;--bg3:#252528;--bg4:#2a2a2d;--bg5:#1e1e20;
  --fg:#ccc;--fg2:#e0e0e0;--fg3:#fff;--sub:#888;--accent:#3C3489;--accent2:#534AB7;
  --border:#333;--border2:#444;--hover-bg:#D4A843;--warn:#E55B5B;
  --mc-scale:1;
  background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;font-size:13px;display:flex;flex-direction:column}
/* 浅色主题 */
#mtgcn-builder.mc-light{
  --bg:#f4f4f7;--bg2:#fff;--bg3:#EEEDFE;--bg4:#f8f8fb;--bg5:#fafafc;
  --fg:#222;--fg2:#333;--fg3:#000;--sub:#666;--accent:#3C3489;--accent2:#534AB7;
  --border:#e0e0e6;--border2:#d0d0da;--hover-bg:#534AB7;--warn:#993C1D}
/* 容器内所有 label 清除默认/继承 margin（含 17lands 全局 label margin-bottom），统一紧凑对齐 */
#mtgcn-builder label{margin:0}
#mc-top{background:var(--accent);color:#fff;padding:6px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:44px}
#mc-top b{font-size:15px;margin-right:auto;flex-shrink:0;display:flex;align-items:center}
/* 顶栏控件严格统一（按钮 / 缩放滑块 / 含指示物复选框 同高同圆角同背景） */
.mc-top-btn,.mc-top-range,.mc-top-check{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:32px;min-height:32px;padding:0 12px;font-size:12px;font-weight:600;border:0;border-radius:8px;white-space:nowrap;vertical-align:middle;cursor:pointer;background:#fff;color:var(--accent);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:filter .15s,transform .05s;margin:0}
.mc-top-btn:hover,.mc-top-range:hover,.mc-top-check:hover{filter:brightness(1.05)}
.mc-top-btn:active,.mc-top-range:active,.mc-top-check:active{transform:translateY(1px)}
.mc-top-btn.x{background:#712B13;color:#fff}
.mc-top-range{gap:5px}
.mc-top-range input[type=range]{width:80px;height:6px;margin:0;padding:0;accent-color:var(--accent);cursor:pointer}
.mc-top-range span{min-width:38px;text-align:right}
.mc-top-check{gap:5px}
.mc-top-check input[type=checkbox]{width:15px;height:15px;margin:0;padding:0;accent-color:var(--accent);cursor:pointer}
#mc-theme-btn{background:#fff;color:var(--accent)}
/* 筛选栏 */
#mc-filters{display:flex;gap:6px;flex-wrap:wrap;padding:6px 10px;background:var(--bg2);border-bottom:1px solid var(--border);align-items:center}
#mc-filters b{color:var(--sub)}
#mc-filters input,#mc-filters select{font-size:12px;padding:3px;background:var(--bg4);color:var(--fg);border:1px solid var(--border2)}
#mc-filters label{display:inline-flex;align-items:center;gap:3px;font-size:12px;color:var(--fg);cursor:pointer}
#mc-filters input[type=checkbox]{width:14px;height:14px;margin:0;accent-color:var(--accent)}
/* 三列布局 */
#mc-main-row{flex:1;display:flex;overflow:hidden}
#mc-cols{flex:1;display:grid;grid-template-columns:200px 1fr 200px;gap:6px;padding:6px;overflow:hidden}
.mc-col{background:var(--bg2);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.mc-col h3{margin:0;padding:6px 8px;background:var(--bg3);color:var(--accent);font-size:12px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)}

/* ===== 卡图区域：多列原始 MTG 卡图网格 ===== */
.mc-list{flex:1;overflow:auto;padding:10px;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;background:var(--bg5)}
/* 主牌：按费用 8 列（0..7+）曲线棋盘，每列独立拖拽区，列内可自由拖拽排序 */
#mc-main-cols{flex:1;display:flex;gap:4px;overflow:auto;padding:6px;background:var(--bg5);align-items:stretch}
.mc-mcol{display:flex;flex-direction:column;width:calc(168px*var(--mc-scale));flex-shrink:0;background:var(--bg2);border:1px solid var(--border);border-radius:6px;overflow:hidden}
.mc-mcol-h{text-align:center;font-weight:bold;padding:3px;background:var(--bg3);color:var(--accent);border-bottom:1px solid var(--border);font-size:12px}
.mc-mcol-list{flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px;align-items:center;min-height:60px}
.mc-mcol-list .mc-card{width:calc(154px*var(--mc-scale));height:calc(216px*var(--mc-scale))}
/* 单张卡：原始中文 webp 图片（带完整 MTG 卡框） */
.mc-card{width:calc(168px*var(--mc-scale));height:calc(235px*var(--mc-scale));border-radius:5px;overflow:hidden;background:var(--bg4);
  border:2px solid var(--border2);flex-shrink:0;cursor:grab;position:relative;
  box-shadow:0 2px 5px rgba(0,0,0,.35);
  transition:border-color .15s,box-shadow .15s,transform .12s,z-index .12s}
.mc-card img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
/* hover：金色高亮 + 轻微放大 + 光晕 */
.mc-card:hover{
  border-color:#D4A843!important;
  box-shadow:0 0 16px rgba(212,168,67,.45),0 4px 16px rgba(0,0,0,.4);
  transform:scale(1.05) translateY(-3px);z-index:100!important}
.mc-card:active{cursor:grabbing}
.mc-card.mc-dragging{opacity:.35;transform:scale(.96)}
/* 堆叠：同名第2张起向上偏移（紧凑，露出约 18% 边缘），随缩放同步 */
.mc-card.mc-stacked{margin-top:calc(216px*var(--mc-scale)*-0.82)}
/* drop indicator */
.mc-drop-line{width:3px;align-self:stretch;background:#D4A843;border-radius:2px;margin:0 1px}

/* 悬浮放大预览（构筑器卡图 与 token 弹窗小图 共用一套逻辑，无金框） */
#mc-hover-zoom{position:fixed;z-index:2147483652;pointer-events:none;
  border:0;border-radius:8px;
  box-shadow:0 10px 40px rgba(0,0,0,.55);
  background:var(--bg);display:none;overflow:hidden}
#mc-hover-zoom img{width:100%;height:100%;display:block;object-fit:contain}

/* 右栏统计面板 */
#mc-side-panel{width:210px;background:var(--bg2);border-left:1px solid var(--border);padding:8px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.mc-stat-card{border:1px solid var(--border);border-radius:6px;padding:6px;background:var(--bg5)}
.mc-stat-card b{font-size:11px;color:var(--sub);display:block;margin-bottom:4px}
.mc-stat-val{font-size:12px;color:var(--fg)}
.mc-warn{color:var(--warn);font-weight:bold}
/* 曲线：最高柱=满高，其余按“张数/最多张数”比例缩放；网格线按 1/4 等分（满高=最多张数） */
.mc-curve{position:relative;display:flex;align-items:flex-end;gap:4px;height:240px;padding:0 2px 22px;background:var(--bg5);border-radius:4px}
.mc-cgrid{position:absolute;left:0;right:0;top:0;bottom:16px;
  background:repeating-linear-gradient(to top,transparent 0,transparent 49px,var(--border) 49px,var(--border) 50px);pointer-events:none}
.mc-bar{position:relative;flex:1;height:218px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end}
.mc-bar-n{font-size:10px;color:var(--fg3);font-weight:700;margin-bottom:6px;z-index:1}
.mc-bar-fill{width:72%;max-width:20px;background:linear-gradient(to top,#3C3489,#534AB7);border-radius:3px 3px 0 0;min-height:2px;transition:height .2s}
.mc-bar-x{position:absolute;bottom:-20px;font-size:10px;color:var(--sub)}
.mc-curve-note{float:right;font-size:10px;color:var(--sub);font-weight:normal}
/* 颜色点 */
.mc-colors{display:flex;gap:3px}
.mc-c{font-size:10px;padding:2px 4px;border-radius:3px;color:#fff;font-weight:bold;text-align:center;width:34px}
.mc-c b{display:block;color:#fff}
.mc-cW{background:#E5D9A0;color:#5a4a00}.mc-cW b{color:#5a4a00}
.mc-cU{background:#5EB7E5}.mc-cB{background:#888}.mc-cR{background:#E55B5B}.mc-cG{background:#6FB85E}
/* 地牌 */
.mc-land{display:flex;align-items:center;gap:4px;margin:2px 0;font-size:12px;color:var(--fg)}
.mc-land b{width:50px;color:var(--fg2)}
.mc-land button{width:20px;height:20px;font-size:12px;background:var(--bg4);color:var(--accent);border:1px solid var(--border2);border-radius:3px;cursor:pointer}
.mc-land span{text-align:center;width:28px;color:var(--fg)}
/* loading / search / misc */
#mc-loading{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:2147483648;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:system-ui,sans-serif;gap:16px;padding:30px;text-align:center}
#mc-loading .mc-spin{width:44px;height:44px;border:4px solid rgba(255,255,255,.22);border-top-color:#534AB7;border-radius:50%;animation:mcspin .8s linear infinite}
#mc-loading .mc-msg{font-size:15px;opacity:.95;letter-spacing:.5px}
@keyframes mcspin{to{transform:rotate(360deg)}}
.mc-sr{font-size:12px;border:1px solid var(--border2);border-radius:4px;padding:4px;margin:3px 0;display:flex;gap:4px;align-items:center;background:var(--bg5);color:var(--fg)}
.mc-sr img{width:28px;height:39px}
.mc-sr button{background:var(--accent);color:#fff;border:0;border-radius:3px;padding:1px 6px;cursor:pointer}
.mc-collapsed{display:none}
.mc-panel-h{font-size:12px;font-weight:bold;cursor:pointer;color:var(--accent);padding:4px;border-bottom:1px solid var(--border)}
</style>
<div id="mc-top"><b>卡组构筑器 · draft <span id="mc-did"></span></b>
  <button id="mc-theme-btn" class="mc-top-btn">🌙 深色</button>
  <label class="mc-top-range">卡图 <input type="range" id="mc-zoom" min="0.6" max="1.6" step="0.05" value="1"> <span id="mc-zoom-val">100%</span></label>
  <label class="mc-top-check">含指示物 <input type="checkbox" id="mc-inc-tokens" checked></label>
  <button id="mc-allin" class="mc-top-btn">一键全入主牌</button>
  <button id="mc-tts" class="mc-top-btn">导出牌表</button>
  <button id="mc-word" class="mc-top-btn">打印卡图</button>
  <button id="mc-close" class="mc-top-btn x">关闭</button></div>
<div id="mc-filters"><b>筛选:</b>
  <label><input type="checkbox" value="W">白</label><label><input type="checkbox" value="U">蓝</label>
  <label><input type="checkbox" value="B">黑</label><label><input type="checkbox" value="R">红</label><label><input type="checkbox" value="G">绿</label>
  CMC<select id="mc-fcmc"><option value="all">全部</option><option>0</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option><option>7+</option></select>
  类型<select id="mc-ft"><option value="all">全部</option><option value="creature">生物</option><option value="instant">瞬间</option><option value="sorcery">法术</option><option value="artifact">神器</option><option value="enchantment">结界</option><option value="planeswalker">鹏洛客</option><option value="land">地</option></select>
  <input id="mc-fq" placeholder="卡名搜索…" style="flex:1;min-width:60px">
  卡池排序<select id="mc-psort"><option value="cmc">费用</option><option value="name">名字</option><option value="type">类型</option><option value="color">颜色</option></select>
  主牌排序<select id="mc-msort"><option value="cmc">曲线(费用)</option><option value="color">颜色</option><option value="type">类型</option><option value="name">名字</option></select>
  <span style="font-size:11px;color:#666">拖动卡图在 卡池 / 主牌 / 备牌 间移动</span>
</div>
<div id="mc-main-row"><div id="mc-cols">
  <div class="mc-col"><h3><span id="mc-pool-h">卡池</span></h3><div id="mc-pool-list" class="mc-list"></div></div>
  <div class="mc-col"><h3><span id="mc-main-h">主牌</span></h3><div id="mc-main-cols"></div></div>
  <div class="mc-col"><h3><span id="mc-side-h">备牌</span></h3><div id="mc-side-list" class="mc-list"></div></div>
</div><div id="mc-side-panel">
  <div id="mc-stats"></div>
  <div><div class="mc-panel-h">基本地 <span id="mc-landset-label" style="font-weight:normal;float:right"></span></div>
    系列:<input id="mc-landset" style="width:60px">
    <div style="display:flex;gap:4px;align-items:center;margin:5px 0;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--sub)">地总数</span>
      <input id="mc-landtotal" type="number" min="0" max="40" value="17" style="width:46px;font-size:12px;padding:2px;background:var(--bg4);color:var(--fg);border:1px solid var(--border2)">
      <button id="mc-autoland" class="mc-build-btn" style="margin:0;padding:3px 10px">自动配置地卡</button>
    </div>
    <div id="mc-lands"></div></div>
  <div><div class="mc-panel-h" id="mc-srch-toggle">搜索加卡 ▸</div>
    <div id="mc-srch-box" class="mc-collapsed"><input id="mc-sq" placeholder="Scryfall搜索…" style="width:100%"><div id="mc-sr-list"></div></div></div>
</div></div>`;
        document.body.appendChild(root);
        root.querySelector('#mc-did').textContent = (CUR_DRAFT || '').slice(0, 8);
        root.querySelector('#mc-close').onclick = () => root.remove();

        // 主题切换（深色 / 浅色）
        const themeBtn = root.querySelector('#mc-theme-btn');
        let isLight = false;
        themeBtn.onclick = () => {
            isLight = !isLight;
            root.classList.toggle('mc-light', isLight);
            themeBtn.textContent = isLight ? '☀️ 浅色' : '🌙 深色';
        };

        // 卡图缩放滑块（同步缩放所有卡图 + 列宽 + 悬浮预览）
        const zoom = root.querySelector('#mc-zoom');
        const applyZoom = () => {
            const v = parseFloat(zoom.value) || 1;
            CARD_SCALE = v;
            root.style.setProperty('--mc-scale', v);
            root.querySelector('#mc-zoom-val').textContent = Math.round(v * 100) + '%';
        };
        zoom.oninput = applyZoom; applyZoom();

        const sync = () => {
            FILTERS.colors = [...root.querySelectorAll('#mc-filters input[type=checkbox]:checked')].map(c => c.value);
            FILTERS.cmc = root.querySelector('#mc-fcmc').value; FILTERS.type = root.querySelector('#mc-ft').value;
            FILTERS.q = root.querySelector('#mc-fq').value;
            STATE.poolSort = root.querySelector('#mc-psort').value;
            const newSort = root.querySelector('#mc-msort').value;
            if (newSort !== STATE.mainSort) {
                STATE.mainSort = newSort;
                STATE.main.sort((a, b) => sortCmp(a.key, b.key, newSort));
                saveState();
            }
            rerender();
        };
        root.querySelectorAll('#mc-filters input,#mc-filters select').forEach(e => e.oninput = sync);
        root.querySelector('#mc-psort').value = STATE.poolSort;
        root.querySelector('#mc-msort').value = STATE.mainSort;

        // 地牌
        const landsetInput = root.querySelector('#mc-landset');
        landsetInput.value = STATE.landSet || 'LTR';
        root.querySelector('#mc-landset-label').textContent = '(' + (STATE.landSet || 'LTR') + ')';
        landsetInput.onchange = (e) => { STATE.landSet = e.target.value.toUpperCase(); root.querySelector('#mc-landset-label').textContent = '(' + STATE.landSet + ')'; saveState(); };
        // 自动配置地卡：按主牌颜色比例分配各色地，扣除已存在的地；地总数取输入框
        const autoBtn = root.querySelector('#mc-autoland');
        if (autoBtn) autoBtn.onclick = () => {
            const t = parseInt(root.querySelector('#mc-landtotal').value, 10);
            autoLand(isNaN(t) ? 17 : t);
        };
        const LANDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
        const CN = { Plains: '平原', Island: '海岛', Swamp: '沼泽', Mountain: '山脉', Forest: '森林' };
        const landsEl = root.querySelector('#mc-lands');
        renderLandsPanel(root);

        // 搜索加卡（加入卡池）
        const srchBox = root.querySelector('#mc-srch-box');
        root.querySelector('#mc-srch-toggle').onclick = () => {
            const open = srchBox.classList.toggle('mc-collapsed');
            root.querySelector('#mc-srch-toggle').textContent = '搜索加卡 ' + (open ? '▸' : '▾');
        };
        let t;
        root.querySelector('#mc-sq').oninput = (e) => {
            clearTimeout(t); const q = e.target.value.trim(); if (!q) return;
            t = setTimeout(async () => {
                const list = root.querySelector('#mc-sr-list'); list.innerHTML = '搜索中…';
                try {
                    const r = await gmFetch('https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q) + '&order=name&unique=art');
                    const res = (JSON.parse(r.responseText).data) || []; list.innerHTML = '';
                    res.slice(0, 30).forEach(c => {
                        CARDS[c.id] = { uuid: c.id, name: c.name, set: (c.set || '').toUpperCase(), type_line: c.type_line || '', cmc: c.cmc || 0, colors: c.colors || [], mana_cost: c.mana_cost || '', rarity: c.rarity || '', collector_number: c.collector_number || '', img: cnImg(c.id) };
                        const d = document.createElement('div'); d.className = 'mc-sr';
                        d.innerHTML = '<img src="' + cnImg(c.id) + '"><span style="flex:1">' + c.name + ' (' + (c.set || '').toUpperCase() + ')</span>';
                        const bm = document.createElement('button'); bm.textContent = '+池';
                        bm.onclick = () => { STATE.pool.push({ key: c.id }); saveState(); rerender(); };
                        d.appendChild(bm); list.appendChild(d);
                    });
                    if (!res.length) list.innerHTML = '无结果';
                } catch (err) { list.innerHTML = '出错:' + err; }
            }, 400);
        };

        // 一键全入主牌（按费用落入对应列，作为列内自由拖拽的初始顺序）
        root.querySelector('#mc-allin').onclick = () => {
            STATE.pool.forEach(e => addToMain(e.key, cmcCol(e.key)));
            STATE.pool = [];
            saveState(); rerender();
        };

        // 卡池 / 备牌 拖拽区（主牌 8 列在 rerender 内各自挂载，buildUI 仅挂载 卡池/备牌 一次）
        wireDropZone(root.querySelector('#mc-pool-list'), 'pool');
        wireDropZone(root.querySelector('#mc-side-list'), 'side');

        root.querySelector('#mc-tts').onclick = exportTTS;
        root.querySelector('#mc-word').onclick = exportWord;
        const incTok = root.querySelector('#mc-inc-tokens');
        if (incTok) incTok.onchange = (e) => { STATE.includeTokens = e.target.checked; };
    }

    // ================================================================
    //  模块 5 — TTS 牌表导出
    // ================================================================
    function download(text, name, type) {
        const blob = new Blob([text], { type: type || 'text/plain' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
    }
    // ============================================================
    //  统一导出解析：TTS 与 Word 共用同一来源（STATE.main / STATE.side）。
    //  基本地(name::X) → set 取当前系列 STATE.landSet，卡图取 BASIC_IMG（已按 set 预取）；
    //  非基本地       → 取 CARDS 元数据（含 set / 中文webp 或 Scryfall 原图）。
    //  这样 TTS 牌表的「数量 卡名 (SET)」与 Word 卡图都来自同一解析，
    //  地卡既带系列代码(如 Forest (LTR))、又不会重复导出（曾导致 TTS 地翻倍 + Word 空白尾页）。
    // ============================================================
    function exportCardInfo(key) {
        const c = cardOf(key);
        if (isBasicLand(key)) {
            const name = c.name || key.replace(/^name::/, '');
            return { name, set: (STATE.landSet || 'LTR').toUpperCase(), isBasic: true, imgUrl: BASIC_IMG[name] || (c.orig_url || '') };
        }
        return { name: c.name || '(未知)', set: (c.set || '').toUpperCase(), isBasic: false, imgUrl: imgFor(key) };
    }
    // TTS 牌表：数量 卡名 (SET)，按 主牌/备牌 遍历（地卡也在主牌中，自然带系列代码）
    function exportTTS() {
        function part(items, label) {
            let out = '// ' + label + '\n';
            const groups = {};
            items.forEach(x => {
                const n = (x.n != null ? x.n : 1); // 主牌为独立实例{key,col}→n=1；备牌为{key,n}
                const info = exportCardInfo(x.key);
                const gk = info.name + ' ' + info.set;
                if (!groups[gk]) groups[gk] = { name: info.name, set: info.set, total: 0 };
                groups[gk].total += n;
            });
            Object.keys(groups).forEach(gk => {
                const g = groups[gk];
                out += g.total + ' ' + g.name + (g.set ? ' (' + g.set + ')' : '') + '\n';
            });
            return out;
        }
        const out = part(STATE.main, '主牌') + '\n' + part(STATE.side, '备牌');
        download(out, 'deck_' + (CUR_DRAFT || '').slice(0, 8) + '_decklist.txt', 'text/plain');
    }
    if (typeof window !== 'undefined') window.__MC_EXPORT_CARDINFO = exportCardInfo;

    // ================================================================
    //  模块 6 — 卡图打印导出（A4 · 3×3=9张/页 · 真实 MTG 尺寸 · 最窄边框）
    // ================================================================
    // 策略：生成「打印级精确」HTML 文件（浏览器原生完美支持 @page/mm单位/table），
    //       用户打开后 Ctrl+P → 打印到 A4 纸。不再依赖 html-docx-js 做网格布局（它不支持 mm/@page/固定表宽，只能输出乱排图片）。
    // MTG 标准卡: 63mm × 88mm。打印优化版:
    //   CW=62.5mm, CH=87mm（保持原始比例 0.718）
    //   A4 = 210mm × 297mm, 页边距 M=2.5mm → 可用 205mm × 292mm
    //   3列: 列宽 = 205/3 ≈ 68.33mm;  3行: 行高 = 292/3 ≈ 97.33mm
    //   每格内居中放一张 62.5×87mm 卡图, 无边框, 纸张利用率 ~97%
    const _PW_COLS = 3, _PW_ROWS = 3, _PW_PER_PAGE = 9;
    const _PW_CW = '62.5mm', _PW_CH = '87mm';   // 打印卡图尺寸

    async function toPngDataUrl(imgUrl) {
        /* 将任意图片 URL 转为 PNG data URL (用于嵌入离线 HTML) */
        const r = await gmFetch(imgUrl, { responseType: 'arraybuffer' });
        // 用真实 content-type 建 blob（mtgch 是 webp，Scryfall 指示物是 jpg/png，误标会导致解码失败）
        let ct = 'image/webp';
        try { const m = String(r.responseHeaders || '').match(/content-type:\s*([^\s;]+)/i); if (m) ct = m[1]; } catch (e) {}
        const blob = new Blob([r.response], { type: ct });
        const url = URL.createObjectURL(blob);
        try {
            const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
            const cv = document.createElement('canvas'); cv.width = 488; cv.height = 680;
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            return cv.toDataURL('image/png');
        } finally { URL.revokeObjectURL(url); }
    }

    // —— 指示物(Token)收集：参考“TTS万智牌导出工具”的自动导入指示物 ——
    // 每张非地卡在 Scryfall 的 all_parts 里带 component==="token" 的子卡，
    // 这些就是该卡在游戏中会生成的指示物；按 token id 去重后抓取卡图，
    // 在「导出Word卡图」时一并打印（带金色边框 + “指示物”角标，与参考站一致）。
    let _scryLast = 0;
    const _scryCache = new Map();
    async function scryGet(url) {
        // 轻量限流：两次请求间隔≥80ms，规避 Scryfall 429 限流
        const wait = 80 - (Date.now() - _scryLast);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _scryLast = Date.now();
        const r = await gmFetch(url);
        return JSON.parse(r.responseText);
    }
    async function collectTokensForDeck() {
        const out = [];           // { id, name, imgUrl, key }
        const seen = new Set();
        const keys = new Set();
        STATE.main.forEach(x => keys.add(x.key));
        STATE.side.forEach(x => keys.add(x.key));
        for (const key of keys) {
            if (isBasicLand(key)) continue;
            const c = cardOf(key);
            if (!c || !c.name || c.name === '(未知)') continue;
            const cacheKey = c.set ? c.name + '|' + c.set : c.name;
            let info = _scryCache.get(cacheKey);
            if (info === undefined) {
                try { info = await scryGet('https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(c.name) + (c.set ? '&set=' + encodeURIComponent(c.set) : '')); }
                catch (e) { info = false; }
                _scryCache.set(cacheKey, info);
            }
            if (!info || !info.all_parts) continue;
            for (const p of info.all_parts) {
                if (p.component !== 'token' || !p.id || seen.has(p.id)) continue;
                seen.add(p.id);
                let t = null;
                try { t = await scryGet('https://api.scryfall.com/cards/' + p.id); } catch (e) { continue; }
                if (!t) continue;
                const imgUrl = (t.image_uris && t.image_uris.normal) ||
                    (t.card_faces && t.card_faces[0] && t.card_faces[0].image_uris && t.card_faces[0].image_uris.normal) || null;
                if (imgUrl) out.push({ id: p.id, name: t.name || p.name, imgUrl, key: 'token::' + p.id });
            }
        }
        return out;
    }

    // 选择指示物打印数量的弹窗（返回带 count 的 token 列表）
    function chooseTokenCounts(tokens) {
        return new Promise((resolve, reject) => {
            const host = document.getElementById('mtgcn-builder') || document.body;
            const overlay = document.createElement('div'); overlay.id = 'mc-token-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483650;display:flex;align-items:center;justify-content:center';
            const box = document.createElement('div'); box.id = 'mc-token-modal';
            box.style.cssText = 'background:var(--bg2,#fff);color:var(--fg,#222);border-radius:12px;padding:16px;max-width:min(560px,90vw);max-height:80vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:system-ui,sans-serif;min-width:300px';
            box.innerHTML = '<h3 style="margin:0 0 12px;font-size:15px">选择要打印的指示物数量</h3><div id="mc-token-list"></div>' +
                '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
                '<button id="mc-token-cancel" style="padding:6px 14px;border:0;border-radius:8px;background:#999;color:#fff;font-size:12px;font-weight:600;cursor:pointer">取消</button>' +
                '<button id="mc-token-confirm" style="padding:6px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:12px;font-weight:600;cursor:pointer">确认打印</button></div>';
            host.appendChild(overlay);
            overlay.appendChild(box);
            const list = box.querySelector('#mc-token-list');
            tokens.forEach((t, i) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:6px 0';
                row.innerHTML = '<img src="' + t.imgUrl + '" style="width:48px;height:67px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#ccc);flex-shrink:0;cursor:zoom-in">' +
                    '<span style="flex:1;font-size:13px;color:var(--fg)">' + (t.name || '指示物') + '</span>' +
                    '<input type="number" min="0" value="1" style="width:56px;text-align:center;font-size:13px;padding:2px;border:1px solid var(--border2,#ccc);border-radius:4px;background:var(--bg4);color:var(--fg)" data-idx="' + i + '">';
                list.appendChild(row);
                const img = row.querySelector('img');
                img.addEventListener('mouseenter', (e) => showHoverZoom(t.imgUrl, 'mouse', e, [220, 308]));
                img.addEventListener('mousemove', (e) => { if (_mcHz && _mcHz.style.display !== 'none') posHoverZoom(_mcHz, 'mouse', e); });
                img.addEventListener('mouseleave', hideHoverZoom);
            });
            const close = () => { hideHoverZoom(); overlay.remove(); };
            box.querySelector('#mc-token-cancel').onclick = () => { close(); reject('cancelled'); };
            box.querySelector('#mc-token-confirm').onclick = () => {
                const inputs = box.querySelectorAll('input[type=number]');
                const out = [];
                inputs.forEach((inp, i) => { out.push(Object.assign({}, tokens[i], { count: parseInt(inp.value, 10) || 0 })); });
                close(); resolve(out);
            };
        });
    }

    async function exportWord() {
        // ---- 收集主牌全部卡（统一来源：STATE.main，与 TTS 完全一致）----
        const list = [];
        STATE.main.forEach(x => { const info = exportCardInfo(x.key); list.push({ key: x.key, img: info.imgUrl, isToken: false }); });
        if (!list.length) { alert('主牌为空，无法打印'); return; }

        // ---- 进度提示 ----
        const status = document.createElement('div');
        status.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#3C3489;color:#fff;padding:8px 12px;border-radius:6px;z-index:2147483649';
        status.textContent = '准备卡图…';
        document.body.appendChild(status);

        // ---- 已内嵌到 HTML 的图片缓存（token 会先进来，主牌卡图随后抓）----
        const pngMap = {};
        let tokenCount = 0;

        // ---- 若开启“含指示物”，收集本副牌会生成的 token 并让用户选择打印数量 ----
        if (STATE.includeTokens) {
            try {
                status.textContent = '正在查找指示物…';
                const tokens = await collectTokensForDeck();
                if (tokens.length > 0) {
                    // 先把 token 卡图转为内嵌 PNG，避免弹窗中直接外链 Scryfall 导致图裂
                    status.textContent = '正在抓取指示物卡图…';
                    const tokenPngs = [];
                    for (let i = 0; i < tokens.length; i++) {
                        status.textContent = '抓取指示物卡图 ' + (i + 1) + '/' + tokens.length;
                        const t = tokens[i];
                        try { tokenPngs.push(Object.assign({}, t, { imgUrl: await toPngDataUrl(t.imgUrl) })); }
                        catch (e) { console.warn('[导出] token 图失败', t.name, e); }
                    }
                    if (tokenPngs.length > 0) {
                        status.textContent = '请选择指示物数量…';
                        const chosen = await chooseTokenCounts(tokenPngs);
                        chosen.forEach(t => {
                            const cnt = Math.max(0, parseInt(t.count, 10) || 0);
                            if (cnt > 0) {
                                pngMap[t.key] = t.imgUrl; // token 已内嵌，直接入缓存
                                for (let i = 0; i < cnt; i++) list.push({ key: t.key, img: t.imgUrl, isToken: true, name: t.name });
                                tokenCount += cnt;
                            }
                        });
                    }
                }
            } catch (e) {
                if (e === 'cancelled') { status.textContent = '已取消打印'; setTimeout(() => status.remove(), 1000); return; }
                console.warn('[导出] 指示物收集失败', e);
            }
        }

        // ---- 去重 + 转换主牌卡图（token 已提前写入 pngMap，此处不再重复处理）----
        const imgMap = {};
        list.forEach(x => { if (!imgMap[x.key]) imgMap[x.key] = x.img; });
        const keys = Object.keys(imgMap);
        const toFetch = keys.filter(k => !imgMap[k].startsWith('data:'));
        for (let i = 0; i < toFetch.length; i++) {
            status.textContent = '抓取卡图 ' + (i + 1) + '/' + toFetch.length;
            const key = toFetch[i];
            try {
                pngMap[key] = await toPngDataUrl(imgMap[key]);
            } catch (e) {
                console.warn('[导出] 图转换失败，回退原图', key, e);
                pngMap[key] = imgMap[key]; // 转换失败也用原图，避免空白
            }
        }
        // 兜底：所有仍是 data: 的 key（只有 token）写进 pngMap
        keys.forEach(k => { if (imgMap[k].startsWith('data:') && !pngMap[k]) pngMap[k] = imgMap[k]; });
        status.textContent = '生成打印页…';

        // ---- 构建完整打印 HTML（每页 9 张 3×3，@page 控制 A4 分页）----
        let pagesHtml = '';
        for (let p = 0; p < list.length; p += _PW_PER_PAGE) {
            let rows = '';
            for (let r = 0; r < _PW_ROWS; r++) {
                let cells = '';
                for (let c = 0; c < _PW_COLS; c++) {
                    const item = list[p + r * _PW_COLS + c];
                    const key = item ? item.key : null;
                    if (key && pngMap[key]) {
                        cells += '<td><img src="' + pngMap[key] + '" alt="card"/></td>';
                    } else {
                        cells += '<td></td>';
                    }
                }
                rows += '<tr>' + cells + '</tr>';
            }
            pagesHtml += '<table class="pg">' + rows + '</table>';
        }

        const totalPages = Math.ceil(list.length / _PW_PER_PAGE);
        const fullHtml = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>MTG Cards - Print</title>' +
            '<style>' +
            '@page{size:A4 portrait;margin:2.5mm}' +
            '*{margin:0;padding:0;box-sizing:border-box}' +
            'body{background:#fff}' +
            'table.pg{width:205mm;height:292mm;margin:0 auto;' +
              'border-collapse:collapse;table-layout:fixed;' +
              'page-break-after:always;page-break-inside:avoid}' +
            'table.pg:last-child{page-break-after:auto}' +
            'table.pg td{width:68.333mm;height:97.333mm;' +
              'padding:0;text-align:center;vertical-align:middle;border:none}' +
            'table.pg td img{width:' + _PW_CW + ';height:' + _PW_CH + ';' +
              'display:block;object-fit:cover;margin:0 auto}' +
            '@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}' +
            '</style></head><body>' + pagesHtml +
            '<script>window.onload=function(){window.print()};<\/script></body></html>';

        // ---- 下载 HTML 文件并自动打开 ----
        download(fullHtml, 'deck_' + (CUR_DRAFT || '').slice(0, 8) + '_cards.html', 'text/html');
        const realCards = list.length - tokenCount;
        status.textContent = '完成！已生成打印文件 (' + realCards + ' 张卡' + (tokenCount ? ' + ' + tokenCount + ' 指示物' : '') + ' / ' + totalPages + ' 页)';
        setTimeout(() => status.remove(), 3000);

        alert('已生成打印文件！\n\n主牌 ' + realCards + ' 张' + (tokenCount ? '，指示物 ' + tokenCount + ' 张' : '') + '。\n请打开下载的 .html 文件 → 浏览器会自动弹出打印对话框。\n选择 A4 纸、无边距打印即可得到 3×3 排列的卡牌页面。');
    }

    function showLoading(msg) { let l = document.getElementById('mc-loading'); if (!l) { l = document.createElement('div'); l.id = 'mc-loading'; l.innerHTML = '<div class="mc-spin"></div><div class="mc-msg"></div>'; document.body.appendChild(l); } l.querySelector('.mc-msg').textContent = msg || '加载中…'; }
    function hideLoading() { const l = document.getElementById('mc-loading'); if (l) l.remove(); }

    console.log('%c[17Lands-CN] v0.42 — 修复「点开其他 seat 构筑牌组后卡图悬浮放大失效」(用户定位)：根因是 buildUI 在切换历史/座位时会 remove #mc-hover-zoom 浮层，却未清空模块级 _mcHz，使其仍指向已脱离文档的游离节点，mcHoverEl 的 if(!_mcHz) 判断误以为已存在→不再 appendChild→hover 大图永不可见。修复：mcHoverEl 增加 !document.body.contains(_mcHz) 判定，节点脱离文档即重建挂回；buildUI 删除浮层后同步 _mcHz=null。v0.41 的 DRAG 兜底保留(无害)。', 'color:#3C3489;font-weight:bold');
})();
