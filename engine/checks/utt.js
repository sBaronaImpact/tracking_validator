'use strict';

const { STATUS } = require('../result');
const { findCookiesByValue } = require('./cookies');

const WEB_TAG_HOSTS  = ['utt.impactcdn.com', 'd.impactradius-event.com'];
const IDENTIFY_PATHS = ['xur', 'ur', 'iur', 'cur'];

function isWebTagUrl(urlString) {
  try { return WEB_TAG_HOSTS.includes(new URL(urlString).hostname); }
  catch { return false; }
}

function isIdentifyUrl(urlString) {
  try {
    const path = new URL(urlString).pathname;
    return IDENTIFY_PATHS.some(p => path.includes(`/${p}/`) || path.endsWith(`/${p}`));
  } catch { return false; }
}

function extractIdentifyPath(urlString) {
  try {
    const path = new URL(urlString).pathname;
    return IDENTIFY_PATHS.find(p => path.includes(p)) || null;
  } catch { return null; }
}

function parseFormData(body) {
  const result = {};
  if (!body) return result;
  try {
    const params = new URLSearchParams(body);
    for (const [k, v] of params.entries()) result[k.toLowerCase()] = v;
  } catch { /* malformed */ }
  return result;
}

/**
 * Extract cookie names from a value-first cookie match array.
 * Returns comma-separated names, or null if no matches.
 */
function cookieNamesFromMatches(matches) {
  if (!matches || matches.length === 0) return null;
  return matches.map(c => c.name).join(', ');
}

/**
 * Run all UTT checks.
 *
 * @param {Array}    networkEvents  - web tag + identify events
 * @param {Array}    cookies        - all page cookies
 * @param {string}   campaign_id
 * @param {string}   click_id       - from URL chain
 * @param {string}   initiatorUrl   - from CDP, identifies which TMS fired identify
 * @param {string}   inlineMatch    - from scanInlineScriptForTms()
 * @param {string[]} detectedTms    - from detectAllTms()
 */
async function runUttChecks(networkEvents, cookies, campaign_id, click_id, initiatorUrl, inlineMatch, detectedTms) {
  const { resolveImplementationMethod } = require('./general');

  const result = {
    tag_detected:          STATUS.NA,
    identify_call:         STATUS.NA,
    identify_path:         null,
    identify_status:       null,
    cli_present:           STATUS.NA,
    cli_value:             null,
    cli_cookie_name:       null,
    cus_id_present:        STATUS.NA,
    cus_id_value:          null,
    cus_id_cookie_name:    null,
    click_id_in_payload:   STATUS.NA,
    click_id_cookies:      null,
    ir_field:              null,
    implementation_method: null,
    time_to_tag_ms:        null,
    time_to_identify_ms:   null,
  };

  if (networkEvents.length === 0) {
    result.tag_detected = STATUS.NA;
    return result;
  }

  // ── Tag detection ──────────────────────────────────────────────────
  const tagEvents = networkEvents.filter(e => e.webTagRequest);
  if (tagEvents.length > 0) {
    result.tag_detected         = STATUS.PASS;
    result.identify_call        = STATUS.FAIL; // upgrade once tag confirmed
    result.click_id_in_payload  = STATUS.FAIL;
    result.cus_id_present       = STATUS.PASS; // PASS = absent (correct)
    result.time_to_tag_ms       = Math.min(...tagEvents.map(e => e.timeSinceStart));
  }

  // ── Identify call ──────────────────────────────────────────────────
  const identifyEvents = networkEvents.filter(e => e.identifyRequest);
  if (identifyEvents.length === 0) return result;

  const ev = identifyEvents[0];
  result.identify_call         = STATUS.PASS;
  result.identify_status       = ev.status;
  result.time_to_identify_ms   = ev.timeSinceStart;
  result.identify_path         = extractIdentifyPath(ev.url);
  result.implementation_method = resolveImplementationMethod(initiatorUrl, inlineMatch, detectedTms);

  // ── Payload ────────────────────────────────────────────────────────
  const payload = parseFormData(ev.requestBody || '');

  // cli (customprofileid)
  const cpid = payload.customprofileid;
  if (cpid !== undefined) {
    if (cpid) {
      const matches          = findCookiesByValue(cookies, cpid);
      result.cli_present     = matches.length > 0 ? STATUS.PASS : STATUS.INFO;
      result.cli_value       = cpid;
      result.cli_cookie_name = cookieNamesFromMatches(matches);
    } else {
      result.cli_present = STATUS.WARN; // field present but empty
    }
  }

  // cus_id (customerid) — WARN if populated in anonymous session
  const cid = payload.customerid;
  if (cid) {
    const matches               = findCookiesByValue(cookies, cid);
    result.cus_id_present       = STATUS.WARN;
    result.cus_id_value         = cid;
    result.cus_id_cookie_name   = cookieNamesFromMatches(matches);
  }

  // click_id in payload
  const clickid = payload.clickid;
  if (clickid) {
    result.click_id_in_payload = STATUS.PASS;
    const matches              = findCookiesByValue(cookies, clickid);
    result.click_id_cookies    = cookieNamesFromMatches(matches);
  } else if (click_id) {
    const matches           = findCookiesByValue(cookies, click_id);
    result.click_id_cookies = cookieNamesFromMatches(matches);
  }

  result.ir_field = payload._ir || null;

  return result;
}

module.exports = { runUttChecks, isWebTagUrl, isIdentifyUrl, WEB_TAG_HOSTS, IDENTIFY_PATHS };
