#!/usr/bin/env node
'use strict';

/**
 * Tracking Validator — Engine Test Script
 *
 * Usage:
 *   node test.js
 *   node test.js https://brand.sjv.io/c/2222/368370/5422 irclickid 5422
 */

const fs   = require('fs');
const path = require('path');

const TEST_URLS = [];

if (process.argv[2]) {
  TEST_URLS.push({
    url:          process.argv[2],
    clickIdParam: process.argv[3] || 'irclickid',
    campaignId:   process.argv[4] || '',
  });
}

if (TEST_URLS.length === 0) {
  console.error(`
  ✖ No URLs to test.

  Usage:
    node test.js <url> <click_id_param> <campaign_id>

  Example:
    node test.js https://mizunousa.sjv.io/c/2222/368370/5422 irclickid 5422
  `);
  process.exit(1);
}

const CONFIG = { concurrency: 1, waitTime: 20_000, retryCount: 1, interUrlDelay: 2_000 };

const OUTPUT_DIR  = path.join(__dirname, 'test-output');
const TIMESTAMP   = Date.now();
const OUTPUT_JSON = path.join(OUTPUT_DIR, `results_${TIMESTAMP}.json`);
const OUTPUT_CSV  = path.join(OUTPUT_DIR, `results_${TIMESTAMP}.csv`);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const allResults = [];

// ── CSV ───────────────────────────────────────────────────────────────────────
const CSV_FIELDS = [
  'input_url','final_url','final_status_code','overall_status','integration_type',
  'click_id_in_url','click_id','consent_detected','captcha_detected',
  'navigation_error','detected_tms','brwsr_cookie',
  'redirect_chain',
  // UTT
  'utt.tag_detected','utt.identify_call','utt.identify_path','utt.identify_status',
  'utt.cli_present','utt.cli_value','utt.cli_cookie_name',
  'utt.cus_id_present','utt.cus_id_value','utt.cus_id_cookie_name',
  'utt.click_id_in_payload','utt.click_id_cookies',
  'utt.ir_field','utt.implementation_method',
  'utt.time_to_tag_ms','utt.time_to_identify_ms',
  // Shopify
  'shopify.pageload_found','shopify.pageload_status','shopify.integration_source',
  'shopify.click_id_in_payload','shopify.click_id_cookies',
  'shopify.cli_present','shopify.cli_value','shopify.cli_cookie_name',
  'shopify.cus_id_present','shopify.cus_id_value','shopify.cus_id_cookie_name',
  'shopify.first_party_cookie_field','shopify.web_pixel_console',
  'shopify.web_pixel_console_status','shopify.shopify_consent',
  // Cookies
  'cookies',
  // Identity
  'identity.status','identity.lookup_type','identity.attempts',
  'identity.consumer_id','identity.ids',
  'identity.pro_node','identity.fpc_node','identity.cli_node','identity.note',
];

function getVal(obj, fieldPath) {
  const val = fieldPath.split('.').reduce((o, k) => (o != null ? o[k] : null), obj);
  if (val === null || val === undefined || val === '') return 'N/A';
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : 'N/A';
  return val;
}

function csvCell(val) {
  const s = String(val);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeFiles() {
  // Strip internal _raw before writing JSON
  const clean = allResults.map(r => {
    const { _raw, ...rest } = r;
    return rest;
  });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(clean, null, 2), 'utf8');
  const header = CSV_FIELDS.join(',');
  const rows   = allResults.map(r => CSV_FIELDS.map(f => csvCell(getVal(r, f))).join(','));
  fs.writeFileSync(OUTPUT_CSV, [header, ...rows].join('\n'), 'utf8');
}

// ── Display ───────────────────────────────────────────────────────────────────
function trunc(val, n = 35) {
  if (!val) return 'N/A';
  return String(val).length > n ? String(val).slice(0, n) + '…' : String(val);
}

function row(label, val) {
  const padded = label.padEnd(26);
  const display = (val === null || val === undefined || val === '') ? 'N/A' : val;
  console.log(`  ${padded}: ${display}`);
}

