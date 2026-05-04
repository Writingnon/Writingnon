// ==UserScript==
// @name         Reddit Hide User Comments
// @namespace    https://github.com/writingnon/writingnon
// @version      1.0.0
// @description  Adds an "ignore" button next to commenter usernames on Reddit. Comments from ignored users are replaced with the word "ignored", while their child replies remain visible.
// @author       writingnon
// @match        *://*.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
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
        btn.style.marginLeft = '6px';
        btn.style.fontSize = '11px';
        btn.style.color = alreadyIgnored ? '#888' : '#cc3333';
        btn.style.cursor = 'pointer';
        btn.style.textDecoration = 'underline';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (isIgnored(author)) {
                unignore(author);
            } else {
                ignore(author);
            }
        });
        return btn;
    }

    // ---------- Old Reddit ----------

    function processOldReddit(root) {
        // Match both "div.comment" (full subtree) and "div.thing.comment".
        const comments = (root || document).querySelectorAll('div.thing.comment, div.comment');
        comments.forEach(processOldComment);
    }

    function getOwnEntry(comment) {
        // Direct-child entry (skip entries belonging to nested comments).
        for (const child of comment.children) {
            if (child.classList && child.classList.contains('entry')) return child;
        }
        return null;
    }

    function getOwnBody(entry) {
        // The comment's own body lives at: entry > form.usertext > div.usertext-body.
        // A separate reply form (also a usertext-body) may appear as a sibling — skip it
        // by taking only the first form that is NOT a reply form.
        const forms = entry.querySelectorAll(':scope > form.usertext');
        for (const f of forms) {
            if (f.classList.contains('cloneable')) continue; // template
            const body = f.querySelector(':scope > div.usertext-body');
            if (body) return body;
        }
        // Fallback: first direct-descendant usertext-body inside entry.
        return entry.querySelector(':scope > form > .usertext-body') ||
               entry.querySelector(':scope .usertext-body');
    }

    function processOldComment(comment) {
        if (comment.getAttribute('data-deleted') === 'true') return;
        const author = comment.getAttribute('data-author');
        if (!author || author === '[deleted]') return;

        const entry = getOwnEntry(comment);
        if (!entry) return;

        // Add ignore button next to the username if not already present.
        if (!comment.hasAttribute(PROCESSED_ATTR)) {
            const tagline = entry.querySelector(':scope > p.tagline, :scope > .tagline');
            const authorLink = (tagline || entry).querySelector('a.author');
            if (authorLink && !(tagline || entry).querySelector('.ignore-user-btn')) {
                const btn = makeButton(author, isIgnored(author));
                authorLink.insertAdjacentElement('afterend', btn);
            }
            comment.setAttribute(PROCESSED_ATTR, '1');
        } else {
            const btn = entry.querySelector(':scope .ignore-user-btn');
            if (btn) {
                const ig = isIgnored(author);
                btn.textContent = ig ? 'unignore' : 'ignore';
                btn.style.color = ig ? '#888' : '#cc3333';
            }
        }

        const body = getOwnBody(entry);
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

    // Initial pass.
    applyAll();

    // Watch for new comments loaded dynamically (load-more, infinite scroll, route changes).
    const observer = new MutationObserver((mutations) => {
        let needsRun = false;
        for (const m of mutations) {
            if (m.addedNodes && m.addedNodes.length) {
                needsRun = true;
                break;
            }
        }
        if (needsRun) applyAll();
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();
