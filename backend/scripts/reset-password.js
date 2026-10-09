#!/usr/bin/env node
// Set a new password for an existing account and sign that account out
// everywhere, so a leaked password stops working immediately.
//
//   docker compose exec backend node scripts/reset-password.js --email you@example.com
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { q, closePool } from '../db.js';
import { hashPassword, findUserByEmail, destroyUserSessions } from '../auth.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
  },
});

if (!values.email) {
  console.error('\n  Usage: node scripts/reset-password.js --email <email> [--password <password>]\n');
  process.exit(1);
}

const password = values.password ?? crypto.randomBytes(12).toString('base64url');

try {
  const user = await findUserByEmail(values.email);
  if (!user) {
    console.error(`\n  No account for ${values.email}.\n`);
    process.exitCode = 1;
  } else {
    await q('UPDATE users SET password_hash = $2 WHERE id = $1',
      [user.id, await hashPassword(password)]);
    await destroyUserSessions(user.id);
    console.log(`
  Password changed for ${user.email}, and every existing session was signed out.
${values.password ? '' : `\n    password  ${password}\n\n  Store it now — it is not shown again.`}
`);
  }
} catch (err) {
  console.error('\n  ' + (err.message ?? err) + '\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
