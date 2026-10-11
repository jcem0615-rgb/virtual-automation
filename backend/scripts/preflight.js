#!/usr/bin/env node
// What is missing before this deployment can be used for real.
//
// Run it against a live stack. Nothing here changes anything: it reads the
// configuration and the database and prints what would stop a real seller
// getting a real message out, in the order it would stop them.
//
//   docker compose exec backend node scripts/preflight.js
import { q, closePool } from '../db.js';
import { credentialsKeyIsSet, REQUIRED_CREDENTIALS, decryptCredentials,
         missingCredentials } from '../secrets.js';
import { authorizable } from '../oauth.js';
import { BUSINESS_TYPES } from '../business-lines.js';

const RED = '\x1b[31m'; const YEL = '\x1b[33m'; const GRN = '\x1b[32m';
const DIM = '\x1b[2m'; const OFF = '\x1b[0m';

let stops = 0;
let warns = 0;
const stop = (what, fix) => { stops += 1; console.log(`${RED}✗${OFF} ${what}\n  ${DIM}${fix}${OFF}`); };
const warn = (what, fix) => { warns += 1; console.log(`${YEL}!${OFF} ${what}\n  ${DIM}${fix}${OFF}`); };
const good = (what) => console.log(`${GRN}✓${OFF} ${what}`);

const url = (name) => process.env[name] ?? '';

console.log('\nVirtual Office — preflight\n');

// ---------------------------------------------------------------- secrets
console.log('Secrets');
if (!credentialsKeyIsSet()) {
  stop('CREDENTIALS_KEY is not set',
    'Without it no shop can be connected. 32 bytes, base64 or hex: '
    + 'openssl rand -base64 32 — and keep it, or every seller reconnects.');
} else good('CREDENTIALS_KEY is set');

if (!process.env.INTERNAL_TOKEN || process.env.INTERNAL_TOKEN === 'dev-internal-token') {
  stop('INTERNAL_TOKEN is the development default',
    'Anyone who can reach /api/internal/* can file approvals and read '
    + 'credentials with it. Set it to something random.');
} else good('INTERNAL_TOKEN has been changed from the default');

if (process.env.COOKIE_SECURE === 'false' || !process.env.COOKIE_SECURE) {
  warn('COOKIE_SECURE is off',
    'Fine over http on your own machine. Over the internet the session '
    + 'cookie travels in the clear — docker-compose.prod.yml turns it on.');
} else good('the session cookie is Secure');

// ------------------------------------------------------------- the floors
console.log('\nFloors and people');
const { rows: counts } = await q(`
  SELECT (SELECT count(*) FROM users)::int AS users,
         (SELECT count(*) FROM users WHERE is_platform_owner)::int AS operators,
         (SELECT count(*) FROM businesses WHERE is_active)::int AS floors,
         (SELECT count(*) FROM agents WHERE removed_at IS NULL)::int AS desks`);
const c = counts[0];
if (!c.users) {
  stop('there are no accounts, so nobody can sign in',
    'node scripts/create-user.js --email you@example.com --name "You" '
    + '--business <CODE> --role owner');
} else good(`${c.users} account${c.users === 1 ? '' : 's'}, ${c.floors} open floor`
  + `${c.floors === 1 ? '' : 's'}, ${c.desks} desks`);
if (!c.operators) {
  warn('no platform operator',
    'Optional. It watches every floor and can read none of them: '
    + 'create-user.js --platform-owner');
}

const { rows: types } = await q(
  `SELECT business_type, count(*)::int AS n FROM businesses WHERE is_active
    GROUP BY business_type ORDER BY business_type`);
for (const t of types) {
  if (!BUSINESS_TYPES.includes(t.business_type)) {
    warn(`${t.n} floor(s) are of an unknown trade "${t.business_type}"`,
      'Their desks fall back to the plain names and the universal skills.');
  }
}

// --------------------------------------------------------- the marketplaces
console.log('\nConnecting a shop');
for (const platform of ['shopee', 'lazada', 'tiktok', 'facebook', 'instagram']) {
  if (authorizable(platform)) good(`${platform}: a seller can authorise it from the dashboard`);
  else {
    warn(`${platform}: no app credentials, so the dashboard falls back to pasting keys`,
      `Set this platform's app id and secret to get the proper connect flow.`);
  }
}
if (!url('OAUTH_REDIRECT_BASE') && !url('PUBLIC_URL')) {
  stop('OAUTH_REDIRECT_BASE is not set',
    'The marketplace redirect must land on the dashboard\'s own origin or '
    + 'it arrives signed out. Set it to your https:// dashboard URL.');
} else {
  const base = url('OAUTH_REDIRECT_BASE') || url('PUBLIC_URL');
  if (!/^https:\/\//.test(base)) {
    warn(`the connect redirect points at ${base}`,
      'A marketplace will usually refuse a redirect that is not https.');
  } else good(`the connect redirect lands on ${base}`);
}

