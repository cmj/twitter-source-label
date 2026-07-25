// ==UserScript==
// @name         Twitter / X.com Source Label Restorer
// @namespace    https://github.com/cmj
// @version      2.0
// @description  Restore Android, Web, iPhone, TweetDeck, etc. source labels on X.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
"use strict";

/***********************************************************************
 * Debug - Logs every capture to the console and pops up an alert
 ***********************************************************************/

const DEBUG = false;
let debugAlertShown = false;
const debugSeenIds = new Set();

if (DEBUG) {
    console.log("[SourceRestorer] script installed, fetch/XHR hooks going up now");
}

/***********************************************************************
 * Service worker removal
 *
 * X's service worker can serve a cached page shell almost instantly
 * on a normal reload, letting the page's own bundle start executing
 * (and grab the native fetch/XHR) before this script's document-start
 * injection lands. A force-reload (Ctrl+F5) bypasses the service
 * worker entirely for the navigation request. Unregistering it here
 * removes the race condition so normal reloads behave the same way.
 ***********************************************************************/

const UNREGISTER_SERVICE_WORKER = true;

if (UNREGISTER_SERVICE_WORKER && navigator.serviceWorker?.getRegistrations) {
    navigator.serviceWorker.getRegistrations()
        .then(registrations => {
            for (const registration of registrations) {
                registration.unregister();
                if (DEBUG) {
                    console.log(`[SourceRestorer] unregistered service worker: ${registration.scope}`);
                }
            }
        })
        .catch(() => {});
    if (navigator.serviceWorker) {
        navigator.serviceWorker.register = function (...args) {
            if (DEBUG) {
                console.log("[SourceRestorer] blocked serviceWorker.register() call", args);
            }
            return Promise.reject(new DOMException(
                "serviceWorker.register() blocked by SourceRestorer",
                "SecurityError"
            ));
        };
    }
}

const tweetSources = new Map();

const GRAPHQL_ENDPOINTS = [
    "HomeTimeline",
    "TweetDetail",
    "SearchTimeline",
    "UserTweets",
    "UserTweetsAndReplies",
    "UserMedia",
    "Bookmarks",
    "Likes",
    "ListLatestTweetsTimeline",
    "CommunitiesTimeline"
];

function shouldInspectURL(url) {
    if (!url.includes("/i/api/graphql/")) {
        return false;
    }
    if (DEBUG) {
        console.log(`[SourceRestorer] saw graphql request: ${url}`);
    }
    return GRAPHQL_ENDPOINTS.some(endpoint =>
        url.includes(endpoint)
    );
}

function decodeHTML(html) {
    if (!html) {
        return "";
    }
    const textarea = document.createElement("textarea");
    textarea.innerHTML = html;
    return textarea.value;
}

function parseSource(html) {
    if (!html) {
        return null;
    }
    const div = document.createElement("div");
    div.innerHTML = decodeHTML(html);
    let text = div.textContent.trim();
    // "Twitter for iPhone" -> "iPhone", "Twitter for Android" -> "Android", etc.
    text = text.replace(/^Twitter for\s+/i, "");
    // "Twitter Web App" -> "Web" (no "for" to strip via the rule above).
    text = text.replace(/^Twitter\s+/i, "");
    return text;
}

function getSource(obj) {
    if (!obj || typeof obj !== "object") {
        return null;
    }
    return (
        obj.source ||
        obj.legacy?.source ||
        obj.result?.source ||
        obj.result?.legacy?.source ||
        obj.result?.tweet?.source ||
        obj.result?.tweet?.legacy?.source ||
        obj.tweet?.source ||
        obj.tweet?.legacy?.source ||
        obj.tweet_results?.result?.source ||
        obj.tweet_results?.result?.legacy?.source ||
        obj.tweet_results?.result?.tweet?.source ||
        obj.tweet_results?.result?.tweet?.legacy?.source ||
        null
    );
}

function getRestId(obj) {
    if (!obj) {
        return null;
    }
    return (
        obj.rest_id ||
        obj.result?.rest_id ||
        obj.tweet_results?.result?.rest_id ||
        null
    );
}

function cacheTweet(obj) {
    const id = getRestId(obj);
    if (!id) {
        return;
    }
    if (DEBUG && !debugSeenIds.has(id)) {
        debugSeenIds.add(id);
        console.log(`[SourceRestorer] saw rest_id ${id}`);
    }
    const rawSource = getSource(obj);
    if (!rawSource) {
        return;
    }
    const source = parseSource(rawSource);
    if (!source) {
        return;
    }
    const isNew = !tweetSources.has(id);
    tweetSources.set(id, source);
    if (DEBUG && isNew) {
        console.log(`[SourceRestorer] captured "${source}" for tweet ${id}`);
        if (!debugAlertShown) {
            debugAlertShown = true;
            alert(`SourceRestorer: captured "${source}" for tweet ${id}`);
        }
    }
}


function walk(node) {
    if (!node || typeof node !== "object") {
        return;
    }
    cacheTweet(node);
    if (Array.isArray(node)) {
        for (const item of node) {
            walk(item);
        }
        return;
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
            walk(value);
        }
    }
}

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const LABEL_CLASS = "source-restorer-label";
const SEP_CLASS = "source-restorer-sep";
const ROW_CLASS = "source-restorer-row";
const FOCAL_TIME_PATTERN = /\d{1,2}:\d{2}\s?(AM|PM)/i;