function printResult(r) {
  const L = '─'.repeat(76);
  console.log('\n' + L);
  row('input_url',        r.input_url);
  row('final_url',        r.final_url);
  row('final_status_code',r.final_status_code);
  row('overall_status',   r.overall_status);
  row('integration_type', r.integration_type);
  row('detected_tms',     r.detected_tms?.join(', ') || 'N/A');
  console.log('');

  if (r.captcha_detected)  { console.log('  ⚠ CAPTCHA DETECTED — checks skipped'); console.log(L); return; }
  if (r.navigation_error)  { console.log(`  ✖ NAVIGATION ERROR: ${r.navigation_error_message}`); console.log(L); return; }

  // Redirect chain
  console.log('  ── Redirect Chain ───────────────────────────────────────────────');
  if (r.redirect_chain) {
    r.redirect_chain.split('\n').forEach(line => console.log('  ' + line));
  } else {
    console.log('  N/A');
  }

  // General
  console.log('  ── General ──────────────────────────────────────────────────────');
  row('click_id_in_url',  r.click_id_in_url);
  row('click_id',         trunc(r.click_id));
  row('consent_detected', r.consent_detected);
  row('brwsr_cookie',     trunc(r.brwsr_cookie));

  // UTT
  if (r.utt?.tag_detected !== 'N/A') {
    console.log('\n  ── UTT ──────────────────────────────────────────────────────────');
    row('tag_detected',       `${r.utt.tag_detected}  (${r.utt.time_to_tag_ms ?? 'N/A'}ms)`);
    row('identify_call',      `${r.utt.identify_call}  path=${r.utt.identify_path || 'N/A'}  status=${r.utt.identify_status || 'N/A'}  (${r.utt.time_to_identify_ms ?? 'N/A'}ms)`);
    row('implementation',     r.utt.implementation_method);
    row('cli_present',        r.utt.cli_present);
    row('cli_value',          trunc(r.utt.cli_value));
    row('cli_cookie_name',    r.utt.cli_cookie_name);
    row('cus_id_present',     r.utt.cus_id_present + (r.utt.cus_id_value ? ' ⚠ value=' + trunc(r.utt.cus_id_value) : ''));
    row('cus_id_cookie_name', r.utt.cus_id_cookie_name);
    row('click_id_in_payload',r.utt.click_id_in_payload);
    row('click_id_cookies',   r.utt.click_id_cookies);
    row('ir_field',           trunc(r.utt.ir_field));
  }

  // Shopify
  if (r.shopify?.pageload_found !== 'N/A' || r.shopify?.web_pixel_console !== 'N/A') {
    console.log('\n  ── Shopify ──────────────────────────────────────────────────────');
    row('pageload_found',          `${r.shopify.pageload_found}  status=${r.shopify.pageload_status || 'N/A'}`);
    row('integration_source',      r.shopify.integration_source);
    row('click_id_in_payload',     r.shopify.click_id_in_payload);
    row('click_id_cookies',        r.shopify.click_id_cookies);
    row('cli_present',             r.shopify.cli_present);
    row('cli_value',               trunc(r.shopify.cli_value));
    row('cli_cookie_name',         r.shopify.cli_cookie_name);
    row('cus_id_present',          r.shopify.cus_id_present + (r.shopify.cus_id_value ? ' ⚠' : ''));
    row('cus_id_cookie_name',      r.shopify.cus_id_cookie_name);
    row('first_party_cookie_field',r.shopify.first_party_cookie_field);
    row('web_pixel_console',       `${r.shopify.web_pixel_console}  status=${r.shopify.web_pixel_console_status || 'N/A'}`);
    row('shopify_consent',         r.shopify.shopify_consent === null ? 'N/A' : String(r.shopify.shopify_consent));
  }

  // Cookies
  console.log('\n  ── Cookies ──────────────────────────────────────────────────────');
  if (r.cookies) {
    r.cookies.split('\n').forEach(line => console.log('  ' + line));
  } else {
    console.log('  N/A');
  }

  // Identity
  console.log('\n  ── Identity ─────────────────────────────────────────────────────');
  row('status',       r.identity.status);
  row('lookup_type',  r.identity.lookup_type);
  if (r.identity.note) row('note', r.identity.note);
  if (r.identity.consumer_id) {
    row('consumer_id', r.identity.consumer_id);
    row('pro_node',    r.identity.pro_node);
    row('fpc_node',    r.identity.fpc_node);
    row('cli_node',    r.identity.cli_node);
    console.log('  ids:');
    (r.identity.ids || '').split('\n').forEach(id => console.log('    • ' + id));
  }
  console.log(L);
}

// ── Identity updates ──────────────────────────────────────────────────────────
function handleIdentityUpdate(resultId, update) {
  const r = allResults.find(x => x.id === resultId);
  if (r) Object.assign(r.identity, update);

  const s = update.status;
  if (s === 'PASS') {
    console.log(`\n  [identity] ✔ Consumer ID: ${update.consumer_id}`);
    if (update.ids) update.ids.split('\n').forEach(id => console.log(`             • ${id}`));
    writeFiles();
  } else if (s === 'WARN' || s === 'FAIL') {
    console.log(`\n  [identity] ✖ ${update.note}`);
    writeFiles();
  } else if (s === 'N/A') {
    console.log(`\n  [identity] — ${update.note}`);
    writeFiles();
  } else if (update.attempts) {
    process.stdout.write(`\r  [identity] ↻ ${update.note}   `);
  }
}

function handleIdentityDone() {
  writeFiles();
  console.log('\n\n  ✔ All identity lookups resolved. Final files written.');
  console.log(`  JSON: ${OUTPUT_JSON}`);
  console.log(`  CSV : ${OUTPUT_CSV}\n`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n  ╔══════════════════════════════════════════════╗');
  console.log('  ║     Tracking Validator — Engine Test         ║');
  console.log('  ║     TSE — impact.com                         ║');
  console.log('  ╚══════════════════════════════════════════════╝\n');
  console.log(`  URLs     : ${TEST_URLS.length}`);
  console.log(`  Wait time: ${CONFIG.waitTime / 1000}s per URL`);
  console.log(`  Retries  : ${CONFIG.retryCount}\n`);

  let Crawler;
  try { ({ Crawler } = require('./engine/crawler')); }
  catch (e) {
    console.error('\n  ✖ Load failed. Run `npm install` and `npx playwright install chromium`.\n  ' + e.message);
    process.exit(1);
  }

  const crawler = new Crawler(
    CONFIG,
    msg    => console.log(' ', msg),
    result => { allResults.push(result); printResult(result); writeFiles(); },
    handleIdentityUpdate,
    ()     => {
      writeFiles();
      console.log(`\n  Crawl done. Identity enrichment running (up to 7 min)…`);
      console.log(`  JSON: ${OUTPUT_JSON}`);
      console.log(`  CSV : ${OUTPUT_CSV}\n`);
    },
    handleIdentityDone,
  );

  await crawler.run(TEST_URLS);
}

main().catch(err => { console.error('\n  ✖ Fatal:', err.message); process.exit(1); });