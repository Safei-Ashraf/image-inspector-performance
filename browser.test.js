const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const extensionPath = __dirname;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const startFixtureServer = () =>
    new Promise((resolve) => {
        const server = http.createServer((request, response) => {
            if (request.url.startsWith('/image.svg')) {
                response.writeHead(200, { 'content-type': 'image/svg+xml' });
                response.end(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="644" height="526"><rect width="644" height="526" fill="#eef2ff"/><circle cx="322" cy="230" r="130" fill="#5b5bd6"/><text x="322" y="450" text-anchor="middle" font-size="44">Test image</text></svg>',
                );
                return;
            }
            if (request.url.startsWith('/large.svg')) {
                response.writeHead(200, { 'content-type': 'image/svg+xml' });
                response.end(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#fee2e2"/><text x="600" y="320" text-anchor="middle" font-size="72">Large image</text></svg>',
                );
                return;
            }

            response.writeHead(200, { 'content-type': 'text/html' });
            response.end(
                '<!doctype html><style>body{margin:40px;font-family:sans-serif;min-height:2400px}img{display:block;width:269px;height:auto;margin:20px}#large{margin-top:1200px}</style><img id="target" src="/image.svg?width=2400" alt="Fixture"><img id="large" src="/large.svg?width=2400" alt="Large fixture">',
            );
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });

test('keeps the page audit visible while hover and click expose per-image guidance', async () => {
    const server = await startFixtureServer();
    const address = server.address();
    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
    });
    const context = await browser.newContext({
        viewport: { width: 1200, height: 800 },
        deviceScaleFactor: 2,
    });
    await context.addInitScript(() => {
        globalThis.chrome = {
            storage: {
                sync: {
                    get: async (defaults) => defaults,
                    set: async () => {},
                },
            },
            runtime: {
                onMessage: {
                    addListener: (listener) => {
                        globalThis.__extensionMessageListener = listener;
                    },
                },
                sendMessage: async () => ({ results: [] }),
            },
        };
    });

    try {
        const page = await context.newPage();

        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.addStyleTag({ path: path.join(extensionPath, 'inspector.css') });
        await page.addScriptTag({ path: path.join(extensionPath, 'analysis.js') });
        await page.addScriptTag({ path: path.join(extensionPath, 'inspector.js') });
        await page.evaluate(() => {
            globalThis.__extensionMessageListener({ type: 'fastly-image-inspector-toggle' }, null, () => {});
        });
        await page.locator('.fii-prompt').waitFor({ state: 'visible' });
        await page.evaluate(() => {
            const image = document.querySelector('#target');
            image.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });

        const panelText = await page.locator('.fii-panel').innerText();
        assert.match(panelText, /Use 540px/);
        assert.match(panelText, /Preferred DPR\s+2\.00×/i);
        assert.match(panelText, /Recommended width\s+540px/i);

        await page.locator('[data-action="audit"]').first().click();
        await page.locator('.fii-eyebrow', { hasText: 'Full-page audit complete' }).waitFor();
        const auditText = await page.locator('.fii-panel').innerText();
        assert.match(auditText, /2 images have room/);
        assert.match(auditText, /1,000,000 users × one complete page visit/i);
        assert.match(auditText, /Must fix/i);
        assert.match(auditText, /Worth reviewing/i);
        assert.match(auditText, /How savings are calculated/i);
        assert.match(auditText, /Implementation benchmark/i);
        assert.match(auditText, /setImageWidth/i);
        assert.match(auditText, /Replace width=2400 with width=540/i);
        assert.match(auditText, /AI agent handoff/i);
        assert.match(auditText, /Generate task prompt/i);
        assert.equal(await page.locator('.fii-check-item.is-complete').count(), 5);
        assert.equal(await page.locator('img.fii-audited-image').count(), 2);
        assert.match(await page.locator('#large').getAttribute('style'), /--fii-audit-color: #ef4444/);

        await page.locator('[data-action="generate-prompt"]').click();
        await page.locator('.fii-agent-prompt').waitFor({ state: 'visible' });
        const generatedPrompt = await page.locator('.fii-agent-prompt textarea').inputValue();
        assert.equal(await page.locator('.fii-agent-prompt textarea').evaluate((element) => element.scrollTop), 0);
        assert.match(generatedPrompt, /Image delivery optimization task/i);
        assert.match(generatedPrompt, /2 image elements/i);
        assert.match(generatedPrompt, /current 1200 × 800 viewport at 2\.00× device DPR/i);
        assert.match(generatedPrompt, /Replace width=2400 with width=540/i);
        assert.match(generatedPrompt, /Do not blindly hardcode the sampled recommendation/i);
        assert.match(generatedPrompt, /If you can edit the repository, implement and verify the fix end to end/i);
        assert.equal(await page.locator('[data-action="copy-agent-prompt"]').count(), 1);
        assert.equal(await page.locator('[data-action="download-agent-prompt"]').count(), 1);
        await page.screenshot({ path: path.join(extensionPath, 'browser-verification-agent-prompt.png') });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: `http://127.0.0.1:${address.port}`,
        });
        await page.locator('[data-action="copy-agent-prompt"]').click();
        await page.locator('[data-action="copy-agent-prompt"]', { hasText: 'Prompt copied' }).waitFor();
        assert.equal(await page.locator('[data-action="copy-agent-prompt"]').innerText(), 'Prompt copied');
        const downloadPromise = page.waitForEvent('download');
        await page.locator('[data-action="download-agent-prompt"]').click();
        const download = await downloadPromise;
        assert.match(download.suggestedFilename(), /^image-optimization-task-\d{4}-\d{2}-\d{2}\.md$/);
        await page.locator('[data-action="close-agent-prompt"]').click();
        assert.equal(await page.locator('.fii-agent-prompt').isVisible(), false);

        assert.equal(await page.locator('.fii-filter-button').count(), 5);
        await page.locator('.fii-filter-button', { hasText: 'High' }).click();
        assert.equal(await page.locator('.fii-result-button:visible').count(), 1);
        assert.match(await page.locator('.fii-result-button:visible').innerText(), /Large fixture/i);
        await page.screenshot({ path: path.join(extensionPath, 'browser-verification-filter.png') });
        await page.locator('.fii-filter-button', { hasText: 'Medium' }).click();
        assert.equal(await page.locator('.fii-result-button:visible').count(), 1);
        assert.match(await page.locator('.fii-result-button:visible').innerText(), /Fixture/i);
        await page.locator('.fii-filter-button', { hasText: 'All' }).click();

        const highestOpportunity = page.locator('.fii-result-button').first();
        const rowText = await highestOpportunity.innerText();
        assert.match(rowText, /1200px\s*→\s*540px/i);
        assert.match(rowText, /URL requests 2400px/i);
        assert.match(rowText, /safe at 2\.00× DPR/i);
        assert.match(rowText, /save 156 B/i);
        assert.ok((await page.locator('#large').boundingBox()).y > 800);
        await highestOpportunity.evaluate((row) => row.scrollIntoView());
        await page.screenshot({ path: path.join(extensionPath, 'browser-verification-results.png') });
        await highestOpportunity.click();
        await page.waitForFunction(() => window.scrollY > 500);
        assert.match(await page.locator('.fii-navigation-toast').innerText(), /(scrolling down|image centered)/i);
        await page.waitForFunction(() => document.querySelector('#large').classList.contains('fii-locate-pulse'));
        assert.equal(await page.locator('#large').evaluate((image) => image.classList.contains('fii-locate-pulse')), true);
        await page.screenshot({ path: path.join(extensionPath, 'browser-verification-locate.png') });

        await page.locator('#large').hover();
        await page.locator('.fii-image-tooltip').waitFor({ state: 'visible' });
        const tooltipText = await page.locator('.fii-image-tooltip').innerText();
        assert.match(tooltipText, /High opportunity/i);
        assert.match(tooltipText, /Use 540px/i);
        assert.equal(await page.locator('.fii-highlight').evaluate((element) => getComputedStyle(element).display), 'block');

        await page.locator('#target').click();
        const persistentAuditText = await page.locator('.fii-panel').innerText();
        assert.match(persistentAuditText, /Full-page audit complete/i);
        assert.match(persistentAuditText, /Selected image/i);
        assert.match(persistentAuditText, /Use 540px/i);
        assert.equal(await page.locator('.fii-selected-detail').count(), 1);

        await page.evaluate(() => {
            const dynamicImage = document.querySelector('#target').cloneNode();
            dynamicImage.id = 'dynamic';
            dynamicImage.alt = 'Added after audit';
            document.body.append(dynamicImage);
        });
        await page.locator('#dynamic').click();
        assert.match(await page.locator('.fii-panel').innerText(), /Full-page audit complete/i);
        assert.equal(await page.locator('.fii-selected-detail').count(), 1);

        const panelBeforeDrag = await page.locator('.fii-panel').boundingBox();
        const dragHandle = await page.locator('.fii-audit-header').boundingBox();
        await page.mouse.move(dragHandle.x + 120, dragHandle.y + 22);
        await page.mouse.down();
        await page.mouse.move(dragHandle.x - 80, dragHandle.y + 72, { steps: 5 });
        await page.mouse.up();
        const panelAfterDrag = await page.locator('.fii-panel').boundingBox();
        assert.ok(panelAfterDrag.x < panelBeforeDrag.x - 100);
        assert.equal(await page.locator('.fii-panel').evaluate((element) => getComputedStyle(element).resize), 'both');

        await page.locator('.fii-audit-header [data-action="minimize"]').click();
        await page.locator('.fii-minimized-bar').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.fii-panel').isVisible(), false);
        assert.equal(await page.locator('.fii-prompt').isVisible(), false);
        assert.match(await page.locator('.fii-minimized-bar').innerText(), /2 images have room/i);
        assert.equal(await page.locator('.fii-minimized-bar [data-action="close-inspector"]').count(), 1);
        assert.equal(await page.locator('.fii-minimized-bar [data-action="maximize"]').count(), 1);
        await page.screenshot({ path: path.join(extensionPath, 'browser-verification-minimized.png') });
        await page.locator('.fii-minimized-bar [data-action="maximize"]').click();
        await page.locator('.fii-panel').waitFor({ state: 'visible' });
        assert.match(await page.locator('.fii-panel').innerText(), /Full-page audit complete/i);
        await page.screenshot({ path: path.join(extensionPath, 'browser-verification.png') });

        const optionsPage = await context.newPage();
        await optionsPage.goto(`file://${path.join(extensionPath, 'options.html')}`);
        assert.equal(await optionsPage.locator('[name="desktopTargetDpr"]').inputValue(), '2');
        assert.equal(await optionsPage.locator('[name="projectedVisits"]').inputValue(), '1000000');
        assert.match(await optionsPage.locator('[name="honoredWidths"]').inputValue(), /540/);
    } finally {
        await context.close();
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
});
