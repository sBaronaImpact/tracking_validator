'use strict';

const { STATUS, INTEGRATION_TYPE } = require('../result');

const SHOPIFY_IDENTITY_COOKIES = [
  '_shopify_y', 'shopify_client_id', '_shopify_sa_t', '_shopify_sa_p', '_shopify_fs',
];

function detectIntegrationType(utt, shopify, clickIdCookieNames) {
  const hasUttTag   = utt.tag_detected        === true;
  const hasIdentify = utt.identify_call        === true;
  const hasPageload = shopify.pageload_found   === true;
  const hasWebPixel = shopify.web_pixel_console === true;
  const hasShopify  = hasPageload || hasWebPixel;

  if (hasUttTag && hasShopify) return INTEGRATION_TYPE.HYBRID;

  if (hasUttTag && hasIdentify && !hasShopify) {
    const cookieName = utt.cli_cookie_name || '';
    const usesShopifyCookie = SHOPIFY_IDENTITY_COOKIES.some(n => cookieName.includes(n));
    if (usesShopifyCookie) return INTEGRATION_TYPE.HYBRID;
    return INTEGRATION_TYPE.UTT;
  }

  if (hasShopify && !hasUttTag) return INTEGRATION_TYPE.SHOPIFY;
  if (hasUttTag && !hasShopify) return INTEGRATION_TYPE.UTT;

  // No UTT, no Shopify, but click ID stored as a cookie → ClickId Integration
  if (!hasUttTag && !hasShopify && clickIdCookieNames) {
    return INTEGRATION_TYPE.CLICKID;
  }

  return INTEGRATION_TYPE.UNKNOWN;
}

module.exports = { detectIntegrationType, SHOPIFY_IDENTITY_COOKIES };
