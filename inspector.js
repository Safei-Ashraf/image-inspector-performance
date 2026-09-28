(() => {
    if (window.__fastlyImageInspectorInstalled) return;
    window.__fastlyImageInspectorInstalled = true;

    const api = globalThis.FastlyImageAnalysis;
    const AUDIT_STAGES = [
        'Trigger lazy-loaded images',
        'Discover DOM images',
        'Read current CDN metadata',
        'Calculate safe rendered widths',
        'Measure recommended variants',
        'Build results and highlights',
    ];
    const MAX_BACKGROUND_TARGETS = 300;
    const UNMEASURABLE_COLOR = '#9ca3af';
    const state = {
        active: false,
        auditing: false,
        auditComplete: false,
        config: { ...api.DEFAULT_CONFIG },
        hoveredImage: null,
        auditedImages: new Set(),
        auditItems: new Map(),
        auditResultItems: new Map(),
        activeFilter: 'all',
        minimized: false,
        panelSummary: 'Image inspector',
        agentPrompt: '',
        drag: null,
    };

    const escapeHtml = (value) =>
        String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    const formatNumber = (value, digits = 0) => Number(value || 0).toFixed(digits);
    const formatPercent = (value) => `${formatNumber(Math.max(0, value), 1)}%`;
    const formatBytes = (value) => {
        const bytes = Math.max(0, Number(value) || 0);
        if (bytes < 1000) return `${Math.round(bytes)} B`;
        if (bytes < 1000000) return `${formatNumber(bytes / 1000, 1)} kB`;
        if (bytes < 1000000000) return `${formatNumber(bytes / 1000000, 2)} MB`;
        if (bytes < 1000000000000) return `${formatNumber(bytes / 1000000000, 2)} GB`;
        return `${formatNumber(bytes / 1000000000000, 2)} TB`;
    };

    const root = document.createElement('div');
    root.id = 'fastly-image-inspector-root';
    root.innerHTML = `
        <div class="fii-highlight" aria-hidden="true"></div>
        <aside class="fii-image-tooltip" role="status" aria-live="polite"></aside>
        <div class="fii-navigation-toast" role="status" aria-live="polite"></div>
        <div class="fii-prompt" role="status">
            <span>Hover for guidance · Click for details · Esc to stop</span>
            <button type="button" data-action="audit">Analyze full page</button>
        </div>
        <section class="fii-panel" role="dialog" aria-live="polite" aria-label="Fastly image analysis"></section>
        <div class="fii-minimized-bar" role="dialog" aria-label="Minimized image inspector">
            <strong>Image inspector</strong>
            <div>
                <button type="button" data-action="maximize" aria-label="Restore image inspector">□</button>
                <button type="button" data-action="close-inspector" aria-label="Close image inspector">×</button>
            </div>
        </div>
    `;
    document.documentElement.append(root);

    const highlight = root.querySelector('.fii-highlight');
    const tooltip = root.querySelector('.fii-image-tooltip');
    const navigationToast = root.querySelector('.fii-navigation-toast');
    const prompt = root.querySelector('.fii-prompt');
    const panel = root.querySelector('.fii-panel');
    const minimizedBar = root.querySelector('.fii-minimized-bar');

    const reasonCopy = {
        'source-below-target': 'The delivered source is already below the preferred DPR target.',
        'already-optimal': 'No smaller verified width can preserve the preferred DPR.',
        'no-honored-width': 'No verified width fits between the DPR requirement and this source.',
        'negligible-room': 'A smaller safe width exists, but the reduction is below your configured threshold.',
        'invalid-dimensions': 'The image does not expose usable rendered and intrinsic dimensions.',
        'safe-honored-width': 'A smaller verified width still covers the preferred DPR.',
    };

    const recommendationText = (item) => {
        if (item.result.status === 'improve') return `Use ${item.result.recommendedWidth}px`;
        if (item.result.reason === 'invalid-dimensions') return 'Not measurable yet';
        if (item.result.reason === 'source-below-target') return 'Keep · source-limited';
        return 'Keep as is';
    };

    const getOpportunity = (item) => {
        if (!(item.naturalWidth > 0 && item.naturalHeight > 0)) return { label: 'Not measurable', tier: 'unknown' };
        if (item.result.status !== 'improve') return { label: 'No reduction needed', tier: 'keep' };
        if (item.byteSavingPercent >= 55) return { label: 'High opportunity', tier: 'high' };
        if (item.byteSavingPercent >= 15) return { label: 'Medium opportunity', tier: 'medium' };
        return { label: 'Low opportunity', tier: 'low' };
    };

    const evidenceBadge = (item) => {
        if (item.result.status !== 'improve') return '';
        const kind = item.optimizedMeasured ? 'measured' : 'estimated';
        const label = item.optimizedMeasured ? 'Measured' : 'Estimated';
        return `<span class="fii-badge" data-kind="${kind}">${label}</span>`;
    };

    const hideHover = () => {
        state.hoveredImage = null;
        highlight.style.display = 'none';
        tooltip.style.display = 'none';
    };

    const positionHighlight = (image) => {
        const rect = image.getBoundingClientRect();
        state.hoveredImage = image;
        highlight.style.display = 'block';
        highlight.style.left = `${rect.left}px`;
        highlight.style.top = `${rect.top}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
    };

    const analyzeElement = (image, dimensions = {}) => {
        const rect = image.getBoundingClientRect();
        const targetDpr = api.resolveTargetDpr(window.innerWidth, state.config);
        const naturalWidth = dimensions.width || image.naturalWidth;
        const naturalHeight = dimensions.height || image.naturalHeight;
        const result = api.analyzeImage({
            renderedWidth: rect.width,
            renderedHeight: rect.height,
            naturalWidth,
            naturalHeight,
            actualDpr: window.devicePixelRatio,
            targetDpr,
            safetyMargin: state.config.safetyMargin,
            honoredWidths: state.config.honoredWidths,
            minWidthSavingPercent: state.config.minWidthSavingPercent,
        });
        const source = image.currentSrc || image.src;
        let requestedWidth = 0;
        try {
            requestedWidth = Number(new URL(source, location.href).searchParams.get(state.config.widthParameter)) || 0;
        } catch (_error) {
            requestedWidth = 0;
        }
        return {
            image,
            source,
            rect,
            targetDpr,
            naturalWidth,
            naturalHeight,
            requestedWidth,
            result,
            currentBytes: 0,
            optimizedBytes: 0,
            byteSavingPercent: result.estimatedPixelAreaSavingPercent,
            hasSrcset: Boolean(image.srcset),
            isBackground: false,
            recommendedUrl: result.recommendedWidth
                ? api.buildRecommendedUrl(source, result.recommendedWidth, state.config.widthParameter)
                : '',
        };
    };

    const backgroundDimensionCache = new Map();
    const loadBackgroundDimensions = (url) => {
        if (!backgroundDimensionCache.has(url)) {
            backgroundDimensionCache.set(
                url,
                new Promise((resolve) => {
                    const probe = new Image();
                    const timer = window.setTimeout(() => resolve({ width: 0, height: 0 }), 3000);
                    probe.onload = () => {
                        window.clearTimeout(timer);
                        resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
                    };
                    probe.onerror = () => {
                        window.clearTimeout(timer);
                        resolve({ width: 0, height: 0 });
                    };
                    probe.src = url;
                }),
            );
        }
        return backgroundDimensionCache.get(url);
    };

    const analyzeBackgroundElement = async ({ element, url }) => {
        const rect = element.getBoundingClientRect();
        const dimensions = await loadBackgroundDimensions(url);
        const targetDpr = api.resolveTargetDpr(window.innerWidth, state.config);
        const result = api.analyzeImage({
            renderedWidth: rect.width,
            renderedHeight: rect.height,
            naturalWidth: dimensions.width,
            naturalHeight: dimensions.height,
            actualDpr: window.devicePixelRatio,
            targetDpr,
            safetyMargin: state.config.safetyMargin,
            honoredWidths: state.config.honoredWidths,
            minWidthSavingPercent: state.config.minWidthSavingPercent,
        });
        let requestedWidth = 0;
        try {
            requestedWidth = Number(new URL(url).searchParams.get(state.config.widthParameter)) || 0;
        } catch (_error) {
            requestedWidth = 0;
        }
        return {
            image: element,
            source: url,
            rect,
            targetDpr,
            naturalWidth: dimensions.width,
            naturalHeight: dimensions.height,
            requestedWidth,
            result,
            currentBytes: 0,
            optimizedBytes: 0,
            byteSavingPercent: result.estimatedPixelAreaSavingPercent,
            hasSrcset: false,
            isBackground: true,
            recommendedUrl: result.recommendedWidth
                ? api.buildRecommendedUrl(url, result.recommendedWidth, state.config.widthParameter)
                : '',
        };
    };

    const findAuditTarget = (target) => {
        if (!(target instanceof Element)) return null;
        const image = target.closest('img');
        if (image) return image;
        return target.closest('.fii-audited-image');
    };

    const resolveItem = (element) => {
        const cached = state.auditItems.get(element);
        if (cached) return cached;
        return element.tagName === 'IMG' ? analyzeElement(element) : null;
    };

    const renderHoverTooltip = (image) => {
        const item = resolveItem(image);
        if (!item) return;
        const opportunity = getOpportunity(item);
        const rect = image.getBoundingClientRect();
        const tooltipWidth = 272;
        const left = rect.right + 12 + tooltipWidth <= window.innerWidth ? rect.right + 12 : rect.left - tooltipWidth - 12;
        const top = Math.max(84, Math.min(rect.top, window.innerHeight - 170));
        const byteLine =
            opportunity.tier === 'unknown'
                ? 'Hidden or not loaded — scroll it into view and rerun the audit'
                : item.currentBytes
                  ? `${formatBytes(item.currentBytes)} → ${formatBytes(item.optimizedBytes)}`
                  : `${formatPercent(item.byteSavingPercent)} estimated pixel reduction`;
        const badge = evidenceBadge(item);
        const srcsetNote = item.hasSrcset ? ' · srcset sampled at this viewport only' : '';

        tooltip.dataset.tier = opportunity.tier;
        tooltip.innerHTML = `
            <div class="fii-tooltip-heading"><strong>${escapeHtml(opportunity.label)}</strong><span>${formatPercent(item.byteSavingPercent)}</span></div>
            <b>${escapeHtml(recommendationText(item))}</b> ${badge}
            <p>${formatNumber(item.rect.width, 0)}px rendered · ${item.naturalWidth || '—'}px delivered · ${formatNumber(item.targetDpr, 1)}× preferred DPR${escapeHtml(srcsetNote)}</p>
            <small>${escapeHtml(byteLine)}</small>
        `;
        tooltip.style.left = `${Math.max(12, left)}px`;
        tooltip.style.top = `${top}px`;
        tooltip.style.display = 'block';
    };

    const buildImageDetail = (item, selected = false) => {
        const { rect, targetDpr, naturalWidth, naturalHeight, result, source, recommendedUrl } = item;
        const opportunity = getOpportunity(item);
        if (opportunity.tier === 'unknown') {
            return `
                <section class="${selected ? 'fii-selected-detail' : 'fii-single-detail'}" data-tier="unknown">
                    ${
                        selected
                            ? `<div class="fii-detail-heading"><div><span class="fii-eyebrow">Selected image</span><h3>Not measurable yet</h3></div><button type="button" class="fii-small-close" data-action="close-detail" aria-label="Close selected image details">×</button></div>`
                            : ''
                    }
                    <p>This ${item.isBackground ? 'background' : ''} image is hidden or was not loaded during the audit, so no reliable sizing recommendation is available. Scroll it into view, let it load, and run the audit again.</p>
                    <div class="fii-source" title="${escapeHtml(source)}">${escapeHtml(source)}</div>
                </section>
            `;
        }
        const srcsetNote = item.hasSrcset
            ? '<div class="fii-safety-note"><strong>Responsive markup</strong><span>This image uses srcset/sizes. The audit sampled the source the browser selected at the current viewport only — re-audit at other breakpoints before changing widths.</span></div>'
            : '';
        const marginNote = result.usedSafetyMargin
            ? `${formatNumber((state.config.safetyMargin - 1) * 100)}% safety margin is included in this verified width.`
            : `${result.marginWidth}px is not a verified CDN width, so the tool selected the next safe verified width without adding an unsupported margin.`;
        const headline = recommendationText(item);
        const step = result.status === 'improve' ? `${naturalWidth}px → ${result.recommendedWidth}px` : `Keep ${naturalWidth}px`;
        const saving = Math.max(0, item.currentBytes - item.optimizedBytes);
        const impact = item.currentBytes
            ? `Saves ${formatBytes(saving)} (${formatPercent(item.byteSavingPercent)}) while covering ${formatNumber(targetDpr, 2)}× DPR.`
            : `${formatPercent(result.estimatedPixelAreaSavingPercent)} estimated pixel-area reduction while covering ${formatNumber(targetDpr, 2)}× DPR.`;
        const requestNote = item.requestedWidth ? ` URL requested ${item.requestedWidth}px; Fastly delivered ${naturalWidth}px.` : '';

        return `
            <section class="${selected ? 'fii-selected-detail' : 'fii-single-detail'}" data-tier="${opportunity.tier}">
                ${
                    selected
                        ? `<div class="fii-detail-heading"><div><span class="fii-eyebrow">Selected image</span><h3>${escapeHtml(headline)}</h3></div><button type="button" class="fii-small-close" data-action="close-detail" aria-label="Close selected image details">×</button></div>`
                        : ''
                }
                <div class="fii-result-hero">
                    <div><span>Recommended width</span><strong>${result.recommendedWidth || naturalWidth || '—'}px</strong></div>
                    <div><span>Exact safe step</span><strong>${escapeHtml(step)}</strong> ${evidenceBadge(item)}<small><b>${escapeHtml(opportunity.label)}.</b> ${escapeHtml(impact + requestNote)}</small></div>
                </div>
                <div class="fii-detail-groups">
                    <div>
                        <h4>Size requirement</h4>
                        <dl>
                            <div><dt>Rendered size</dt><dd>${formatNumber(rect.width, 1)} × ${formatNumber(rect.height, 1)} CSS px</dd></div>
                            <div><dt>Preferred DPR</dt><dd>${formatNumber(targetDpr, 2)}×</dd></div>
                            <div><dt>Required delivery</dt><dd>${result.requiredWidth} × ${result.requiredHeight}px</dd></div>
                            <div><dt>Currently delivered</dt><dd>${naturalWidth} × ${naturalHeight}px</dd></div>
                        </dl>
                    </div>
                    <div>
                        <h4>Optimization impact</h4>
                        <dl>
                            <div><dt>Width reduction</dt><dd>${formatPercent(result.widthSavingPercent)}</dd></div>
                            <div><dt>${item.currentBytes ? 'Encoded bytes' : 'Pixel-area estimate'}</dt><dd>${item.currentBytes ? `${formatBytes(item.currentBytes)} → ${formatBytes(item.optimizedBytes)}` : formatPercent(result.estimatedPixelAreaSavingPercent)}</dd></div>
                            <div><dt>Delivered / rendered ratio</dt><dd>${formatNumber(result.suppliedDpr, 2)}×</dd></div>
                        </dl>
                    </div>
                </div>
                <div class="fii-safety-note"><strong>Safety rule</strong><span>${escapeHtml(marginNote)}</span></div>
                ${srcsetNote}
                <div class="fii-source" title="${escapeHtml(source)}">${escapeHtml(source)}</div>
                <div class="fii-actions fii-detail-actions">
                    ${recommendedUrl ? `<button type="button" data-action="copy" data-url="${escapeHtml(recommendedUrl)}">Copy recommended URL</button>` : ''}
                    ${selected ? '' : '<button type="button" data-action="settings" class="fii-secondary">Settings</button>'}
                </div>
            </section>
        `;
    };

    const renderAnalysis = (image) => {
        const auditItem = state.auditItems.get(image);
        if (state.auditComplete) {
            const selectedItem = auditItem || resolveItem(image);
            if (!selectedItem) return;
            const previous = panel.querySelector('.fii-selected-detail');
            if (previous) previous.outerHTML = buildImageDetail(selectedItem, true);
            else panel.querySelector('.fii-audit-header')?.insertAdjacentHTML('afterend', buildImageDetail(selectedItem, true));
            panel.scrollTop = 0;
            return;
        }

        const item = auditItem || resolveItem(image);
        if (!item) return;
        panel.dataset.status = item.result.status;
        panel.innerHTML = `
            <div class="fii-panel-header">
                <div><span class="fii-eyebrow">Fastly image inspector</span><h2>${escapeHtml(recommendationText(item))}</h2></div>
                <button class="fii-icon-button" data-action="minimize" type="button" aria-label="Minimize inspector">×</button>
            </div>
            ${buildImageDetail(item)}
            <p class="fii-footnote">Recommendations use only configured, production-verified widths.</p>
        `;
        if (!state.minimized) panel.style.display = 'block';
        state.panelSummary = recommendationText(item);
    };

    const getTimingBytes = (source) => {
        const entries = performance.getEntriesByName(source, 'resource');
        const entry = entries.at(-1);
        return Number(entry?.encodedBodySize || entry?.transferSize) || 0;
    };

    const measureUrls = async (urls) => {
        if (!urls.length) return new Map();
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'fastly-image-inspector-measure-urls',
                urls: [...new Set(urls)],
            });
            return new Map((response?.results || []).map((result) => [result.url, result]));
        } catch (_error) {
            return new Map();
        }
    };

    const measureUrlsInBatches = async (urls, onProgress) => {
        const uniqueUrls = [...new Set(urls)];
        const results = new Map();
        const batchSize = 8;
        if (!uniqueUrls.length) onProgress?.(1, 1);
        for (let index = 0; index < uniqueUrls.length; index += batchSize) {
            const batch = uniqueUrls.slice(index, index + batchSize);
            const measured = await measureUrls(batch);
            for (const [url, metadata] of measured) results.set(url, metadata);
            onProgress?.(Math.min(index + batch.length, uniqueUrls.length), uniqueUrls.length);
        }
        return results;
    };

    const clearAudit = (forgetResults = false) => {
        for (const image of state.auditedImages) {
            image.classList.remove('fii-audited-image');
            image.style.removeProperty('--fii-audit-color');
        }
        state.auditedImages.clear();
        hideHover();
        if (forgetResults) {
            state.auditItems.clear();
            state.auditResultItems.clear();
            state.auditComplete = false;
            state.agentPrompt = '';
        }
    };

    const setFloatingPosition = (element, left, top) => {
        const maxLeft = Math.max(8, window.innerWidth - element.offsetWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - element.offsetHeight - 8);
        element.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
        element.style.top = `${Math.max(8, Math.min(top, maxTop))}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.style.insetInlineEnd = 'auto';
        element.style.insetBlockEnd = 'auto';
    };

    const minimizePanel = () => {
        if (state.minimized || panel.style.display === 'none') return;
        const rect = panel.getBoundingClientRect();
        minimizedBar.querySelector('strong').textContent = state.panelSummary;
        panel.style.display = 'none';
        prompt.style.display = 'none';
        hideHover();
        minimizedBar.style.display = 'flex';
        setFloatingPosition(minimizedBar, rect.left, rect.top);
        state.minimized = true;
    };

    const maximizePanel = () => {
        if (!state.minimized) return;
        const rect = minimizedBar.getBoundingClientRect();
        minimizedBar.style.display = 'none';
        panel.style.display = 'block';
        prompt.style.display = 'flex';
        setFloatingPosition(panel, rect.left, rect.top);
        state.minimized = false;
    };

    const locateAuditImage = (item) => {
        if (!item?.image?.isConnected) {
            navigationToast.textContent = 'This image is no longer in the DOM. Run the audit again.';
            navigationToast.dataset.status = 'error';
            navigationToast.style.display = 'block';
            return;
        }

        const rect = item.image.getBoundingClientRect();
        const directions = [];
        if (rect.bottom < 0) directions.push('up');
        else if (rect.top > window.innerHeight) directions.push('down');
        if (rect.right < 0) directions.push('left');
        else if (rect.left > window.innerWidth) directions.push('right');
        const directionText = directions.length ? `Scrolling ${directions.join(' and ')} to the image…` : 'Image is on screen — centering and flashing it…';

        const panelRect = panel.getBoundingClientRect();
        const isRtl = getComputedStyle(document.documentElement).direction === 'rtl';
        const availableCenter = isRtl
            ? panelRect.right + (window.innerWidth - panelRect.right) / 2
            : panelRect.left / 2;
        navigationToast.style.left = `${Math.max(16, Math.min(window.innerWidth - 16, availableCenter))}px`;
        navigationToast.dataset.status = 'locating';
        navigationToast.textContent = directionText;
        navigationToast.style.display = 'block';
        item.image.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

        window.setTimeout(() => {
            positionHighlight(item.image);
            highlight.classList.remove('is-locating');
            item.image.classList.remove('fii-locate-pulse');
            void highlight.offsetWidth;
            highlight.classList.add('is-locating');
            item.image.classList.add('fii-locate-pulse');
            const step = item.result.status === 'improve'
                ? `${item.naturalWidth}px → ${item.result.recommendedWidth}px`
                : `Keep ${item.naturalWidth}px`;
            navigationToast.textContent = `Image centered · ${step} · safe at ${formatNumber(item.targetDpr, 2)}× DPR`;
            window.setTimeout(() => {
                highlight.classList.remove('is-locating');
                item.image.classList.remove('fii-locate-pulse');
                navigationToast.style.display = 'none';
            }, 3200);
        }, 500);
    };

    const checklistHtml = (activeStage = AUDIT_STAGES.length, done = 1, total = 1) => {
        const percent = total ? Math.round((done / total) * 100) : 0;
        return `<ol class="fii-checklist">
            ${AUDIT_STAGES.map((label, index) => {
                const complete = index < activeStage || activeStage === AUDIT_STAGES.length;
                const current = index === activeStage;
                return `<li class="fii-check-item${complete ? ' is-complete' : ''}${current ? ' is-current' : ''}">
                    <span class="fii-check-icon">${complete ? '✓' : index + 1}</span>
                    <div><strong>${escapeHtml(label)}</strong>${current ? `<small>${done} of ${total} · ${percent}%</small><span class="fii-stage-progress"><i style="width:${percent}%"></i></span>` : ''}</div>
                </li>`;
            }).join('')}
        </ol>`;
    };

    const renderAuditProgress = (activeStage, done, total) => {
        panel.dataset.status = 'audit';
        panel.innerHTML = `
            <div class="fii-panel-header">
                <div><span class="fii-eyebrow">Full-page audit</span><h2>Checking image delivery</h2></div>
                <button class="fii-icon-button" data-action="minimize" type="button" aria-label="Minimize inspector">×</button>
            </div>
            <p class="fii-summary">Each check completes once its own work reaches 100%.</p>
            ${checklistHtml(activeStage, done, total)}
        `;
        if (!state.minimized) panel.style.display = 'block';
        state.panelSummary = 'Full-page audit running';
    };

    const getUniqueItems = (items) => {
        const uniqueSources = new Map();
        for (const item of items.filter((entry) => entry.naturalWidth > 0 && entry.naturalHeight > 0)) {
            const previous = uniqueSources.get(item.source);
            const shouldReplace =
                !previous ||
                (previous.result.status === 'improve' && item.result.status !== 'improve') ||
                (previous.result.status === item.result.status &&
                    Number(item.result.recommendedWidth) > Number(previous.result.recommendedWidth));
            if (shouldReplace) uniqueSources.set(item.source, item);
        }
        return [...uniqueSources.values()];
    };

    const categorySummary = (items, tier) => {
        const matches = items.filter((item) => getOpportunity(item).tier === tier);
        const saving = matches.reduce((sum, item) => sum + Math.max(0, item.currentBytes - item.optimizedBytes), 0);
        return { count: matches.length, saving };
    };

    const getWidthFix = (item) => {
        if (item.result.status !== 'improve') {
            return item.requestedWidth ? `Keep width=${item.requestedWidth}` : 'No width parameter change';
        }
        return item.requestedWidth
            ? `Replace width=${item.requestedWidth} with width=${item.result.recommendedWidth}`
            : `Add width=${item.result.recommendedWidth}`;
    };

    const buildAgentPrompt = (items) => {
        const analyzable = items.filter((item) => item.naturalWidth > 0 && item.naturalHeight > 0);
        const improvements = analyzable.filter((item) => item.result.status === 'improve');
        const uniqueItems = getUniqueItems(items);
        const currentBytes = uniqueItems.reduce((sum, item) => sum + item.currentBytes, 0);
        const optimizedBytes = uniqueItems.reduce((sum, item) => sum + item.optimizedBytes, 0);
        const savingBytes = Math.max(0, currentBytes - optimizedBytes);
        const projectedVisits = Number(state.config.projectedVisits) || 1000000;
        const realizedPercent = api.resolveRealizedTrafficPercent(state.config);
        const high = categorySummary(uniqueItems, 'high');
        const medium = categorySummary(uniqueItems, 'medium');
        const low = categorySummary(uniqueItems, 'low');
        const keep = categorySummary(uniqueItems, 'keep');
        const safePageUrl = `${location.origin}${location.pathname}`;
        const representativeCases = uniqueItems
            .filter((item) => item.result.status === 'improve')
            .sort((first, second) => second.byteSavingPercent - first.byteSavingPercent)
            .slice(0, 20)
            .map((item) => ({
                tier: getOpportunity(item).tier,
                label: (item.isBackground
                    ? `Background image on <${item.image.tagName.toLowerCase()}>`
                    : item.image.alt || 'Unlabelled image'
                ).slice(0, 160),
                source: item.source,
                requestedWidth: item.requestedWidth || null,
                deliveredWidth: item.naturalWidth,
                deliveredHeight: item.naturalHeight,
                renderedWidth: Number(item.rect.width.toFixed(2)),
                renderedHeight: Number(item.rect.height.toFixed(2)),
                recommendedWidth: item.result.recommendedWidth,
                targetDpr: item.targetDpr,
                currentBytes: item.currentBytes,
                optimizedBytes: item.optimizedBytes,
                savingBytes: Math.max(0, item.currentBytes - item.optimizedBytes),
                savingPercent: Number(item.byteSavingPercent.toFixed(2)),
                action: getWidthFix(item),
                recommendedUrl: item.recommendedUrl,
                measured: Boolean(item.optimizedMeasured),
            }));

        return api.buildAgentPrompt({
            page: {
                url: safePageUrl,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                deviceDpr: window.devicePixelRatio,
            },
            config: state.config,
            summary: {
                imageElements: items.length,
                analyzableImages: analyzable.length,
                unmeasurableImages: items.length - analyzable.length,
                uniqueSources: uniqueItems.length,
                improvements: improvements.length,
                currentBytes,
                optimizedBytes,
                savingBytes,
                savingPercent: currentBytes ? (savingBytes / currentBytes) * 100 : 0,
                projectedVisits,
                projectedSavingBytes: Math.round(savingBytes * projectedVisits * (realizedPercent / 100)),
                measuredCount: improvements.filter((item) => item.optimizedMeasured).length,
                replaceCount: improvements.filter((item) => item.requestedWidth).length,
                addCount: improvements.filter((item) => !item.requestedWidth).length,
                tiers: {
                    high: { count: high.count, savingBytes: high.saving },
                    review: { count: medium.count + low.count, savingBytes: medium.saving + low.saving },
                    keep: { count: keep.count, savingBytes: keep.saving },
                },
            },
            cases: representativeCases,
        });
    };

    const showAgentPrompt = () => {
        const promptSection = panel.querySelector('.fii-agent-prompt');
        if (!promptSection || !state.agentPrompt) return;
        promptSection.hidden = false;
        const textArea = promptSection.querySelector('textarea');
        textArea.value = state.agentPrompt;
        panel.scrollTop = promptSection.offsetTop - 16;
        textArea.focus();
        textArea.setSelectionRange(0, 0);
        textArea.scrollTop = 0;
    };

    const applyResultFilter = (filter) => {
        state.activeFilter = filter;
        const rows = [...panel.querySelectorAll('.fii-results li')];
        let visibleCount = 0;
        for (const row of rows) {
            const visible = filter === 'all' || row.dataset.tier === filter;
            row.hidden = !visible;
            if (visible) visibleCount += 1;
        }
        for (const button of panel.querySelectorAll('.fii-filter-button')) {
            const active = button.dataset.filter === filter;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        const status = panel.querySelector('.fii-filter-status');
        if (status) status.textContent = `Showing ${visibleCount} of ${rows.length} results`;
    };

    const renderAuditResults = (items) => {
        const analyzable = items.filter((item) => item.naturalWidth > 0 && item.naturalHeight > 0);
        const improvements = analyzable.filter((item) => item.result.status === 'improve');
        const uniqueItems = getUniqueItems(items);
        const currentBytes = uniqueItems.reduce((sum, item) => sum + item.currentBytes, 0);
        const optimizedBytes = uniqueItems.reduce((sum, item) => sum + item.optimizedBytes, 0);
        const savingBytes = Math.max(0, currentBytes - optimizedBytes);
        const savingPercent = currentBytes ? (savingBytes / currentBytes) * 100 : 0;
        const measuredCount = improvements.filter((item) => item.optimizedMeasured).length;
        const sorted = [...items].sort((first, second) => second.byteSavingPercent - first.byteSavingPercent);
        const projectedVisits = Number(state.config.projectedVisits) || 1000000;
        const realizedPercent = api.resolveRealizedTrafficPercent(state.config);
        const projectedSaving = Math.round(savingBytes * projectedVisits * (realizedPercent / 100));
        const unmeasurable = items.length - analyzable.length;
        const srcsetCount = analyzable.filter((item) => item.hasSrcset).length;
        const barWidth = currentBytes ? Math.max(2, (optimizedBytes / currentBytes) * 100) : 100;
        const must = categorySummary(uniqueItems, 'high');
        const medium = categorySummary(uniqueItems, 'medium');
        const low = categorySummary(uniqueItems, 'low');
        const keep = categorySummary(uniqueItems, 'keep');
        const review = { count: medium.count + low.count, saving: medium.saving + low.saving };
        const tierCounts = { all: sorted.length, high: 0, medium: 0, low: 0, keep: 0, unknown: 0 };
        for (const item of sorted) tierCounts[getOpportunity(item).tier] += 1;
        const filters = [
            ['all', 'All'],
            ['high', 'High'],
            ['medium', 'Medium'],
            ['low', 'Low'],
            ['keep', 'Keep'],
            ...(tierCounts.unknown ? [['unknown', 'N/A']] : []),
        ];
        const replaceCount = improvements.filter((item) => item.requestedWidth).length;
        const addCount = improvements.length - replaceCount;
        const benchmarkItem = improvements[0];
        state.agentPrompt = buildAgentPrompt(items);
        state.auditResultItems.clear();
        sorted.forEach((item, index) => state.auditResultItems.set(String(index), item));

        panel.dataset.status = 'audit';
        panel.innerHTML = `
            <div class="fii-panel-header fii-audit-header">
                <div><span class="fii-eyebrow">Full-page audit complete</span><h2>${improvements.length} images have room</h2></div>
                <button class="fii-icon-button" data-action="minimize" type="button" aria-label="Minimize inspector">×</button>
            </div>
            <details class="fii-completed-checks"><summary>${AUDIT_STAGES.length} checks completed</summary>${checklistHtml()}</details>
            <div class="fii-audit-stats">
                <div><span>Image elements</span><strong>${items.length}</strong></div>
                <div><span>Unique sources</span><strong>${uniqueItems.length}</strong></div>
                <div><span>Keep</span><strong>${analyzable.length - improvements.length}</strong></div>
                <div><span>Could improve</span><strong>${improvements.length}</strong></div>
                <div><span>Not measurable</span><strong>${unmeasurable}</strong></div>
            </div>
            <div class="fii-tier-summary">
                <div data-tier="high"><span>Must fix</span><strong>${formatBytes(must.saving)}</strong><small>${must.count} high-opportunity sources</small></div>
                <div data-tier="medium"><span>Worth reviewing</span><strong>${formatBytes(review.saving)}</strong><small>${review.count} medium/low sources</small></div>
                <div data-tier="keep"><span>Keep as-is</span><strong>${formatBytes(keep.saving)}</strong><small>${keep.count} sources need no reduction</small></div>
            </div>
            <div class="fii-traffic">
                <div class="fii-traffic-label"><span>Unique image payload per complete visit</span><strong>${formatPercent(savingPercent)} less</strong></div>
                <div class="fii-traffic-bar" title="Green is the projected optimized payload; pale red is removable payload."><span style="width:${barWidth}%"></span></div>
                <div class="fii-traffic-values"><span>${formatBytes(currentBytes)} currently transferred</span><span>${formatBytes(optimizedBytes)} after recommendations</span></div>
                <p>Counts each unique image URL once. Duplicate DOM elements using the same URL do not multiply network bytes.</p>
            </div>
            <div class="fii-projection">
                <div><span>${realizedPercent < 100 ? 'Adjusted projection' : 'Projected saving (upper bound)'}</span><strong>${formatBytes(projectedSaving)}</strong></div>
                <p>${projectedVisits.toLocaleString()} users × one complete page visit × ${formatBytes(savingBytes)} saved per visit${
                    realizedPercent < 100
                        ? `, scaled to ${realizedPercent}% realized traffic (your cache/lazy-load factor in Options)`
                        : ''
                }. Repeat visits, browser cache, and lazy-loaded images can lower real traffic; treat the 100% figure as a ceiling, not a forecast.</p>
            </div>
            <details class="fii-explainer"><summary>How savings are calculated</summary><p>Measured Fastly variants use response bytes. Unmeasured variants use the change in pixel area as an estimate. Recommendations preserve the configured preferred DPR and only use verified CDN widths.</p></details>
            <section class="fii-code-benchmark">
                <div><span>Implementation benchmark</span><strong>Use one shared URL helper</strong></div>
                <p>${replaceCount} URLs need their existing width replaced; ${addCount} need a width added. Each row gives the exact value.</p>
                ${benchmarkItem ? `<code>${escapeHtml(getWidthFix(benchmarkItem))}</code>` : '<code>No width change recommended</code>'}
                <pre>const setImageWidth = (src, width) =&gt; {
    const url = new URL(src, location.origin);
    url.searchParams.set('${escapeHtml(state.config.widthParameter)}', String(width));
    return url.toString();
};</pre>
                <small>Do not remove a width parameter unless the no-parameter response was separately verified to return identical dimensions and bytes.</small>
            </section>
            <section class="fii-agent-handoff">
                <div><span>AI agent handoff</span><strong>Generate a repository-ready task</strong></div>
                <p>Packages this audit's real values, prioritized examples, responsive safety rules, implementation steps, and verification checklist into one portable Markdown prompt.</p>
                <button type="button" data-action="generate-prompt">Generate task prompt</button>
            </section>
            <section class="fii-agent-prompt" aria-label="Generated AI task prompt" hidden>
                <div class="fii-agent-prompt-header">
                    <div><span>Generated Markdown</span><strong>Ready for any coding agent</strong></div>
                    <button type="button" data-action="close-agent-prompt" aria-label="Close generated prompt">×</button>
                </div>
                <textarea readonly spellcheck="false" aria-label="Generated AI task prompt"></textarea>
                <div class="fii-actions">
                    <button type="button" data-action="copy-agent-prompt">Copy prompt</button>
                    <button type="button" data-action="download-agent-prompt" class="fii-secondary">Download .md</button>
                </div>
                <small>The prompt includes up to 20 representative unique sources. It instructs the agent to trace the shared renderer and verify every responsive layout before changing code.</small>
            </section>
            <div class="fii-filter-header"><strong>Filter results</strong><span class="fii-filter-status">Showing ${sorted.length} of ${sorted.length} results</span></div>
            <div class="fii-filters" role="group" aria-label="Filter image results">
                ${filters.map(([filter, label]) => `<button class="fii-filter-button${filter === 'all' ? ' is-active' : ''}" type="button" data-action="filter" data-filter="${filter}" aria-pressed="${filter === 'all'}"><i class="${filter}"></i>${label}<b>${tierCounts[filter]}</b></button>`).join('')}
            </div>
            <ol class="fii-results">
                ${sorted.map((item, index) => {
                    const tier = getOpportunity(item).tier;
                    const saving = Math.max(0, item.currentBytes - item.optimizedBytes);
                    const step =
                        tier === 'unknown'
                            ? '<span>Not measurable</span>'
                            : item.result.status === 'improve'
                              ? `<span>${item.naturalWidth}px</span><b>→</b><span>${item.result.recommendedWidth}px</span>`
                              : `<span>Keep ${item.naturalWidth}px</span>`;
                    const request = item.requestedWidth ? `URL requests ${item.requestedWidth}px · ` : '';
                    const impact =
                        tier === 'unknown'
                            ? 'Hidden or not loaded during the audit — scroll it into view and run again'
                            : item.result.status === 'improve'
                              ? `${getWidthFix(item)} · ${request}${item.currentBytes ? `Save ${formatBytes(saving)} (${formatPercent(item.byteSavingPercent)})` : `${formatPercent(item.byteSavingPercent)} estimated pixel reduction`} · Safe at ${formatNumber(item.targetDpr, 2)}× DPR`
                              : `No safe reduction recommended · ${formatNumber(item.targetDpr, 2)}× DPR target`;
                    const label = item.isBackground
                        ? `background image on <${item.image.tagName.toLowerCase()}>`
                        : item.image.alt || item.source;
                    return `<li data-tier="${tier}" style="--fii-result-color:${item.color}">
                        <button class="fii-result-button" type="button" data-action="locate" data-item-id="${index}" aria-label="Locate ${escapeHtml(item.image.alt || 'image')} on the page">
                            <span class="fii-result-copy"><strong class="fii-result-step">${step}</strong><span class="fii-result-impact">${evidenceBadge(item)} ${escapeHtml(impact)}</span><small>${escapeHtml(label)}</small></span>
                            <span class="fii-locate-label">Locate <b>↗</b></span>
                        </button>
                    </li>`;
                }).join('')}
            </ol>
            <div class="fii-actions">
                <button type="button" data-action="audit">Run again</button>
                <button type="button" data-action="clear-audit" class="fii-secondary">Clear borders</button>
            </div>
            <p class="fii-footnote">${measuredCount}/${improvements.length} optimized variants were byte-measured; rows badge each saving as Measured or Estimated.${
                srcsetCount
                    ? ` ${srcsetCount} images use responsive srcset — recommendations reflect this viewport's selected source only; re-audit at other breakpoints.`
                    : ''
            }${
                unmeasurable
                    ? ` ${unmeasurable} images stayed hidden or unloaded and are outlined gray as Not measurable.`
                    : ''
            } Hover any outlined image for its recommendation; click it to pin full details here without losing this audit.</p>
        `;
        state.auditComplete = true;
        state.panelSummary = `${improvements.length} images have room`;
        state.activeFilter = 'all';
    };

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const triggerLazyLoading = async (onProgress) => {
        const originalY = window.scrollY;
        const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
        const maxSteps = 40;
        for (let index = 1; index <= maxSteps; index += 1) {
            const maxScroll = Math.max(
                document.documentElement.scrollHeight,
                document.body?.scrollHeight || 0,
            );
            const top = Math.min(index * step, maxScroll);
            window.scrollTo({ top, behavior: 'instant' });
            onProgress?.(index, Math.max(Math.ceil(maxScroll / step), 1));
            if (top >= maxScroll) break;
            await sleep(180);
        }
        await sleep(250);
        window.scrollTo({ top: originalY, behavior: 'instant' });
    };

    const waitForImage = (image, timeout = 3000) => {
        if (image.complete && image.naturalWidth) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = window.setTimeout(() => resolve(false), timeout);
            const done = (ok) => {
                window.clearTimeout(timer);
                resolve(ok);
            };
            if (typeof image.decode === 'function') {
                image.decode().then(() => done(true), () => done(false));
            } else {
                image.addEventListener('load', () => done(true), { once: true });
                image.addEventListener('error', () => done(false), { once: true });
            }
        });
    };

    const collectAuditTargets = () => {
        const images = [];
        const elements = [];
        const walk = (rootNode) => {
            for (const element of rootNode.querySelectorAll('*')) {
                if (element.closest('#fastly-image-inspector-root')) continue;
                if (element.tagName === 'IMG') images.push(element);
                if (element.shadowRoot) walk(element.shadowRoot);
                elements.push(element);
            }
        };
        walk(document);

        const backgrounds = [];
        const urlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/;
        for (const element of elements) {
            if (backgrounds.length >= MAX_BACKGROUND_TARGETS) break;
            const backgroundImage = getComputedStyle(element).backgroundImage;
            if (!backgroundImage || backgroundImage === 'none') continue;
            const match = urlPattern.exec(backgroundImage);
            if (!match?.[2]) continue;
            try {
                backgrounds.push({ element, url: new URL(match[2], location.href).href });
            } catch (_error) {
                // Ignore unparseable background URLs.
            }
        }
        return { images, backgrounds };
    };

    const runAudit = async () => {
        if (state.auditing) return;
        state.auditing = true;
        state.auditComplete = false;
        state.auditItems.clear();
        state.auditResultItems.clear();
        clearAudit();

        renderAuditProgress(0, 0, 1);
        await triggerLazyLoading((done, total) => renderAuditProgress(0, done, total));
        await Promise.allSettled([...document.images].map((image) => waitForImage(image)));

        renderAuditProgress(1, 0, 1);
        const { images: domImages, backgrounds } = collectAuditTargets();
        const images = domImages.filter((image) => image.currentSrc || image.src);
        renderAuditProgress(1, 1, 1);

        const sources = [
            ...images.map((image) => image.currentSrc || image.src),
            ...backgrounds.map((target) => target.url),
        ];
        renderAuditProgress(2, 0, Math.max(sources.length, 1));
        const currentMetadata = await measureUrlsInBatches(sources, (done, total) => {
            renderAuditProgress(2, done, Math.max(total, 1));
        });

        renderAuditProgress(3, 0, Math.max(images.length + backgrounds.length, 1));
        const items = [];
        for (const [index, image] of images.entries()) {
            const source = image.currentSrc || image.src;
            const metadata = currentMetadata.get(source) || {};
            const item = analyzeElement(image, metadata);
            item.currentBytes = metadata.bytes || getTimingBytes(source);
            items.push(item);
            if (index % 10 === 0 || index === images.length - 1) {
                renderAuditProgress(3, index + 1, Math.max(images.length + backgrounds.length, 1));
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }
        const backgroundItems = await Promise.all(backgrounds.map((target) => analyzeBackgroundElement(target)));
        for (const item of backgroundItems) {
            const metadata = currentMetadata.get(item.source) || {};
            item.currentBytes = metadata.bytes || getTimingBytes(item.source);
            items.push(item);
        }
        renderAuditProgress(3, images.length + backgrounds.length, Math.max(images.length + backgrounds.length, 1));

        const recommendedUrls = items.filter((item) => item.result.status === 'improve').map((item) => item.recommendedUrl);
        renderAuditProgress(4, 0, Math.max(new Set(recommendedUrls).size, 1));
        const optimizedMetadata = await measureUrlsInBatches(recommendedUrls, (done, total) => {
            renderAuditProgress(4, done, Math.max(total, 1));
        });

        renderAuditProgress(5, 0, Math.max(items.length, 1));
        for (const [index, item] of items.entries()) {
            const optimized = optimizedMetadata.get(item.recommendedUrl);
            const measurable = item.naturalWidth > 0 && item.naturalHeight > 0;
            item.optimizedMeasured = Boolean(optimized?.bytes);
            item.optimizedBytes =
                item.result.status === 'improve'
                    ? optimized?.bytes || api.estimateOptimizedBytes(item.currentBytes, item.naturalWidth, item.result.recommendedWidth)
                    : item.currentBytes;
            item.byteSavingPercent = item.currentBytes
                ? Math.max(0, (1 - item.optimizedBytes / item.currentBytes) * 100)
                : item.result.estimatedPixelAreaSavingPercent;
            item.color = measurable
                ? api.getOpportunityColor(item.byteSavingPercent, item.result.status)
                : UNMEASURABLE_COLOR;
            item.image.style.setProperty('--fii-audit-color', item.color);
            item.image.classList.add('fii-audited-image');
            state.auditedImages.add(item.image);
            state.auditItems.set(item.image, item);
            if (index % 20 === 0 || index === items.length - 1) renderAuditProgress(5, index + 1, Math.max(items.length, 1));
        }
        renderAuditResults(items);
        state.auditing = false;
    };

    const loadConfig = async () => {
        const stored = await chrome.storage.sync.get(api.DEFAULT_CONFIG);
        state.config = {
            ...api.DEFAULT_CONFIG,
            ...stored,
            honoredWidths: api.sanitizeWidths(stored.honoredWidths || api.DEFAULT_HONORED_WIDTHS),
        };
    };

    const activate = async () => {
        await loadConfig();
        state.active = true;
        prompt.style.display = 'flex';
        document.documentElement.classList.add('fii-inspecting');
    };

    const deactivate = () => {
        state.active = false;
        state.auditing = false;
        prompt.style.display = 'none';
        panel.style.display = 'none';
        minimizedBar.style.display = 'none';
        state.minimized = false;
        clearAudit(true);
        document.documentElement.classList.remove('fii-inspecting');
    };

    document.addEventListener('pointerover', (event) => {
        if (!state.active || state.minimized || root.contains(event.target)) return;
        const image = findAuditTarget(event.target);
        if (image) {
            positionHighlight(image);
            renderHoverTooltip(image);
        } else hideHover();
    }, true);

    document.addEventListener('click', (event) => {
        if (!state.active || state.minimized || root.contains(event.target)) return;
        const image = findAuditTarget(event.target);
        if (!image) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        positionHighlight(image);
        renderAnalysis(image);
    }, true);

    document.addEventListener('keydown', (event) => {
            if (state.active && event.key === 'Escape') minimizePanel();
    }, true);

    root.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.action === 'minimize') minimizePanel();
        if (button.dataset.action === 'maximize') maximizePanel();
        if (button.dataset.action === 'close-inspector') deactivate();
        if (button.dataset.action === 'close-detail') button.closest('.fii-selected-detail')?.remove();
        if (button.dataset.action === 'settings') chrome.runtime.sendMessage({ type: 'fastly-image-inspector-open-options' });
        if (button.dataset.action === 'audit') runAudit();
        if (button.dataset.action === 'clear-audit') clearAudit();
        if (button.dataset.action === 'locate') locateAuditImage(state.auditResultItems.get(button.dataset.itemId));
        if (button.dataset.action === 'filter') applyResultFilter(button.dataset.filter);
        if (button.dataset.action === 'generate-prompt') showAgentPrompt();
        if (button.dataset.action === 'close-agent-prompt') button.closest('.fii-agent-prompt').hidden = true;
        if (button.dataset.action === 'copy-agent-prompt') {
            try {
                await navigator.clipboard.writeText(state.agentPrompt);
                button.textContent = 'Prompt copied';
            } catch (_error) {
                button.textContent = 'Copy failed';
            }
        }
        if (button.dataset.action === 'download-agent-prompt') {
            const blobUrl = URL.createObjectURL(new Blob([state.agentPrompt], { type: 'text/markdown' }));
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `image-optimization-task-${new Date().toISOString().slice(0, 10)}.md`;
            link.click();
            URL.revokeObjectURL(blobUrl);
        }
        if (button.dataset.action === 'copy') {
            try {
                await navigator.clipboard.writeText(button.dataset.url);
                button.textContent = 'Copied';
            } catch (_error) {
                button.textContent = 'Copy failed';
            }
        }
    });

    root.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('.fii-panel-header, .fii-minimized-bar');
        if (!handle || event.target.closest('button')) return;
        const element = handle.classList.contains('fii-minimized-bar') ? minimizedBar : panel;
        const rect = element.getBoundingClientRect();
        state.drag = { element, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        element.classList.add('is-dragging');
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    document.addEventListener('pointermove', (event) => {
        if (!state.drag) return;
        setFloatingPosition(state.drag.element, event.clientX - state.drag.offsetX, event.clientY - state.drag.offsetY);
    }, true);

    document.addEventListener('pointerup', () => {
        state.drag?.element.classList.remove('is-dragging');
        state.drag = null;
    }, true);

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'fastly-image-inspector-ping') {
            sendResponse({ installed: true, active: state.active });
            return;
        }
        if (message?.type === 'fastly-image-inspector-toggle') {
            if (state.active) {
                if (state.minimized) maximizePanel();
                else minimizePanel();
                sendResponse({ active: true, minimized: state.minimized });
            } else {
                activate().then(() => sendResponse({ active: true }));
                return true;
            }
        }
    });
})();
