'use strict';

const { BrowserManager }      = require('./context-manager');
const { createResult, computeOverallStatus, buildCookiesString, STATUS } = require('./result');
const { checkCaptcha, tryAcceptConsent, findClickIdInUrls, detectAllTms, scanInlineScriptForTms, resolveImplementationMethod } = require('./checks/general');
const { runUttChecks, isWebTagUrl, isIdentifyUrl, WEB_TAG_HOSTS } = require('./checks/utt');
const { runShopifyChecks, isPageloadUrl }  = require('./checks/shopify');
const { detectIntegrationType }            = require('./checks/hybrid');
const { findCookieByName, findCookiesByValue } = require('./checks/cookies');
const { IdentityQueue }                    = require('./identity');

class Crawler {
  constructor(config, onLog, onResult, onIdentityUpdate, onDone, onIdentityDone) {
    this.config = {
      concurrency:   config.concurrency   ?? 4,
      waitTime:      config.waitTime      ?? 20_000,
      retryCount:    config.retryCount    ?? 1,
      interUrlDelay: config.interUrlDelay ?? 2_000,  // ms between batches (+ up to 1s random)
    };
    this.onLog          = onLog;
    this.onResult       = onResult;
    this.onDone         = onDone;
    this.cancelled      = false;
    this.browserManager = new BrowserManager();
    this.identityQueue  = new IdentityQueue(
      (id, update) => onIdentityUpdate(id, update),
      onIdentityDone || null,
    );
  }

  async run(urlObjects) {
    this.cancelled = false;
    try {
      await this.browserManager.launch();
      this.log(`▶ Starting crawl — ${urlObjects.length} URL(s), concurrency: ${this.config.concurrency}`);

      const batches = [];
      for (let i = 0; i < urlObjects.length; i += this.config.concurrency) {
        batches.push(urlObjects.slice(i, i + this.config.concurrency));
      }

      for (let i = 0; i < batches.length; i++) {
        if (this.cancelled) { this.log('✖ Crawl cancelled.'); break; }
        // Process each URL with a hard timeout safety net. Even if a single
        // URL hangs on an unresolved Playwright await, we move on.
        await Promise.all(batches[i].map(obj => this._processWithTimeout(obj)));

        if (this.cancelled) break;

        // Delay between batches — randomised to avoid bot detection
        if (i < batches.length - 1 && this.config.interUrlDelay > 0) {
          const delay = this.config.interUrlDelay + Math.floor(Math.random() * 1_000);
          this.log(`  ↷ Waiting ${(delay / 1000).toFixed(1)}s before next batch…`);
          // Interruptible sleep — checks cancellation flag every 250ms
          for (let waited = 0; waited < delay; waited += 250) {
            if (this.cancelled) break;
            await new Promise(r => setTimeout(r, Math.min(250, delay - waited)));
          }
        }
      }
    } catch (e) {
      this.log(`✖ Fatal error in run loop: ${e.message}`);
    } finally {
      try { await this.browserManager.close(); } catch { /* ignore */ }
      this.log(this.cancelled ? '✖ Crawl cancelled.' : '✔ Crawl complete.');
      try { this.identityQueue.finalize(); } catch { /* ignore */ }
      try { this.onDone(); } catch { /* ignore */ }
    }
  }

  cancel() {
    if (this.cancelled) return;  // already cancelling, don't repeat the log
    this.cancelled = true;
    this.log('⚠ Cancellation requested — aborting in-flight requests…');
    // Force-close the browser to make all in-flight Playwright ops fail fast.
    // Each _processWithTimeout catches the resulting errors and resolves cleanly.
    this.browserManager.close().catch(() => { /* ignore */ });
  }

