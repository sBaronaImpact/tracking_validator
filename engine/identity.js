'use strict';

const { STATUS, INTEGRATION_TYPE } = require('./result');
const { extractIrPiProfileId }     = require('./checks/cookies');

const IDENTITY_ENDPOINT = 'https://identity.gcp.srv-impact.net/identityServiceMulti';
const MAX_ATTEMPTS      = 7;
const RETRY_INTERVAL_MS = 60_000;

function buildEndpoint(campaign_id, lookupValue, lookupType) {
  const id = encodeURIComponent(`${lookupValue}${lookupType}`);
  return `${IDENTITY_ENDPOINT}?campaignId=${campaign_id}&ruleSet=campaign&lookupIds=${id}`;
}

function determineLookupStrategy(result) {
  const type = result.integration_type;

  if (type === INTEGRATION_TYPE.UTT || type === INTEGRATION_TYPE.HYBRID) {
    const irPi = result._raw?.ir_pi;
    if (!irPi?.value) return null;
    const profileId = extractIrPiProfileId(irPi.value);
    if (!profileId) return null;
    return { value: profileId, type: '_PRO' };
  }

  if (type === INTEGRATION_TYPE.SHOPIFY) {
    const cpid = result.shopify?.cli_value;
    if (!cpid) return null;
    return { value: cpid, type: '_CLI' };
  }

  return null;
}

async function fetchIdentity(endpoint) {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseResponse(data, campaign_id) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const record = data[0];
  const ids    = Array.isArray(record.ids) ? record.ids : [];
  return {
    consumer_id: record.impactConsumerId || null,
    ids:         ids.join('\n'),   // newline-separated string
    cli_node:    ids.some(id => id.endsWith(`_CLI${campaign_id}`)),
    fpc_node:    ids.some(id => id.endsWith(`_FPC${campaign_id}`)),
    pro_node:    ids.some(id => id.endsWith(`_PRO${campaign_id}`)),
  };
}

class IdentityQueue {
  constructor(onUpdate, onQueueDrained) {
    this.onUpdate       = onUpdate;
    this.onQueueDrained = onQueueDrained || null;
    this.queue          = [];
    this.running        = false;
    this._pending       = 0;
    this._finalized     = false;
  }

  finalize() {
    this._finalized = true;
    this._checkDrained();
  }

  enqueue(result) {
    this._pending++;
    const strategy = determineLookupStrategy(result);

    if (!strategy) {
      this.onUpdate(result.id, {
        status:   STATUS.NA,
        attempts: 0,
        note:     this._naReason(result),
      });
      this._resolve();
      return;
    }

    const endpoint = buildEndpoint(result.campaign_id, strategy.value, strategy.type);
    this.queue.push({
      resultId:    result.id,
      campaign_id: result.campaign_id,
      endpoint,
      lookup_value: strategy.value,
      lookup_type:  strategy.type,
      attempts:    0,
    });

    if (!this.running) this._drain();
  }

  _naReason(result) {
    const type = result.integration_type;
    if (type === INTEGRATION_TYPE.UTT || type === INTEGRATION_TYPE.HYBRID)
      return 'IR_PI cookie not found — identity enrichment skipped';
    if (type === INTEGRATION_TYPE.SHOPIFY)
      return 'cli_value not found in PageLoad payload — identity enrichment skipped';
    return 'Integration type unknown — identity enrichment skipped';
  }

  _resolve() {
    this._pending--;
    this._checkDrained();
  }

  _checkDrained() {
    if (this._finalized && this._pending <= 0 && !this.running && this.onQueueDrained) {
      this.onQueueDrained();
    }
  }

  async _drain() {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      await this._process(item);
    }
    this.running = false;
    this._checkDrained();
  }

  async _process(item) {
    item.attempts++;
    this.onUpdate(item.resultId, {
      status:       'pending',
      attempts:     item.attempts,
      lookup_value: item.lookup_value,
      lookup_type:  item.lookup_type,
      endpoint:     item.endpoint,
      note:         item.attempts === 1
        ? 'Identity enrichment in progress — results update as data becomes available'
        : `Retrying (${item.attempts}/${MAX_ATTEMPTS}) — allow up to 1 minute`,
    });

    try {
      const data   = await fetchIdentity(item.endpoint);
      const parsed = parseResponse(data, item.campaign_id);

      if (parsed) {
        this.onUpdate(item.resultId, {
          status:       'PASS',  // explicit string — identity.status is a process state, not a check result
          attempts:     item.attempts,
          lookup_value: item.lookup_value,
          lookup_type:  item.lookup_type,
          endpoint:     item.endpoint,
          ...parsed,
          note: null,
        });
        this._resolve();
        return;
      }
      await this._scheduleRetry(item, null);
    } catch (error) {
      await this._scheduleRetry(item, error);
    }
  }

  async _scheduleRetry(item, error) {
    if (item.attempts < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
      this.queue.unshift(item);
    } else {
      this.onUpdate(item.resultId, {
        status:       error ? 'FAIL' : 'WARN',
        attempts:     item.attempts,
        lookup_value: item.lookup_value,
        lookup_type:  item.lookup_type,
        endpoint:     item.endpoint,
        note:         error
          ? `Identity lookup failed after ${MAX_ATTEMPTS} attempts: ${error.message}`
          : `Identity not found after ${MAX_ATTEMPTS} attempts — may indicate a stitching issue or timing delay.`,
      });
      this._resolve();
    }
  }
}

module.exports = { IdentityQueue, buildEndpoint, determineLookupStrategy };
