'use strict';

const STATUS = {
  PASS:    true,      // check passed
  FAIL:    false,     // check failed
  WARN:    'WARN',    // nuanced — needs attention
  SKIP:    'SKIP',    // overall status — captcha/nav error
  INFO:    'INFO',    // informational
  NA:      'N/A',     // not applicable
  PENDING: 'PENDING', // enrichment not yet resolved
};

const INTEGRATION_TYPE = {
  UTT:      'UTT',
  SHOPIFY:  'SHOPIFY',
  HYBRID:   'Potential Hybrid Integration',
  CLICKID:  'ClickId Integration',
  UNKNOWN:  'UNKNOWN',
};

function createResult(input_url, campaign_id, click_id_param) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,

    // ── Input ─────────────────────────────────────────────────────────
    input_url,
    campaign_id,
    click_id_param,

    // ── General ───────────────────────────────────────────────────────
    final_url:               null,
    final_status_code:       null,
    captcha_detected:        false,
    navigation_error:        false,
    navigation_error_message:null,
    consent_detected:        false,
    consent_accepted:        false,
    click_id_in_url:         STATUS.NA,
    click_id:                null,
    brwsr_cookie:            null,
    click_id_cookie_names:   null,
    profile_redirect:        false,  // true when ojrq.net appears in redirect chain
    traffic_guard:           false,  // true when trafficguard.ai appears in redirect chain
    detected_tms:            [],
    crawl_note:              null,
    attempts:                1,     // TMS globals found on page
    integration_type:        INTEGRATION_TYPE.UNKNOWN,
    overall_status:          STATUS.PENDING,

    // ── UTT ───────────────────────────────────────────────────────────
    utt: {
      tag_detected:          STATUS.NA,
      identify_call:         STATUS.NA,
      identify_path:         null,
      identify_status:       null,
      cli_present:           STATUS.NA,
      cli_value:             null,
      cli_cookie_name:       null,   // cookie name(s) whose value matches cli_value
      cus_id_present:        STATUS.NA,
      cus_id_value:          null,
      cus_id_cookie_name:    null,
      click_id_in_payload:   STATUS.NA,
      click_id_cookies:      null,   // cookie name(s) storing the click ID
      ir_field:              null,
      implementation_method: null,   // GTM | Tealium | Segment | AdobeLaunch | direct
      time_to_tag_ms:        null,
      time_to_identify_ms:   null,
    },

    // ── Shopify ───────────────────────────────────────────────────────
    shopify: {
      pageload_found:            STATUS.NA,
      pageload_status:           null,
      time_to_pageload_ms:       null,
      integration_source:        null,
      click_id_in_payload:       STATUS.NA,
      click_id_cookies:          null,
      cli_present:               STATUS.NA,
      cli_value:                 null,
      cli_cookie_name:           null,
      cus_id_present:            STATUS.NA,
      cus_id_value:              null,
      cus_id_cookie_name:        null,
      first_party_cookie_field:  null,
      web_pixel_console:         STATUS.NA,
      web_pixel_console_status:  null,
      shopify_consent:           null,
    },

    // ── Redirect chain (formatted string, built after navigation) ─────
    // One hop per line: {status} [{ip}] {url}
    // Example:
    //   301 [104.21.3.45] https://brand.sjv.io/c/2222/...
    //   302 [172.67.12.8] https://brand.com/?irclickid=...
    //   200 [104.26.9.11] https://www.brand.com/landing
    redirect_chain: null,

    // ── Cookies (formatted string, built at end of processing) ────────
    // One NAME=value per line. Example:
    //   IR_PI=efddf093-593e-11f1-bfdf...
    //   IR_5422=1779826230394|0|...
    //   IR_gbd=mizuno.com
    cookies: null,

    // ── Internal raw cookie refs (used during processing, not output) ─
    _raw: {
      ir_pi:         null,
      ir_campaign:   null,
      ir_gbd:        null,
      click_id_list: [],   // full cookie objects matching click ID
    },

    // ── Identity ──────────────────────────────────────────────────────
    identity: {
      status:       STATUS.PENDING,
      lookup_value: null,
      lookup_type:  null,
      endpoint:     null,
      attempts:     0,
      consumer_id:  null,
      ids:          null,   // newline-separated string of id nodes
      cli_node:     false,
      fpc_node:     false,
      pro_node:     false,
      note:         null,
    },
  };
}

/**
 * Build the formatted cookies string from raw cookie objects.
 * Includes: impact cookies, click ID cookies, and any cookies
 * referenced by cli_cookie_name or cus_id_cookie_name in check results.
 *
 * @param {Object} raw          - result._raw (ir_pi, ir_campaign, etc.)
 * @param {Array}  allCookies   - full Playwright cookie jar for the page
 * @param {Array}  extraNames   - additional cookie names to include (from check results)
 */
function buildCookiesString(raw, allCookies, extraNames) {
  const { safeDecode } = require('./checks/cookies');
  const lines    = [];
  const included = new Set();

  function addObj(cookie) {
    if (!cookie || included.has(cookie.name)) return;
    included.add(cookie.name);
    lines.push(`${cookie.name}=${safeDecode(cookie.value)}`);
  }

  function addByName(name) {
    if (!name || included.has(name)) return;
    const found = (allCookies || []).find(c => c.name === name);
    if (found) addObj(found);
  }

  // Impact cookies first
  addObj(raw.ir_pi);
  addObj(raw.ir_campaign);
  addObj(raw.ir_gbd);

  // Click ID cookies (value-first matches)
  (raw.click_id_list || []).forEach(addObj);

  // Referenced cookies from check results (cli, cus_id matches)
  (extraNames || []).forEach(addByName);

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Compute overall status, scoped to integration type.
 * Avoids penalising UTT results for missing Shopify signals and vice versa.
 */
function computeOverallStatus(result) {
  if (result.navigation_error || result.captcha_detected) return 'SKIP';
  if (!result.final_status_code ||
      result.final_status_code < 200 ||
      result.final_status_code >= 400) {
    return 'FAIL';
  }

  const type = result.integration_type;
  const collected = [result.click_id_in_url];

  if (type === INTEGRATION_TYPE.UTT || type === INTEGRATION_TYPE.HYBRID) {
    const u = result.utt;
    collected.push(u.tag_detected, u.identify_call, u.click_id_in_payload);
    if (u.cus_id_present === STATUS.WARN) collected.push(STATUS.WARN);
    collected.push(result._raw.ir_pi ? true : false);
  }

  if (type === INTEGRATION_TYPE.SHOPIFY || type === INTEGRATION_TYPE.HYBRID) {
    const s = result.shopify;
    collected.push(s.pageload_found, s.click_id_in_payload);
    if (s.cus_id_present === STATUS.WARN) collected.push(STATUS.WARN);
  }

  const meaningful = collected.filter(s =>
    s !== STATUS.NA && s !== STATUS.INFO && s !== STATUS.PENDING
  );

  if (meaningful.includes(false))   return 'FAIL';
  if (meaningful.includes('WARN'))  return 'WARN';
  if (meaningful.length > 0 && meaningful.every(s => s === true)) return 'PASS';
  return 'INFO';
}

/**
 * Convert any null/undefined value to 'N/A' for output.
 * Applied recursively when serialising for CSV/display.
 */
function naify(val) {
  if (val === null || val === undefined || val === '') return 'N/A';
  return val;
}

module.exports = {
  STATUS,
  INTEGRATION_TYPE,
  createResult,
  buildCookiesString,
  computeOverallStatus,
  naify,
};