  // Hard cap on per-URL processing time. The shared `emit` closure ensures
  // ONE emission per URL — whichever fires first (hard timeout OR
  // _processWithRetry completion) wins; the other becomes a silent no-op.
  async _processWithTimeout(urlObj) {
    const HARD_TIMEOUT = 60_000;
    return new Promise(resolve => {
      let settled = false;

      const emit = (result) => {
        if (settled) return;       // already emitted — drop this one
        settled = true;
        try { this.onResult(result); }              catch { /* ignore */ }
        try { this.identityQueue.enqueue(result); } catch { /* ignore */ }
        resolve();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        this.log(`⏱ Hard timeout (${HARD_TIMEOUT / 1000}s): ${urlObj.url}`);
        const result = createResult(urlObj.url, urlObj.campaignId, urlObj.clickIdParam);
        result.navigation_error         = true;
        result.navigation_error_message = `Hard timeout after ${HARD_TIMEOUT / 1000}s — URL abandoned`;
        result.crawl_note               = `Hard timeout after ${HARD_TIMEOUT / 1000}s — URL abandoned. The page or one of its requests never resolved. Manual verification recommended.`;
        result.overall_status           = STATUS.SKIP;
        result.attempts                 = 1;
        emit(result);
      }, HARD_TIMEOUT);

      this._processWithRetry(urlObj, emit)
        .catch(() => { /* _processWithRetry handles its own errors */ })
        .finally(() => {
          clearTimeout(timer);
          if (!settled) { settled = true; resolve(); }
        });
    });
  }

  async _processWithRetry(urlObj, emit) {
    const maxAttempts = (this.config.retryCount || 0) + 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this._processUrl(urlObj);
        result.attempts = attempt;
        if (attempt > 1) {
          const note = `Succeeded on attempt ${attempt} of ${maxAttempts} after ${attempt - 1} failed attempt(s).`;
          result.crawl_note = result.crawl_note ? `${note} ${result.crawl_note}` : note;
        }
        emit(result);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          this.log(`  ↻ Retry ${attempt}/${this.config.retryCount}: ${urlObj.url} — ${error.message}`);
        }
      }
    }

    // All attempts failed — emit a single final failure result
    const msg     = lastError ? lastError.message : 'unknown error';
    const result  = createResult(urlObj.url, urlObj.campaignId, urlObj.clickIdParam);
    result.navigation_error         = true;
    result.navigation_error_message = msg;
    result.crawl_note               = buildCrawlNote(msg, maxAttempts);
    result.overall_status           = STATUS.SKIP;
    result.attempts                 = maxAttempts;
    this.log(`✖ Failed (${maxAttempts} attempts): ${urlObj.url} — ${msg}`);
    emit(result);
  }

  // Detect and bypass impact.com's corporate security proxy interstitial.
  // The proxy intercepts navigation to "Newly Registered Domain" / uncategorized
  // domains and serves a warning page with "Proceed to site" — which would
  // otherwise stall the crawl for 85 seconds while the auto-close timer runs.
  async _bypassCorporateProxy(page) {
    try {
      const bypassed = await page.evaluate(() => {
        const title = (document.title || '').toLowerCase();
        const body  = (document.body && document.body.textContent || '').toLowerCase();

        // Distinct fingerprint: title mentions "security alert"/"newly registered"
        // OR body contains the gateway's standard phrasing alongside impact branding.
        const isImpactProxy = (
          title.includes('security alert') ||
          title.includes('newly registered') ||
          body.includes('newly registered or uncategorized domain') ||
          (body.includes('proceed to site') && body.includes('impact.com'))
        );
        if (!isImpactProxy) return false;

        // Click "Proceed to site" — search buttons, links, inputs
        const els = Array.from(document.querySelectorAll(
          'button, a, input[type="button"], input[type="submit"]'
        ));
        const proceedBtn = els.find(el => {
          const text = (el.textContent || el.value || '').trim().toLowerCase();
          return text === 'proceed to site' || text === 'proceed' || text.startsWith('proceed');
        });
        if (proceedBtn) {
          proceedBtn.click();
          return true;
        }
        return false;
      });

      if (bypassed) {
        this.log('  ⓘ Corporate proxy interstitial bypassed — clicked "Proceed to site"');
        // Give the bypass navigation time to complete
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
        } catch { /* timeout is fine — page may have stayed put */ }
        await page.waitForTimeout(2_000);  // settle delay
      }
      return bypassed;
    } catch {
      return false;
    }
  }

  async _processUrl(urlObj) {
    const { url, campaignId, clickIdParam } = urlObj;
    const result = createResult(url, campaignId, clickIdParam);

    this.log(`→ ${url}`);

    const context = await this.browserManager.newContext();
    const page    = await context.newPage();

    const networkEvents    = [];
    const consoleMessages  = [];
    const requestBodies    = new Map();
    let   brwsrCookie      = null;
    const startTime        = Date.now();
    let   identifyInitiatorUrl = null;

    // ── CDP session ────────────────────────────────────────────────────
    // Captures: redirect chain (status + server IP per hop), identify initiator
    const cdpRedirectChain = []; // [{url, status, ip}]
    const responseIps      = new Map(); // url → ip (for final URL lookup)
    let   cdpClient        = null;

    try {
      cdpClient = await context.newCDPSession(page);
      await cdpClient.send('Network.enable');

      // requestWillBeSent fires for every network request on the page.
      // We only want the main navigation redirect chain — not ad pixels,
      // beacon syncs, or other sub-resource redirects that fire on the
      // landing page. The trick: HTTP redirect chains share the same
      // requestId across every hop. Pixels/beacons get different requestIds.
      //
      // Strategy:
      //   1. Capture the requestId of the first Document-type request to our URL.
      //   2. Only record redirectResponse events that share that requestId.
      let navigationRequestId = null;

      cdpClient.on('Network.requestWillBeSent', params => {
        // Step 1: identify the main navigation request
        if (!navigationRequestId && params.type === 'Document') {
          navigationRequestId = params.requestId;
        }

        // Step 2: only track redirects from the main navigation chain
        if (params.redirectResponse && params.requestId === navigationRequestId) {
          cdpRedirectChain.push({
            url:    params.redirectResponse.url,
            status: params.redirectResponse.status,
            ip:     params.redirectResponse.remoteIPAddress || null,
          });
        }

        // Capture which script URL triggered the identify call
        if (isIdentifyUrl(params.request.url) && !identifyInitiatorUrl) {
          const frames = params.initiator?.stack?.callFrames || [];
          if (frames.length > 0) identifyInitiatorUrl = frames[0].url;
        }
      });

      // responseReceived gives IP for every response including the final URL
      cdpClient.on('Network.responseReceived', params => {
        const ip = params.response?.remoteIPAddress;
        if (ip) responseIps.set(params.response.url, ip);
      });

    } catch { /* CDP unavailable — redirect chain and IP will be empty */ }

    // ── Request body capture ──────────────────────────────────────────
    page.on('request', request => {
      requestBodies.set(request.url(), { body: request.postData() || '' });
    });

    // ── Response handler ──────────────────────────────────────────────
    page.on('response', async response => {
      const resUrl = response.url();
      const status = response.status();

      // brwsr cookie from Set-Cookie during redirects
      try {
        const setCookie = response.headers()['set-cookie'] || '';
        for (const line of setCookie.split('\n')) {
          const t = line.trim();
          if (t.startsWith('brwsr=') && !brwsrCookie) {
            brwsrCookie = t.split(';')[0].split('=').slice(1).join('=');
          }
        }
      } catch { /* ignore */ }

      // Skip redirect responses — CDP handles those
      if (status >= 300 && status < 400) return;

      let hostname = '';
      try { hostname = new URL(resUrl).hostname; } catch { return; }

      const isWebTag     = WEB_TAG_HOSTS.includes(hostname);
      const isIdentify   = isIdentifyUrl(resUrl);
      const isPageload   = isPageloadUrl(resUrl);
      let   inputHost    = '';
      try { inputHost    = new URL(url).hostname; } catch {}
      const isInputDomain = hostname === inputHost;

      if (!isWebTag && !isIdentify && !isPageload && !isInputDomain) return;

      const meta = requestBodies.get(resUrl) || {};
      networkEvents.push({
        url:            resUrl,
        status,
        requestBody:    meta.body || '',
        timeSinceStart: Date.now() - startTime,
        webTagRequest:  isWebTag,
        identifyRequest:isIdentify,
        pageloadRequest:isPageload,
      });
    });

    // ── Console capture ───────────────────────────────────────────────
    page.on('console', msg => {
      consoleMessages.push({
        type:          msg.type(),
        text:          msg.text(),
        timeSinceStart:Date.now() - startTime,
      });
    });

    // ── TrafficGuard intercept ────────────────────────────────────────
    await page.route('**/click.trafficguard.ai/**', async route => {
      try {
        const u = new URL(route.request().url());
        u.searchParams.set('source_id', 'test');
        await route.continue({ url: u.toString() });
      } catch { await route.continue(); }
    });

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Corporate security proxy bypass — impact.com's network gateway
      // intercepts navigation to "newly registered" or uncategorized domains
      // and serves an interstitial with a "Proceed to site" button. Detect
      // this page by its distinctive content and auto-click Proceed.
      await this._bypassCorporateProxy(page);

      // CAPTCHA check
      if (await checkCaptcha(page)) {
        this.log(`  ⚠ CAPTCHA — skipping: ${url}`);
        result.captcha_detected = true;
        result.crawl_note       = 'CAPTCHA challenge detected on landing page. Headless browser was blocked. Manual verification required.';
        result.overall_status   = STATUS.SKIP;
        return result;
      }

      result.final_status_code = response?.status() ?? null;

      // Consent (5s delay for banners to load)
      await page.waitForTimeout(5_000);
      const consentClicked         = await tryAcceptConsent(page);
      result.consent_accepted      = consentClicked;
      result.consent_detected      = consentClicked;

      // Wait for tracking tags
      const remaining = Math.max(0, this.config.waitTime - 5_000);
      if (remaining > 0) await page.waitForTimeout(remaining);

      // Final URL
      result.final_url = page.url();

      // ── Build redirect chain ─────────────────────────────────────────
      // cdpRedirectChain has all intermediate hops (from CDP redirectResponse).
      // Add the final URL as the last entry using its IP from responseIps.
      const finalIp = responseIps.get(result.final_url) || null;
      const allHops = [
        ...cdpRedirectChain,
        { url: result.final_url, status: result.final_status_code, ip: finalIp },
      ];
      result.redirect_chain = allHops
        .map(h => `${h.status} [${h.ip || '—'}] ${h.url}`)
        .join('\n');

      // Profile Redirect — ojrq.net is impact's browser profile sync server.
      result.profile_redirect = allHops.some(h => h.url && h.url.includes('ojrq.net'));

      // Traffic Guard — third-party click fraud protection gateway.
      result.traffic_guard    = allHops.some(h => h.url && h.url.includes('trafficguard.ai'));

      // Child/parent program redirect — a second impact tracking URL with a
      // different campaign ID in the chain means the child program is routing
      // through a parent program via a third-party gateway.
      const trackingPattern = /\/c\/\d+\/\d+\/(\d+)/;
      const parentHop = allHops.slice(1).find(h => {
        if (!h.url) return false;
        const match = h.url.match(trackingPattern);
        if (!match) return false;
        return match[1] !== String(result.campaign_id);
      });
      if (parentHop) {
        result.child_parent_redirect = true;
        result.parent_campaign_id    = parentHop.url.match(trackingPattern)[1];
      }

      // ── Click ID — scan full redirect chain ──────────────────────────
      const allUrls      = allHops.map(h => h.url);
      allUrls.unshift(url); // include original input URL
      const clickIdFound = findClickIdInUrls(allUrls, clickIdParam);
      result.click_id_in_url = clickIdFound ? STATUS.PASS : STATUS.FAIL;
      result.click_id        = clickIdFound?.value ?? null;

      // ── Click ID embedded detection ───────────────────────────────────
      // Checks whether the click ID appears only as a substring of another
      // parameter's value (embedded) rather than as a standalone param value.
      // e.g. sourceid=imp_ABC123 (embedded) vs irclickid=ABC123 (standalone)
      if (result.click_id && result.final_url) {
        try {
          const finalUrlParsed = new URL(result.final_url);
          let hasStandalone = false;
          let hasEmbedded   = false;
          for (const [, val] of finalUrlParsed.searchParams) {
            let decoded;
            try { decoded = decodeURIComponent(val); } catch { decoded = val; }
            if (decoded === result.click_id)              hasStandalone = true;
            else if (decoded.includes(result.click_id))   hasEmbedded   = true;
          }
          if (hasEmbedded && !hasStandalone) result.click_id_embedded = true;
        } catch { /* ignore URL parse errors */ }
      }

      // ── TMS detection ────────────────────────────────────────────────
      result.detected_tms = await detectAllTms(page);

      // ── Inline script TMS scan (for GTM compiled tags etc.) ──────────
      const inlineMatch = await scanInlineScriptForTms(page);

      // Cookies
      const cookies = await context.cookies();
      result.brwsr_cookie = brwsrCookie;

      const irPi       = findCookieByName(cookies, 'IR_PI');
      const irCampaign = findCookieByName(cookies, `IR_${campaignId}`);
      const irGbd      = findCookieByName(cookies, 'IR_gbd');
      const clickIdList= result.click_id ? findCookiesByValue(cookies, result.click_id) : [];

      result._raw.ir_pi         = irPi;
      result._raw.ir_campaign   = irCampaign;
      result._raw.ir_gbd        = irGbd;
      result._raw.click_id_list = clickIdList;

      // UTT checks — pass all three args for implementation_method resolution
      result.utt = await runUttChecks(
        networkEvents.filter(e => e.webTagRequest || e.identifyRequest),
        cookies,
        campaignId,
        result.click_id,
        identifyInitiatorUrl,
        inlineMatch,
        result.detected_tms,
      );

      // Shopify checks
      result.shopify = await runShopifyChecks(
        page,
        networkEvents.filter(e => e.pageloadRequest),
        consoleMessages,
        cookies,
        result.click_id,
      );

      // Build cookies string AFTER checks so referenced cookies are included.
      const referencedNames = new Set();
      [
        result.utt.cli_cookie_name,
        result.utt.cus_id_cookie_name,
        result.shopify.cli_cookie_name,
        result.shopify.cus_id_cookie_name,
      ].filter(Boolean).forEach(names =>
        names.split(',').map(n => n.trim()).forEach(n => referencedNames.add(n))
      );
      result.cookies = buildCookiesString(result._raw, cookies, [...referencedNames]);

      // Expose click ID cookie names (top-level, survives IPC sanitize)
      result.click_id_cookie_names = clickIdList.length > 0
        ? clickIdList.map(c => c.name).join(', ')
        : null;

      // Integration type + overall status
      result.integration_type = detectIntegrationType(result.utt, result.shopify, result.click_id_cookie_names);
      result.overall_status   = computeOverallStatus(result);

      this.log(`  ✔ ${result.integration_type} · ${result.overall_status} · ${url}`);
      return result;

    } catch (error) {
      // Don't emit here — _processWithRetry is the sole emitter and decides
      // whether to retry. Just propagate the error.
      this.log(`  ✖ Error: ${url} — ${error.message}`);
      throw error;
    } finally {
      try { if (cdpClient) await cdpClient.detach(); } catch {}
      try { await context.close(); } catch {}
    }
  }

  log(message) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' });
    this.onLog(`[${ts}] ${message}`);
  }
}

