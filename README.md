# Image Inspector

An internal Chrome extension (Manifest V3, loaded unpacked) that checks whether a rendered image can safely use a
smaller verified CDN width — for one image, or for the whole page at once.

> **Reading this on GitHub?** A richer visual version of this guide lives on the project's GitHub Pages site
> (`index.html` in this repo).  https://safei-ashraf.github.io/image-inspector-performance/ 

## What it does

- **Inspect one image** — click the toolbar icon, then click any `<img>`: instant **Keep as is** or **Use Npx**
  verdict with the full sizing math.
- **Audit the full page** — one click auto-scrolls to trigger lazy-loaded images, waits for them, then scans every
  `<img>` (including open shadow roots) and CSS `background-image`, outlines each by severity, and opens a ranked
  dashboard with measured byte savings.
- **Hand off to a coding agent** — generate a portable Markdown task with measured totals, exact width changes,
  verified CDN widths, responsive safety constraints, and an explain/implement/test/rerun workflow.

Outline colors: **green** keep as is · **yellow** low savings · **orange** medium · **red** high ·
**gray** not measurable (hidden or not loaded during the audit).

## Install

No store, no account — the extension runs unpacked:

1. Get the code: download and unzip the repo ZIP (**Code → Download ZIP**), or
   `git clone <repo-url>` (cloning makes updates a one-liner).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and choose this directory (the one with `manifest.json`).
5. Pin **Fastly Image Inspector** to the toolbar via the puzzle-piece icon.
6. Open the extension's **Options**, add your CDN hostname(s) under **CDN measurement**, and save — Chrome asks for
   a one-time permission per host. Nothing is measured until you do this.

## Use

1. Open the page to inspect.
2. Click the extension icon.
3. Click any `<img>` on the page, or click **Analyze full page** in the inspector pill.
4. Read the **Keep as is** / **Use Npx** result, or work the ranked dashboard.
5. Press <kbd>Esc</kbd> or click the extension icon again to stop inspecting.

The completed dashboard stays open while inspecting the page:

- Hover any outlined image for a floating recommendation, delivered size, preferred DPR, and savings.
- Click an image to pin its full analysis above the page results without replacing the audit.
- Click any ranked row to scroll its image into view, show directional guidance, and pulse its border.
- Each optimization row states the exact delivered-width change (for example `2400px → 480px`), saved bytes and
  percentage, and the preferred DPR that remains covered. Every saving carries a **Measured** badge (real response
  bytes) or an **Estimated** badge (pixel-area estimate) — never treat estimates as measurements.
- Images using `srcset`/`sizes` are flagged: the audit samples the source the browser selected at the current
  viewport, so re-audit at other breakpoints before changing their widths.
- Filter the ranked list by High, Medium, Low, Keep, or N/A (not measurable).
- Drag the panel by its header and resize it from its corner. The × minimizes without losing the audit; the minimized
  bar has separate restore and full-close buttons.
- The implementation benchmark shows the shared `setImageWidth` helper and whether each row should add, replace, or
  keep the configured width parameter.
- **Generate task prompt** creates the Markdown agent handoff — preview it, copy it, or download it as a `.md` file.
- The dashboard separates high-opportunity **Must fix**, lower-opportunity **Worth reviewing**, and **Keep as-is**
  byte totals, and labels the traffic projection as an upper bound unless you set a realized-traffic factor.

The audit auto-scrolls the page (up to 40 viewport steps) and waits for pending images before measuring, so most
lazy-loaded images are covered. Any image that still exposes no rendered or intrinsic dimensions is outlined gray,
listed under the **N/A** filter, and counted separately as **Not measurable** instead of being silently treated as
"keep". CDN metadata requests are deduplicated and sent in small batches.

The extension does not change the selected image. **Copy recommended URL** copies a URL with the configured width
parameter replaced for manual testing.

## Update

- Cloned with git: `git pull`, then press reload on the extension card at `chrome://extensions`.
- Downloaded ZIP: extract the latest ZIP over the old folder (or remove the extension and load the new folder),
  then reload at `chrome://extensions`.

## Settings (Options)

Right-click the toolbar icon → **Options**, or use the Settings button in the panel. Defaults match the production
policy:

- Desktop preferred DPR: 2
- Mobile preferred DPR: 3
- Use this device's actual DPR: off (overrides the fixed targets when enabled)
- Mobile breakpoint: 768 CSS px
- Safety multiplier: 1.05, used only when the exact post-margin integer is in the verified list
- Minimum worthwhile width reduction: 5%
- Widths: a built-in starter list in `analysis.js` — replace it with widths you have verified against your own CDN
- CDN hostnames: none by default. Add your CDN host(s) in Options; each is granted via a one-time Chrome permission
  prompt (subdomains match automatically), and nothing is measured until at least one host is configured.
  Non-Fastly hosts still get `content-length` byte measurements; only Fastly hosts expose `fastly-io-info`
  dimensions.
- Projection: 1,000,000 complete page visits at 100% realized traffic (an upper bound; lower the realized-traffic
  percentage to adjust for browser cache and lazy loading)

The verified width list can also be fetched from an `https://` URL (plain text or JSON numbers); Chrome asks for host
permission once, and Options warns when a fetched list is older than 30 days or when the embedded snapshot has never
been refreshed.

## Recommendation rules

1. Required pixels = rendered CSS dimensions × preferred DPR.
2. If the source is below that target, keep it because it is already source-limited.
3. Apply the safety multiplier only when its exact rounded width is verified; otherwise use the smallest verified
   width that covers the raw DPR requirement.
4. Keep the current image if no smaller verified width exists or the width reduction is below the configured
   threshold.
5. Otherwise recommend the smaller verified width and show estimated width and pixel-area reduction.

For CDN URLs, the full-page audit asks the extension service worker for `HEAD` metadata and reads `content-length`
and `fastly-io-info`. If the optimized variant cannot be measured, it estimates encoded bytes from the pixel-area
ratio and badges the row as **Estimated**. Identical current URLs are deduplicated in traffic totals. The projection
assumes every DOM image loads once per visit unless you lower the realized-traffic factor; lazy loading and browser
caches can make realized savings lower.

## Troubleshooting

- **Red "!" badge on the toolbar icon** — the page can't be injected (`chrome://` pages, the Chrome Web Store, PDFs).
  Try a regular page.
- **Gray / "Not measurable" images** — hidden or still loading during the audit. Scroll them into view and press
  **Run again**.
- **"Estimated" instead of "Measured"** — the optimized variant couldn't be fetched; the byte figure is a pixel-area
  estimate.
- **Extra CDN host not measured** — open Options and check the permission status under **CDN measurement**; saving
  again re-triggers the Chrome permission prompt.
- **Remove** — `chrome://extensions` → **Remove** on the extension card, then delete the folder.

## Test

```sh
node --test analysis.test.js
```

## Repo layout

- `manifest.json` — extension manifest (MV3)
- `background.js` — service worker: injection, CDN `HEAD` measurement, options shortcut
- `analysis.js` — shared analysis engine (recommendation rules, prompt builder, host/width helpers)
- `inspector.js` / `inspector.css` — in-page inspector UI and audit dashboard
- `options.html` / `options.js` / `options.css` — settings page
- `index.html` — standalone visual guide (publish via GitHub Pages)
- `analysis.test.js` — Node test suite
