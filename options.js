const api = globalThis.FastlyImageAnalysis;
const form = document.querySelector('#settings-form');
const status = document.querySelector('#status');
const restoreButton = document.querySelector('#restore-defaults');
const fetchButton = document.querySelector('#fetch-widths');
const widthListStatus = document.querySelector('#width-list-status');
const hostPermissionStatus = document.querySelector('#host-permission-status');

const PRECONFIGURED_HOSTS = [];

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const populate = (config) => {
    for (const [key, value] of Object.entries(config)) {
        const field = form.elements.namedItem(key);
        if (!field) continue;
        if (field.type === 'checkbox') {
            field.checked = Boolean(value);
            continue;
        }
        field.value = Array.isArray(value) ? value.join(', ') : value;
    }
};

const describeWidthList = async () => {
    const { widthListUrl, widthListFetchedAt } = await chrome.storage.sync.get([
        'widthListUrl',
        'widthListFetchedAt',
    ]);
    if (widthListUrl && widthListFetchedAt) {
        const age = Date.now() - Number(widthListFetchedAt);
        const fetched = new Date(Number(widthListFetchedAt)).toLocaleDateString();
        widthListStatus.textContent =
            age > STALE_AFTER_MS
                ? `Warning: this list was fetched on ${fetched} and may be stale. Fetch it again or verify against production.`
                : `List fetched from its source on ${fetched}.`;
        widthListStatus.dataset.state = age > STALE_AFTER_MS ? 'stale' : 'fresh';
    } else {
        widthListStatus.textContent =
            'Using the embedded production snapshot. It only changes when the extension files are updated — verify it against the CDN periodically.';
        widthListStatus.dataset.state = 'embedded';
    }
};

const describeHostPermissions = async () => {
    const { cdnHosts } = await chrome.storage.sync.get({ cdnHosts: PRECONFIGURED_HOSTS });
    const extraHosts = api.sanitizeHosts(cdnHosts).filter((host) => !PRECONFIGURED_HOSTS.includes(host));
    if (!extraHosts.length) {
        hostPermissionStatus.textContent = '';
        hostPermissionStatus.dataset.state = '';
        return;
    }
    const origins = extraHosts.map((host) => `https://*.${host}/*`);
    const granted = await chrome.permissions.contains({ origins });
    hostPermissionStatus.textContent = granted
        ? `Measurement permission granted for: ${extraHosts.join(', ')}`
        : `Permission not yet granted for: ${extraHosts.join(', ')} — save settings to grant it.`;
    hostPermissionStatus.dataset.state = granted ? 'fresh' : 'stale';
};

const load = async () => {
    const stored = await chrome.storage.sync.get(api.DEFAULT_CONFIG);
    populate({ ...api.DEFAULT_CONFIG, ...stored });
    describeWidthList();
    describeHostPermissions();
};

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const honoredWidths = api.sanitizeWidths(String(data.get('honoredWidths')).split(/[\s,]+/));
    const cdnHosts = api.sanitizeHosts(String(data.get('cdnHosts')).split(/[\s,]+/));

    if (!honoredWidths.length) {
        status.textContent = 'Add at least one verified width.';
        return;
    }
    if (!cdnHosts.length) {
        status.textContent = 'Add at least one CDN hostname.';
        return;
    }

    // Request host permissions first, while the user gesture is still active.
    const extraHosts = cdnHosts.filter((host) => !PRECONFIGURED_HOSTS.includes(host));
    let hostsGranted = true;
    if (extraHosts.length) {
        hostsGranted = await chrome.permissions.request({
            origins: extraHosts.map((host) => `https://*.${host}/*`),
        });
    }

    await chrome.storage.sync.set({
        breakpoint: Number(data.get('breakpoint')),
        desktopTargetDpr: Number(data.get('desktopTargetDpr')),
        mobileTargetDpr: Number(data.get('mobileTargetDpr')),
        useDeviceDpr: data.get('useDeviceDpr') === 'on',
        safetyMargin: Number(data.get('safetyMargin')),
        minWidthSavingPercent: Number(data.get('minWidthSavingPercent')),
        widthParameter: String(data.get('widthParameter')).trim(),
        projectedVisits: Number(data.get('projectedVisits')),
        realizedTrafficPercent: Math.min(100, Math.max(1, Number(data.get('realizedTrafficPercent')) || 100)),
        widthListUrl: String(data.get('widthListUrl')).trim(),
        cdnHosts,
        honoredWidths,
    });

    status.textContent = hostsGranted
        ? `Saved ${honoredWidths.length} verified widths and ${cdnHosts.length} CDN hostnames.`
        : `Saved, but Chrome denied permission for ${extraHosts.join(', ')} — those hosts will not be measured until granted.`;
    describeWidthList();
    describeHostPermissions();
});

fetchButton.addEventListener('click', async () => {
    const field = form.elements.namedItem('widthListUrl');
    const url = field.value.trim();
    let parsed;
    try {
        parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('not-https');
    } catch (_error) {
        status.textContent = 'Enter a valid https:// URL for the width list.';
        return;
    }

    const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
    if (!granted) {
        status.textContent = 'Permission denied — cannot fetch from that host.';
        return;
    }

    fetchButton.disabled = true;
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const widths = api.sanitizeWidths(text.match(/\d+/g) || []);
        if (!widths.length) throw new Error('no numbers found');
        form.elements.namedItem('honoredWidths').value = widths.join(', ');
        await chrome.storage.sync.set({
            honoredWidths: widths,
            widthListUrl: url,
            widthListFetchedAt: Date.now(),
        });
        status.textContent = `Fetched and saved ${widths.length} verified widths.`;
        describeWidthList();
    } catch (error) {
        status.textContent = `Fetch failed: ${error.message}`;
    } finally {
        fetchButton.disabled = false;
    }
});

restoreButton.addEventListener('click', async () => {
    await chrome.storage.sync.set(api.DEFAULT_CONFIG);
    await chrome.storage.sync.remove(['widthListFetchedAt']);
    populate(api.DEFAULT_CONFIG);
    status.textContent = 'Verified defaults restored.';
    describeWidthList();
    describeHostPermissions();
});

load();
