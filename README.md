# Tracking Validator

Internal TSE tool for impact.com. Automates the evaluation of tracking integrations at scale — crawls tracking links with a real headless Chromium browser, follows the full redirect chain, and validates UTT, Shopify Plugin, Page Load API, and mobile MMP implementations.

Built to replace manual link-by-link inspection. A batch of hundreds of programs that would take hours to check by hand runs in minutes, surfaces integration issues, and generates actionable remediation guidance — all without leaving the app.

**Not for client distribution.** Internal TSE use only.

## Download

[Download the latest release →](https://fastshoes.co.za/scott/tools/tracking_validator/)

macOS only (arm64 + x64 DMG). See the download page for installation instructions, How-To, and full changelog.

## What it does

**Desktop crawl** — validates UTT, Shopify Plugin, and Page Load API integrations. Captures the full redirect chain with server IPs, cookies, verbatim network payloads, and runs identity graph enrichment against impact.com's identity service.

**Mobile crawl** — simulates iOS Safari and Android Chrome user agents to trace mobile-specific routing: MMP handoffs (AppsFlyer, Branch, Adjust, Kochava, Singular, Tune, Button), app-store redirects, mobile web landings, and no-redirect cases.

A rule-based remediation engine evaluates every result and generates a specific, actionable recommendation — UTT placement, Shopify configuration, click ID propagation, Traffic Guard interference, identity graph issues, and mobile redirect configuration.

## Stack

- Electron (v30) + Playwright (Chromium) + Node.js
- Packaged as a native macOS app via electron-builder
- No data leaves your machine — all crawling happens locally using the bundled Chromium browser
- Identity enrichment queries impact.com's identity service directly

## Repos

This is the source repo. Releases are mirrored to [`sBaronaImpact/tracking_validator`](https://github.com/sBaronaImpact/tracking_validator) (public) via GitHub Actions — required due to org-level PAT restrictions on private repo releases.

## Release process

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
git push personal vX.Y.Z
```

GitHub Actions builds arm64 + x64 DMGs and publishes a draft release automatically. Version is synced from the tag — never edit `package.json` version manually.

## Internal docs

In-app How-To and About tabs cover usage in detail. This README is intentionally brief — see the app itself for the full reference.