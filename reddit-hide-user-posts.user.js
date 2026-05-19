// ==UserScript==
// @name         Reddit Hide User Comments
// @namespace    https://github.com/writingnon/writingnon
// @version      2.1.0
// @description  Adds an "ignore" link next to commenter usernames on Reddit. Comments from ignored users are replaced with the word "ignored", while their child replies remain visible.
// @author       writingnon
// @match        *://*.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
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

    // ---------- Storage ----------

    function loadIgnored() {
        try {
            const raw = hasGM
                ? GM_getValue(STORAGE_KEY, '[]')
                : (localStorage.getItem(STORAGE_KEY) || '[]');
            return new Set(JSON.parse(raw));
        } catch (_) {
            return new Set();
        }
    }

    function saveIgnored(set) {
        const json = JSON.stringify([...set]);
        if (hasGM) GM_setValue(STORAGE_KEY, json);
        else localStorage.setItem(STORAGE_KEY, json);
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
