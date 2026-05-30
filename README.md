# Tracking Validator

> macOS desktop app for TSE at impact.com. Validates impact.com tracking integrations at scale by crawling tracking links through headless Chromium and inspecting UTT, Shopify Plugin, and custom click ID implementations.

---

## What It Does

Tracking Validator automates the manual process of checking whether tracking links are configured and firing correctly. Given a list of tracking URLs, it:

- Crawls each link through a headless Chromium browser
- Follows the full redirect chain (including impact.com → merchant → landing page)
- Detects the integration type: UTT, Shopify Plugin, Hybrid, ClickId, or Unknown
- Validates click ID propagation, UTT tag presence, identify call firing, and Shopify pageload behavior
- Enriches results via the Identity API (consumer lookup by click ID or first-party cookie)
- Surfaces a remediation note per result based on a priority-ordered rule engine
- Exports results to CSV

---

## Installation

### Download

Download the latest release from the [TSE Tools hub](https://fastshoes.co.za/scott/tools/tracking_validator/).

Two builds are available:
- `Tracking.Validator-arm64.dmg` — Apple Silicon (M1/M2/M3)
- `Tracking.Validator-x64.dmg` — Intel

### First-Run Setup

The app is not code-signed. After dragging to `/Applications`, run this once in Terminal:

```bash
sudo xattr -cr "/Applications/Tracking Validator.app"
```

Then open normally. macOS will not prompt again.

---

## Usage

### Input Format

Paste tracking URLs into the input area — one per line. URLs must be valid impact.com tracking links (e.g. `https://brand.sjv.io/c/...` or custom tracking domain).

Optionally provide:
- **Campaign IDs** — used to generate the SQL query for bulk click ID parameter lookup
- **Click ID Parameter** — if known, overrides auto-detection

### Running a Validation

1. Paste URLs → click **Validate**
2. Results stream in as each URL is processed
3. Click any row to open the detail drawer (full result breakdown + Identity API output)
4. Use **Export CSV** to download all results

### SQL Query Helper

The **SQL** button generates a query for `r_ds_multiDb` that returns tracking URLs and their `{clickid}` parameter for a given set of campaign IDs. Uses `={clickid}` exact match — not substring — to correctly identify standalone parameters.

### Event Repository

Any result with a valid click ID shows an **↗ ER** button that links to:
```
https://er-api.gcp.srv-impact.net/events.html?id={clickid}
```

---

## Integration Types

| Type | Detection Condition |
|---|---|
| UTT | UTT tag + identify call detected; no Shopify signals |
| SHOPIFY | Shopify pageload or web pixel detected; no UTT |
| Potential Hybrid | Both UTT and Shopify signals present, OR UTT using `_shopify_y` as CustomProfileId |
| ClickId Integration | Click ID found in cookie; no UTT or Shopify |
| UNKNOWN | No integration signals detected |

---

## Result Statuses

| Status | Meaning |
|---|---|
| PASS | Integration detected and functioning correctly |
| FAIL | Critical issue — integration not working |
| WARN | Integration detected but with a non-critical issue |
| SKIP | URL could not be crawled (timeout, DNS failure, CAPTCHA) |

---

## Remediation Engine

Each result includes a `remediation_note` computed client-side by a priority-ordered rule engine. Rules fire in this order:

1. CAPTCHA detected → manual validation required
2. Timeout / DNS failure → manual test, verify domain
3. Traffic Guard present + click ID not in URL → test with `1111` or live link
4. Child/parent redirect detected → awareness note (no action required)
5. Click ID embedded inside another parameter only → configure standalone `{clickid}` parameter
6. UNKNOWN integration → verify manually
7. ClickId Integration → verify via Loggly or SQL
8. UTT tag missing → check `<head>` placement, ensure it loads first
9. UTT identify missing → must fire after UTT library loads
10. UTT click ID not in payload → check TMS variable/trigger config
11. `customerId` field used → should use `customProfileId` instead
12. Shopify via web pixel only, no pageload → check plugin installation
13. Shopify pageload found, click ID not in payload → check plugin settings
14. Hybrid: both Shopify PLA and UTT identify firing with no issues → consider consolidating
15. Identity API returned WARN → retry after delay; endpoint shown in drawer
16. Clean PASS → no note

---

## Corporate Network

The app is built for use on the impact.com corporate network:

- Safe Browsing is disabled in the Chromium launch args (avoids SSL interception blocks)
- `_bypassCorporateProxy()` auto-detects the impact.com security interstitial and clicks through
- `rejectUnauthorized: false` is set for all outbound Node.js HTTPS calls

---

## Update Notifications

On launch the app polls the GitHub Releases API. If a newer version is available, an amber pulsing pill appears in the top bar. Click it to go to the download page.

No silent auto-install — updates require a manual download and drag-to-Applications.

---

## Development

### Prerequisites

- Node.js 18+
- npm
- macOS (Electron + Playwright Chromium)

### Setup

```bash
git clone https://github.com/sBaronaImpact/tracking_validator.git
cd tracking_validator/tracking_validator_app
npm install
npx playwright install chromium
```

### Run

```bash
npm start
```

### Project Structure

```
tracking_validator_app/
├── .github/workflows/release.yml    ← Release pipeline (triggered by git tag)
├── assets/
│   ├── icon.icns                    ← macOS app icon
│   └── icon.svg                     ← Source icon (TSE crawler)
├── engine/
│   ├── checks/
│   │   ├── cookies.js               ← Cookie extraction
│   │   ├── general.js               ← Click ID, redirect chain, TMS detection
│   │   ├── hybrid.js                ← Hybrid integration detection
│   │   ├── shopify.js               ← Shopify pageload + web pixel checks
│   │   └── utt.js                   ← UTT tag + identify call checks
│   ├── context-manager.js           ← Chromium launch config
│   ├── crawler.js                   ← Core crawl engine (retry + timeout logic)
│   ├── identity.js                  ← Identity API enrichment (7 retries)
│   └── result.js                    ← Result schema definition
├── renderer/
│   ├── index.html                   ← App UI (Validate, How-To, About tabs)
│   ├── renderer.js                  ← UI logic, remediation engine, CSV export
│   └── style.css                    ← Dark/light theme, TSE design system
├── main.js                          ← Electron main process, IPC, update check
├── preload.js                       ← IPC bridge (contextBridge)
├── package.json                     ← App config + electron-builder settings
└── test.js                          ← Inline logic tests
```

### Key Architecture Notes

**Deduplication** — `_processWithRetry` and `_processWithTimeout` share a single `emit` closure. Only one result is emitted per URL regardless of retry count or timeout race conditions.

**IPC timing** — The renderer sends a `renderer:ready` signal after all IPC listeners are registered. Main waits for this before sending any messages. Do not use `setTimeout` for IPC timing.

**Remediation engine** — Lives entirely in `renderer.js → computeRemediation()`. It is client-side only and operates on the completed result object. Rule order is intentional — do not reorder without reviewing downstream interactions.

---

## Releasing

### Shipping a New Version

```bash
git tag v1.0.X
git push origin v1.0.X
```

GitHub Actions builds arm64 + x64 DMGs on `macos-latest` and publishes them to GitHub Releases as a **Draft**. After the build completes (~5–8 min), go to the Releases page and publish the draft manually.

### Rules

- **Never manually edit the version in `package.json`** — the workflow reads the tag and syncs it automatically
- **Never set a DMG background image** — `"background": null` is required; the ARM64 runner cannot mount `.tiff` files
- New releases will be auto-detected by installed apps on next launch

### Deployment Checklist

Before tagging:
- [ ] All changed JS files pass `node -c`
- [ ] Logic changes covered by an inline test in `test.js`
- [ ] `package.json` version left as-is (workflow handles it)
- [ ] `"background": null` present in `dmg` config in `package.json`

After the build:
- [ ] Draft published on GitHub Releases
- [ ] DMG tested locally (`sudo xattr -cr` → open → verify)
- [ ] Update pill appears in previously installed version

---

## Hosting

| Resource | URL |
|---|---|
| TSE Tools Hub | https://fastshoes.co.za/scott/tools/ |
| Download Page | https://fastshoes.co.za/scott/tools/tracking_validator/ |

The download page uses a PHP proxy (`download.php`) to serve the private GitHub Release assets. Auth is HMAC-SHA256 signed cookie — no PHP sessions (Afrihost GC destroys them unpredictably).

---

## Roadmap

- [ ] FTP auto-deploy via GitHub Actions (`tse-tools` mono-repo)
- [ ] Code signing (eliminates `sudo xattr` requirement)
- [ ] Transfer repo to impact.com GitHub org
- [ ] TrackMethod Sync — same Electron packaging treatment

---

*Internal tool — TSE, impact.com. Not for external distribution.*
