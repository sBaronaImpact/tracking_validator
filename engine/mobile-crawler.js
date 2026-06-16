'use strict';

const { chromium } = require('playwright');

// ── Device profiles ────────────────────────────────────────────────────────────
const DEVICES = {
  ios: {
    label:     'iOS Safari',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport:  { width: 390, height: 844 },
  },
  android: {
    label:     'Android Chrome',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport:  { width: 412, height: 915 },
  },
};

// ── MMP detection ──────────────────────────────────────────────────────────────
const MMP_PATTERNS = [
  { name: 'Button',    domains: ['r.bttn.io', 'bttn.io'] },
  { name: 'AppsFlyer', domains: ['onelink.me', 'go.onelink.me', 'app.appsflyer.com'] },
  { name: 'Branch',    domains: ['app.link', 'bnc.lt', 'page.link'] },
  { name: 'Adjust',    domains: ['app.adjust.com', 'adj.st', 'adjust.com'] },
  { name: 'Kochava',   domains: ['ko.link', 'kochava.com'] },
  { name: 'Singular',  domains: ['app.singular.net', 'singular.net'] },
  { name: 'Tune',      domains: ['tlnk.io', 'tune.com', 'hasoffers.com'] },
  { name: 'Skadnetwork', domains: ['skadnetwork.apple.com'] },
];

function detectMmp(urlString) {
  if (!urlString) return null;
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    for (const { name, domains } of MMP_PATTERNS) {
      if (domains.some(d => host === d || host.endsWith('.' + d))) return name;
    }
  } catch {}
  return null;
}

// ── Terminal type detection ────────────────────────────────────────────────────
function detectTerminalType(urlString) {
  if (!urlString) return 'unknown';
  const u = urlString.toLowerCase();
  if (u.startsWith('itms-apps://') || u.startsWith('itms-appss://') ||
      u.includes('apps.apple.com') || u.includes('itunes.apple.com')) return 'app-store-ios';
  if (u.startsWith('market://') || u.includes('play.google.com/store')) return 'app-store-android';
  if (!u.startsWith('http://') && !u.startsWith('https://') && u.includes('://')) return 'custom-scheme';
  // Button interstitial — btn_interstitial_id or interstitial in btn_variation_type
  try {
    const params = new URL(urlString).searchParams;
    if (params.has('btn_interstitial_id') ||
        (params.get('btn_variation_type') || '').toLowerCase().includes('interstitial')) {
      return 'mmp-interstitial';
    }
  } catch {}
  return 'mobile-web';
}

// ── Hop type detection ─────────────────────────────────────────────────────────
const IMPACT_DOMAINS = ['sjv.io', 'pxf.io', 'ojrq.net', 'impact.com', 'impactradius.com'];
// Impact tracking link path pattern: /c/{publisherId}/{adId}/{campaignId}
const IMPACT_TRACKING_PATH = /^\/c\/\d+\/\d+\/\d+/;

