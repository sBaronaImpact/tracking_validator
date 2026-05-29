'use strict';

const { STATUS } = require('../result');
const { findCookiesByValue } = require('./cookies');

function isPageloadUrl(urlString) {
  try { return new URL(urlString).pathname.toLowerCase().includes('pageload'); }
  catch { return false; }
}

function parsePageloadPayload(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch {}
  try {
    const params = new URLSearchParams(body);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  } catch { return {}; }
}

function cookieNamesFromMatches(matches) {
  if (!matches || matches.length === 0) return null;
  return matches.map(c => c.name).join(', ');
}

async function runShopifyChecks(page, networkEvents, consoleMessages, cookies, click_id) {
  // Web-pixel console messages
  const webPixelMessages = consoleMessages.filter(m =>
    m.text.toLowerCase().includes('web-pixel') || m.text.toLowerCase().includes('webpixel')
  );

  // Return all N/A if no Shopify signals at all
  if (networkEvents.length === 0 && webPixelMessages.length === 0) {
    return {
      pageload_found:           STATUS.NA,
      pageload_status:          null,
      time_to_pageload_ms:      null,
      integration_source:       null,
      click_id_in_payload:      STATUS.NA,
      click_id_cookies:         null,
      cli_present:              STATUS.NA,
      cli_value:                null,
      cli_cookie_name:          null,
      cus_id_present:           STATUS.NA,
      cus_id_value:             null,
      cus_id_cookie_name:       null,
      first_party_cookie_field: null,
      web_pixel_console:        STATUS.NA,
      web_pixel_console_status: null,
      shopify_consent:          null,
    };
  }

  const result = {
    pageload_found:           STATUS.FAIL,
    pageload_status:          null,
    time_to_pageload_ms:      null,
    integration_source:       null,
    click_id_in_payload:      STATUS.FAIL,
    click_id_cookies:         null,
    cli_present:              STATUS.FAIL,
    cli_value:                null,
    cli_cookie_name:          null,
    cus_id_present:           STATUS.PASS,   // PASS = absent (expected)
    cus_id_value:             null,
    cus_id_cookie_name:       null,
    first_party_cookie_field: null,
    web_pixel_console:        STATUS.FAIL,
    web_pixel_console_status: null,
    shopify_consent:          null,
  };

  // ── PageLoad request ───────────────────────────────────────────────
  const ev = networkEvents.find(e => e.pageloadRequest);
  if (ev) {
    result.pageload_found     = STATUS.PASS;
    result.pageload_status    = ev.status;
    result.time_to_pageload_ms = ev.timeSinceStart != null ? ev.timeSinceStart : null;

    const payload = parsePageloadPayload(ev.requestBody || '');
    result.integration_source = payload.IntegrationSource || payload.integrationSource || null;

    // click_id
    const clickId = payload.ClickId || payload.clickid || null;
    if (clickId) {
      result.click_id_in_payload = STATUS.PASS;
      result.click_id_cookies    = cookieNamesFromMatches(findCookiesByValue(cookies, clickId));
    } else if (click_id) {
      result.click_id_cookies = cookieNamesFromMatches(findCookiesByValue(cookies, click_id));
    }

    // cli (CustomProfileId) — value-first cookie scan
    const cpid = payload.CustomProfileId || payload.customprofileid || null;
    if (cpid !== undefined && cpid !== null) {
      if (cpid) {
        const matches          = findCookiesByValue(cookies, cpid);
        result.cli_present     = matches.length > 0 ? STATUS.PASS : STATUS.INFO;
        result.cli_value       = cpid;
        result.cli_cookie_name = cookieNamesFromMatches(matches);
      } else {
        result.cli_present = STATUS.WARN;
      }
    } else {
      result.cli_present = STATUS.NA; // field not present in payload
    }

    // cus_id — WARN if present
    const cid = payload.CustomerId || payload.customerid || null;
    if (cid) {
      const matches             = findCookiesByValue(cookies, cid);
      result.cus_id_present     = STATUS.WARN;
      result.cus_id_value       = cid;
      result.cus_id_cookie_name = cookieNamesFromMatches(matches);
    }

    result.first_party_cookie_field = payload.FirstPartyCookie !== undefined
      ? (payload.FirstPartyCookie || null)
      : null;
  }

  // ── Web pixel console ──────────────────────────────────────────────
  if (webPixelMessages.length > 0) {
    result.web_pixel_console        = STATUS.PASS;
    const okMsg                     = webPixelMessages.find(m => m.text.includes('200'));
    result.web_pixel_console_status = okMsg ? 200 : null;
  }

  // ── Shopify consent API ────────────────────────────────────────────
  try {
    result.shopify_consent = await page.evaluate(() => {
      if (window.Shopify?.customerPrivacy?.userCanBeTracked) {
        return window.Shopify.customerPrivacy.userCanBeTracked();
      }
      return null;
    });
  } catch { result.shopify_consent = null; }

  return result;
}

module.exports = { runShopifyChecks, isPageloadUrl };
