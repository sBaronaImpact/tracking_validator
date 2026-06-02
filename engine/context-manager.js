'use strict';

const path = require('path');

// When running as a packaged Electron app, point Playwright at the Chromium
// binary bundled into Resources/chromium — not the user's local playwright
// cache which won't exist on a fresh install.
// Must be set BEFORE playwright is required, as Playwright reads this env var
// at module load time when initialising its browser registry.
try {
  const { app } = require('electron');
  if (app?.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'chromium');
  }
} catch { /* not in Electron context (e.g. running tests directly) — use system playwright */ }

// Use playwright-extra for stealth plugin support.
// Falls back to standard playwright if playwright-extra is not installed.
let chromium;
try {
  const { chromium: chromiumExtra } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromiumExtra.use(StealthPlugin());
  chromium = chromiumExtra;
} catch {
  // playwright-extra not installed — use standard playwright
  // Run `npm install` to get stealth support
  ({ chromium } = require('playwright'));
  console.warn('[context-manager] playwright-extra not found — running without stealth patches.');
  console.warn('[context-manager] Run `npm install` to enable stealth mode.');
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

class BrowserManager {
  constructor() {
    this.browser = null;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Bypass Chrome Safe Browsing interstitial that some impact.com redirect
        // domains trigger (the "suspicious website" prompt). Without these, the
        // browser hangs on the interstitial waiting for user input.
        '--disable-features=SafeBrowsingEnhancedProtection,SafeBrowsing,IsolateOrigins,site-per-process',
        '--disable-client-side-phishing-detection',
        '--safebrowsing-disable-auto-update',
        '--disable-popup-blocking',
      ],
    });
  }

  /**
   * Create a fresh, isolated browser context (incognito equivalent).
   * Each context gets additional init scripts to patch common automation
   * detection signals that stealth plugin may not cover.
   */
  async newContext() {
    if (!this.browser || !this.browser.isConnected()) await this.launch();

    const context = await this.browser.newContext({
      userAgent:          USER_AGENT,
      ignoreHTTPSErrors:  true,
      storageState:       { cookies: [], origins: [] },
      // Randomise viewport slightly to avoid identical fingerprint per run
      viewport: {
        width:  1280 + Math.floor(Math.random() * 120),
        height: 800  + Math.floor(Math.random() * 80),
      },
      locale:   'en-US',
      timezone: 'America/New_York',
    });

    // Belt-and-suspenders: additional automation detection patches
    // These run before any page script, hiding automation signals
    await context.addInitScript(() => {
      // Hide webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

      // Spoof plugins array (headless has none by default)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5], // non-empty
      });

      // Spoof languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Chrome object expected by many bot detectors
      if (!window.chrome) {
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
      }

      // Prevent detection via notification permissions query
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    });

    return context;
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }

  get isLaunched() {
    return this.browser !== null && this.browser.isConnected();
  }
}

module.exports = { BrowserManager };