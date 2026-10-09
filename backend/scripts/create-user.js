#!/usr/bin/env node
// Create a dashboard account and give it access to one or more businesses.
// There is no sign-up page: accounts are made here, by whoever runs the stack.
//
//   docker compose exec backend node scripts/create-user.js \
//     --email you@example.com --name "Your Name" --business BIZ_ELEC --role owner
//
// Leave --password out and a strong one is generated and printed once.
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { q, closePool } from '../db.js';
import { createUser, grantBusiness } from '../auth.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    business: { type: 'string', multiple: true },
    role: { type: 'string', default: 'reviewer' },
    help: { type: 'boolean', default: false },
  },
});

function usage(message) {
  if (message) console.error('\n  ' + message);
  console.error(`
  Usage: node scripts/create-user.js --email <email> [options]

    --email     <email>        required
    --name      <display name> defaults to the part before the @
    --password  <password>     at least 10 characters; generated if omitted
    --business  <code|uuid>    repeatable; omit to grant every business
    --role      owner|reviewer defaults to reviewer
`);
  process.exit(message ? 1 : 0);
}

if (values.help) usage();
if (!values.email) usage('--email is required.');
if (!['owner', 'reviewer'].includes(values.role)) usage('--role must be owner or reviewer.');

const password = values.password ?? crypto.randomBytes(12).toString('base64url');
const generated = !values.password;

try {
  const user = await createUser({
    email: values.email,
    password,
    displayName: values.name,
  });

  // Resolve the business codes (or uuids) the account should see.
  const { rows: businesses } = values.business?.length
    ? await q(
        `SELECT id, code, name FROM businesses
          WHERE code = ANY($1::text[])
             OR id::text = ANY($1::text[])
          ORDER BY name`,
        [values.business],
      )
    : await q('SELECT id, code, name FROM businesses ORDER BY name');

  if (!businesses.length) {
    console.error('\n  No businesses matched. The account exists but can see nothing yet.');
  }
  for (const business of businesses) {
    await grantBusiness(user.id, business.id, values.role);
  }

  console.log(`
  Account created.

    email     ${user.email}
    name      ${user.display_name}
    role      ${values.role}
    access    ${businesses.map((b) => b.code).join(', ') || '(none)'}
${generated ? `    password  ${password}\n\n  Store that password now — it is not shown again.` : ''}
`);
} catch (err) {
  if (err.code === '23505') {
    console.error(`\n  An account already exists for ${values.email}.\n`);
  } else {
    console.error('\n  ' + (err.message ?? err) + '\n');
  }
  process.exitCode = 1;
} finally {
  await closePool();
}