function detectHopType(urlString) {
  if (!urlString) return 'normal';
  const u = urlString.toLowerCase();
  if (u.startsWith('itms-apps://') || u.startsWith('itms-appss://') || u.includes('apps.apple.com') || u.startsWith('market://') || u.includes('play.google.com')) return 'app-store';
  if (!u.startsWith('http://') && !u.startsWith('https://') && u.includes('://')) return 'custom-scheme';
  try {
    const parsed = new URL(urlString);
    const host   = parsed.hostname.toLowerCase();
    if (IMPACT_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return 'impact';
    // Publisher tracking domains route through impact infrastructure — detect by path shape
    if (IMPACT_TRACKING_PATH.test(parsed.pathname)) return 'impact';
    if (detectMmp(urlString)) return 'mmp';
  } catch {}
  return 'normal';
}

// ── URL param parser ───────────────────────────────────────────────────────────
function parseUrlParams(urlString) {
  if (!urlString) return null;
  try {
    const url = new URL(urlString);
    const params = {};
    for (const [k, v] of url.searchParams.entries()) {
      params[k] = v;
    }
    if (Object.keys(params).length === 0) return null;
    return params;
  } catch { return null; }
}

// ── Chromium launch args (same as main crawler) ────────────────────────────────
function getLaunchArgs() {
  return [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-features=SafeBrowsingEnhancedProtection,SafeBrowsing,IsolateOrigins,site-per-process',
    '--disable-client-side-phishing-detection', '--safebrowsing-disable-auto-update',
    '--disable-popup-blocking', '--disable-blink-features=AutomationControlled',
  ];
}

// ── Single URL crawl for one device ───────────────────────────────────────────
async function crawlUrlForDevice(browser, url, deviceKey, iosClickIdParam, androidClickIdParam, desktopClickIdParam) {
  const device = DEVICES[deviceKey];

  // Validate param name — must look like a real URL parameter (alphanumeric/underscore/hyphen)
  // The SQL returns unicode garbage (ʘ) when no mobile URL is configured — ignore those
  const isValidParam = p => p && /^[a-zA-Z0-9_~\-]{1,64}$/.test(p);

  const deviceParam   = deviceKey === 'ios' ? iosClickIdParam : androidClickIdParam;
  // Build ordered list: device-specific param first, then desktop param, then common fallbacks
  const paramCandidates = [
    isValidParam(deviceParam)          ? deviceParam          : null,
    isValidParam(desktopClickIdParam)  ? desktopClickIdParam  : null,
    'clickid', 'ClickId', 'irclickid',
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // deduplicate
  const chain          = [];
  let   mmpHandoffUrl    = null;
  let   mmpDetected      = null;
  let   clickId          = null;
  let   chainTerminated  = false;

  const context = await browser.newContext({
    userAgent:         device.userAgent,
    viewport:          device.viewport,
    ignoreHTTPSErrors: true,
  });

  try {
    const page = await context.newPage();

    // Only capture document/redirect responses — ignore sub-resources (images, fonts, JS)
    page.on('response', res => {
      if (chainTerminated) return;
      const resUrl = res.url();
      const status = res.status();

      // Skip sub-resource noise — only care about navigation responses.
      // 'other' at non-200 status catches redirect hops Playwright classifies ambiguously;
      // 'other' at 200 is always a post-load sub-resource (favicon, pixel, iframe) — skip it.
      const type = res.request().resourceType();
      if (type !== 'document' && !(type === 'other' && status !== 200)) return;

      const hopType  = detectHopType(resUrl);
      const params   = parseUrlParams(resUrl);
      const terminal = detectTerminalType(resUrl);
      const mmp      = detectMmp(resUrl);

      // Extract click ID — try device-specific param, desktop param, then common fallbacks
      if (!clickId) {
        try {
          const u = new URL(resUrl);
          for (const p of paramCandidates) {
            const v = u.searchParams.get(p);
            if (v) { clickId = v; break; }
          }
        } catch {}
      }

      // Track MMP/integration handoff.
      // Button wraps a downstream MMP — lock on Button so the downstream doesn't overwrite it.
      if (mmp && (!mmpDetected || mmpDetected !== 'Button')) {
        mmpDetected   = mmp;
        mmpHandoffUrl = resUrl;
      }

      chain.push({ status, url: resUrl, params, hop_type: hopType });

      // Stop collecting after reaching an app-store or custom-scheme terminal
      if (terminal === 'app-store-ios' || terminal === 'app-store-android' || terminal === 'custom-scheme') {
        chainTerminated = true;
        return;
      }

      // Stop collecting after the first 200 on a non-impact, non-MMP URL — this is the landing page.
      // MMP hops can also return 200 (e.g. Button interstitial at land.bttn.io) — keep collecting through those.
      // Everything after a normal 200 (pixels, iframes, Snapchat syncs, Tapad, etc.) is sub-resource noise.
      if (status === 200 && hopType !== 'impact' && hopType !== 'mmp') {
        chainTerminated = true;
      }
    });

    let navigationError = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Check for CAPTCHA on the landed page
      const isCaptcha = await page.evaluate(() => {
        const title = (document.title || '').toLowerCase();
        return ['just a moment', 'attention required', 'checking your browser',
                'security check', 'human verification', 'access denied'].some(t => title.includes(t));
      }).catch(() => false);
      if (isCaptcha) navigationError = 'CAPTCHA challenge detected — headless browser blocked';
    } catch (e) {
      navigationError = e.message;
    }

    // Truncate chain at first terminal hop
    const terminalIdx = chain.findIndex(h => {
      const t = detectTerminalType(h.url);
      return t === 'app-store-ios' || t === 'app-store-android' || t === 'custom-scheme';
    });
    const finalChain = terminalIdx >= 0 ? chain.slice(0, terminalIdx + 1) : chain;

    const lastHop       = finalChain.length > 0 ? finalChain[finalChain.length - 1] : null;
    const rawTerminal   = lastHop ? detectTerminalType(lastHop.url) : 'unknown';

    // If chain never left the impact domain (all hops are impact type), classify as no-redirect
    const allImpact = finalChain.length > 0 && finalChain.every(h => h.hop_type === 'impact');

    const terminalType  = allImpact
      ? 'no-redirect'
      : (rawTerminal === 'mobile-web' && lastHop && lastHop.hop_type === 'mmp')
        ? 'mmp-link'
        : rawTerminal;
    const finalUrl      = lastHop ? lastHop.url : null;

    return {
      device:          device.label,
      overall_status:  'PASS',
      terminal_type:   terminalType,
      final_url:       finalUrl,
      click_id:        clickId,
      mmp_detected:    mmpDetected,
      mmp_handoff_url: mmpHandoffUrl,
      redirect_chain:  finalChain,
      error:           navigationError,
    };

  } catch (e) {
    return {
      device:          device.label,
      overall_status:  'WARN',
      terminal_type:   'unknown',
      final_url:       null,
      click_id:        null,
      mmp_detected:    null,
      mmp_handoff_url: null,
      redirect_chain:  [],
      error:           e.message,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ── MobileCrawler class ────────────────────────────────────────────────────────
class MobileCrawler {
  constructor(config, onLog, onResult, onDone) {
    this.config    = { devices: config.devices || ['ios', 'android'] };
    this.log       = onLog    || (() => {});
    this.onResult  = onResult || (() => {});
    this.onDone    = onDone   || (() => {});
    this.cancelled = false;
    this._closePromise = null;
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.log('⚠ Mobile crawl cancellation requested…');
    this._closePromise = this._browser?.close().catch(() => {});
  }

  async run(urlObjects) {
    this.cancelled = false;
    if (this._closePromise) {
      await this._closePromise.catch(() => {});
      this._closePromise = null;
    }

    const executablePath = (() => {
      try {
        const { chromium: pw } = require('playwright');
        return pw.executablePath();
      } catch { return undefined; }
    })();

    try {
      this._browser = await chromium.launch({
        headless:       true,
        executablePath,
        args:           getLaunchArgs(),
      });
    } catch (e) {
      this.log(`✖ Fatal error launching browser: ${e.message}`);
      this.onDone();
      return;
    }

    this.log(`▶ Starting mobile crawl — ${urlObjects.length} URL(s), devices: ${this.config.devices.join(' + ')}`);

    try {
      for (const urlObj of urlObjects) {
        if (this.cancelled) break;

        const url = urlObj.url;
        this.log(`→ ${url}`);

        // Run iOS and Android in parallel
        const deviceCrawls = this.config.devices.map(deviceKey =>
          crawlUrlForDevice(
            this._browser,
            url,
            deviceKey,
            urlObj.iosClickIdParam     || urlObj.ios_clickid_param     || null,
            urlObj.androidClickIdParam || urlObj.android_clickid_param || null,
            urlObj.clickIdParam        || urlObj.click_id_param        || null,
          )
        );

        const results = await Promise.all(deviceCrawls);

        if (this.cancelled) break;

        const mobileResult = {
          url,
          campaign_id:    urlObj.campaignId    || urlObj.campaign_id   || null,
          campaign_name:  urlObj.campaignName  || urlObj.campaign_name  || null,
          click_id_param: urlObj.clickIdParam  || urlObj.click_id_param || null,
        };

        for (const r of results) {
          const key = r.device.toLowerCase().includes('ios') ? 'ios' : 'android';
          mobileResult[key] = r;
          this.log(`  ✔ ${r.device} — ${r.terminal_type} — ${r.terminal_url || 'no final URL'}`);
        }

        this.onResult(mobileResult);
      }
    } catch (e) {
      this.log(`✖ Fatal error in mobile crawl: ${e.message}`);
    } finally {
      this._closePromise = this._browser?.close().catch(() => {});
      await this._closePromise;
      this._closePromise = null;
      this._browser = null;
      this.log(this.cancelled ? '✖ Mobile crawl cancelled.' : '✔ Mobile crawl complete.');
      this.onDone();
    }
  }
}

module.exports = { MobileCrawler, DEVICES, detectMmp, detectTerminalType };