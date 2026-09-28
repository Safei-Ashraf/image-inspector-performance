importScripts('analysis.js');

const FALLBACK_CDN_HOSTS = [];
let cdnHosts = FALLBACK_CDN_HOSTS;

const refreshCdnHosts = async () => {
    try {
        const stored = await chrome.storage.sync.get({ cdnHosts: FALLBACK_CDN_HOSTS });
        const sanitized = FastlyImageAnalysis.sanitizeHosts(stored.cdnHosts);
        cdnHosts = sanitized.length ? sanitized : FALLBACK_CDN_HOSTS;
    } catch (_error) {
        cdnHosts = FALLBACK_CDN_HOSTS;
    }
};

refreshCdnHosts();
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.cdnHosts) refreshCdnHosts();
});

const sendMessage = async (tabId, message) => {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (_error) {
        return null;
    }
};

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;

    const existing = await sendMessage(tab.id, { type: 'fastly-image-inspector-ping' });

    try {
        if (!existing) {
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['inspector.css'] });
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['analysis.js', 'inspector.js'],
            });
        }

        await sendMessage(tab.id, { type: 'fastly-image-inspector-toggle' });
    } catch (_error) {
        await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
        await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b42318' });
    }
});

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'fastly-image-inspector-open-options') {
        chrome.runtime.openOptionsPage();
    }
});

const isAllowedCdnUrl = (value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && FastlyImageAnalysis.hostMatches(url.hostname, cdnHosts);
    } catch (_error) {
        return false;
    }
};

const readMetadata = async (url) => {
    if (!isAllowedCdnUrl(url)) return { url, error: 'unsupported-host' };
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            cache: 'force-cache',
            headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        });
        const info = response.headers.get('fastly-io-info') || '';
        const dimensions = /(?:^|\s)odim=(\d+)x(\d+)/i.exec(info);
        const outputSize = /(?:^|\s)ofsz=(\d+)/i.exec(info);
        const contentLength = Number(response.headers.get('content-length')) || 0;
        return {
            url,
            ok: response.ok,
            bytes: contentLength || Number(outputSize?.[1]) || 0,
            width: Number(dimensions?.[1]) || 0,
            height: Number(dimensions?.[2]) || 0,
            fastlyIoInfo: info,
        };
    } catch (error) {
        return { url, error: error instanceof Error ? error.message : 'request-failed' };
    }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'fastly-image-inspector-measure-urls') return false;
    const urls = [...new Set((Array.isArray(message.urls) ? message.urls : []).filter(isAllowedCdnUrl))];
    Promise.all(urls.map(readMetadata)).then((results) => sendResponse({ results }));
    return true;
});
