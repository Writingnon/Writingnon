// ==UserScript==
// @name         Reddit Hide User Comments
// @namespace    https://github.com/writingnon/writingnon
// @version      2.2.0
// @description  Adds an "ignore" link next to commenter usernames on Reddit. Comments from ignored users are replaced with the word "ignored", while their child replies remain visible.
// @author       writingnon
// @match        *://*.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'reddit_ignored_users';
    const PROCESSED_ATTR = 'data-rhuc-added';
    const HIDDEN_ATTR = 'data-rhuc-hidden';
    const ORIGINAL_ATTR = 'data-rhuc-original';
    const BTN_CLASS = 'rhuc-ignore-btn';
    const AUTHOR_DATA_ATTR = 'data-rhuc-author';
    const PLACEHOLDER_CLASS = 'rhuc-placeholder';

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const hasGMDelete = typeof GM_deleteValue === 'function';
    const hasGMList = typeof GM_listValues === 'function';
    const CHUNK_PREFIX = STORAGE_KEY + '__c_';
    const CHUNK_COUNT_KEY = STORAGE_KEY + '__n';
    const CHUNK_SIZE = 200; // names per chunk; small enough to fit any sane quota

    // ---------- Storage ----------
    // Each save writes to BOTH the userscript manager (GM) and localStorage so
    // they back each other up. Loads take the union of every source we know
    // about, so transient quota failures on one backend don't drop names.

    function safeParse(raw) {
        if (!raw) return [];
        try {
            const v = JSON.parse(raw);
            return Array.isArray(v) ? v : [];
        } catch (_) { return []; }
    }

    function gmGet(key, fallback) {
        if (!hasGM) return fallback;
        try { return GM_getValue(key, fallback); }
        catch (e) { console.warn('[reddit-ignore] GM_getValue failed', key, e); return fallback; }
    }

    function gmSet(key, value) {
        if (!hasGM) return false;
        try { GM_setValue(key, value); return true; }
        catch (e) { console.warn('[reddit-ignore] GM_setValue failed', key, e); return false; }
    }

    function gmDelete(key) {
        if (!hasGMDelete) return;
        try { GM_deleteValue(key); } catch (_) {}
    }

    function lsGet(key) {
        try { return localStorage.getItem(key); }
        catch (_) { return null; }
    }

    function lsSet(key, value) {
        try { localStorage.setItem(key, value); return true; }
        catch (e) { console.warn('[reddit-ignore] localStorage failed', key, e); return false; }
    }

    function loadIgnored() {
        const all = new Set();

        // 1) GM legacy single-key.
        safeParse(gmGet(STORAGE_KEY, null)).forEach((n) => all.add(n));

        // 2) GM chunked keys.
        const declared = parseInt(gmGet(CHUNK_COUNT_KEY, '0'), 10) || 0;
        for (let i = 0; i < declared; i++) {
            safeParse(gmGet(CHUNK_PREFIX + i, null)).forEach((n) => all.add(n));
        }
        // Sweep any extra chunks (in case CHUNK_COUNT_KEY itself was lost).
        if (hasGMList) {
            try {
                for (const k of GM_listValues()) {
                    if (typeof k === 'string' && k.indexOf(CHUNK_PREFIX) === 0) {
                        safeParse(gmGet(k, null)).forEach((n) => all.add(n));
                    }
                }
            } catch (_) {}
        }

        // 3) localStorage fallback / mirror.
        safeParse(lsGet(STORAGE_KEY)).forEach((n) => all.add(n));

        return all;
    }

    function saveIgnored(set) {
        const arr = [...set];
        const json = JSON.stringify(arr);
        let gmOk = false;

        if (hasGM) {
            // Try a single compact value first — cheapest, smallest footprint.
            if (gmSet(STORAGE_KEY, json)) {
                gmOk = true;
                // Drop any chunked leftovers so we don't double-store.
                const declared = parseInt(gmGet(CHUNK_COUNT_KEY, '0'), 10) || 0;
                for (let i = 0; i < declared; i++) gmDelete(CHUNK_PREFIX + i);
                gmDelete(CHUNK_COUNT_KEY);
            } else {
                // Compact save failed (likely per-key quota). Fall back to chunks
                // so a single big value doesn't get rejected wholesale.
                gmDelete(STORAGE_KEY);
                const chunkCount = Math.max(1, Math.ceil(arr.length / CHUNK_SIZE));
                let allChunksOk = true;
                for (let i = 0; i < chunkCount; i++) {
                    const part = arr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                    if (!gmSet(CHUNK_PREFIX + i, JSON.stringify(part))) {
                        allChunksOk = false;
                        break;
                    }
                }
                if (allChunksOk) {
                    gmSet(CHUNK_COUNT_KEY, String(chunkCount));
                    // Trim any stale chunks past the new end.
                    const declared = parseInt(gmGet(CHUNK_COUNT_KEY, '0'), 10) || 0;
                    for (let i = chunkCount; i < declared; i++) gmDelete(CHUNK_PREFIX + i);
                    gmOk = true;
                }
            }
        }

        // Always mirror to localStorage too.
        const lsOk = lsSet(STORAGE_KEY, json);

        if (!gmOk && !lsOk) {
            console.error('[reddit-ignore] both storage backends failed; ignore list will not persist');
        }
    }

    // Cross-tab sync: pick up names added on another tab so we don't overwrite
    // them on the next save.
    function installStorageSync() {
        try {
            window.addEventListener('storage', (e) => {
                if (e.key === STORAGE_KEY) {
                    safeParse(e.newValue).forEach((n) => ignored.add(n));
                    applyAll();
                }
            });
        } catch (_) {}
    }

    let ignored = loadIgnored();

    function normalize(name) {
        if (!name) return '';
        return String(name).replace(/^\/?u\//i, '').trim().toLowerCase();
    }

    function isIgnored(name) {
        return ignored.has(normalize(name));
    }

    function toggleIgnored(name) {
        const n = normalize(name);
        if (!n) return;
        if (ignored.has(n)) ignored.delete(n);
        else ignored.add(n);
        saveIgnored(ignored);
        applyAll();
    }

    // ---------- Styles ----------
    // Inject a stylesheet so reddit's `button { ... }` and `.entry a { ... }`
    // rules can't override us. Everything is !important to win specificity wars
    // against old reddit's bundled CSS.
    function injectStyles() {
        if (document.getElementById('rhuc-styles')) return;
        const css = `
            .${BTN_CLASS} {
                display: inline-block !important;
                margin: 0 0 0 6px !important;
                padding: 1px 6px !important;
                border: 0 !important;
                border-radius: 3px !important;
                background: #cc3333 !important;
                color: #ffffff !important;
                font: bold 11px/1.4 sans-serif !important;
                text-decoration: none !important;
                text-transform: lowercase !important;
                cursor: pointer !important;
                vertical-align: baseline !important;
                box-shadow: none !important;
                touch-action: manipulation !important;
                user-select: none !important;
            }
            .${BTN_CLASS}.rhuc-on {
                background: #888888 !important;
            }
            .${BTN_CLASS}:hover {
                opacity: 0.85 !important;
            }
        `;
        const style = document.createElement('style');
        style.id = 'rhuc-styles';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function makeButton(author) {
        // <a> rather than <button>: old reddit's CSS heavily restyles button
        // elements but leaves anchors with custom classes alone. No href, so
        // there's no navigation/CSP issue.
        const a = document.createElement('a');
        a.className = BTN_CLASS + (isIgnored(author) ? ' rhuc-on' : '');
        a.textContent = isIgnored(author) ? 'unignore' : 'ignore';
        a.setAttribute(AUTHOR_DATA_ATTR, author);
        a.setAttribute('role', 'button');
        a.setAttribute('tabindex', '0');
        a.title = (isIgnored(author) ? 'Unignore ' : 'Ignore ') + author;
        return a;
    }

    function refreshButton(btn, author) {
        const on = isIgnored(author);
        btn.textContent = on ? 'unignore' : 'ignore';
        btn.classList.toggle('rhuc-on', on);
        btn.title = (on ? 'Unignore ' : 'Ignore ') + author;
    }

    // ---------- Old Reddit ----------

    const COMMENT_SEL = '.thing.comment[data-author], .thing[data-type="comment"][data-author], .comment[data-author]';

    function processOldReddit(root) {
        (root || document).querySelectorAll(COMMENT_SEL).forEach(processOldComment);
    }

    function getOwnEntry(comment) {
        const all = comment.querySelectorAll('.entry');
        for (const e of all) {
            if (e.closest(COMMENT_SEL) === comment) return e;
        }
        return null;
    }

    function getOwnBody(comment, entry) {
        const candidates = entry.querySelectorAll('.usertext-body');
        let firstNonReply = null;
        for (const body of candidates) {
            if (body.closest(COMMENT_SEL) !== comment) continue;
            const form = body.closest('form.usertext');
            if (form && form.classList.contains('cloneable')) continue;
            if (!firstNonReply) firstNonReply = body;
            if (form && form.parentElement === entry) return body;
        }
        return firstNonReply;
    }

    function findAuthorLink(entry) {
        return entry.querySelector('a.author') ||
               entry.querySelector('.tagline a[href*="/user/"]') ||
               entry.querySelector('.tagline a[href*="/u/"]');
    }

    function processOldComment(comment) {
        if (comment.getAttribute('data-deleted') === 'true') return;
        const author = comment.getAttribute('data-author');
        if (!author || author === '[deleted]') return;

        const entry = getOwnEntry(comment);
        if (!entry) return;

        let btn = entry.querySelector('.' + BTN_CLASS);
        if (!btn) {
            const authorLink = findAuthorLink(entry);
            if (authorLink) {
                btn = makeButton(author);
                authorLink.insertAdjacentElement('afterend', btn);
                comment.setAttribute(PROCESSED_ATTR, '1');
            }
        } else {
            refreshButton(btn, author);
        }

        const body = getOwnBody(comment, entry);
        if (!body) return;

        applyHide(body, '<div class="md ' + PLACEHOLDER_CLASS + '"><p><em>ignored</em></p></div>', author);
    }

    // Replace `body.innerHTML` with `replacement` if the user is ignored and
    // the placeholder isn't currently present (so we recover whenever reddit
    // re-renders the body and wipes our content). Restore otherwise.
    function applyHide(body, replacement, author) {
        const hasPlaceholder = !!body.querySelector('.' + PLACEHOLDER_CLASS);
        if (isIgnored(author)) {
            if (!hasPlaceholder) {
                if (!body.hasAttribute(ORIGINAL_ATTR)) {
                    body.setAttribute(ORIGINAL_ATTR, encodeURIComponent(body.innerHTML));
                }
                body.setAttribute(HIDDEN_ATTR, '1');
                body.innerHTML = replacement;
            }
        } else if (body.hasAttribute(HIDDEN_ATTR) || hasPlaceholder) {
            const original = body.getAttribute(ORIGINAL_ATTR);
            if (original !== null) body.innerHTML = decodeURIComponent(original);
            body.removeAttribute(HIDDEN_ATTR);
            body.removeAttribute(ORIGINAL_ATTR);
        }
    }

    // ---------- New Reddit (shreddit) ----------

    function processNewReddit(root) {
        (root || document).querySelectorAll('shreddit-comment').forEach(processNewComment);
    }

    function processNewComment(comment) {
        const author = comment.getAttribute('author');
        if (!author) return;

        const headerAuthor = comment.querySelector('a[href^="/user/"], a[href^="/u/"]');
        let btn = comment.querySelector('.' + BTN_CLASS);
        if (!btn) {
            if (headerAuthor) {
                btn = makeButton(author);
                headerAuthor.insertAdjacentElement('afterend', btn);
                comment.setAttribute(PROCESSED_ATTR, '1');
            }
        } else {
            refreshButton(btn, author);
        }

        const candidates = comment.querySelectorAll('[slot="comment"], div[id$="-post-rtjson-content"], .md');
        let body = null;
        for (const c of candidates) {
            if (c.closest('shreddit-comment') === comment) {
                body = c;
                break;
            }
        }
        if (!body) return;

        applyHide(body, '<p class="' + PLACEHOLDER_CLASS + '"><em>ignored</em></p>', author);
    }

    // ---------- Drive ----------

    function applyAll() {
        try {
            processOldReddit(document);
            processNewReddit(document);
        } catch (err) {
            console.error('[reddit-hide-user-comments] applyAll error', err);
        }
    }

    // Single document-level click handler: capture phase so old reddit's
    // .entry click/expand handlers can't see the event first.
    function onDocClick(e) {
        const target = e.target && e.target.closest && e.target.closest('.' + BTN_CLASS);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        const author = target.getAttribute(AUTHOR_DATA_ATTR);
        if (author) toggleIgnored(author);
    }

    function onDocMousedown(e) {
        // Old reddit installs onmousedown handlers on the tagline that can
        // cancel the subsequent click. Stop them when we're the target.
        if (e.target && e.target.closest && e.target.closest('.' + BTN_CLASS)) {
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
    }

    let pending = false;
    function scheduleApply() {
        if (pending) return;
        pending = true;
        (window.requestAnimationFrame || setTimeout)(() => {
            pending = false;
            applyAll();
        });
    }

    function start() {
        injectStyles();
        installStorageSync();
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('mousedown', onDocMousedown, true);
        applyAll();

        new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                    scheduleApply();
                    return;
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
