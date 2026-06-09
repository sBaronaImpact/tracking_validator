'use strict';

const { STATUS, INTEGRATION_TYPE } = require('../result');

const SHOPIFY_IDENTITY_COOKIES = [
  '_shopify_y', 'shopify_client_id', '_shopify_sa_t', '_shopify_sa_p', '_shopify_fs',
];

function detectIntegrationType(utt, shopify, clickIdCookieNames) {
  const hasUttTag          = utt.tag_detected          === true;
  const hasIdentify        = utt.identify_call          === true;
  const hasShopifyPageload = shopify.pageload_found     === true &&
                             shopify.integration_source === 'Shopify';
  const hasDirectPageload  = shopify.pageload_found     === true &&
                             shopify.integration_source !== 'Shopify';
  const hasWebPixel        = shopify.web_pixel_console  === true;
  const hasShopify         = hasShopifyPageload || hasWebPixel;

  // UTT + Shopify signals → Hybrid
  if (hasUttTag && hasShopify) return INTEGRATION_TYPE.HYBRID;

  // UTT + non-Shopify PLA running in parallel → UTT + Page Load API
  if (hasUttTag && hasIdentify && hasDirectPageload) return INTEGRATION_TYPE.UTTPLAAPI;

  // UTT only
  if (hasUttTag && hasIdentify && !hasShopify) {
    const cookieName = utt.cli_cookie_name || '';
    const usesShopifyCookie = SHOPIFY_IDENTITY_COOKIES.some(n => cookieName.includes(n));
    if (usesShopifyCookie) return INTEGRATION_TYPE.HYBRID;
    return INTEGRATION_TYPE.UTT;
  }

  if (hasUttTag && !hasShopify) return INTEGRATION_TYPE.UTT;

  // Shopify Plugin only
  if (hasShopify && !hasUttTag) return INTEGRATION_TYPE.SHOPIFY;

  // Direct (non-Shopify) Page Load API only
  if (hasDirectPageload) return INTEGRATION_TYPE.PAGELOADAPI;

  // No UTT, no Shopify, but click ID stored as a cookie → ClickId Integration
  if (!hasUttTag && !hasShopify && !hasDirectPageload && clickIdCookieNames) {
    return INTEGRATION_TYPE.CLICKID;
  }

  return INTEGRATION_TYPE.UNKNOWN;
}

module.exports = { detectIntegrationType, SHOPIFY_IDENTITY_COOKIES };