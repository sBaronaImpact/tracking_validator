'use strict';

const { STATUS, INTEGRATION_TYPE } = require('./result');
const { extractIrPiProfileId }     = require('./checks/cookies');

const IDENTITY_ENDPOINT = 'https://identity.gcp.srv-impact.net/identityServiceMulti';
const MAX_ATTEMPTS      = 10;
const RETRY_INTERVAL_MS = 30_000;
const CONCURRENCY       = 15;  // Parallel identity lookups in flight at once.

function buildEndpoint(campaign_id, lookupValue, lookupType) {
  const id = encodeURIComponent(`${lookupValue}${lookupType}`);
  return `${IDENTITY_ENDPOINT}?campaignId=${campaign_id}&ruleSet=campaign&lookupIds=${id}`;
}

function determineLookupStrategy(result) {
  const type = result.integration_type;

  if (type === INTEGRATION_TYPE.UTT || type === INTEGRATION_TYPE.HYBRID) {
    const irPi      = result._raw?.ir_pi;
    const profileId = irPi?.value ? extractIrPiProfileId(irPi.value) : null;
    const cliValue  = result.utt?.cli_value || null;

    if (profileId) {
      // Primary: PRO lookup via IR_PI. Fallback to CLI if a CustomProfileId value is available.
      return { value: profileId, type: '_PRO', fallback: cliValue ? { value: cliValue, type: '_CLI' } : null };
    }
    if (cliValue) {
      // No IR_PI — use CLI directly
      return { value: cliValue, type: '_CLI', fallback: null };
    }
    return null;
  }

  if (type === INTEGRATION_TYPE.SHOPIFY) {
    const cpid = result.shopify?.cli_value;
    if (!cpid) return null;
    return { value: cpid, type: '_CLI', fallback: null };
  }

  if (type === INTEGRATION_TYPE.PAGELOADAPI) {
    // Use CustomProfileId from the PLA payload for CLI lookup
    const cpid = result.pla_payload?.CustomProfileId || result.pla_payload?.customProfileId || null;
    if (!cpid) return null;
    return { value: cpid, type: '_CLI', fallback: null };
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
    ids:         ids.join('\n'),
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
    this.workers        = 0;
    this._pending       = 0;
    this._finalized     = false;
    this._stopped       = false;
  }

  /**
   * User-initiated stop. Drains all pending items immediately with a "stopped"
   * status. Items currently in-flight (awaiting fetch or in retry sleep) will
   * notice the flag on their next await checkpoint and terminate.
   */
  stop() {
    if (this._stopped) return;
    this._stopped = true;

    // Terminate all items still in the queue immediately
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      this._terminateAsStopped(item);
    }
    // In-flight items will hit a checkpoint and self-terminate
  }

  finalize() {
    this._finalized = true;
    this._checkDrained();
  }

  enqueue(result) {
    if (this._stopped) {
      // Lookups arriving after stop go straight to N/A
      this.onUpdate(result.id, {
        status: STATUS.NA,
        attempts: 0,
        note: 'Identity enrichment stopped by user',
      });
      return;
    }

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
      fallback:    strategy.fallback || null,
    });

    this._startWorkers();
  }

  _naReason(result) {
    const type = result.integration_type;
    if (type === INTEGRATION_TYPE.UTT || type === INTEGRATION_TYPE.HYBRID)
      return 'IR_PI cookie and CustomProfileId (CLI) not found — identity enrichment skipped';
    if (type === INTEGRATION_TYPE.SHOPIFY)
      return 'cli_value not found in PageLoad payload — identity enrichment skipped';
    if (type === INTEGRATION_TYPE.PAGELOADAPI)
      return 'CustomProfileId not found in PLA payload — identity enrichment skipped';
    return 'Integration type unknown — identity enrichment skipped';
  }

  _terminateAsStopped(item) {
    this.onUpdate(item.resultId, {
      status:       STATUS.NA,
      attempts:     item.attempts,
      lookup_value: item.lookup_value,
      lookup_type:  item.lookup_type,
      endpoint:     item.endpoint,
      note:         'Identity enrichment stopped by user',
    });
    this._resolve();
  }

  _resolve() {
    this._pending--;
    this._checkDrained();
  }

  _checkDrained() {
    if (this._finalized && this._pending <= 0 && this.workers === 0 && this.onQueueDrained) {
      this.onQueueDrained();
    }
  }

  _startWorkers() {
    while (this.workers < CONCURRENCY && this.queue.length > 0) {
      this.workers++;
      this._worker();
    }
  }

  async _worker() {
    try {
      while (!this._stopped) {
        const item = this.queue.shift();
        if (!item) {
          // Queue is empty. If fully finalized with nothing pending, we're done.
          if (this._finalized && this._pending === 0) break;
          // Otherwise exit this worker — _startWorkers() will spawn a fresh one
          // when new work arrives via _scheduleRetry. Avoids accumulating idle
          // polling workers that burn CPU indefinitely.
          break;
        }
        if (this._stopped) {
          this._terminateAsStopped(item);
          continue;
        }
        await this._process(item);
      }
    } finally {
      this.workers--;
      this._checkDrained();
    }
  }

  async _process(item) {
    if (this._stopped) { this._terminateAsStopped(item); return; }

    item.attempts++;
    this.onUpdate(item.resultId, {
      status:       'pending',
      attempts:     item.attempts,
      lookup_value: item.lookup_value,
      lookup_type:  item.lookup_type,
      endpoint:     item.endpoint,
      note:         item.attempts === 1
        ? 'Identity enrichment in progress — results update as data becomes available'
        : `Retrying (${item.attempts}/${MAX_ATTEMPTS}) — 30s between attempts`,
    });

    try {
      const data = await fetchIdentity(item.endpoint);
      if (this._stopped) { this._terminateAsStopped(item); return; }
      const parsed = parseResponse(data, item.campaign_id);

      if (parsed) {
        this.onUpdate(item.resultId, {
          status:       'PASS',
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
      if (this._stopped) { this._terminateAsStopped(item); return; }
      await this._scheduleRetry(item, error);
    }
  }

  async _scheduleRetry(item, error) {
    if (this._stopped) { this._terminateAsStopped(item); return; }

    if (item.attempts < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
      if (this._stopped) { this._terminateAsStopped(item); return; }
      this.queue.unshift(item);
      this._startWorkers();
    } else if (!error && item.fallback) {
      // PRO lookup exhausted with no matching data — fall back to CLI
      const fb       = item.fallback;
      const endpoint = buildEndpoint(item.campaign_id, fb.value, fb.type);
      this.onUpdate(item.resultId, {
        status:       'pending',
        attempts:     0,
        lookup_value: fb.value,
        lookup_type:  fb.type,
        endpoint,
        note:         'PRO lookup returned no data — retrying with CLI (CustomProfileId) lookup',
      });
      this.queue.unshift({
        ...item,
        endpoint,
        lookup_value: fb.value,
        lookup_type:  fb.type,
        attempts:     0,
        fallback:     null,
      });
      this._startWorkers();
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