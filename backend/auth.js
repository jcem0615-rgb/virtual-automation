// Accounts, sessions and tenant scope.
//
// Passwords use node's own scrypt, so there is no native dependency to build.
// Sessions live in Postgres and the cookie carries only a random token, so a
// sign-out (or a disabled account) takes effect on the very next request.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q, HttpError, assertUuid } from './db.js';

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const COOKIE_NAME = 'vo_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 7);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// ------------------------------------------------------------- passwords

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 10) {
    throw new HttpError(400, 'password must be at least 10 characters');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(plain, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const derived = await scrypt(plain, Buffer.from(salt, 'base64'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Constant-time compare for shared secrets (the n8n token). */
export function secretsMatch(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// -------------------------------------------------------------- cookies

/** Minimal cookie reader — express only parses cookies with a middleware. */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

// ------------------------------------------------------------- sessions

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export async function createSession(userId, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)`,
    [userId, sha256(token), String(SESSION_DAYS), (userAgent ?? '').slice(0, 300), ip ?? null],
  );
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  await q('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function destroyUserSessions(userId) {
  await q('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/**
 * Resolve a cookie value to a user plus the businesses they may see.
 * Returns null for anything expired, revoked or belonging to a disabled
 * account — the caller decides whether that is a 401 or just "anonymous".
 */
export async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await q(
    `SELECT s.id AS session_id, s.last_seen_at,
            u.id, u.email, u.display_name, u.is_platform_owner,
            COALESCE(
              array_agg(b.id ORDER BY b.id) FILTER (WHERE b.id IS NOT NULL),
              '{}'
            ) AS business_ids,
            COALESCE(
              jsonb_object_agg(b.id, ub.role) FILTER (WHERE b.id IS NOT NULL),
              '{}'::jsonb
            ) AS roles
       FROM sessions s
       JOIN users u ON u.id = s.user_id
  LEFT JOIN user_businesses ub ON ub.user_id = u.id
  -- A suspended business drops out of the session's scope entirely, so every
  -- read, write and socket room derived from it is closed in one place.
  LEFT JOIN businesses b ON b.id = ub.business_id AND b.is_active
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active
   GROUP BY s.id, s.last_seen_at, u.id, u.email, u.display_name, u.is_platform_owner`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;

  // Keep an active session alive without writing on every single request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60 * 60 * 1000) {
    await q(
      `UPDATE sessions
          SET last_seen_at = now(), expires_at = now() + ($2 || ' days')::interval
        WHERE id = $1`,
      [row.session_id, String(SESSION_DAYS)],
    ).catch(() => {});
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isPlatformOwner: row.is_platform_owner,
    businessIds: row.business_ids,
    roles: row.roles ?? {},      // business_id -> 'owner' | 'reviewer'
  };
}

// ---------------------------------------------------------------- login

// Per-process throttle. It is not shared between backend instances, so put a
// rate limit at the proxy too if you run more than one.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttleKey(email, ip) {
  return `${String(email).toLowerCase()}|${ip ?? 'unknown'}`;
}

export function checkThrottle(email, ip) {
  const record = attempts.get(throttleKey(email, ip));
  if (!record) return;
  if (Date.now() - record.first > WINDOW_MS) return;
  if (record.count >= MAX_ATTEMPTS) {
    const retryIn = Math.ceil((WINDOW_MS - (Date.now() - record.first)) / 1000);
    throw new HttpError(429, `too many sign-in attempts — try again in ${retryIn}s`);
  }
}

export function noteFailure(email, ip) {
  const key = throttleKey(email, ip);
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 });
  } else {
    record.count += 1;
  }
}

export function clearThrottle(email, ip) {
  attempts.delete(throttleKey(email, ip));
}

export async function findUserByEmail(email) {
  const { rows } = await q(
    `SELECT id, email, display_name, password_hash, is_active
       FROM users WHERE lower(email) = lower($1)`,
    [String(email ?? '')],
  );
  return rows[0] ?? null;
}

// Cost-matched decoy so a wrong email and a wrong password take the same time.
const DECOY_HASH = 'scrypt$16384$8$1$' +
  Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(64).toString('base64');

export async function authenticate(email, password, { ip } = {}) {
  checkThrottle(email, ip);
  const user = await findUserByEmail(email);
  const ok = await verifyPassword(String(password ?? ''), user?.password_hash ?? DECOY_HASH);
  if (!user || !ok || !user.is_active) {
    noteFailure(email, ip);
    throw new HttpError(401, 'that email and password do not match an account');
  }
  clearThrottle(email, ip);
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return user;
}

// ----------------------------------------------------------- middleware

/** Attaches req.user, or 401s. Every /api route except /api/auth and health. */
export function requireUser(req, _res, next) {
  resolveSession(readCookie(req.headers.cookie, COOKIE_NAME))
    .then((user) => {
      if (!user) return next(new HttpError(401, 'sign in to continue'));
      req.user = user;
      next();
    })
    .catch(next);
}

/** What this user is inside one business, or null if they are not in it. */
export function roleFor(user, businessId) {
  return user.roles?.[businessId] ?? null;
}

/**
 * Guard for the things only a business owner may do. A reviewer reads the
 * floor and decides on drafts; switching a desk off is an owner's call.
 */
export function requireOwner(user, businessId) {
  const role = roleFor(user, businessId);
  if (!role) throw new HttpError(404, 'not found');
  if (role !== 'owner') {
    throw new HttpError(403, 'only an owner can do that — you are a reviewer here');
  }
  return role;
}

/** Guard for the platform portal: running the deployment, not a tenant. */
export function requirePlatformOwner(req, _res, next) {
  requireUser(req, _res, (err) => {
    if (err) return next(err);
    if (!req.user?.isPlatformOwner) {
      return next(new HttpError(403, 'this is the platform operator area'));
    }
    next();
  });
}

/**
 * Tenant scope for an authenticated request. `requested` is what the UI asked
 * for; what comes back is always limited to the user's own businesses, so a
 * crafted business_id cannot widen it.
 */
export function scopeFor(user, requested) {
  const allowed = user.businessIds ?? [];
  if (!allowed.length) throw new HttpError(403, 'this account has no businesses yet');
  if (requested == null || requested === 'all') return allowed;
  assertUuid(requested, 'business_id');
  if (!allowed.includes(requested)) throw new HttpError(403, 'not your business');
  return [requested];
}

// ------------------------------------------------- operator-side helpers

export async function createUser({ email, password, displayName }) {
  const normalised = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalised)) {
    throw new HttpError(400, 'a valid email is required');
  }
  const passwordHash = await hashPassword(password);
  // A duplicate email raises 23505 on users_email_lower_idx; the caller turns
  // that into a readable message rather than swallowing it here.
  const { rows } = await q(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name`,
    [normalised, passwordHash, String(displayName ?? normalised.split('@')[0])],
  );
  return rows[0];
}

export async function setPlatformOwner(userId, value = true) {
  await q('UPDATE users SET is_platform_owner = $2 WHERE id = $1', [userId, value]);
}

export async function grantBusiness(userId, businessId, role = 'reviewer') {
  await q(
    `INSERT INTO user_businesses (user_id, business_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, business_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, businessId, role],
  );
}

/** Housekeeping: drop rows for sessions that have already lapsed. */
export async function purgeExpiredSessions() {
  const { rowCount } = await q('DELETE FROM sessions WHERE expires_at < now()');
  return rowCount;
}
