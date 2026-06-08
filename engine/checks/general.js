'use strict';

// ── Consent button IDs ─────────────────────────────────────────────────────────
const CONSENT_BUTTON_IDS = [
  'onetrust-accept-btn-handler', 'cmCloseBanner', 'accept-all-cookies',
  'acceptAllButton', 'CybotCookiebotDialogBodyButtonAccept',
  'didomi-notice-agree-button', 'consent-accept', 'cookie-consent-accept',
];

// ── TMS globals and script URL patterns ────────────────────────────────────────
const TMS_SIGNATURES = [
  { name: 'GTM',         global: 'google_tag_manager', script: 'googletagmanager.com/gtm' },
  { name: 'Tealium',     global: 'utag',               script: 'tiqcdn.com/utag/' },
  { name: 'Segment',     global: 'analytics',          script: 'cdn.segment.com/analytics' },
  { name: 'AdobeLaunch', global: '_satellite',         script: 'assets.adobedtm.com' },
  { name: 'Ensighten',   global: 'Bootstrapper',       script: 'nexus.ensighten.com' },
  { name: 'MParticle',   global: 'mParticle',          script: 'jssdkcdns.mparticle.com' },
];

const TMS_SCRIPT_PATTERNS = [
  { name: 'GTM',         patterns: ['googletagmanager.com'] },
  { name: 'Tealium',     patterns: ['tiqcdn.com'] },
  { name: 'Segment',     patterns: ['cdn.segment.com', 'segment.io'] },
  { name: 'AdobeLaunch', patterns: ['assets.adobedtm.com', 'launch-', '.adobedtm.com'] },
  { name: 'Ensighten',   patterns: ['nexus.ensighten.com'] },
  { name: 'MParticle',   patterns: ['jssdkcdns.mparticle.com'] },
];

// ── CAPTCHA detection ──────────────────────────────────────────────────────────

/**
 * Detect whether the page is presenting an active CAPTCHA challenge.
 *
 * Checks for *rendered, active* challenge widgets — NOT for the mere
 * presence of CAPTCHA library scripts in the page source.
 *
 * Many sites load reCAPTCHA/Turnstile/PerimeterX libraries as a precaution
 * without ever presenting a challenge. Scanning raw HTML for 'captcha'
 * strings produces false positives on those sites.
 *
 * Detection strategy:
 *   1. Page title — challenge pages always have distinctive titles
 *   2. Cloudflare-specific body/html class signatures
 *   3. Rendered widget iframes — only injected when a challenge fires
 *      (an empty .g-recaptcha div = library loaded, no challenge;
 *       .g-recaptcha with inner iframe = active challenge)
 */
async function checkCaptcha(page) {
  try {
    return await page.evaluate(() => {
      // 1. Challenge page titles
      const title = (document.title || '').toLowerCase();
      const challengeTitles = [
        'just a moment', 'attention required', 'checking your browser',
        'one more step', 'security check', 'human verification',
        'access denied', 'ddos protection', 'please wait',
      ];
      if (challengeTitles.some(t => title.includes(t))) return true;

      // 2. Cloudflare challenge class on body/html
      const cls = (document.body?.className || '') +
                  (document.documentElement?.className || '');
      if (/cf-challenge|challenge-running/.test(cls)) return true;

      // 3. Rendered (active) challenge widget selectors
      const activeSelectors = [
        '#cf-challenge-running',
        '#challenge-running',
        '.cf-challenge-running',
        '#turnstile-wrapper > iframe',       // Cloudflare Turnstile rendered
        '.cf-turnstile > iframe',
        '#px-captcha',                       // PerimeterX active challenge
        '.px-captcha-container',
        '.h-captcha > iframe',               // hCaptcha active (has iframe)
        '.g-recaptcha > div > div > iframe', // reCAPTCHA v2 active
        '#recaptcha-anchor',                 // reCAPTCHA checkbox rendered
      ];
      return activeSelectors.some(sel => !!document.querySelector(sel));
    });
  } catch {
    return false;
  }
}

// ── Consent ────────────────────────────────────────────────────────────────────