// Build a human-readable crawl note from a Playwright/navigation error message.
function buildCrawlNote(errorMessage, attempts) {
  const msg     = String(errorMessage || '').toLowerCase();
  const prefix  = attempts > 1 ? `Failed after ${attempts} attempts — ` : '';

  if (msg.includes('timeout') || msg.includes('exceeded')) {
    return prefix + 'Navigation timeout — page did not reach DOMContentLoaded within 30s. The site may be slow or blocking headless browsers. Manual verification recommended.';
  }
  if (msg.includes('net::err_name_not_resolved') || msg.includes('err_name_not_resolved')) {
    return prefix + 'DNS resolution failed — the tracking domain could not be resolved. Check the tracking link.';
  }
  if (msg.includes('net::err_connection_refused')) {
    return prefix + 'Connection refused by the target server.';
  }
  if (msg.includes('net::err_aborted') || msg.includes('target page, context or browser has been closed')) {
    return prefix + 'Request aborted — likely due to crawl cancellation.';
  }
  if (msg.includes('net::err_cert')) {
    return prefix + 'SSL/TLS certificate error on the target server.';
  }
  if (msg.includes('net::err_too_many_redirects')) {
    return prefix + 'Too many redirects — the redirect chain did not terminate.';
  }
  return prefix + `Navigation error: ${errorMessage}`;
}

module.exports = { Crawler };