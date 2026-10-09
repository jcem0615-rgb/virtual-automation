#!/usr/bin/env node
// Move the platform operator role to a different account. There is only ever
// one, so this clears the old flag and sets the new one in one transaction.
//
//   docker compose exec backend node scripts/transfer-owner.js --to you@example.com
import { parseArgs } from 'node:util';
import { q, tx, closePool } from '../db.js';
import { findUserByEmail } from '../auth.js';

const { values } = parseArgs({ options: { to: { type: 'string' } } });

if (!values.to) {
  console.error('\n  Usage: node scripts/transfer-owner.js --to <email>\n');
  process.exit(1);
}

try {
  const target = await findUserByEmail(values.to);
  if (!target) {
    console.error(`\n  No account for ${values.to}. Create it first with create-user.js.\n`);
    process.exitCode = 1;
  } else {
    const { rows: before } = await q('SELECT email FROM users WHERE is_platform_owner');
    await tx(async (client) => {
      await client.query('UPDATE users SET is_platform_owner = false WHERE is_platform_owner');
      await client.query('UPDATE users SET is_platform_owner = true WHERE id = $1', [target.id]);
    });
    console.log(`
  ${target.email} is now the platform operator.
${before[0] ? `  ${before[0].email} is not any more — their business access is unchanged.\n` : ''}`);
  }
} catch (err) {
  console.error('\n  ' + (err.message ?? err) + '\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
