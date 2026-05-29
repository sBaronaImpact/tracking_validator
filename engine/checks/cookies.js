'use strict';

/**
 * Safely URL-decode a value without throwing.
 */
function safeDecode(value) {
  if (!value) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Format a Playwright cookie object into a clean result shape.
 */
function formatCookie(cookie) {
  return {
    name:     cookie.name,
    value:    cookie.value,
    domain:   cookie.domain,
    path:     cookie.path,
    expires:  cookie.expires > 0
                ? new Date(cookie.expires * 1000).toISOString()
                : 'Session',
    httpOnly: !!cookie.httpOnly,
    secure:   !!cookie.secure,
    sameSite: cookie.sameSite || 'None',
    size:     (cookie.value || '').length,
  };
}

/**
 * Value-first cookie scan.
 * Returns all cookies whose (raw or decoded) value matches the target value.
 * Handles both URL-encoded and plain comparisons.
 */
function findCookiesByValue(cookies, targetValue) {
  if (!targetValue || !Array.isArray(cookies)) return [];
  const decodedTarget = safeDecode(targetValue);

  return cookies
    .filter(cookie => {
      const raw     = cookie.value || '';
      const decoded = safeDecode(raw);
      return (
        raw === targetValue ||
        raw === decodedTarget ||
        decoded === targetValue ||
        decoded === decodedTarget
      );
    })
    .map(formatCookie);
}

/**
 * Find a single cookie by exact name match.
 */
function findCookieByName(cookies, name) {
  if (!name || !Array.isArray(cookies)) return null;
  const found = cookies.find(c => c.name === name);
  return found ? formatCookie(found) : null;
}

/**
 * Parse the IR_PI cookie value and extract the profile UUID (first segment).
 *
 * IR_PI format (URL-decoded): {uuid}|{timestamp}
 * Example: bf305b28-5932-11f1-a871-991684982e00|1779907390073
 *
 * Returns the UUID only, ready to append _PRO for identity lookup.
 */
function extractIrPiProfileId(irPiCookieValue) {
  if (!irPiCookieValue) return null;
  try {
    const decoded = safeDecode(irPiCookieValue);
    const segment = decoded.split('|')[0];
    // Basic UUID pattern sanity check
    return segment && segment.includes('-') ? segment : null;
  } catch {
    return null;
  }
}

/**
 * Parse the IR_{campaignId} cookie value and extract the embedded click ID.
 *
 * Format (URL-decoded): {timestamp}|0|{timestamp}|{clickId}|
 * The click ID is the 4th pipe-delimited segment (index 3).
 */
function extractClickIdFromIrCookie(irCookieValue) {
  if (!irCookieValue) return null;
  try {
    const decoded = safeDecode(irCookieValue);
    const parts = decoded.split('|');
    return parts[3] || null;
  } catch {
    return null;
  }
}

module.exports = {
  safeDecode,
  formatCookie,
  findCookiesByValue,
  findCookieByName,
  extractIrPiProfileId,
  extractClickIdFromIrCookie,
};
