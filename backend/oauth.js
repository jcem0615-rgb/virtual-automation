// Connecting a shop the way a seller actually connects one.
//
// Nobody should be asked to find their partner key in a developer console and
// paste it into somebody else's app. Every one of these marketplaces has the
// same flow instead: we send the seller to the platform's own page, they sign
// in there, pick which shop they are granting access to, and press authorize.
// The platform sends them back to us with a one-time code, and we swap that
// code for the tokens — server to server, so the browser never sees them.
//
// The signatures and endpoints differ per platform; the shape does not:
//
//   Shopee       /api/v2/shop/auth_partner, signed with the partner key.
//                Comes back with ?code= and ?shop_id=, and the token call is
//                /api/v2/auth/token/get.
//   Lazada       auth.lazada.com/oauth/authorize, then /rest/auth/token/create
//                under the open platform's sorted-parameter signature.
//   TikTok Shop  services.tiktokshop.com/open/authorize, then
//                auth.tiktok-shops.com/api/v2/token/get.
//   Meta         the Facebook login dialog, then a page token per page.
//
// What this file will NOT do is invent an authorization it cannot perform. A
// platform whose app credentials are not configured says so by name, and the
// dashboard falls back to the manual form rather than opening a page that
// would only fail.
import crypto from 'node:crypto';
import { HttpError } from './db.js';

/**
 * Where the marketplace sends the seller back to. Must match what is
 * registered with each platform exactly, so it is one value for all of them.
 *
 * It has to be the origin the dashboard itself is served from. The redirect
 * is a top-level navigation and the session cookie only rides along if the
 * host matches — point this at the API on another host and every callback
 * arrives signed out, which looks like the platform refusing rather than a
 * configuration mistake.
 */
export function redirectUri() {
  const base = (process.env.OAUTH_REDIRECT_BASE ?? process.env.PUBLIC_URL ?? '')
    .replace(/\/$/, '');
  return base ? `${base}/api/accounts/callback` : '';
}

/** The app-level credentials, which belong to the deployment, not a tenant. */
const APP = {
  shopee: () => ({
    partner_id: process.env.SHOPEE_PARTNER_ID,
    partner_key: process.env.SHOPEE_PARTNER_KEY,
    host: process.env.SHOPEE_HOST || 'https://partner.shopeemobile.com',
    auth_host: process.env.SHOPEE_AUTH_HOST || 'https://partner.shopeemobile.com',
  }),
  lazada: () => ({
    app_key: process.env.LAZADA_APP_KEY,
    app_secret: process.env.LAZADA_APP_SECRET,
    host: process.env.LAZADA_HOST || 'https://api.lazada.com.ph/rest',
    auth_host: process.env.LAZADA_AUTH_HOST || 'https://auth.lazada.com',
  }),
  tiktok: () => ({
    app_key: process.env.TIKTOK_APP_KEY,
    app_secret: process.env.TIKTOK_APP_SECRET,
    service_id: process.env.TIKTOK_SERVICE_ID,
    host: process.env.TIKTOK_HOST || 'https://open-api.tiktokglobalshop.com',
    auth_host: process.env.TIKTOK_AUTH_HOST || 'https://auth.tiktok-shops.com',
    consent_host: process.env.TIKTOK_CONSENT_HOST || 'https://services.tiktokshop.com',
  }),
  facebook: () => ({
    app_id: process.env.META_APP_ID,
    app_secret: process.env.META_APP_SECRET,
    version: process.env.META_API_VERSION || 'v21.0',
  }),
};
APP.instagram = APP.facebook;

/** Which app-level variables a platform needs before it can be authorised. */
const APP_REQUIRED = {
  shopee: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
  lazada: ['LAZADA_APP_KEY', 'LAZADA_APP_SECRET'],
  tiktok: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_SERVICE_ID'],
  facebook: ['META_APP_ID', 'META_APP_SECRET'],
  instagram: ['META_APP_ID', 'META_APP_SECRET'],
};

