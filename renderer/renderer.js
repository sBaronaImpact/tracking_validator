'use strict';

// Identity status values — mirror result.js STATUS constants used in the engine
const STATUS_PENDING = 'PENDING';
const STATUS_NA      = 'N/A';

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════
const state = {
  results:     [],       // all result objects
  parsed:      [],       // parsed input URLs [{url,clickIdParam,campaignId,campaignName}]
  filter:      'all',    // 'all'|'UTT'|'SHOPIFY'|'HYBRID'|'issues'
  running:        false,
  cancelRequested:false,
  searchQuery:    '',
  drawerWide:     false,
  terminalExpanded: false,
  terminalBackup: null,
  inputBackup:    null,
  config:         {},
  detailId:    null,     // ID of result shown in detail drawer (null = closed)
  theme:       'dark',
  // ── Walkthrough mode ────────────────────────────────────────────────────
  mode:        'walkthrough',  // 'walkthrough' | 'workbench'
  guidedStep:  1,              // 1..6 — only used in walkthrough
  campaignIds: [],             // step 1 output, used to populate step 2 SQL
  autoDownloaded: false,       // guard so step 6 only auto-downloads once per crawl
  identityStopped: false,      // true when user manually stops identity enrichment
};

// ══════════════════════════════════════════════════════════════════════════════
// COLUMN DEFINITIONS
// ══════════════════════════════════════════════════════════════════════════════
const COL_GROUPS = [
  {
    id: 'action', label: 'Recommended Action', always: true,
    cols: [
      { key: 'remediation_note', label: 'Remediation', type: 'remediation', w: 360,
        tip: 'Actionable recommendation based on the check results. What to investigate or fix.' },
    ]
  },
  {
    id: 'general', label: 'General', always: true,
    cols: [
      { key: 'integration_type',   label: 'Integration Type',          type: 'text',   w: 140,
        tip: 'The integration method detected on the landing page: UTT, SHOPIFY, Potential Hybrid Integration, ClickId Integration, or UNKNOWN.' },
      { key: 'input_url', label: 'Tracking Link', type: 'url', w: 220,
        tip: 'The tracking link as input. Click any row to open the detail panel.' },
      { key: 'final_url',          label: 'Final URL',                type: 'url',    w: 200,
        tip: 'The final landing page URL after all redirects resolve.' },
      { key: 'final_status_code',  label: 'HTTP',                     type: 'http',   w: 48,
        tip: 'HTTP status code of the final landing page. 200-299 is healthy.' },
      { key: 'click_id_in_url',    label: 'Click ID in URL',          type: 'bool',   w: 100,
        tip: 'Whether the click ID parameter is present in the final landing page URL as a standalone parameter value.' },
      { key: 'click_id_embedded',  label: 'CID Embedded',             type: 'bool',   w: 90,
        tip: 'Whether the click ID appears only embedded within another parameter\'s value (e.g. sourceid=imp_{clickid}) rather than as a standalone parameter (e.g. irclickid={clickid}). When true, the program should be configured with a dedicated {clickid} parameter for reliable attribution.' },
      { key: 'click_id',           label: 'Event Repository',                   type: 'events', w: 48,
        tip: 'Opens the Event Repository for this click ID — shows the click record and its metadata. Test clicks are generated in an isolated incognito session; only the click record itself will be present, not impression or conversion events.' },
      { key: 'detected_tms',       label: 'Global Tag Mgmt Systems',  type: 'array',  w: 150,
        tip: 'Tag management systems detected loaded on the website (GTM, Tealium, Segment, etc). This is what is present on the site — it does not necessarily mean impact.com tracking is deployed through it.' },
      { key: 'brwsr_cookie',       label: 'brwsr',                    type: 'has',    w: 50,
        tip: 'The impact brwsr cookie. Always absent in this tool — the crawler runs in a fresh incognito session, so the third-party brwsr cookie cannot be dropped by the tracking domain. Use Profile Redirect to confirm the ojrq.net lookup was attempted.' },
      { key: 'profile_redirect',   label: 'Profile Redirect',         type: 'bool',   w: 110,
        tip: 'Whether ojrq.net appeared in the redirect chain. When no brwsr cookie is present on a request, impact redirects to ojrq.net to check for an existing one; if none is found, a fresh cookie is generated and set on the tracking domain. In the crawler\'s incognito session the cookie cannot be dropped. Profile Redirect confirms the lookup was attempted, not that a match was found.' },
      { key: 'traffic_guard',      label: 'Traffic Guard',            type: 'bool',   w: 100,
        tip: 'Whether a Traffic Guard redirect (trafficguard.ai) was detected in the chain. Traffic Guard is a third-party click fraud gateway. If the Click ID in URL check failed alongside this, the click ID was likely stripped because the test partner ID (2222) is not a valid live partner for this advertiser.' },
      { key: 'child_parent_redirect', label: 'Child/Parent',          type: 'bool',   w: 90,
        tip: 'Whether a child/parent program redirect was detected — the tracking link belongs to a child program that routes through a parent program via a third-party gateway. Check the parent_campaign_id field for the parent program.' },
      { key: 'consent_detected',   label: 'Consent',                  type: 'bool',   w: 58,
        tip: 'Whether a cookie consent banner was detected and accepted on the landing page.' },
    ]
  },
  {
    id: 'utt', label: 'Universal Tracking Tag',
    integrations: ['UTT', 'Potential Hybrid Integration'],
    cols: [
      { key: 'utt.tag_detected',           label: 'UTT Library',          type: 'bool',  w: 88,
        tip: 'Whether the impact.com Universal Tracking Tag JavaScript library loaded on the page.' },
      { key: 'utt.identify_call',          label: 'Identify Call',        type: 'bool',  w: 90,
        tip: 'Whether the UTT fired an identify call to impact.com.' },
      { key: 'utt.identify_path',          label: 'Path',                 type: 'text',  w: 48,
        tip: 'The URL path segment of the identify call endpoint.' },
      { key: 'utt.cli_present',            label: 'CustomProfileId',      type: 'bool',  w: 110,
        tip: 'Whether a CustomProfileId value was passed in the identify call payload.' },
      { key: 'utt.cli_cookie_name',        label: 'CustomProfileId Cookie',type: 'text', w: 130,
        tip: 'Name of the cookie whose value matches the CustomProfileId (value-first match — name varies by client).' },
      { key: 'utt.cus_id_present',         label: 'CustomerId',           type: 'warn',  w: 100,
        tip: 'Whether a CustomerId was passed in an anonymous session. It should NOT be present — a CustomerId in an anonymous session is flagged as a warning.' },
      { key: 'utt.click_id_in_payload',    label: 'Click ID in Payload',  type: 'bool',  w: 120,
        tip: 'Whether the click ID was present in the identify call payload.' },
      { key: 'utt.implementation_method',  label: 'Method',               type: 'tms',   w: 120,
        tip: 'How the UTT identify call was implemented — via a tag manager (GTM, Tealium, etc) or fired directly. "(inferred)" means it was deduced from script context rather than confirmed from the call stack.' },
      { key: 'utt.time_to_tag_ms',         label: 'UTT Library ms',       type: 'ms',    w: 100,
        tip: 'Time in milliseconds from navigation start until the UTT library loaded.' },
      { key: 'utt.time_to_identify_ms',    label: 'Identify ms',          type: 'ms',    w: 90,
        tip: 'Time in milliseconds from navigation start until the identify call fired.' },
    ]
  },
  {
    id: 'shopify', label: 'Shopify',
    integrations: ['SHOPIFY', 'Potential Hybrid Integration'],
    cols: [
      { key: 'shopify.pageload_found',     label: 'Pageload Call',        type: 'bool', w: 90,
        tip: 'Whether the Shopify Plugin PageLoad API request fired on the landing page.' },
      { key: 'shopify.time_to_pageload_ms',label: 'Pageload ms',          type: 'ms',   w: 90,
        tip: 'Time in milliseconds from navigation start until the PageLoad API request fired.' },
      { key: 'shopify.integration_source', label: 'Source',               type: 'text', w: 68,
        tip: 'The IntegrationSource value reported in the PageLoad payload — expected to be "Shopify".' },
      { key: 'shopify.click_id_in_payload',label: 'Click ID in Payload',  type: 'bool', w: 120,
        tip: 'Whether the click ID was present in the PageLoad request payload.' },
      { key: 'shopify.cli_present',        label: 'CustomProfileId',      type: 'bool', w: 110,
        tip: 'Whether a CustomProfileId value was passed in the PageLoad payload.' },
      { key: 'shopify.cli_cookie_name',    label: 'CustomProfileId Cookie',type: 'text',w: 130,
        tip: 'Name of the cookie whose value matches the CustomProfileId (value-first match — name varies by client).' },
      { key: 'shopify.cus_id_present',     label: 'CustomerId',           type: 'warn', w: 100,
        tip: 'Whether a CustomerId was passed in an anonymous session. It should NOT be present — a CustomerId in an anonymous session is flagged as a warning.' },
      { key: 'shopify.web_pixel_console',  label: 'Web Pixel',            type: 'bool', w: 80,
        tip: 'Whether the Shopify web pixel logged its expected console signal.' },
      { key: 'shopify.shopify_consent',    label: 'Consent API',          type: 'bool', w: 90,
        tip: 'Whether the Shopify Customer Privacy / consent API was detected.' },
    ]
  },
  {
    id: 'identity', label: 'Identity', always: true,
    cols: [
      { key: 'identity.status',    label: 'Status',      type: 'id-status', w: 70,
        tip: 'Result of the identity graph enrichment lookup against the impact identity service.' },
      { key: 'identity.pro_node',  label: 'PRO',         type: 'bool',      w: 40,
        tip: 'Whether a _PRO node (the click\'s profile ID) was found in the identity graph.' },
      { key: 'identity.fpc_node',  label: 'FPC',         type: 'bool',      w: 40,
        tip: 'Whether a _FPC node (first-party cookie) was found in the identity graph.' },
      { key: 'identity.cli_node',  label: 'CLI',         type: 'bool',      w: 40,
        tip: 'Whether a _CLI node (CustomProfileId cookie) was found in the identity graph.' },
      { key: 'identity.consumer_id',label:'Consumer ID', type: 'trunc',     w: 100,
        tip: 'The resolved consumer ID from the identity graph.' },
    ]
  },
  {
    id: 'notes', label: 'Notes', always: true,
    cols: [
      { key: 'crawl_note',       label: 'Crawl Notes',  type: 'note',        w: 260,
        tip: 'Why the URL was skipped or failed (timeout, CAPTCHA, network error, etc). Empty for successful crawls.' },
    ]
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// REMEDIATION ENGINE — rule-based actionable recommendations
// ══════════════════════════════════════════════════════════════════════════════

function computeRemediation(r) {
  if (!r) return null;

  const type = r.integration_type || '';
  const utt  = r.utt  || {};
  const shop = r.shopify || {};

  // SKIP / error cases
  if (r.captcha_detected) {
    return 'CAPTCHA challenge blocked the crawler. Manual validation required.';
  }
  if (r.overall_status === 'SKIP' || r.navigation_error) {
    const msg = (r.navigation_error_message || r.crawl_note || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('exceeded')) {
      return 'Page timed out. Test manually — site may be slow or blocking headless browsers.';
    }
    if (msg.includes('err_name_not_resolved') || msg.includes('dns')) {
      return 'Tracking domain could not be resolved. Verify domain configuration in impact.';
    }
    if (msg.includes('hard timeout')) {
      return 'URL abandoned after hard timeout. The page or a dependency never finished loading. Test manually.';
    }
    return null;
  }

  const notes = [];

  // Click ID embedded only — not configured as a standalone parameter
  if (r.click_id_embedded) {
    notes.push(
      'The click ID is present in the final URL but only embedded within another ' +
      'parameter\'s value — it is not configured as a standalone parameter. ' +
      'The impact program should have a dedicated {clickid} parameter in the tracking template ' +
      'or global URL params (e.g. irclickid={clickid}). Without this, the click ID cannot be ' +
      'reliably extracted for attribution.'
    );
  }

  // Child/parent program redirect
  if (r.child_parent_redirect) {
    notes.push(
      `Child/parent program redirect detected. This tracking link (campaign ID: ${r.campaign_id}) ` +
      `routes through a parent program (campaign ID: ${r.parent_campaign_id}) via a third-party gateway. ` +
      `This is noted for awareness — no action required.`
    );
  }

  // Traffic Guard — must check BEFORE integration-type early returns because
  // it fires at the redirect chain level regardless of whether UTT/Shopify was
  // detected. UNKNOWN integrations with Traffic Guard in their chain still need
  // this remediation surfaced.
  if (r.traffic_guard && r.click_id_in_url === false) {
    notes.push(
      'Traffic Guard redirect detected and click ID is missing from the final URL. ' +
      'Traffic Guard likely stripped the click ID because the test partner ID "2222" is not a ' +
      'valid live media partner for this advertiser. ' +
      'To validate: replace "2222" with "1111" (impact\'s test partner ID) in the tracking link, ' +
      'or test with a live campaign link.'
    );
  }

  // UNKNOWN — if TG is already noted, add UNKNOWN as secondary context then return
  if (type === 'UNKNOWN') {
    notes.push('No tracking integration detected. Verify integration manually — may indicate a custom implementation not supported by this tool.');
    return notes.join('\n\n');
  }

  // ClickId Integration
  if (type === 'ClickId Integration') {
    notes.push('Click ID stored as a cookie but no landing page tracking detected via UTT. The client may be using the Click ID strictly for attribution. Verify conversion submission method using internal tools (Loggly, SQL, etc.).');
    return notes.join('\n\n');
  }

  // CustomerId ⚠ — checked before other rules, applies to both UTT and Shopify
  const CUSTOMERID_NOTE =
    'CustomerId detected in an anonymous session. CustomerId should only be sent after a user has authenticated.\n' +
    'For anonymous visitors, use CustomProfileId instead:\n' +
    '  • customProfileId — unique visitor identifier regardless of sign-in state (UUID, anonymous cookie, IDFV)\n' +
    '  • customerId — maps to your site\'s backend user systems (authenticated users only)\n' +
    '  • customerEmail — SHA-1 hash of visitor\'s email address\n' +
    'If any value is unknown, pass an empty string.';

  if (utt.cus_id_present === 'WARN' || shop.cus_id_present === 'WARN') {
    notes.push(CUSTOMERID_NOTE);
  }

  // UTT checks
  if (type === 'UTT' || type === 'Potential Hybrid Integration') {
    if (utt.tag_detected === false) {
      notes.push(
        'UTT library not detected on landing page. Verify the impact.com tag is deployed and loading ' +
        'correctly on this domain. This script must be placed in the <head> section of the site and must ' +
        'fire sequentially first — before the Identify call. It must fire on page load, not on a button click or redirect event.'
      );
    } else if (utt.identify_call === false) {
      notes.push(
        'UTT library loaded but Identify call not firing. Check the TMS tag configuration — ensure ' +
        "ire('identify', {...}) fires on page load. The Identify call must fire after the UTT library " +
        'has loaded, otherwise it will fail to execute.'
      );
    } else if (utt.click_id_in_payload === false) {
      notes.push(
        'Identify call firing but click ID not passed in payload. Verify the click ID parameter is ' +
        'mapped to the Identify call in your TMS configuration.'
      );
    }
  }

  // Shopify checks
  if (type === 'SHOPIFY' || type === 'Potential Hybrid Integration') {
    if (shop.pageload_found === false && shop.web_pixel_console === true) {
      notes.push(
        'Shopify Plugin confirmed via web pixel but PageLoad API request not found. ' +
        'Check plugin installation and domain configuration.'
      );
    } else if (shop.pageload_found === true && shop.click_id_in_payload === false) {
      notes.push(
        'Shopify Plugin firing but click ID not in PageLoad payload. ' +
        'Verify the click ID parameter is configured in plugin settings.'
      );
    }
  }

  // Hybrid redundancy — only warn when BOTH the Shopify PageLoad API request
  // AND the UTT Identify call are firing. A Hybrid detection caused solely by
  // UTT using a Shopify cookie (_shopify_y) as CustomProfileId is a legitimate
  // single-method integration — UTT is the only active tracking, the client
  // is just using the Shopify session cookie as their visitor identifier.
  if (type === 'Potential Hybrid Integration' &&
      shop.pageload_found === true &&
      utt.identify_call === true &&
      notes.length === 0) {
    notes.push(
      'Both UTT and Shopify Plugin signals detected simultaneously. This is redundant and creates ' +
      'duplicate tracking events. Consolidate to a single tracking method unless there is a very ' +
      'specific use case. Confirm with the client which is intended and disable the other.'
    );
  }

  // Identity lookup failed
  if (r.identity && r.identity.status === 'WARN') {
    const ep = r.identity.endpoint ? `\nEndpoint: ${r.identity.endpoint}` : '';
    notes.push(
      `Identity lookup could not resolve after ${r.identity.attempts || 'multiple'} attempt(s). ` +
      `Retry after a delay — identity data may require time to propagate after the session.${ep}`
    );
  }

  return notes.length > 0 ? notes.join('\n\n') : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// SQL QUERY
// ══════════════════════════════════════════════════════════════════════════════
const SQL_QUERY = `select
  lower(concat("https://",IF(tracking_domain_type="CUSTOM",
    tracking_domain,
    concat(sub_tracking_domain,".",tracking_domain)),
    "/c/2222/",ad.id,"/",c.id)) URL
  ,COALESCE(
    IF(LOCATE('={clickid}', campaign_tracking_template) > 0,
      SUBSTRING_INDEX(
        SUBSTRING_INDEX(campaign_tracking_template, '={clickid}', 1), '&', -1
      ),
      NULL
    ),
    IF(LOCATE('={clickid}', global_url_params) > 0,
      SUBSTRING_INDEX(
        SUBSTRING_INDEX(global_url_params, '={clickid}', 1), '&', -1
      ),
      NULL
    )
  ) as clickid_param
  ,c.id as campaign_id
  ,c.name as campaign_name
from ircm.ircm_technicalintegration ti
join ircm.ircm_campaign c on c.id = ti.ircm_campaign_id
join irad.irad_ad ad on ad.ircm_campaign_id = ti.ircm_campaign_id
  and ad_type = "ONLINE_TRACKING_LINK"
where
  ti.ircm_campaign_id in ({campaign_id})`;

// ══════════════════════════════════════════════════════════════════════════════
// INPUT PARSING
// ══════════════════════════════════════════════════════════════════════════════

function parseInput(text) {
  if (!text || !text.trim()) return { urls: [], error: null };
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { urls: [], error: null };

  // Detect MySQL table format
  if (lines[0].startsWith('+')) return parseMysqlTable(lines);
  return parseCsv(lines);
}

function parseMysqlTable(lines) {
  const dataLines = lines.filter(l => l.startsWith('|'));
  if (dataLines.length < 2) return { urls: [], error: 'No data rows found in MySQL table' };

  const parseRow = line => line.split('|').slice(1, -1).map(c => c.trim());
  const headers  = parseRow(dataLines[0]).map(h => h.toLowerCase());

  const urlIdx   = headers.findIndex(h => h === 'url');
  const cidIdx   = headers.findIndex(h => h === 'clickid_param');
  const campIdx  = headers.findIndex(h => h === 'campaign_id');
  const nameIdx  = headers.findIndex(h => h === 'campaign_name');

  if (urlIdx < 0) return { urls: [], error: 'Missing URL column in MySQL table' };

  const urls = dataLines.slice(1).map(line => {
    const cells = parseRow(line);
    return {
      url:          cells[urlIdx]  || '',
      clickIdParam: cidIdx  >= 0 ? cells[cidIdx]  || 'irclickid' : 'irclickid',
      campaignId:   campIdx >= 0 ? cells[campIdx] || '' : '',
      campaignName: nameIdx >= 0 ? cells[nameIdx] || '' : '',
    };
  }).filter(r => r.url.startsWith('http'));

  if (!urls.length) return { urls: [], error: 'No valid URLs found in MySQL table' };
  return { urls, error: null };
}

function parseCsv(lines) {
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const urlIdx  = headers.findIndex(h => h === 'url');
  const cidIdx  = headers.findIndex(h => h === 'clickid_param');
  const campIdx = headers.findIndex(h => h === 'campaign_id');
  const nameIdx = headers.findIndex(h => h === 'campaign_name');

  if (urlIdx < 0) return { urls: [], error: 'Missing URL column. Expected CSV header: URL,clickid_param,campaign_id,campaign_name' };

  const urls = lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    return {
      url:          cells[urlIdx]  || '',
      clickIdParam: cidIdx  >= 0 ? cells[cidIdx]  || 'irclickid' : 'irclickid',
      campaignId:   campIdx >= 0 ? cells[campIdx] || '' : '',
      campaignName: nameIdx >= 0 ? cells[nameIdx] || '' : '',
    };
  }).filter(r => r.url.startsWith('http'));

  if (!urls.length) return { urls: [], error: 'No valid URLs found. Make sure URLs start with http.' };
  return { urls, error: null };
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// ══════════════════════════════════════════════════════════════════════════════
// CELL RENDERING
// ══════════════════════════════════════════════════════════════════════════════

function getVal(result, key) {
  return key.split('.').reduce((o, k) => (o != null ? o[k] : null), result);
}

function renderCell(result, col) {
  const raw = getVal(result, col.key);

  switch (col.type) {
    case 'bool':
      if (raw === true)   return `<span class="bool-true" title="true">✓</span>`;
      if (raw === false)  return `<span class="bool-false" title="false">✗</span>`;
      if (raw === 'WARN') return `<span class="bool-warn">WARN</span>`;
      if (raw === 'INFO') return `<span class="bool-info">INFO</span>`;
      return `<span class="bool-na">—</span>`;

    case 'warn':
      // CustomerId check: ✓ none = no CustomerId passed (correct);
      // ⚠ present = CustomerId passed in anonymous session (flag this)
      if (raw === 'PASS' || raw === true)
        return `<span class="bool-true" title="No CustomerId passed — correct for an anonymous session">✓ none</span>`;
      if (raw === 'WARN')
        return `<span class="bool-warn" title="A CustomerId was passed in an anonymous session — flag this to the client">⚠ present</span>`;
      return `<span class="bool-na">—</span>`;

    case 'tms':
      // Implementation method — highlight TMS names like the TMS column
      if (!raw || raw === 'N/A') return `<span class="bool-na">—</span>`;
      if (raw === 'direct')
        return `<span style="font-size:11px;color:var(--text-muted)" data-tip="${esc(raw)}">direct</span>`;
      return `<span class="tms-tag" data-tip="${esc(raw)}">${esc(trunc(raw, 20))}</span>`;

    case 'events':
      if (!raw) return `<span class="bool-na">—</span>`;
      return `<button class="events-btn" data-eid="${esc(raw)}" title="View Event Repository for this click ID">↗ ER</button>`;
      // Crawl note — show first sentence, full text on hover
      if (!raw) return `<span class="bool-na">—</span>`;
      return `<span class="crawl-note-text" data-tip="${esc(raw)}">${esc(trunc(raw.split('\n')[0], 80))}</span>`;

    case 'remediation':
      // Remediation note — first sentence in cell, full text on hover
      if (!raw) return `<span class="bool-na">—</span>`;
      return `<span class="remediation-text" data-tip="${esc(raw)}">${esc(trunc(raw.split('\n')[0], 80))}</span>`;

    case 'url':
      if (!raw) return `<span class="bool-na">—</span>`;
      return `<span class="url-cell" data-tip="${esc(raw)}">${esc(trunc(raw, 40))}</span>`;

    case 'http':
      if (!raw) return `<span class="bool-na">—</span>`;
      const cls = raw >= 200 && raw < 300 ? 'bool-true' : 'bool-false';
      return `<span class="${cls}">${raw}</span>`;

    case 'array':
      if (!raw || !raw.length) return `<span class="bool-na">—</span>`;
      return raw.map(t => `<span class="tms-tag">${esc(t)}</span>`).join(' ');

    case 'has':
      return raw
        ? `<span class="bool-true" data-tip="${esc(raw)}">✓</span>`
        : `<span class="bool-na">—</span>`;

    case 'text':
      if (!raw) return `<span class="bool-na">—</span>`;
      return `<span data-tip="${esc(raw)}" style="font-size:10px;color:var(--text-muted)">${esc(trunc(raw, 22))}</span>`;

    case 'trunc':
      if (!raw) return `<span class="bool-na">—</span>`;
      return `<span data-tip="${esc(raw)}" style="font-size:10px;color:var(--text-muted)">${esc(trunc(raw, 16))}</span>`;

    case 'ms': {
      if (raw == null) return `<span class="bool-na">—</span>`;
      const cls2 = raw < 5000 ? 'ms-fast' : raw < 15000 ? 'ms-slow' : 'ms-very-slow';
      return `<span class="${cls2}">${raw}</span>`;
    }

    case 'id-status': {
      if (raw === 'PASS' || raw === true)  return `<span class="id-status-pass">✓</span>`;
      if (raw === 'WARN')   return `<span class="id-status-pending">⚠</span>`;
      if (raw === 'N/A')    return `<span class="id-status-na">—</span>`;
      if (raw === 'PENDING' || raw === 'pending') return `<span class="id-status-pending">…</span>`;
      if (typeof raw === 'string' && raw.startsWith('retry')) return `<span class="id-status-pending">↻</span>`;
      return `<span class="id-status-na">—</span>`;
    }

    default:
      if (raw == null || raw === '') return `<span class="bool-na">—</span>`;
      return `<span>${esc(String(raw))}</span>`;
  }
}

function renderStatusBadge(status) {
  const map = {
    'PASS': 'status-pass', 'FAIL': 'status-fail',
    'WARN': 'status-warn', 'SKIP': 'status-skip', 'INFO': 'status-info',
    'PENDING': 'status-skip',
  };
  const cls = map[status] || 'status-skip';
  return `<span class="status-badge ${cls}">${status || '—'}</span>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function trunc(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}

// ══════════════════════════════════════════════════════════════════════════════
// SQL SYNTAX HIGHLIGHTER — lightweight regex-based MySQL highlighter
// ══════════════════════════════════════════════════════════════════════════════

function highlightSql(sql) {
  const KEYWORDS = [
    'select','from','where','join','inner','left','right','outer','on','and','or',
    'as','in','is','null','case','when','then','else','end','if','not','like',
    'between','order','by','group','having','desc','asc','limit','offset',
    'insert','into','values','update','set','delete','create','alter','drop',
    'table','index','distinct','union','with','exists','all','any',
  ];
  const FUNCTIONS = [
    'IF','COALESCE','LOCATE','SUBSTRING_INDEX','CONCAT','LOWER','UPPER','TRIM',
    'REPLACE','LENGTH','CAST','COUNT','SUM','AVG','MIN','MAX','ROUND','NOW',
    'DATE','DATEDIFF','DATE_FORMAT','UNIX_TIMESTAMP','IFNULL','NULLIF','IN',
  ];

  // First escape the HTML
  let html = esc(sql);

  // 1. Comments (-- to end of line, /* ... */)
  html = html.replace(/(--[^\n]*)/g,           '\x01C\x02$1\x03');
  html = html.replace(/(\/\*[\s\S]*?\*\/)/g,   '\x01C\x02$1\x03');

  // 2. Strings — single and double quoted (use placeholder markers)
  html = html.replace(/(&#39;[^&]*?&#39;|&quot;[^&]*?&quot;)/g, '\x01S\x02$1\x03');

  // 3. Placeholders {name}
  html = html.replace(/(\{[a-zA-Z_]\w*\})/g,   '\x01P\x02$1\x03');

  // 4. Functions (case-sensitive uppercase)
  const fnRegex = new RegExp('\\b(' + FUNCTIONS.join('|') + ')(?=\\s*\\()', 'g');
  html = html.replace(fnRegex,                 '\x01F\x02$1\x03');

  // 5. Keywords (case-insensitive)
  const kwRegex = new RegExp('\\b(' + KEYWORDS.join('|') + ')\\b', 'gi');
  html = html.replace(kwRegex,                 '\x01K\x02$1\x03');

  // 6. Numbers (standalone)
  html = html.replace(/\b(\d+)\b/g,            '\x01N\x02$1\x03');

  // 7. Replace markers with span tags
  const wrap = { C: 'sql-comment', S: 'sql-string', P: 'sql-placeholder',
                 F: 'sql-fn',      K: 'sql-keyword', N: 'sql-number' };
  html = html.replace(/\x01([CSPFKN])\x02([\s\S]*?)\x03/g,
                      (_, t, c) => `<span class="${wrap[t]}">${c}</span>`);

  return html;
}

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOM TOOLTIP — reliable hover bubble that works on data-tip attributes
// ══════════════════════════════════════════════════════════════════════════════

function initTooltips() {
  const bubble = document.createElement('div');
  bubble.className = 'tip-bubble';
  document.body.appendChild(bubble);

  let hideTimer = null;

  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    clearTimeout(hideTimer);
    bubble.textContent = tip;
    bubble.classList.add('visible');
    positionTooltip(bubble, target);
  });

  document.addEventListener('mouseout', e => {
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    hideTimer = setTimeout(() => bubble.classList.remove('visible'), 100);
  });

  document.addEventListener('mousemove', e => {
    if (!bubble.classList.contains('visible')) return;
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    positionTooltip(bubble, target, e);
  });

  // Hide on scroll (so the bubble doesn't get stranded)
  document.addEventListener('scroll', () => bubble.classList.remove('visible'), true);
}

function positionTooltip(bubble, target, mouseEvent) {
  const rect = target.getBoundingClientRect();
  const bubRect = bubble.getBoundingClientRect();
  const margin = 8;

  // Default: below the target, left-aligned
  let top  = rect.bottom + margin;
  let left = rect.left;

  // If too close to bottom, show above
  if (top + bubRect.height > window.innerHeight - 8) {
    top = rect.top - bubRect.height - margin;
  }
  // If too close to right edge, shift left
  if (left + bubRect.width > window.innerWidth - 8) {
    left = window.innerWidth - bubRect.width - 8;
  }
  if (left < 8) left = 8;

  bubble.style.top  = top  + 'px';
  bubble.style.left = left + 'px';
}

// ══════════════════════════════════════════════════════════════════════════════
// COLUMN VISIBILITY — smart auto-hide
// ══════════════════════════════════════════════════════════════════════════════

function visibleGroups(filtered) {
  // When filter selects a specific type, show only relevant groups
  // When 'all', auto-hide groups where every visible row is N/A
  return COL_GROUPS.filter(grp => {
    if (grp.always) return true;
    if (!filtered.length) return false;

    // Explicit integration filter
    if (state.filter !== 'all' && state.filter !== 'issues') {
      const typeMap = { 'UTT': 'UTT', 'SHOPIFY': 'SHOPIFY', 'HYBRID': 'Potential Hybrid Integration' };
      const t = typeMap[state.filter];
      return grp.integrations && grp.integrations.includes(t);
    }

    // All/issues: show group if at least one row has a non-NA value
    return filtered.some(r =>
      grp.cols.some(col => {
        const v = getVal(r, col.key);
        return v !== 'N/A' && v !== null && v !== undefined;
      })
    );
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TABLE RENDERING
// ══════════════════════════════════════════════════════════════════════════════

function filteredResults() {
  const typeMap = {
    'UTT':     'UTT',
    'SHOPIFY': 'SHOPIFY',
    'HYBRID':  'Potential Hybrid Integration',
    'CLICKID': 'ClickId Integration',
  };
  const q = (state.searchQuery || '').trim().toLowerCase();

  return state.results.filter(r => {
    if (state.filter !== 'all') {
      if (state.filter === 'issues') {
        // Hard issues — always count regardless of integration_type:
        //   FAIL status, CAPTCHA blocks, navigation errors
        // Soft SKIP — only count when integration was actually detected
        //   (UNKNOWN SKIPs go to the Unknown bucket for manual review)
        const isHardIssue = r.captcha_detected || r.navigation_error || r.overall_status === 'FAIL';
        const isSkipIssue = r.overall_status === 'SKIP' && r.integration_type !== 'UNKNOWN';
        if (!isHardIssue && !isSkipIssue) return false;
      } else if (state.filter === 'unknown') {
        if (r.integration_type !== 'UNKNOWN') return false;
      } else {
        const t = typeMap[state.filter];
        if (r.integration_type !== t) return false;
      }
    }
    if (q) {
      const hay = ((r.input_url || '') + ' ' + (r.final_url || '') + ' ' + (r.campaign_id || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTable() {
  // Capture scroll positions so they survive filter/refresh re-renders
  const wrap     = document.getElementById('results-table-wrap');
  const tabPane  = document.getElementById('tab-validator');
  const wrapScroll = wrap    ? { left: wrap.scrollLeft, top: wrap.scrollTop } : null;
  const paneTop    = tabPane ? tabPane.scrollTop : 0;

  const filtered = filteredResults();
  const groups   = visibleGroups(filtered);
  const thead    = document.getElementById('results-thead');
  const tbody    = document.getElementById('results-tbody');
  const empty    = document.getElementById('results-empty');

  if (!filtered.length) {
    empty.classList.remove('hidden');
    thead.innerHTML = '';
    tbody.innerHTML = '';
    renderTable._lastGroupKey = '';
    requestAnimationFrame(() => { if (tabPane) tabPane.scrollTop = paneTop; });
    return;
  }
  empty.classList.add('hidden');

  // ── Header rows — only rebuild when visible group set changes ───────────────
  // During live crawl updates only tbody changes; skipping thead saves significant DOM work.
  const groupKey = groups.map(g => g.id).join(',');
  if (groupKey !== renderTable._lastGroupKey) {
    renderTable._lastGroupKey = groupKey;

    let groupHtml = '<tr class="group-header-row">';
    let colHtml   = '<tr class="col-header-row">';

    const frozenBandWidth = 36 + 96 + 140 + 64;
    groupHtml += `<th class="col-frozen-0 col-frozen-group-label"><div style="width:${frozenBandWidth}px;text-align:center;letter-spacing:0.1em;font-weight:700;font-size:10px;text-transform:uppercase">Summary</div></th>`;
    groupHtml += '<th class="col-frozen-1 col-frozen-group-label"></th>';
    groupHtml += '<th class="col-frozen-2 col-frozen-group-label"></th>';
    groupHtml += '<th class="col-frozen-3 col-frozen-group-label"></th>';
    colHtml   += '<th class="col-frozen-0">#</th>';
    colHtml   += '<th class="col-frozen-1" data-tip="The impact.com campaign (program) ID for this tracking link.">CampaignId</th>';
    colHtml   += '<th class="col-frozen-2" data-tip="The campaign (program) name from impact.com.">CampaignName</th>';
    colHtml   += '<th class="col-frozen-3">Status</th>';

    groups.forEach((grp, gi) => {
      const startCls = gi === 0 ? '' : 'group-start';
      const grpCls   = `grp-${grp.id}`;
      groupHtml += `<th colspan="${grp.cols.length}" class="${startCls} ${grpCls}">${grp.label}</th>`;
      grp.cols.forEach((col, ci) => {
        const cls = (ci === 0 && gi > 0 ? 'group-start ' : '') + grpCls;
        const tip = col.tip ? esc(col.tip) : col.key;
        colHtml += `<th class="${cls}" style="min-width:${col.w}px" data-tip="${tip}">${col.label}</th>`;
      });
    });

    groupHtml += '</tr>';
    colHtml   += '</tr>';
    thead.innerHTML = groupHtml + colHtml;
  }

  // ── Data rows ──────────────────────────────────────────────────────────────
  const rows = filtered.map((r, i) => {
    const statusCls = { PASS:'row-pass',FAIL:'row-fail',WARN:'row-warn',SKIP:'row-skip' }[r.overall_status] || '';
    const active    = state.detailId === r.id ? 'row-active' : '';

    let row = `<tr class="${statusCls} ${active}" data-id="${r.id}">`;
    row += `<td class="col-frozen-0 row-idx">${i + 1}</td>`;
    row += `<td class="col-frozen-1"><span style="color:var(--text-muted);font-size:11px">${esc(r.campaign_id || '—')}</span></td>`;
    row += `<td class="col-frozen-2 align-left"><span style="color:var(--text);font-size:11px" data-tip="${esc(r.campaign_name || '')}">${esc(trunc(r.campaign_name || '—', 18))}</span></td>`;
    row += `<td class="col-frozen-3">${renderStatusBadge(r.overall_status)}</td>`;

    groups.forEach((grp, gi) => {
      grp.cols.forEach((col, ci) => {
        let cls = (ci === 0 && gi > 0 ? 'group-start ' : '') + `grp-${grp.id}`;
        if (col.type === 'note')        cls += ' crawl-note-cell' + (r.crawl_note ? ' has-note' : '');
        if (col.type === 'remediation') {
          cls += ' remediation-cell';
          if (r.remediation_note) {
            const isAttention = r.overall_status === 'FAIL' || r.overall_status === 'SKIP' || r.overall_status === 'WARN';
            if (isAttention) cls += ' is-warn is-attention';
          }
        }
        row += `<td class="${cls}">${renderCell(r, col)}</td>`;
      });
    });

    row += '</tr>';
    return row;
  }).join('');

  tbody.innerHTML = rows;

  // Row click opens the detail drawer
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (window.getSelection().toString().length > 0) return;
      if (e.target.closest('a, button')) return;
      openDetail(tr.dataset.id);
    });
  });

  // Restore scroll positions on next frame after browser reflows the new content.
  // Prevents the page from jumping up when switching to a shorter filtered list.
  requestAnimationFrame(() => {
    if (wrapScroll && wrap) {
      wrap.scrollLeft = wrapScroll.left;
      wrap.scrollTop  = wrapScroll.top;
    }
    if (tabPane) tabPane.scrollTop = paneTop;
  });
}

// Helper used by updateIdentityProgress — kept here so it works alongside esc()

// ══════════════════════════════════════════════════════════════════════════════
// DETAIL DRAWER — vertical cheat-sheet, scrollable, copyable
// ══════════════════════════════════════════════════════════════════════════════

// Copy values keyed by id — copy buttons reference these (never inline JSON)
const copyValues = {};

function openDetail(id) {
  state.detailId = id;
  renderDrawer();
  renderTable();
}

function closeDetail() {
  state.detailId = null;
  document.getElementById('detail-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('visible');
  renderTable();
}

function renderDrawer() {
  const r = state.results.find(x => x.id === state.detailId);
  const drawer  = document.getElementById('detail-drawer');
  const overlay = document.getElementById('drawer-overlay');
  if (!r) { closeDetail(); return; }

  const naSpan = '<span class="dv-na">N/A</span>';

  const field = (label, val) => {
    const display = (val === null || val === undefined || val === '')
      ? naSpan : esc(String(val));
    return '<div class="dv-field"><div class="dv-label">' + label +
           '</div><div class="dv-value">' + display + '</div></div>';
  };

  const bool = (label, val) => {
    let d;
    if (val === true)        d = '<span class="dv-true">✓ true</span>';
    else if (val === false)  d = '<span class="dv-false">✗ false</span>';
    else if (val === 'WARN') d = '<span class="dv-warn">⚠ WARN</span>';
    else                     d = naSpan;
    return '<div class="dv-field"><div class="dv-label">' + label +
           '</div><div class="dv-value">' + d + '</div></div>';
  };

  const custId = (label, val) => {
    let d;
    if (val === 'PASS' || val === true) d = '<span class="dv-true">✓ none passed (correct)</span>';
    else if (val === 'WARN')            d = '<span class="dv-warn">⚠ present — flag to client</span>';
    else                                d = naSpan;
    return '<div class="dv-field"><div class="dv-label">' + label +
           '</div><div class="dv-value">' + d + '</div></div>';
  };

  const block = (label, val, copyKey) => {
    const text = (val === null || val === undefined || val === '') ? '' : String(val);
    if (!text) return '<div class="dv-field"><div class="dv-label">' + label +
                       '</div><div class="dv-value">' + naSpan + '</div></div>';
    copyValues[copyKey] = text;
    return '<div class="dv-field"><div class="dv-block-head">' +
           '<span class="dv-label">' + label + '</span>' +
           '<button class="dv-copy" data-copy="' + copyKey + '">Copy</button>' +
           '</div><pre class="dv-block">' + esc(text) + '</pre></div>';
  };

  // Redirect chain — each hop in its own div for hanging-indent wrap
  const redirectBlock = (val, copyKey) => {
    const text = (val === null || val === undefined || val === '') ? '' : String(val);
    if (!text) return '<div class="dv-field"><div class="dv-label">redirect_chain</div><div class="dv-value">' + naSpan + '</div></div>';
    copyValues[copyKey] = text;
    const hops = text.split('\n')
      .filter(h => h.trim())
      .map(hop => `<div class="redir-hop">${esc(hop)}</div>`)
      .join('');
    return '<div class="dv-field"><div class="dv-block-head">' +
           '<span class="dv-label">redirect_chain</span>' +
           '<button class="dv-copy" data-copy="' + copyKey + '">Copy</button>' +
           '</div><div class="dv-redirect-chain">' + hops + '</div></div>';
  };

  const section = (title, inner, grpId) => {
    const titleCls = grpId ? `dv-section-title grp-${grpId}` : 'dv-section-title';
    return '<div class="dv-section"><div class="' + titleCls + '">' + title + '</div>' + inner + '</div>';
  };

  let html = '';

  // 1. Recommended Action — first, prominent
  if (r.remediation_note) {
    copyValues['remediation'] = r.remediation_note;
    html += '<div class="dv-section dv-section-remediation">' +
            '<div class="dv-block-head"><span class="dv-section-title grp-action">Recommended Action</span>' +
            '<button class="dv-copy" data-copy="remediation">Copy</button></div>' +
            '<pre class="dv-block" style="color:var(--blue);border-color:rgba(74,158,255,0.3);background:rgba(74,158,255,0.05);word-break:normal;overflow-wrap:break-word">' +
            esc(r.remediation_note) + '</pre></div>';
  }

  // 2. General
  html += section('General',
    field('campaign_id',      r.campaign_id) +
    (r.campaign_name ? field('campaign_name', r.campaign_name) : '') +
    field('integration_type', r.integration_type) +
    field('tracking_link',    r.input_url) +
    field('final_url',        r.final_url) +
    field('HTTP status',      r.final_status_code) +
    bool ('click_id_in_url',  r.click_id_in_url) +
    (r.click_id_embedded ? bool('click_id_embedded', r.click_id_embedded) : '') +
    (r.click_id
      ? '<div class="dv-field"><div class="dv-label">click_id</div><div class="dv-value" style="display:flex;align-items:center;gap:10px">' +
        '<span style="user-select:all;word-break:break-all">' + esc(r.click_id) + '</span>' +
        '<button class="events-btn" data-eid="' + esc(r.click_id) + '" style="flex-shrink:0">↗ ER</button>' +
        '</div></div>'
      : field('click_id', null)) +
    field('detected_tms',     Array.isArray(r.detected_tms) ? r.detected_tms.join(', ') : null) +
    field('brwsr_cookie',     r.brwsr_cookie) +
    bool ('profile_redirect', r.profile_redirect) +
    bool ('traffic_guard',         r.traffic_guard) +
    bool ('child_parent_redirect', r.child_parent_redirect) +
    (r.parent_campaign_id ? field('parent_campaign_id', r.parent_campaign_id) : '') +
    bool ('consent_detected', r.consent_detected) +
    (r.integration_type === 'ClickId Integration'
      ? field('note', 'Click ID stored as cookie — verify conversion submission method (CAPI or trackConversion) manually')
      : '') +
    (r.click_id_cookie_names ? field('click_id_cookie_names', r.click_id_cookie_names) : ''),
    'general'
  );

  // 3. Universal Tracking Tag
  if (r.utt && r.utt.tag_detected !== 'N/A') {
    html += section('Universal Tracking Tag',
      bool ('UTT Library',            r.utt.tag_detected) +
      bool ('Identify Call',          r.utt.identify_call) +
      field('identify_path',          r.utt.identify_path) +
      field('identify_status',        r.utt.identify_status) +
      bool ('CustomProfileId',        r.utt.cli_present) +
      field('cli_value',              r.utt.cli_value) +
      field('CustomProfileId Cookie', r.utt.cli_cookie_name) +
      custId('CustomerId',            r.utt.cus_id_present) +
      field('cus_id_value',           r.utt.cus_id_value) +
      field('cus_id_cookie',          r.utt.cus_id_cookie_name) +
      bool ('Click ID in Payload',    r.utt.click_id_in_payload) +
      field('click_id_cookies',       r.utt.click_id_cookies) +
      field('ir_field',               r.utt.ir_field) +
      field('Method',                 r.utt.implementation_method) +
      field('UTT Library ms',         r.utt.time_to_tag_ms) +
      field('Identify ms',            r.utt.time_to_identify_ms),
      'utt'
    );
  }

  // 4. Shopify
  if (r.shopify && r.shopify.pageload_found !== 'N/A') {
    html += section('Shopify',
      bool ('Pageload Call',          r.shopify.pageload_found) +
      field('pageload_status',        r.shopify.pageload_status) +
      field('Pageload ms',            r.shopify.time_to_pageload_ms) +
      field('integration_source',     r.shopify.integration_source) +
      bool ('Click ID in Payload',    r.shopify.click_id_in_payload) +
      field('click_id_cookies',       r.shopify.click_id_cookies) +
      bool ('CustomProfileId',        r.shopify.cli_present) +
      field('cli_value',              r.shopify.cli_value) +
      field('CustomProfileId Cookie', r.shopify.cli_cookie_name) +
      custId('CustomerId',            r.shopify.cus_id_present) +
      field('first_party_cookie',     r.shopify.first_party_cookie_field) +
      bool ('Web Pixel',              r.shopify.web_pixel_console) +
      field('Consent API',            r.shopify.shopify_consent),
      'shopify'
    );
  }

  // 5. Identity
  html += section('Identity',
    field('status',      r.identity && r.identity.status) +
    field('lookup_type', r.identity && r.identity.lookup_type) +
    field('attempts',    r.identity && r.identity.attempts) +
    field('endpoint',    r.identity && r.identity.endpoint) +
    field('consumer_id', r.identity && r.identity.consumer_id) +
    bool ('pro_node',    r.identity && r.identity.pro_node) +
    bool ('fpc_node',    r.identity && r.identity.fpc_node) +
    bool ('cli_node',    r.identity && r.identity.cli_node) +
    ((r.identity && r.identity.ids)  ? block('ids', r.identity.ids, 'ids') : '') +
    ((r.identity && r.identity.note) ? field('note', r.identity.note) : ''),
    'identity'
  );

  // 6. Cookies + Redirect Chain — reference dumps at the bottom
  html += section('Cookies', block('cookies', r.cookies, 'cookies'), 'notes');
  html += section('Redirect Chain', redirectBlock(r.redirect_chain, 'redirect'), 'notes');

  // 7. Crawl Notes — last
  if (r.crawl_note) {
    html += section('Crawl Notes', field('crawl_note', r.crawl_note), 'notes');
  }

  drawer.querySelector('.drawer-body').innerHTML = html;
  // Always start at the top — drawers retain scroll position otherwise
  drawer.querySelector('.drawer-body').scrollTop = 0;
  drawer.querySelector('.drawer-link').textContent = r.input_url;
  drawer.querySelector('.drawer-status').innerHTML = renderStatusBadge(r.overall_status);

  copyValues['__all__'] = buildPlainText(r);

  drawer.querySelectorAll('.dv-copy, .drawer-copy-all').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.copy;
      navigator.clipboard.writeText(copyValues[key] || '').then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
      });
    });
  });

  drawer.classList.add('open');
  overlay.classList.add('visible');
}

function buildPlainText(r) {
  const lines = [];
  const add = (k, v) => lines.push(k + ': ' + (v == null || v === '' ? 'N/A' : v));

  // 1. Recommended Action (if any) — first
  if (r.remediation_note) {
    lines.push('=== RECOMMENDED ACTION ===');
    lines.push(r.remediation_note);
    lines.push('');
  }

  // 2. General
  lines.push('=== GENERAL ===');
  add('campaign_id',      r.campaign_id);
  if (r.campaign_name) add('campaign_name', r.campaign_name);
  add('tracking_link',    r.input_url);
  add('overall_status',   r.overall_status);
  add('integration_type', r.integration_type);
  add('final_url',        r.final_url);
  add('HTTP status',      r.final_status_code);
  add('click_id_in_url',  r.click_id_in_url);
  add('click_id',         r.click_id);
  if (r.click_id) add('events_url', 'https://er-api.gcp.srv-impact.net/events.html?id=' + encodeURIComponent(r.click_id));
  if (r.click_id_embedded) add('click_id_embedded', true);
  add('detected_tms',     Array.isArray(r.detected_tms) ? r.detected_tms.join(', ') : null);
  add('brwsr_cookie',     r.brwsr_cookie);
  add('profile_redirect', r.profile_redirect);
  add('traffic_guard',          r.traffic_guard);
  add('child_parent_redirect',  r.child_parent_redirect);
  if (r.parent_campaign_id) add('parent_campaign_id', r.parent_campaign_id);
  add('consent_detected', r.consent_detected);
  if (r.click_id_cookie_names) add('click_id_cookie_names', r.click_id_cookie_names);

  // 3. Universal Tracking Tag
  if (r.utt && r.utt.tag_detected !== 'N/A') {
    lines.push('', '=== UNIVERSAL TRACKING TAG ===');
    add('UTT Library',            r.utt.tag_detected);
    add('Identify Call',          r.utt.identify_call);
    add('identify_path',          r.utt.identify_path);
    add('identify_status',        r.utt.identify_status);
    add('CustomProfileId',        r.utt.cli_present);
    add('cli_value',              r.utt.cli_value);
    add('CustomProfileId Cookie', r.utt.cli_cookie_name);
    add('CustomerId',             r.utt.cus_id_present);
    add('Click ID in Payload',    r.utt.click_id_in_payload);
    add('ir_field',               r.utt.ir_field);
    add('Method',                 r.utt.implementation_method);
    add('UTT Library ms',         r.utt.time_to_tag_ms);
    add('Identify ms',            r.utt.time_to_identify_ms);
  }

  // 4. Shopify
  if (r.shopify && r.shopify.pageload_found !== 'N/A') {
    lines.push('', '=== SHOPIFY ===');
    add('Pageload Call',          r.shopify.pageload_found);
    add('pageload_status',        r.shopify.pageload_status);
    add('Pageload ms',            r.shopify.time_to_pageload_ms);
    add('integration_source',     r.shopify.integration_source);
    add('Click ID in Payload',    r.shopify.click_id_in_payload);
    add('CustomProfileId',        r.shopify.cli_present);
    add('cli_value',              r.shopify.cli_value);
    add('CustomProfileId Cookie', r.shopify.cli_cookie_name);
    add('CustomerId',             r.shopify.cus_id_present);
    add('Web Pixel',              r.shopify.web_pixel_console);
    add('Consent API',            r.shopify.shopify_consent);
  }

  // 5. Identity
  lines.push('', '=== IDENTITY ===');
  if (r.identity) {
    add('status',      r.identity.status);
    add('lookup_type', r.identity.lookup_type);
    add('attempts',    r.identity.attempts);
    add('consumer_id', r.identity.consumer_id);
    add('pro_node',    r.identity.pro_node);
    add('fpc_node',    r.identity.fpc_node);
    add('cli_node',    r.identity.cli_node);
    if (r.identity.ids)  lines.push('ids:', r.identity.ids);
    if (r.identity.note) add('note', r.identity.note);
  }

  // 6. Cookies + Redirect Chain — reference dumps
  lines.push('', '=== COOKIES ===', r.cookies || 'N/A');
  lines.push('', '=== REDIRECT CHAIN ===', r.redirect_chain || 'N/A');

  // 7. Crawl Notes — last
  if (r.crawl_note) {
    lines.push('', '=== CRAWL NOTES ===', r.crawl_note);
  }

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// COUNTS
// ══════════════════════════════════════════════════════════════════════════════

function updateCounts() {
  const rs = state.results;
  document.getElementById('count-all').textContent     = rs.length;
  document.getElementById('count-utt').textContent     = rs.filter(r => r.integration_type === 'UTT').length;
  document.getElementById('count-shopify').textContent = rs.filter(r => r.integration_type === 'SHOPIFY').length;
  document.getElementById('count-hybrid').textContent  = rs.filter(r => r.integration_type === 'Potential Hybrid Integration').length;
  document.getElementById('count-clickid').textContent = rs.filter(r => r.integration_type === 'ClickId Integration').length;
  document.getElementById('count-unknown').textContent = rs.filter(r => r.integration_type === 'UNKNOWN').length;
  document.getElementById('count-issues').textContent  = rs.filter(r => {
    const isHardIssue = r.captcha_detected || r.navigation_error || r.overall_status === 'FAIL';
    const isSkipIssue = r.overall_status === 'SKIP' && r.integration_type !== 'UNKNOWN';
    return isHardIssue || isSkipIssue;
  }).length;

  // Enable Re-run Issues only when there are issues AND a crawl isn't running
  const issueCount = getRerunCandidates().length;
  const rerunBtn = document.getElementById('rerun-issues-btn');
  if (rerunBtn) {
    rerunBtn.disabled = state.running || issueCount === 0;
    rerunBtn.textContent = issueCount > 0 ? `↻ Re-run Issues (${issueCount})` : '↻ Re-run Issues';
  }
  const wtRerunBtn = document.getElementById('wt-step6-rerun');
  if (wtRerunBtn) {
    wtRerunBtn.disabled = state.running || issueCount === 0;
    wtRerunBtn.textContent = issueCount > 0 ? `↻ Re-run Issues (${issueCount})` : '↻ Re-run Issues';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IDENTITY PROGRESS INDICATOR — pending count in terminal status bar
// ══════════════════════════════════════════════════════════════════════════════

function updateIdentityProgress() {
  const statusEl = document.getElementById('terminal-status');
  if (!statusEl) return;

  // Strip any previous progress badge — keep only the base status text
  const baseText = statusEl.dataset.baseText || statusEl.textContent;
  statusEl.dataset.baseText = baseText;

  const rs = state.results;
  if (!rs.length) {
    statusEl.innerHTML = esc(baseText);
    return;
  }

  // Pending = identity lookup is in flight (status pending/retry) OR has no status yet but should
  const pending = rs.filter(r => {
    const s = r.identity && r.identity.status;
    return s === 'pending' || (typeof s === 'string' && s.startsWith('retry'));
  }).length;

  const resolved = rs.filter(r => {
    const s = r.identity && r.identity.status;
    return s === 'PASS' || s === 'WARN' || s === 'FAIL' || s === 'N/A';
  }).length;

  if (state.running || pending > 0) {
    statusEl.innerHTML = `${esc(baseText)} <span class="identity-progress">Identity: ${resolved}/${rs.length}</span>`;
  } else if (resolved === rs.length && rs.length > 0) {
    statusEl.innerHTML = `${esc(baseText)} <span class="identity-progress complete">Identity: ${resolved}/${rs.length} ✓</span>`;
  } else {
    statusEl.innerHTML = esc(baseText);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// RESET — wipe everything in Quick mode
// ══════════════════════════════════════════════════════════════════════════════

function resetAll() {
  if (state.running) {
    if (!confirm('A crawl is running. Cancel it and reset?')) return;
    try { window.api.cancelCrawl(); } catch {}
  }
  state.results       = [];
  state.parsed        = [];
  state.detailId      = null;
  state.searchQuery   = '';
  state.filter        = 'all';

  // Clear input
  const pasteInput = document.getElementById('paste-input');
  if (pasteInput) pasteInput.value = '';

  // Clear terminal
  const out = document.getElementById('terminal-output');
  if (out) out.innerHTML = '';
  const statusEl = document.getElementById('terminal-status');
  if (statusEl) { statusEl.textContent = ''; delete statusEl.dataset.baseText; }

  // Reset search input
  const searchInput = document.getElementById('results-search');
  if (searchInput) searchInput.value = '';

  // Reset filter tabs to All
  document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
  const allTab = document.querySelector('.filter-tab[data-filter="all"]');
  if (allTab) allTab.classList.add('active');

  // Hide results panel, hide drawer
  document.getElementById('panel-results').classList.add('hidden');
  closeDetail();

  updatePreview('');
  updateCounts();
  renderTable();
}

// ══════════════════════════════════════════════════════════════════════════════
// RE-RUN ISSUES — re-crawl FAIL/SKIP rows, replace in-place
// ══════════════════════════════════════════════════════════════════════════════

function getRerunCandidates() {
  // Hard issues — always re-runnable: FAIL, captcha, navigation error
  // Soft SKIPs — re-run only when integration was detected (UNKNOWN excluded — those need manual review)
  return state.results.filter(r => {
    const isHardIssue = r.captcha_detected || r.navigation_error || r.overall_status === 'FAIL';
    const isSkipIssue = r.overall_status === 'SKIP' && r.integration_type !== 'UNKNOWN';
    return isHardIssue || isSkipIssue;
  });
}

async function rerunIssues() {
  if (state.running) return;
  const candidates = getRerunCandidates();
  if (!candidates.length) return;

  state.running = true;
  document.getElementById('run-btn').classList.add('hidden');
  document.getElementById('cancel-btn').classList.remove('hidden');
  document.getElementById('terminal-status').textContent = `Re-running ${candidates.length} URL${candidates.length !== 1 ? 's' : ''}…`;
  delete document.getElementById('terminal-status').dataset.baseText;
  logLine(`↻ Re-running ${candidates.length} failed/skipped URL${candidates.length !== 1 ? 's' : ''} with current config…`);
  updateCounts();
  saveConfigNow();

  // Build URL list from existing result records — preserve `id` so onResult
  // can find and replace the original row.
  const urls = candidates.map(r => ({
    id:           r.id,
    url:          r.input_url,
    campaignId:   r.campaign_id,
    campaignName: r.campaign_name,
    clickIdParam: r.click_id_param,
  }));

  try {
    const res = await window.api.startCrawl(urls, readConfig());
    if (res && res.error) { logLine('✖ Error: ' + res.error); finishCrawl(); }
  } catch (e) {
    logLine('✖ Fatal: ' + e.message);
    finishCrawl();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PARSE PREVIEW
// ══════════════════════════════════════════════════════════════════════════════

function updatePreview(text) {
  const preview   = document.getElementById('parse-preview');
  const error     = document.getElementById('parse-error');
  const metaEl    = document.getElementById('parse-meta');
  const tbodyEl   = document.getElementById('parse-table-body');
  const runBtn    = document.getElementById('run-btn');

  if (!text || !text.trim()) {
    preview.classList.add('hidden');
    error.classList.add('hidden');
    runBtn.disabled = true;
    state.parsed = [];
    return;
  }

  const { urls, error: err } = parseInput(text);

  if (err || !urls.length) {
    error.textContent = err || 'No valid URLs detected.';
    error.classList.remove('hidden');
    preview.classList.add('hidden');
    runBtn.disabled = true;
    state.parsed = [];
    return;
  }

  error.classList.add('hidden');
  state.parsed = urls;
  runBtn.disabled = false;

  // Meta line
  const params = {};
  urls.forEach(u => { params[u.clickIdParam || 'irclickid'] = (params[u.clickIdParam || 'irclickid'] || 0) + 1; });
  const paramSummary = Object.entries(params).map(([k, v]) => `${v} ${k}`).join(' · ');
  metaEl.textContent = `${urls.length} URL${urls.length > 1 ? 's' : ''} detected · ${paramSummary}`;

  // Table rows
  tbodyEl.innerHTML = urls.slice(0, 20).map(u =>
    `<tr><td>${esc(u.campaignId || '')}</td><td>${esc(u.campaignName || '')}</td><td>${esc(u.url)}</td><td>${esc(u.clickIdParam || '')}</td></tr>`
  ).join('') + (urls.length > 20 ? `<tr><td colspan="4" style="color:var(--text-dim);font-style:italic">…and ${urls.length - 20} more</td></tr>` : '');

  preview.classList.remove('hidden');
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL
// ══════════════════════════════════════════════════════════════════════════════

let terminalAutoScroll = true;

function logLine(msg) {
  const out   = document.getElementById('terminal-output');
  const cls   = msg.includes('✔') || msg.includes('PASS') ? 'log-pass'
              : msg.includes('✖') || msg.includes('error') || msg.includes('Error') ? 'log-error'
              : msg.includes('⚠') || msg.includes('WARN') ? 'log-warn'
              : 'log-line';
  const line  = document.createElement('div');
  line.className = cls;
  line.textContent = msg;
  out.appendChild(line);
  if (terminalAutoScroll) out.scrollTop = out.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════════════════════

// Grouped keys for section headers in CSV/Sheets exports.
// Each group renders a header row, then its columns.
const EXPORT_GROUPS = [
  // Summary — first columns of the table at the front of the export
  {
    label: 'Summary',
    keys: ['campaign_id', 'campaign_name', 'overall_status', 'remediation_note', 'integration_type', 'tracking_link', 'attempts'],
  },
  {
    label: 'General',
    keys: [
      'final_url', 'final_status_code',
      'click_id_in_url', 'click_id', 'click_id_embedded', 'click_id_cookie_names',
      'consent_detected', 'captcha_detected', 'navigation_error',
      'detected_tms', 'brwsr_cookie', 'profile_redirect', 'traffic_guard', 'child_parent_redirect', 'parent_campaign_id', 'redirect_chain',
    ]
  },
  {
    label: 'Universal Tracking Tag',
    keys: [
      'utt.tag_detected', 'utt.identify_call', 'utt.identify_path', 'utt.identify_status',
      'utt.cli_present', 'utt.cli_value', 'utt.cli_cookie_name',
      'utt.cus_id_present', 'utt.cus_id_value', 'utt.cus_id_cookie_name',
      'utt.click_id_in_payload', 'utt.click_id_cookies',
      'utt.ir_field', 'utt.implementation_method',
      'utt.time_to_tag_ms', 'utt.time_to_identify_ms',
    ]
  },
  {
    label: 'Shopify',
    keys: [
      'shopify.pageload_found', 'shopify.pageload_status', 'shopify.time_to_pageload_ms', 'shopify.integration_source',
      'shopify.click_id_in_payload', 'shopify.click_id_cookies',
      'shopify.cli_present', 'shopify.cli_value', 'shopify.cli_cookie_name',
      'shopify.cus_id_present', 'shopify.cus_id_value', 'shopify.cus_id_cookie_name',
      'shopify.first_party_cookie_field', 'shopify.web_pixel_console', 'shopify.shopify_consent',
    ]
  },
  {
    label: 'Identity',
    keys: [
      'identity.status', 'identity.lookup_type', 'identity.attempts', 'identity.endpoint',
      'identity.consumer_id', 'identity.ids',
      'identity.pro_node', 'identity.fpc_node', 'identity.cli_node', 'identity.note',
    ]
  },
  {
    label: 'Cookies',
    keys: ['cookies'],
  },
  {
    label: 'Crawl Notes',
    keys: ['crawl_note'],
  },
];

function flattenResult(r) {
  const get = key => {
    // Special: tracking_link is the exported label for input_url
    if (key === 'tracking_link') return r.input_url || 'N/A';
    const v = getVal(r, key);
    if (v === null || v === undefined) return 'N/A';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  };

  const keys = EXPORT_GROUPS.flatMap(g => g.keys);
  return { keys, values: keys.map(get) };
}

function exportCsv(opts = {}) {
  const rows    = opts.allRows ? state.results : filteredResults();
  if (!rows.length) return;

  const suffix  = opts.suffix ? `_${opts.suffix}` : '';
  const ts      = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(/[\s/:,]/g, '-').replace(/-+/g, '-');

  const escape  = v => { const s = String(v); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s; };

  const groupRow = EXPORT_GROUPS.flatMap(g => [g.label, ...Array(g.keys.length - 1).fill('')]);
  const { keys } = flattenResult(rows[0]);

  const csvRows = [
    groupRow.map(escape).join(','),
    keys.map(escape).join(','),
    ...rows.map(r => flattenResult(r).values.map(escape).join(',')),
  ];

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `tracking-validator-${ts}${suffix}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportSheets() {
  const filtered = filteredResults();
  if (!filtered.length) return;

  const tsvCell  = v => String(v).replace(/\t/g, ' ').replace(/\n/g, ' │ ');

  const groupRow = EXPORT_GROUPS.flatMap(g => [g.label, ...Array(g.keys.length - 1).fill('')]);
  const { keys } = flattenResult(filtered[0]);

  const rows = [
    groupRow.join('\t'),
    keys.join('\t'),
    ...filtered.map(r => flattenResult(r).values.map(tsvCell).join('\t')),
  ];

  navigator.clipboard.writeText(rows.join('\n')).then(() => {
    const btn = document.getElementById('export-sheets-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

async function loadConfig() {
  try {
    const cfg = await window.api.getConfig();
    state.config = cfg;
    document.getElementById('cfg-concurrency').value = cfg.concurrency   ?? 2;
    document.getElementById('cfg-wait').value        = cfg.waitTime      ?? 20000;
    document.getElementById('cfg-retries').value     = cfg.retryCount    ?? 1;
    document.getElementById('cfg-delay').value       = cfg.interUrlDelay ?? 2000;
  } catch { /* API not ready */ }
}

function readConfig() {
  return {
    concurrency:   parseInt(document.getElementById('cfg-concurrency').value) || 2,
    waitTime:      parseInt(document.getElementById('cfg-wait').value)        || 20000,
    retryCount:    parseInt(document.getElementById('cfg-retries').value)     || 1,
    interUrlDelay: parseInt(document.getElementById('cfg-delay').value)       || 2000,
  };
}

function saveConfigNow() {
  try { window.api.setConfig(readConfig()); } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// CRAWL
// ══════════════════════════════════════════════════════════════════════════════

async function startCrawl() {
  if (!state.parsed.length) return;
  state.running = true;
  state.results = [];
  state.detailId = null;
  document.body.classList.add('is-running');    // suppresses heavy animations during crawl

  document.getElementById('run-btn').classList.add('hidden');
  document.getElementById('cancel-btn').classList.remove('hidden');
  document.getElementById('panel-results').classList.remove('hidden');
  document.getElementById('terminal-status').textContent = 'Running…';

  updateCounts();
  renderTable();
  saveConfigNow();

  const urls = state.parsed.map(p => ({
    url:          p.url,
    campaignId:   p.campaignId,
    campaignName: p.campaignName,
    clickIdParam: p.clickIdParam,
  }));

  try {
    const res = await window.api.startCrawl(urls, readConfig());
    if (res.error) { logLine('✖ Error: ' + res.error); finishCrawl(); }
  } catch (e) {
    logLine('✖ Fatal: ' + e.message);
    finishCrawl();
  }
}

function finishCrawl() {
  state.running         = false;
  state.cancelRequested = false;
  document.body.classList.remove('is-running');  // re-enable post-crawl animations
  document.getElementById('run-btn').classList.remove('hidden');
  const cancelBtn = document.getElementById('cancel-btn');
  cancelBtn.classList.add('hidden');
  cancelBtn.textContent = 'Cancel';
  const statusEl = document.getElementById('terminal-status');
  statusEl.textContent = `Done — ${state.results.length} URL${state.results.length !== 1 ? 's' : ''}`;
  delete statusEl.dataset.baseText;
  updateCounts();             // re-evaluate rerun button enabled state
  updateIdentityProgress();   // refresh progress badge
  maybeAdvanceToStep6();      // advance walkthrough if everything is done
}

// Debounced renderTable — batches rapid updates during crawl/identity enrichment.
// Immediate re-render happens on the first call; further calls within 80ms are
// coalesced so a burst of identity updates doesn't re-render dozens of times.
let _renderPending = false;
let _renderTimer   = null;
function renderTableDebounced() {
  if (!_renderPending) {
    _renderPending = true;
    renderTable();                       // immediate first paint
  }
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    _renderPending = false;
    renderTable();                       // trailing paint after burst settles
  }, 80);
}
// ══════════════════════════════════════════════════════════════════════════════

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  localStorage.setItem('tv-mode', mode);

  // Update toggle button visuals
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  if (mode === 'walkthrough') {
    // Switching INTO walkthrough — go to current step (or step 1 if not set)
    goToStep(state.guidedStep || 1);
  } else {
    // Switching INTO workbench — clear step marker so panels show correctly
    document.body.removeAttribute('data-step');
  }
}

function goToStep(n) {
  state.guidedStep = n;
  document.body.dataset.step = String(n);

  // Show only the active step
  document.querySelectorAll('.guided-step').forEach(el => {
    el.classList.toggle('hidden', el.dataset.step !== String(n));
  });

  // Step-entry side effects
  if (n === 2) {
    // Substitute campaign IDs into SQL
    const sql = SQL_QUERY.replace('{campaign_id}', state.campaignIds.join(', '));
    document.getElementById('wt-sql-code').innerHTML = highlightSql(sql);
  }

  if (n === 4) {
    // Populate verify preview from state.parsed
    renderWalkthroughPreview();
    syncConfigToWalkthrough();
  }

  // Steps 5 & 6 — terminal + results need to be visible
  if (n === 5 || n === 6) {
    document.getElementById('panel-terminal').classList.remove('hidden');
    document.getElementById('panel-results').classList.remove('hidden');
  }
}

// ── Step 1 — Campaign ID validation ─────────────────────────────────────────

function parseCampaignIds(text) {
  if (!text || !text.trim()) return { ids: [], error: null };
  // Accept comma or newline separated. Strip whitespace, filter empties.
  const tokens = text.split(/[,\n]/).map(t => t.trim()).filter(Boolean);
  const invalid = tokens.filter(t => !/^\d+$/.test(t));
  if (invalid.length > 0) {
    return { ids: [], error: `Invalid campaign ID: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}. IDs must be numeric.` };
  }
  // Deduplicate
  const ids = [...new Set(tokens)];
  return { ids, error: null };
}

function updateStep1(text) {
  const { ids, error } = parseCampaignIds(text);
  const meta = document.getElementById('wt-step1-meta');
  const nextBtn = document.getElementById('wt-step1-next');

  if (error) {
    meta.textContent = error;
    meta.classList.add('error');
    nextBtn.disabled = true;
    state.campaignIds = [];
    return;
  }

  meta.classList.remove('error');
  if (ids.length === 0) {
    meta.textContent = '';
    nextBtn.disabled = true;
    state.campaignIds = [];
  } else {
    meta.textContent = `${ids.length} campaign ID${ids.length !== 1 ? 's' : ''} detected`;
    nextBtn.disabled = false;
    state.campaignIds = ids;
  }
}

// ── Step 3 — walkthrough-specific input handling ────────────────────────────

function updateWalkthroughPreview(text) {
  const errorEl = document.getElementById('wt-parse-error');
  const metaEl  = document.getElementById('wt-step3-meta');
  const nextBtn = document.getElementById('wt-step3-next');

  if (!text || !text.trim()) {
    errorEl.classList.add('hidden');
    metaEl.textContent = '';
    nextBtn.disabled = true;
    state.parsed = [];
    return;
  }

  const { urls, error } = parseInput(text);

  if (error || !urls.length) {
    errorEl.textContent = error || 'No valid URLs detected.';
    errorEl.classList.remove('hidden');
    metaEl.textContent = '';
    nextBtn.disabled = true;
    state.parsed = [];
    return;
  }

  errorEl.classList.add('hidden');
  state.parsed = urls;
  metaEl.textContent = `${urls.length} URL${urls.length !== 1 ? 's' : ''} detected`;
  nextBtn.disabled = false;

  // Also keep workbench preview in sync so switching modes mid-flow works
  const workbenchPaste = document.getElementById('paste-input');
  if (workbenchPaste && workbenchPaste.value !== text) workbenchPaste.value = text;
  updatePreview(text);
}

// ── Step 4 — verify preview and config sync ─────────────────────────────────

function renderWalkthroughPreview() {
  const metaEl  = document.getElementById('wt-parse-meta');
  const tbodyEl = document.getElementById('wt-parse-table-body');
  const urls    = state.parsed;
  if (!urls.length) return;

  // Meta line — count + click ID param summary
  const params = {};
  urls.forEach(u => {
    const k = u.clickIdParam || 'irclickid';
    params[k] = (params[k] || 0) + 1;
  });
  const paramSummary = Object.entries(params).map(([k, v]) => `${v} ${k}`).join(' · ');
  metaEl.textContent = `${urls.length} URL${urls.length !== 1 ? 's' : ''} ready · ${paramSummary}`;

  tbodyEl.innerHTML = urls.slice(0, 20).map(u =>
    `<tr><td>${esc(u.campaignId || '')}</td><td>${esc(u.campaignName || '')}</td><td>${esc(u.url)}</td><td>${esc(u.clickIdParam || '')}</td></tr>`
  ).join('') + (urls.length > 20 ? `<tr><td colspan="4" style="color:var(--text-dim);font-style:italic">…and ${urls.length - 20} more</td></tr>` : '');
}

function syncConfigToWalkthrough() {
  // Copy values from workbench config inputs into walkthrough config inputs.
  // Both sets are wired with bidirectional listeners so they stay in sync.
  ['concurrency','wait','retries','delay'].forEach(field => {
    const wb = document.getElementById(`cfg-${field}`);
    const wt = document.getElementById(`wt-cfg-${field}`);
    if (wb && wt) wt.value = wb.value;
  });
}

function syncConfigFromWalkthrough() {
  ['concurrency','wait','retries','delay'].forEach(field => {
    const wb = document.getElementById(`cfg-${field}`);
    const wt = document.getElementById(`wt-cfg-${field}`);
    if (wb && wt) wb.value = wt.value;
  });
}

// ── Step 5 → 6 transition: check if everything is complete ──────────────────

function maybeAdvanceToStep6() {
  if (state.mode !== 'walkthrough') return;
  if (state.guidedStep !== 5)       return;
  if (state.running)                return;
  if (state.results.length === 0)   return;

  // All identity lookups resolved? Results with no identity object or no status
  // never entered the queue (e.g. CAPTCHA skips) — treat them as done.
  const allDone = state.results.every(r => {
    const s = r.identity && r.identity.status;
    // No status set, or result never entered identity queue — counts as done
    if (!s) return true;
    // CAPTCHA and navigation error results will never have identity resolved —
    // their status stays PENDING forever. Treat them as done.
    if (s === STATUS_PENDING && (r.captcha_detected || r.navigation_error)) return true;
    return s === 'PASS' || s === 'WARN' || s === 'FAIL' || s === 'N/A';
  });

  if (allDone) {
    goToStep(6);
    if (!state.autoDownloaded) {
      state.autoDownloaded = true;
      const suffix = state.identityStopped ? 'partial' : 'complete';
      setTimeout(() => {
        exportCsv({ allRows: true, suffix });
        const msg = document.getElementById('wt-step6-message');
        if (msg) msg.textContent = state.identityStopped
          ? 'Identity enrichment was stopped. CSV downloaded with available data.'
          : 'CSV downloaded.';
      }, 300);
    }
  }
}

// ── Restart walkthrough (Start Over) ────────────────────────────────────────

function walkthroughRestart() {
  resetAll();
  state.campaignIds    = [];
  state.autoDownloaded = false;
  state.identityStopped = false;
  // Clear walkthrough inputs
  const ci = document.getElementById('wt-campaign-input');
  if (ci) ci.value = '';
  const pi = document.getElementById('wt-paste-input');
  if (pi) pi.value = '';
  document.getElementById('wt-step1-meta').textContent = '';
  document.getElementById('wt-step3-meta').textContent = '';
  document.getElementById('wt-parse-error').classList.add('hidden');
  document.getElementById('wt-step1-next').disabled = true;
  document.getElementById('wt-step3-next').disabled = true;
  // Reset step 3 input mode to Upload CSV (the default)
  document.querySelectorAll('[data-wt-mode]').forEach(b => b.classList.remove('active'));
  const wtFileBtn = document.querySelector('[data-wt-mode="file"]');
  if (wtFileBtn) wtFileBtn.classList.add('active');
  document.querySelectorAll('.wt-input-pane').forEach(p => p.classList.add('hidden'));
  const wtFilePane = document.getElementById('wt-mode-file');
  if (wtFilePane) wtFilePane.classList.remove('hidden');
  goToStep(1);
}



document.addEventListener('DOMContentLoaded', async () => {
  // Signal main process immediately — triggers update check after 1s delay.
  // Don't hold this until end of init; it's independent of UI setup.
  window.api.rendererReady();

  // ── IPC listeners ──────────────────────────────────────────────────────────
  window.api.onLog(msg => logLine(msg));

  window.api.onResult(result => {
    // Engine doesn't propagate campaign_name onto the result — patch it back
    // in from the parsed input by matching on input URL.
    if (!result.campaign_name) {
      const parsed = state.parsed.find(p => p.url === result.input_url);
      if (parsed && parsed.campaignName) result.campaign_name = parsed.campaignName;
    }
    result.remediation_note = computeRemediation(result);
    // Replace-in-place if this id already exists (re-run case), else push.
    // Re-runs always replace the full record. A single [re-run] marker is
    // added to crawl_note so the user can tell, but no chain accumulation
    // across multiple re-runs of the same row.
    const existing = state.results.findIndex(r => r.id === result.id);
    if (existing >= 0) {
      // Preserve campaign_name across re-runs if the new result lacks it
      if (!result.campaign_name && state.results[existing].campaign_name) {
        result.campaign_name = state.results[existing].campaign_name;
      }
      const newNote = result.crawl_note || '';
      result.crawl_note = newNote ? `[re-run] ${newNote}` : '[re-run]';
      result.remediation_note = computeRemediation(result);
      state.results[existing] = result;
    } else {
      state.results.push(result);
    }
    updateCounts();
    updateIdentityProgress();
    renderTableDebounced();
  });

  window.api.onDone(() => {
    logLine('✔ Crawl complete. Identity enrichment running in background…');
    finishCrawl();
  });

  window.api.onIdentityUpdate((id, update) => {
    const r = state.results.find(x => x.id === id);
    if (r) {
      Object.assign(r.identity, update);
      r.remediation_note = computeRemediation(r);
      updateIdentityProgress();
      renderTableDebounced();
      if (state.detailId === id) renderDrawer();
      maybeAdvanceToStep6();
    }
  });

  window.api.onIdentityDone(() => {
    logLine('✔ All identity lookups resolved.');
    const statusEl = document.getElementById('terminal-status');
    statusEl.textContent = 'Complete';
    delete statusEl.dataset.baseText;
    updateIdentityProgress();
    maybeAdvanceToStep6();
  });

  // ── Config ─────────────────────────────────────────────────────────────────
  // Fire without await — config populates via IPC shortly after; HTML defaults cover the gap.
  loadConfig();

  // Save config on blur
  ['cfg-concurrency','cfg-wait','cfg-retries','cfg-delay'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveConfigNow);
  });

  // ── Tab navigation ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  // ── Input mode toggle (workbench panel only) ─────────────────────────────
  // Scoped to .input-mode-toggle so we don't grab walkthrough buttons,
  // which share the .mode-btn class but use data-wt-mode and a different DOM tree.
  document.querySelectorAll('.input-mode-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.input-mode-toggle .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.input-mode-pane').forEach(p => p.classList.add('hidden'));
      const pane = document.getElementById('mode-' + btn.dataset.mode);
      if (pane) pane.classList.remove('hidden');
    });
  });

  // ── Paste input ─────────────────────────────────────────────────────────────
  const pasteInput = document.getElementById('paste-input');
  let parseTimer;
  pasteInput.addEventListener('input', () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => updatePreview(pasteInput.value), 300);
  });

  // ── File upload ─────────────────────────────────────────────────────────────
  document.getElementById('file-browse-btn').addEventListener('click', async () => {
    const content = await window.api.openCsv();
    if (content) updatePreview(content);
  });

  const dropZone = document.getElementById('file-drop-zone');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) { const r = new FileReader(); r.onload = ev => updatePreview(ev.target.result); r.readAsText(file); }
  });

  // ── Run / Cancel ────────────────────────────────────────────────────────────
  document.getElementById('run-btn').addEventListener('click', startCrawl);
  document.getElementById('cancel-btn').addEventListener('click', () => {
    if (state.cancelRequested) {
      // Second click — force-reset UI state. Backend may still be cleaning up
      // but at least the user can start a new crawl.
      logLine('⚠ Force-resetting UI state. Backend may still be running in background.');
      window.api.cancelCrawl();  // best-effort
      finishCrawl();
      state.cancelRequested = false;
    } else {
      window.api.cancelCrawl();
      state.cancelRequested = true;
      logLine('⚠ Cancellation requested. Click Cancel again to force-reset.');
      // Update button text to indicate the next click is more forceful
      const btn = document.getElementById('cancel-btn');
      btn.textContent = 'Force Reset';
    }
  });

  // ── Filter tabs ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderTable();
    });
  });

  // ── Export ──────────────────────────────────────────────────────────────────
  document.getElementById('export-csv-btn').addEventListener('click', exportCsv);
  document.getElementById('export-sheets-btn').addEventListener('click', exportSheets);

  // ── Reset / Re-run Issues ───────────────────────────────────────────────────
  document.getElementById('rerun-issues-btn').addEventListener('click', rerunIssues);
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (state.results.length === 0 && !state.running) {
      // Nothing to reset — still confirm if input has content
      const pasteInput = document.getElementById('paste-input');
      if (pasteInput && !pasteInput.value.trim()) return;
    }
    resetAll();
  });

  // ── SQL Modal ────────────────────────────────────────────────────────────────
  document.getElementById('sql-code').innerHTML = highlightSql(SQL_QUERY);

  document.getElementById('sql-btn').addEventListener('click', () => {
    document.getElementById('sql-modal').classList.remove('hidden');
  });
  document.getElementById('sql-modal-close').addEventListener('click', () => {
    document.getElementById('sql-modal').classList.add('hidden');
  });
  document.getElementById('sql-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  document.getElementById('sql-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(SQL_QUERY).then(() => {
      const btn = document.getElementById('sql-copy-btn');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });

  // ── Terminal collapse ────────────────────────────────────────────────────────
  document.getElementById('terminal-header').addEventListener('click', e => {
    if (e.target.closest('#terminal-clear')) return;
    document.getElementById('panel-terminal').classList.toggle('collapsed');
  });
  document.getElementById('terminal-clear').addEventListener('click', e => {
    e.stopPropagation();
    const out = document.getElementById('terminal-output');
    state.terminalBackup = out.innerHTML;  // save for undo
    out.innerHTML = '';
    document.getElementById('terminal-undo').classList.add('visible');
  });

  document.getElementById('terminal-undo').addEventListener('click', e => {
    e.stopPropagation();
    const out = document.getElementById('terminal-output');
    if (state.terminalBackup) {
      out.innerHTML = state.terminalBackup;
      state.terminalBackup = null;
      out.scrollTop = out.scrollHeight;
    }
    document.getElementById('terminal-undo').classList.remove('visible');
  });

  // ── Input clear / undo ──────────────────────────────────────────────────────
  document.getElementById('input-clear').addEventListener('click', () => {
    const ta = document.getElementById('paste-input');
    if (!ta.value) return;
    state.inputBackup = ta.value;
    ta.value = '';
    updatePreview('');
    document.getElementById('input-undo').classList.remove('hidden');
  });

  document.getElementById('input-undo').addEventListener('click', () => {
    if (!state.inputBackup) return;
    const ta = document.getElementById('paste-input');
    ta.value = state.inputBackup;
    state.inputBackup = null;
    updatePreview(ta.value);
    document.getElementById('input-undo').classList.add('hidden');
  });

  // ── Detail drawer ───────────────────────────────────────────────────────────
  document.getElementById('drawer-close').addEventListener('click', closeDetail);
  document.getElementById('drawer-overlay').addEventListener('click', closeDetail);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.detailId) closeDetail();
  });

  // Drawer expand toggle
  document.getElementById('drawer-expand').addEventListener('click', () => {
    state.drawerWide = !state.drawerWide;
    const drawer = document.getElementById('detail-drawer');
    drawer.classList.toggle('wide', state.drawerWide);
    document.getElementById('drawer-expand').textContent = state.drawerWide ? '⇥ Shrink' : '⇤ Expand';
  });

  // Terminal expand toggle
  document.getElementById('terminal-expand').addEventListener('click', e => {
    e.stopPropagation();
    const panel = document.getElementById('panel-terminal');
    state.terminalExpanded = !state.terminalExpanded;
    // Mutually exclusive: expanding clears collapsed, collapsing clears expanded
    panel.classList.toggle('expanded', state.terminalExpanded);
    if (state.terminalExpanded) panel.classList.remove('collapsed');
    e.target.textContent = state.terminalExpanded ? '⤡' : '⤢';
    e.target.title       = state.terminalExpanded ? 'Collapse to default size' : 'Expand terminal';
  });

  // ── Search input ────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('results-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      renderTable();
    });
  }

  // ── Custom tooltip — reliable hover bubble, replaces native title ──────────
  initTooltips();

  // ── Walkthrough mode ────────────────────────────────────────────────────────

  // Mode toggle
  document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Step 1 — campaign IDs input
  const wtCampaignInput = document.getElementById('wt-campaign-input');
  if (wtCampaignInput) {
    wtCampaignInput.addEventListener('input', () => updateStep1(wtCampaignInput.value));
  }
  document.getElementById('wt-step1-next').addEventListener('click', () => goToStep(2));

  // Step 2 — SQL panel
  document.getElementById('wt-step2-back').addEventListener('click', () => goToStep(1));
  document.getElementById('wt-step2-next').addEventListener('click', () => goToStep(3));
  document.getElementById('wt-sql-copy').addEventListener('click', () => {
    const sql = SQL_QUERY.replace('{campaign_id}', state.campaignIds.join(', '));
    navigator.clipboard.writeText(sql).then(() => {
      const btn = document.getElementById('wt-sql-copy');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });

  // Step 3 — paste/upload toggle
  document.querySelectorAll('[data-wt-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-wt-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.wt-input-pane').forEach(p => p.classList.add('hidden'));
      document.getElementById('wt-mode-' + btn.dataset.wtMode).classList.remove('hidden');
    });
  });

  // Step 3 — paste input
  const wtPasteInput = document.getElementById('wt-paste-input');
  let wtParseTimer;
  if (wtPasteInput) {
    wtPasteInput.addEventListener('input', () => {
      clearTimeout(wtParseTimer);
      wtParseTimer = setTimeout(() => updateWalkthroughPreview(wtPasteInput.value), 300);
    });
  }

  // Switches to Paste/Type tab and briefly flashes the textarea green so the
  // user sees their file contents and knows parsing succeeded.
  function switchToWtPasteView(content) {
    wtPasteInput.value = content;
    // Activate the Paste/Type tab
    document.querySelectorAll('[data-wt-mode]').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-wt-mode="paste"]').classList.add('active');
    document.querySelectorAll('.wt-input-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById('wt-mode-paste').classList.remove('hidden');
    // Brief green border flash so the transition catches the eye
    wtPasteInput.style.transition = 'border-color 0.15s';
    wtPasteInput.style.borderColor = 'var(--accent)';
    setTimeout(() => { wtPasteInput.style.borderColor = ''; }, 1200);
    // Trigger parse
    updateWalkthroughPreview(content);
  }

  // Step 3 — file upload
  document.getElementById('wt-file-browse-btn').addEventListener('click', async () => {
    const content = await window.api.openCsv();
    if (content) switchToWtPasteView(content);
  });

  const wtDropZone = document.getElementById('wt-file-drop-zone');
  wtDropZone.addEventListener('dragover',  e => { e.preventDefault(); wtDropZone.classList.add('drag-over'); });
  wtDropZone.addEventListener('dragleave', () => wtDropZone.classList.remove('drag-over'));
  wtDropZone.addEventListener('drop', e => {
    e.preventDefault();
    wtDropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) {
      const r = new FileReader();
      r.onload = ev => switchToWtPasteView(ev.target.result);
      r.readAsText(file);
    }
  });

  document.getElementById('wt-step3-back').addEventListener('click', () => goToStep(2));
  document.getElementById('wt-step3-next').addEventListener('click', () => goToStep(4));

  // Step 4 — config inputs sync with workbench
  ['concurrency','wait','retries','delay'].forEach(field => {
    const wt = document.getElementById(`wt-cfg-${field}`);
    const wb = document.getElementById(`cfg-${field}`);
    if (wt && wb) {
      wt.addEventListener('input',  () => { wb.value = wt.value; });
      wt.addEventListener('change', () => { wb.value = wt.value; saveConfigNow(); });
      wb.addEventListener('input',  () => { wt.value = wb.value; });
    }
  });

  document.getElementById('wt-step4-back').addEventListener('click', () => goToStep(3));
  document.getElementById('wt-step4-run').addEventListener('click', () => {
    state.autoDownloaded = false;
    goToStep(5);
    startCrawl();
  });

  // Step 5 — cancel crawl
  document.getElementById('wt-step5-cancel').addEventListener('click', () => {
    window.api.cancelCrawl();
    state.cancelRequested = true;
    logLine('⚠ Cancellation requested.');
  });

  // Step 5 — stop identity enrichment
  document.getElementById('wt-step5-stop-identity').addEventListener('click', async () => {
    state.identityStopped = true;
    document.getElementById('wt-step5-stop-identity').disabled = true;
    document.getElementById('wt-step5-stop-identity').textContent = 'Stopping…';
    logLine('⚠ Stopping identity enrichment — downloading CSV with available data…');
    await window.api.stopIdentity();
    // Force advance — identity done IPC may not fire now that queue is drained
    state.running = false;
    state.results.forEach(r => {
      if (!r.identity || (r.identity.status !== 'PASS' && r.identity.status !== 'WARN' && r.identity.status !== 'FAIL')) {
        if (r.identity) r.identity.status = 'N/A';
      }
    });
    maybeAdvanceToStep6();
  });

  // Step 6 — re-run / restart
  document.getElementById('wt-step6-rerun').addEventListener('click', () => {
    state.autoDownloaded = false;
    goToStep(5);
    rerunIssues();
  });
  document.getElementById('wt-step6-restart').addEventListener('click', walkthroughRestart);

  // Initial mode from localStorage — default is walkthrough
  const savedMode = localStorage.getItem('tv-mode') || 'walkthrough';
  setMode(savedMode);


  const THEME_CYCLE = ['dark', 'warm', 'light'];
  const THEME_ICON  = { dark: '◐', warm: '◑', light: '☀' };
  const THEME_NEXT_LABEL = { dark: 'warm', warm: 'light', light: 'dark' };

  const savedTheme = localStorage.getItem('tv-theme') || 'dark';
  document.documentElement.dataset.theme = savedTheme;
  state.theme = savedTheme;

  const themeBtn = document.getElementById('theme-toggle');
  function refreshThemeButton() {
    themeBtn.textContent = THEME_ICON[state.theme] || '◐';
    themeBtn.title = `Theme: ${state.theme} — click for ${THEME_NEXT_LABEL[state.theme]}`;
  }
  refreshThemeButton();

  themeBtn.addEventListener('click', () => {
    const idx  = THEME_CYCLE.indexOf(state.theme);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    state.theme = next;
    document.documentElement.dataset.theme = next;
    localStorage.setItem('tv-theme', next);
    refreshThemeButton();
  });

  // ── Update notification ──────────────────────────────────────────────────────
  window.api.onUpdateAvailable(({ version, url }) => {
    const pill = document.getElementById('update-pill');
    pill.textContent = `⬆ v${version} available`;
    pill.classList.remove('hidden');
    pill.addEventListener('click', e => {
      e.preventDefault();
      window.api.openExternal(url);
    });
  });

  // ── App version ──────────────────────────────────────────────────────────────
  window.api.getVersion().then(v => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${v}`;
  }).catch(() => {});

  // ── Events link — Event Repository ─────────────────────────────
  const EVENTS_BASE = 'https://er-api.gcp.srv-impact.net/events.html?id=';
  document.addEventListener('click', e => {
    const btn = e.target.closest('.events-btn');
    if (btn) {
      e.stopPropagation();
      window.api.openExternal(EVENTS_BASE + encodeURIComponent(btn.dataset.eid));
    }
  });

  ['hub-link'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => {
      e.preventDefault();
      window.api.openExternal('https://fastshoes.co.za/scott/tools/');
    });
  });
  const dlLink = document.getElementById('hub-page-link');
  if (dlLink) dlLink.addEventListener('click', e => {
    e.preventDefault();
    window.api.openExternal('https://fastshoes.co.za/scott/tools/tracking_validator/');
  });

});