function getTweetIdFromArticle(article) {
    const timeEl = article.querySelector("time");
    const link = timeEl?.closest("a[href*='/status/']");
    if (!link) {
        return null;
    }
    const match = link.href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
}

function isFocalTweet(article) {
    const timeEl = article.querySelector("time");
    return !!timeEl && FOCAL_TIME_PATTERN.test(timeEl.textContent);
}

function findActionBar(article) {
    const replyBtn = article.querySelector('[data-testid="reply"]');
    let el = replyBtn?.parentElement;
    while (el && el !== article) {
        if (el.getAttribute("role") === "group") {
            return el;
        }
        el = el.parentElement;
    }
    return null;
}

function makeSourceLabel(source) {
    const label = document.createElement("span");
    label.className = LABEL_CLASS;
    label.textContent = source;
    label.style.paddingTop = "5px";
    label.style.color = "rgb(83, 100, 113)";
    label.style.fontSize = "13px";
    label.style.fontFamily = 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    return label;
}

function makeSeparator() {
    const sep = document.createElement("span");
    sep.className = SEP_CLASS;
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = " · ";
    sep.style.color = "rgb(83, 100, 113)";
    sep.style.fontSize = "13px";
    return sep;
}

function injectFocalLabel(article, timeEl, source) {
    const timeLink = timeEl.closest("a");
    if (!timeLink) {
        if (DEBUG) {
            console.log("[SourceRestorer] focal: no timeLink found", article);
        }
        return false;
    }
    const row = timeLink.parentElement?.parentElement;
    if (row) {
        row.appendChild(makeSeparator());
        row.appendChild(makeSourceLabel(source));
    } else {
        const sep = makeSeparator();
        timeLink.insertAdjacentElement("afterend", sep);
        sep.insertAdjacentElement("afterend", makeSourceLabel(source));
    }
    return true;
}

function injectCompactLabel(article, source) {
    const actionBar = findActionBar(article);
    if (!actionBar?.parentElement) {
        if (DEBUG) {
            console.log("[SourceRestorer] compact: no actionBar found", article);
        }
        return false;
    }

    const row = document.createElement("div");
    row.className = ROW_CLASS;
    row.style.cssText =
        "padding: 2px 0 4px; line-height: 16px; width: 100%; display: flex; justify-content: flex-end;";
    row.appendChild(makeSourceLabel(source));
    actionBar.parentElement.insertBefore(row, actionBar);
    return true;
}

function injectLabels() {
    const articles = document.querySelectorAll(
        `${TWEET_SELECTOR}:not([data-source-restored])`
    );
    if (DEBUG) {
        console.log(`[SourceRestorer] injectLabels: ${articles.length} candidate article(s), ${tweetSources.size} cached source(s)`);
    }
    for (const article of articles) {
        const id = getTweetIdFromArticle(article);
        if (!id) {
            if (DEBUG) {
                console.log("[SourceRestorer] no id resolved for article", article);
            }
            continue;
        }
        const source = tweetSources.get(id);
        if (!source) {
            if (DEBUG) {
                console.log(`[SourceRestorer] id ${id} has no cached source yet`);
            }
            continue;
        }
        const timeEl = article.querySelector("time");
        const inserted = isFocalTweet(article)
            ? injectFocalLabel(article, timeEl, source)
            : injectCompactLabel(article, source);
        if (DEBUG) {
            console.log(`[SourceRestorer] id ${id} inserted=${inserted} source="${source}"`);
        }
        if (inserted) {
            article.setAttribute("data-source-restored", "true");
        }
    }
}

let updatePending = false;

function scheduleDOMUpdate() {
    if (updatePending) {
        return;
    }
    updatePending = true;
    requestAnimationFrame(() => {
        updatePending = false;
        injectLabels();
    });
}

function processPayload(data) {
    try {
        walk(data);
        if (tweetSources.size) {
            scheduleDOMUpdate();
        }
    } catch (e) {
        console.debug("[SourceRestorer]", e);
    }
}

const originalFetch = window.fetch;

window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    let url = "";
    if (typeof args[0] === "string") {
        url = args[0];
    } else if (args[0] instanceof Request) {
        url = args[0].url;
    } else {
        url = args[0]?.url || "";
    }
    if (!shouldInspectURL(url)) {
        return response;
    }
    response.clone()
        .json()
        .then(processPayload)
        .catch(() => {});
    return response;
};

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url) {
    this.__sourceRestorerURL = url;
    return originalOpen.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function() {
    this.addEventListener("load", () => {
        try {
            if (!shouldInspectURL(this.__sourceRestorerURL)) {
                return;
            }
            const contentType =
                this.getResponseHeader("content-type") || "";
            if (!contentType.includes("application/json")) {
                return;
            }
            processPayload(JSON.parse(this.responseText));
        } catch (_) {}
    });

    return originalSend.apply(this, arguments);
};

function startObserver() {
    const observer = new MutationObserver(() => {
        if (tweetSources.size) {
            scheduleDOMUpdate();
        }
    });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
}

if (document.documentElement) {
    startObserver();
} else {
    document.addEventListener("DOMContentLoaded", startObserver);
}

})();