async function tryAcceptConsent(page) {
  for (const id of CONSENT_BUTTON_IDS) {
    try {
      await page.waitForSelector(`#${id}`, { timeout: 800 });
      await page.click(`#${id}`);
      return true;
    } catch { /* continue */ }
  }
  try {
    const clicked = await page.evaluate(() => {
      const phrases = ['accept all', 'accept cookies', 'allow all', 'i agree', 'agree & close', 'got it', 'accept & continue', 'accept and continue'];
      const els = Array.from(document.querySelectorAll('button, [role="button"], a.btn, input[type="button"]'));
      for (const el of els) {
        const text = (el.textContent || el.value || '').trim().toLowerCase();
        if (phrases.some(p => text.includes(p))) { el.click(); return true; }
      }
      return false;
    });
    return clicked;
  } catch {
    return false;
  }
}

// ── Click ID extraction ────────────────────────────────────────────────────────

function extractClickIdFromUrl(urlString, click_id_param) {
  if (!urlString) return null;
  try {
    const url        = new URL(urlString);
    const candidates = ['irclickid', 'clickid', 'ClickId'];
    if (click_id_param && !candidates.includes(click_id_param)) candidates.unshift(click_id_param);
    for (const param of candidates) {
      const val = url.searchParams.get(param);
      if (val) return { param, value: val };
    }
  } catch { /* invalid URL */ }
  return null;
}

function findClickIdInUrls(urls, click_id_param) {
  for (const url of urls) {
    const found = extractClickIdFromUrl(url, click_id_param);
    if (found) return found;
  }
  return null;
}

// ── TMS detection ──────────────────────────────────────────────────────────────

/**
 * Scan window globals to identify which TMS libraries are loaded on the page.
 * Returns an array of TMS names e.g. ['GTM', 'Tealium'].
 * Reliable — each TMS sets a known global when loaded.
 */
async function detectAllTms(page) {
  try {
    return await page.evaluate((signatures) => {
      return signatures
        .filter(sig => typeof window[sig.global] !== 'undefined')
        .map(sig => sig.name);
    }, TMS_SIGNATURES);
  } catch {
    return [];
  }
}

/**
 * Scan inline <script> blocks for TMS artifacts near an identify call.
 *
 * GTM compiles custom HTML tags into inline scripts injected into the page.
 * When these scripts fire network requests, the CDP call stack shows the
 * page URL — not the TMS CDN — as the initiator. This scanner finds the
 * TMS fingerprint in the compiled script source instead.
 */
async function scanInlineScriptForTms(page) {
  try {
    return await page.evaluate(() => {
      const TMS_ARTIFACTS = [
        { name: 'GTM',         patterns: ['google_tag_manager', 'googletagmanager'] },
        { name: 'Tealium',     patterns: ['utag.link', 'utag.view', 'utag_data'] },
        { name: 'Segment',     patterns: ['analytics.identify', 'analytics.track'] },
        { name: 'AdobeLaunch', patterns: ['_satellite.track', '_satellite.getVar'] },
        { name: 'Ensighten',   patterns: ['Bootstrapper.', 'ensighten'] },
      ];
      const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const script of inlineScripts) {
        const content = script.textContent || '';
        if (!content.includes('ire(') && !content.includes('"identify"')) continue;
        for (const { name, patterns } of TMS_ARTIFACTS) {
          if (patterns.some(p => content.includes(p))) return name;
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Resolve which TMS fired a specific network request.
 *
 * Priority:
 *   1. CDP initiator URL matches known TMS CDN (precise)
 *   2. Inline script source contains identify + TMS artifact (inferred)
 *   3. Single TMS in detectedTms, nothing else matched (inferred)
 *   4. 'direct'
 */
function resolveImplementationMethod(initiatorUrl, inlineMatch, detectedTms) {
  if (initiatorUrl) {
    for (const { name, patterns } of TMS_SCRIPT_PATTERNS) {
      if (patterns.some(p => initiatorUrl.includes(p))) return name;
    }
  }
  if (inlineMatch) return `${inlineMatch} (inferred)`;
  if (Array.isArray(detectedTms) && detectedTms.length === 1) {
    return `${detectedTms[0]} (inferred)`;
  }
  return 'direct';
}

module.exports = {
  checkCaptcha,
  tryAcceptConsent,
  extractClickIdFromUrl,
  findClickIdInUrls,
  detectAllTms,
  scanInlineScriptForTms,
  resolveImplementationMethod,
};