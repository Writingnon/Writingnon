// ==UserScript==
// @name         Reddit Hide User Comments
// @namespace    https://github.com/writingnon/writingnon
// @version      1.2.0
// @description  Adds an "ignore" button next to commenter usernames on Reddit. Comments from ignored users are replaced with the word "ignored", while their child replies remain visible.
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
    const PROCESSED_ATTR = 'data-ignore-btn-added';
    const HIDDEN_ATTR = 'data-ignore-hidden';

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function loadIgnored() {
        try {
            if (hasGM) {
                const raw = GM_getValue(STORAGE_KEY, '[]');
                return new Set(JSON.parse(raw));
            }
            return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
        } catch (_) {
            return new Set();
        }
    }

    function saveIgnored(set) {
        const json = JSON.stringify([...set]);
        if (hasGM) {
            GM_setValue(STORAGE_KEY, json);
        } else {
            localStorage.setItem(STORAGE_KEY, json);
        }
    }

    let ignored = loadIgnored();

    function normalize(name) {
        if (!name) return '';
        return String(name).replace(/^\/?u\//i, '').trim().toLowerCase();
    }

    function ignore(name) {
        const n = normalize(name);
        if (!n) return;
        ignored.add(n);
        saveIgnored(ignored);
        applyAll();
    }

    function unignore(name) {
        const n = normalize(name);
        if (!n) return;
        ignored.delete(n);
        saveIgnored(ignored);
        applyAll();
    }

    function isIgnored(name) {
        return ignored.has(normalize(name));
    }

    function makeButton(author, alreadyIgnored) {
        const btn = document.createElement('a');
        btn.href = 'javascript:void(0)';
        btn.className = 'ignore-user-btn';
        btn.textContent = alreadyIgnored ? 'unignore' : 'ignore';
        btn.setAttribute('role', 'button');
        btn.style.marginLeft = '6px';
        btn.style.padding = '2px 6px';
        btn.style.fontSize = '12px';
        btn.style.color = '#fff';
        btn.style.background = alreadyIgnored ? '#888' : '#cc3333';
        btn.style.borderRadius = '3px';
        btn.style.cursor = 'pointer';
        btn.style.textDecoration = 'none';
        btn.style.display = 'inline-block';
        btn.style.touchAction = 'manipulation';
        const handler = function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (isIgnored(author)) unignore(author);
            else ignore(author);
        };
        btn.addEventListener('click', handler);
        // Some Android browsers swallow click on injected anchors; touchend is a reliable backup.
        btn.addEventListener('touchend', handler, { passive: false });
        return btn;
    }

    // ---------- Old Reddit ----------
    // Note: covers desktop old.reddit.com AND the mobile ".compact" layout
    // (which extra-wraps things and is what Android browsers see, including
    // when the user has the Oldlander redirector installed).

    function processOldReddit(root) {
        // Comments may appear as `.thing.comment` or just `.thing[data-author]`.
        // Use [data-author] so we cover the compact mobile markup too.
        const comments = (root || document).querySelectorAll(
            '.thing.comment[data-author], .thing[data-type="comment"][data-author], .comment[data-author]'
        );
        comments.forEach(processOldComment);
    }

    // Find this comment's own .entry, walking through arbitrary wrapper divs
    // that the compact layout sometimes inserts. Stop if we cross into a nested
    // comment.
    function getOwnEntry(comment) {
        const all = comment.querySelectorAll('.entry');
        for (const e of all) {
            if (e.closest('.thing.comment, .comment[data-author], .thing[data-type="comment"]') === comment) {
                return e;
            }
        }
        return null;
    }

    function getOwnBody(comment, entry) {
        // The comment body lives in a usertext-body inside the entry.
        // Skip the cloneable reply-form template and any reply form whose
        // closest comment ancestor is still us (an inline reply box).
        const candidates = entry.querySelectorAll('.usertext-body');
        let firstNonReply = null;
        for (const body of candidates) {
            if (body.closest('.thing.comment, .comment[data-author], .thing[data-type="comment"]') !== comment) continue;
            const form = body.closest('form.usertext');
            if (form && form.classList.contains('cloneable')) continue;
            // The genuine comment body sits inside a non-cloneable form that
            // is itself a direct/near child of `entry` (not inside a `.child`
            // reply container or an "edit/reply" wrapper).
            if (!firstNonReply) firstNonReply = body;
            // Prefer one whose containing form is a direct child of entry.
            if (form && form.parentElement === entry) return body;
        }
        return firstNonReply;
    }

    function findAuthorLink(entry) {
        // Old reddit: a.author. Compact may render the username inside a span
        // with class "author" — handle both.
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

        if (!comment.hasAttribute(PROCESSED_ATTR)) {
            const authorLink = findAuthorLink(entry);
            if (authorLink && !entry.querySelector('.ignore-user-btn')) {
                const btn = makeButton(author, isIgnored(author));
                authorLink.insertAdjacentElement('afterend', btn);
                comment.setAttribute(PROCESSED_ATTR, '1');
            }
        } else {
            const btn = entry.querySelector('.ignore-user-btn');
            if (btn) {
                const ig = isIgnored(author);
                btn.textContent = ig ? 'unignore' : 'ignore';
                btn.style.background = ig ? '#888' : '#cc3333';
            }
        }

        const body = getOwnBody(comment, entry);
        if (!body) return;

        if (isIgnored(author)) {
            if (!body.hasAttribute(HIDDEN_ATTR)) {
                body.setAttribute(HIDDEN_ATTR, '1');
                body.setAttribute('data-original-html', encodeURIComponent(body.innerHTML));
                body.innerHTML = '<div class="md"><p><em>ignored</em></p></div>';
            }
        } else if (body.hasAttribute(HIDDEN_ATTR)) {
            const original = body.getAttribute('data-original-html');
            if (original !== null) body.innerHTML = decodeURIComponent(original);
            body.removeAttribute(HIDDEN_ATTR);
            body.removeAttribute('data-original-html');
        }
    }

    // ---------- New Reddit (shreddit) ----------

    function processNewReddit(root) {
        const comments = (root || document).querySelectorAll('shreddit-comment');
        comments.forEach(processNewComment);
    }

    function processNewComment(comment) {
        const author = comment.getAttribute('author');
        if (!author) return;

        // Username link lives inside a slot in light DOM.
        const headerAuthor = comment.querySelector('a[href^="/user/"], a[href^="/u/"]');

        if (!comment.hasAttribute(PROCESSED_ATTR)) {
            if (headerAuthor && !comment.querySelector(':scope .ignore-user-btn')) {
                const btn = makeButton(author, isIgnored(author));
                headerAuthor.insertAdjacentElement('afterend', btn);
                comment.setAttribute(PROCESSED_ATTR, '1');
            }
        } else {
            const btn = comment.querySelector(':scope .ignore-user-btn');
            if (btn) {
                const ig = isIgnored(author);
                btn.textContent = ig ? 'unignore' : 'ignore';
                btn.style.color = ig ? '#888' : '#cc3333';
            }
        }

        // Find this comment's own body (avoid descending into nested shreddit-comment).
        const candidates = comment.querySelectorAll('[slot="comment"], div[id$="-post-rtjson-content"], .md');
        let body = null;
        for (const c of candidates) {
            if (c.closest('shreddit-comment') === comment) {
                body = c;
                break;
            }
        }
        if (!body) return;

        if (isIgnored(author)) {
            if (!body.hasAttribute(HIDDEN_ATTR)) {
                body.setAttribute(HIDDEN_ATTR, '1');
                body.setAttribute('data-original-html', encodeURIComponent(body.innerHTML));
                body.innerHTML = '<p><em>ignored</em></p>';
            }
        } else if (body.hasAttribute(HIDDEN_ATTR)) {
            const original = body.getAttribute('data-original-html');
            if (original !== null) {
                body.innerHTML = decodeURIComponent(original);
            }
            body.removeAttribute(HIDDEN_ATTR);
            body.removeAttribute('data-original-html');
        }
    }

    function applyAll() {
        processOldReddit(document);
        processNewReddit(document);
    }

    let pending = false;
    function scheduleApply() {
        if (pending) return;
        pending = true;
        // rAF + microtask defer keeps us cheap when many nodes mount at once.
        (window.requestAnimationFrame || setTimeout)(() => {
            pending = false;
            applyAll();
        });
    }

    function start() {
        applyAll();
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                    scheduleApply();
                    return;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    }
})();