// Accounts that are connected but missing a key the sender needs.
const { rows: accounts } = await q(
  `SELECT a.id, a.platform, a.label, a.credentials, b.code
     FROM platform_accounts a JOIN businesses b ON b.id = a.business_id
    WHERE b.is_active ORDER BY b.code, a.platform`);
if (!accounts.length) {
  warn('no shop or page is connected yet',
    'Nothing can go out until at least one is. Market → Connect.');
}
for (const account of accounts) {
  let creds = {};
  try { creds = decryptCredentials(account.credentials) ?? {}; } catch {
    stop(`${account.code}/${account.label}: credentials will not decrypt`,
      'CREDENTIALS_KEY has changed since this was connected. Reconnect it.');
    continue;
  }
  const missing = missingCredentials(account.platform, creds);
  if (missing.length) {
    stop(`${account.code}/${account.label} (${account.platform}) is missing ${missing.join(', ')}`,
      `Reconnect it; ${account.platform} needs ${REQUIRED_CREDENTIALS[account.platform].join(', ')}.`);
  } else good(`${account.code}/${account.label} (${account.platform}) has its keys`);
}

// ------------------------------------------------------------- the workflows
console.log('\nAutomation');
const hooks = {
  N8N_RETRY_WEBHOOK_URL: ['a rejected draft is revised', 'a rejected draft is never revised'],
  N8N_DISPATCH_WEBHOOK_URL: ['an approved reply goes out', 'an approved reply never goes out'],
  N8N_POST_SYNC_WEBHOOK_URL: ['an approved post reaches its pages',
    'an approved post never reaches its pages'],
  N8N_PRODUCT_SYNC_WEBHOOK_URL: ['an approved listing reaches its shops',
    'an approved listing never reaches its shops'],
  N8N_CHAT_WEBHOOK_URL: ['an approved inbox reply reaches the buyer',
    'an approved inbox reply never reaches the buyer'],
  N8N_LIVE_WEBHOOK_URL: ['a live basket gets pinned and the room watched',
    'a live basket is never pinned and no room is watched'],
};
for (const [name, [works, broken]] of Object.entries(hooks)) {
  if (url(name)) good(`${name} is set — ${works}`);
  else stop(`${name} is not set, so ${broken}`,
    'docker-compose.yml sets all six; a deployment that overrides the '
    + 'environment has to set them too.');
}

const reachable = async (name) => {
  const target = url(name);
  if (!target) return null;
  try {
    const res = await fetch(target, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(4000),
    });
    return res.status;
  } catch (err) { return err.message; }
};
const dispatch = await reachable('N8N_DISPATCH_WEBHOOK_URL');
if (dispatch === 404) {
  stop('n8n answers the dispatch webhook with 404',
    'The workflows are imported but not activated, or not imported at all: '
    + 'docker compose exec n8n n8n import:workflow --separate --input=/workflows '
    + 'then activate each one in the editor.');
} else if (typeof dispatch === 'string') {
  stop(`n8n is not reachable (${dispatch})`,
    'The backend cannot hand an approved draft to anything.');
} else if (dispatch !== null) good(`n8n answers the dispatch webhook (${dispatch})`);

// ------------------------------------------------------------------ live
console.log('\nLive selling');
if (!url('LIVE_CHECKOUT_BASE')) {
  warn('LIVE_CHECKOUT_BASE is not set',
    'A claim in a live room will be recorded unanswered rather than sent a '
    + 'checkout link. Fine until you actually go live.');
} else good('a claimer has somewhere to pay');
if (!url('LIVE_REPLY_WEBHOOK_URL')) {
  warn('LIVE_REPLY_WEBHOOK_URL is not set',
    'The desk\'s approved line has nowhere to be posted, so the claimer is '
    + 'told nothing. No open API writes into a live room; this is your own '
    + 'plumbing.');
} else good('the desk\'s line has somewhere to go');

// --------------------------------------------------------------------- end
console.log('');
if (stops) {
  console.log(`${RED}${stops} thing${stops === 1 ? '' : 's'} would stop this working.${OFF}`
    + (warns ? ` ${warns} worth knowing about.` : ''));
} else if (warns) {
  console.log(`${GRN}Nothing is broken.${OFF} ${warns} thing${warns === 1 ? '' : 's'} worth knowing about.`);
} else {
  console.log(`${GRN}Ready.${OFF}`);
}
console.log('');
await closePool();
process.exit(stops ? 1 : 0);