/** What a seller sees named on the consent screen, for the waiting copy. */
export const PLATFORM_NAME = {
  shopee: 'Shopee', lazada: 'Lazada', tiktok: 'TikTok Shop',
  facebook: 'Facebook', instagram: 'Instagram', x: 'X',
};

/**
 * Can this platform be connected by authorising, here, now? Returns the
 * reason it cannot rather than a bare false, because "set SHOPEE_PARTNER_KEY"
 * is a thing somebody can act on and "not supported" is not.
 */
export function authorizable(platform) {
  const required = APP_REQUIRED[platform];
  if (!required) {
    return { ok: false, reason: `${PLATFORM_NAME[platform] ?? platform} has no authorization flow wired up yet` };
  }
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    return { ok: false, reason: `this deployment has not set ${missing.join(' and ')}` };
  }
  if (!redirectUri()) {
    return { ok: false, reason: 'this deployment has not set OAUTH_REDIRECT_BASE' };
  }
  return { ok: true };
}

export const newState = () => crypto.randomBytes(24).toString('base64url');

/** The page we send the seller to. */
export function authorizeUrl(platform, state) {
  const can = authorizable(platform);
  if (!can.ok) throw new HttpError(409, can.reason);
  const redirect = redirectUri();
  // The state rides in the redirect for Shopee, which does not take a state
  // parameter of its own, and as `state` everywhere else.
  const back = `${redirect}?state=${encodeURIComponent(state)}`;

  if (platform === 'shopee') {
    const app = APP.shopee();
    const path = '/api/v2/shop/auth_partner';
    const ts = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', app.partner_key)
      .update(`${app.partner_id}${path}${ts}`).digest('hex');
    const query = new URLSearchParams({
      partner_id: String(app.partner_id), timestamp: String(ts), sign, redirect: back,
    });
    return `${app.auth_host}${path}?${query}`;
  }

  if (platform === 'lazada') {
    const app = APP.lazada();
    const query = new URLSearchParams({
      response_type: 'code', force_auth: 'true',
      redirect_uri: redirect, client_id: app.app_key, state,
    });
    return `${app.auth_host}/oauth/authorize?${query}`;
  }

  if (platform === 'tiktok') {
    const app = APP.tiktok();
    const query = new URLSearchParams({ service_id: app.service_id, state });
    return `${app.consent_host}/open/authorize?${query}`;
  }

  const app = APP.facebook();
  const scope = platform === 'instagram'
    ? 'instagram_basic,instagram_manage_messages,pages_show_list,pages_messaging'
    : 'pages_show_list,pages_messaging,pages_manage_metadata,business_management';
  const query = new URLSearchParams({
    client_id: app.app_id, redirect_uri: redirect, state, scope, response_type: 'code',
  });
  return `https://www.facebook.com/${app.version}/dialog/oauth?${query}`;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Swap the one-time code for tokens. Returns what the account row needs:
 * the credentials to encrypt, the shop's own id, and a name to show if the
 * seller did not give one.
 */
export async function exchangeCode(platform, query) {
  const code = String(query.code ?? '').trim();
  if (!code) throw new HttpError(400, 'the marketplace sent no authorization code');

  if (platform === 'shopee') {
    const app = APP.shopee();
    const shopId = String(query.shop_id ?? '').trim();
    if (!shopId) throw new HttpError(400, 'Shopee sent no shop id');
    const path = '/api/v2/auth/token/get';
    const ts = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', app.partner_key)
      .update(`${app.partner_id}${path}${ts}`).digest('hex');
    const url = `${app.host}${path}?${new URLSearchParams({
      partner_id: String(app.partner_id), timestamp: String(ts), sign })}`;
    const out = await postJson(url, {
      code, shop_id: Number(shopId), partner_id: Number(app.partner_id) });
    const token = out.body?.access_token;
    if (!token) {
      throw new HttpError(502, `Shopee refused the authorization: ${out.body?.message ?? out.status}`);
    }
    return {
      externalId: shopId,
      label: out.body?.shop_name || `Shopee shop ${shopId}`,
      credentials: {
        partner_id: String(app.partner_id),
        partner_key: app.partner_key,
        shop_id: shopId,
        access_token: token,
        refresh_token: out.body?.refresh_token ?? null,
        host: app.host,
      },
      expiresIn: out.body?.expire_in ?? null,
    };
  }

  if (platform === 'lazada') {
    const app = APP.lazada();
    const path = '/auth/token/create';
    const params = {
      app_key: app.app_key, code, sign_method: 'sha256',
      timestamp: String(Date.now()),
    };
    const sorted = Object.keys(params).sort().map((k) => k + params[k]).join('');
    const sign = crypto.createHmac('sha256', app.app_secret)
      .update(path + sorted).digest('hex').toUpperCase();
    const out = await getJson(
      `${app.auth_host}/rest${path}?${new URLSearchParams({ ...params, sign })}`);
    const token = out.body?.access_token;
    if (!token) {
      throw new HttpError(502, `Lazada refused the authorization: ${out.body?.message ?? out.status}`);
    }
    const shop = out.body?.country_user_info?.[0] ?? {};
    return {
      externalId: String(shop.seller_id ?? out.body?.account_id ?? ''),
      label: out.body?.account || `Lazada ${shop.country ?? ''}`.trim(),
      credentials: {
        app_key: app.app_key, app_secret: app.app_secret,
        access_token: token, refresh_token: out.body?.refresh_token ?? null,
        host: app.host,
      },
      expiresIn: out.body?.expires_in ?? null,
    };
  }

  if (platform === 'tiktok') {
    const app = APP.tiktok();
    const out = await getJson(`${app.auth_host}/api/v2/token/get?${new URLSearchParams({
      app_key: app.app_key, app_secret: app.app_secret,
      auth_code: code, grant_type: 'authorized_code' })}`);
    const data = out.body?.data ?? {};
    if (!data.access_token) {
      throw new HttpError(502, `TikTok Shop refused the authorization: ${out.body?.message ?? out.status}`);
    }
    // A seller can grant more than one shop; the first authorised one is the
    // account, and connecting the others is another run through this flow.
    const shop = (data.seller_name || data.shop_list?.[0]?.shop_name) ?? 'TikTok Shop';
    const cipher = data.shop_list?.[0]?.shop_cipher ?? data.shop_cipher ?? null;
    return {
      externalId: String(data.shop_list?.[0]?.shop_id ?? data.seller_base_region ?? ''),
      label: shop,
      credentials: {
        app_key: app.app_key, app_secret: app.app_secret,
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? null,
        shop_cipher: cipher,
        host: app.host,
      },
      expiresIn: data.access_token_expire_in ?? null,
    };
  }

  // Meta: swap for a user token, then take the page token the seller granted.
  const app = APP.facebook();
  const tokenOut = await getJson(
    `https://graph.facebook.com/${app.version}/oauth/access_token?${new URLSearchParams({
      client_id: app.app_id, client_secret: app.app_secret,
      redirect_uri: redirectUri(), code })}`);
  const userToken = tokenOut.body?.access_token;
  if (!userToken) {
    throw new HttpError(502,
      `Facebook refused the authorization: ${tokenOut.body?.error?.message ?? tokenOut.status}`);
  }
  const pagesOut = await getJson(
    `https://graph.facebook.com/${app.version}/me/accounts?${new URLSearchParams({
      access_token: userToken, fields: 'id,name,access_token,instagram_business_account' })}`);
  const page = pagesOut.body?.data?.[0];
  if (!page) {
    throw new HttpError(409,
      'that account granted access but manages no Page, so there is nothing to connect');
  }
  const igId = page.instagram_business_account?.id ?? null;
  if (platform === 'instagram' && !igId) {
    throw new HttpError(409,
      `${page.name} has no Instagram business account linked to it`);
  }
  return {
    externalId: platform === 'instagram' ? String(igId) : String(page.id),
    label: page.name,
    credentials: { page_access_token: page.access_token, page_id: String(page.id),
                   ...(igId ? { instagram_id: String(igId) } : {}) },
    expiresIn: null,
  };
}
