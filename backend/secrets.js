// Marketplace credentials at rest.
//
// A business can connect several seller accounts, so their keys have to live
// in the database rather than the environment. They are encrypted with
// AES-256-GCM under CREDENTIALS_KEY and only ever decrypted for n8n, through
// the internal token. Nothing in here is reachable from a browser.
import crypto from 'node:crypto';
import { HttpError } from './db.js';

const ALGORITHM = 'aes-256-gcm';

let cachedKey;

/**
 * The key is 32 bytes, given as base64 or hex. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function key() {
  if (cachedKey) return cachedKey;
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) {
    throw new HttpError(500,
      'CREDENTIALS_KEY is not set, so marketplace credentials cannot be stored');
  }
  const buffer = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buffer.length !== 32) {
    throw new HttpError(500, 'CREDENTIALS_KEY must decode to 32 bytes');
  }
  cachedKey = buffer;
  return cachedKey;
}

export function credentialsKeyIsSet() {
  try { key(); return true; } catch { return false; }
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptCredentials(value) {
  const plain = JSON.stringify(value ?? {});
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    body.toString('base64url')].join('.');
}

export function decryptCredentials(stored) {
  if (!stored) return null;
  const [version, iv, tag, body] = String(stored).split('.');
  if (version !== 'v1' || !iv || !tag || !body) {
    throw new HttpError(500, 'stored credentials are not in a format this build understands');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plain);
}

// Identifiers can show a tail so a person can tell two shops apart. Secrets
// never do — the tail of a key is still part of the key.
const SECRET_FIELDS = new Set([
  'partner_key', 'app_secret', 'access_token', 'page_access_token',
  'bearer_token', 'refresh_token', 'shop_cipher',
]);

/**
 * What the dashboard is allowed to see: which fields are set, and a tail for
 * the ones that are only identifiers. Never a secret's value, in part or whole.
 */
export function describeCredentials(stored) {
  if (!stored) return { configured: false, fields: [] };
  let data;
  try {
    data = decryptCredentials(stored);
  } catch {
    return { configured: true, unreadable: true, fields: [] };
  }
  return {
    configured: true,
    fields: Object.entries(data ?? {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([name, value]) => ({
        name,
        secret: SECRET_FIELDS.has(name),
        hint: SECRET_FIELDS.has(name)
          ? 'set'
          : (String(value).length > 4 ? `…${String(value).slice(-4)}` : '••••'),
      })),
  };
}

/** Which credential fields each platform needs before it can be used. */
export const REQUIRED_CREDENTIALS = {
  shopee: ['partner_id', 'partner_key', 'shop_id', 'access_token'],
  lazada: ['app_key', 'app_secret', 'access_token'],
  tiktok: ['app_key', 'app_secret', 'access_token', 'shop_cipher'],
  facebook: ['page_access_token'],
  instagram: ['page_access_token'],
  x: ['bearer_token'],
};

export function missingCredentials(platform, data) {
  const required = REQUIRED_CREDENTIALS[platform] ?? [];
  return required.filter((field) => !data?.[field]);
}
