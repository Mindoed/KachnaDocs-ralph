import 'reflect-metadata';
import { closePool, query, reconfigure } from './db';
import { DevIdentityProvider } from './auth/dev-identity.provider';

/**
 * Idempotent seed shared by dev and test. Fixed UUIDs so tests and FINDINGS can
 * name records literally.
 *
 * Layout exercises the interesting ACL paths at once:
 *   HR           (role READ here, inherited by descendants)
 *     └── Payroll    (inherits READ; `salaries` is denied to Ana by NONE)
 *   Engineering  (role READ+WRITE; Bona additionally MANAGEs directly)
 *   Carl          gets READ on one document only, directly
 *   Dana          holds nothing at all: proves default deny
 */
export const FIXTURES = {
  users: {
    ana: '11111111-1111-1111-1111-111111111111',
    bona: '22222222-2222-2222-2222-222222222222',
    carl: '33333333-3333-3333-3333-333333333333',
    dana: '44444444-4444-4444-4444-444444444444',
  },
  roles: {
    hr: 'aaaaaaa1-0000-0000-0000-000000000000',
    eng: 'aaaaaaa2-0000-0000-0000-000000000000',
  },
  groups: {
    hr: 'bbbbbbb1-0000-0000-0000-000000000000',
    payroll: 'bbbbbbb2-0000-0000-0000-000000000000',
    engineering: 'bbbbbbb3-0000-0000-0000-000000000000',
  },
  documents: {
    handbook: 'ccccccc1-0000-0000-0000-000000000000',
    salaries: 'ccccccc2-0000-0000-0000-000000000000',
    runbook: 'ccccccc3-0000-0000-0000-000000000000',
    privateIdea: 'ccccccc4-0000-0000-0000-000000000000',
  },
} as const;

export async function seed(): Promise<void> {
  const f = FIXTURES;

  // The whole graph is rebuilt rather than merged: a grant left over from an
  // earlier version of this file would silently change what the ACL tests
  // prove. Seed data only — never call this against anything you care about.
  await query(
    `TRUNCATE permissions, documents, groups, user_discord_roles, discord_roles, users
       RESTART IDENTITY CASCADE`,
  );

  await query(
    `INSERT INTO discord_roles (id, external_id, name) VALUES
       ($1, 'role-hr',  'HR'),
       ($2, 'role-eng', 'Engineering')`,
    [f.roles.hr, f.roles.eng],
  );

  // Display names and role membership come from DevIdentityProvider, so the
  // seed cannot drift from what a real dev login would produce; only the ids
  // are pinned here.
  const provider = new DevIdentityProvider();
  const handles = ['ana', 'bona', 'carl', 'dana'] as const;
  const userIds: Record<(typeof handles)[number], string> = {
    ana: f.users.ana,
    bona: f.users.bona,
    carl: f.users.carl,
    dana: f.users.dana,
  };
  // handle -> external role ids, resolved to the role rows inserted above.
  const roleByExternal: Record<string, string> = {
    'role-hr': f.roles.hr,
    'role-eng': f.roles.eng,
  };
  for (const handle of handles) {
    const identity = await provider.resolveIdentity(handle);
    await query(
      `INSERT INTO users (id, external_id, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)`,
      [userIds[handle], identity.externalId, identity.displayName, identity.avatarUrl],
    );
    for (const role of await provider.fetchRoleMembership(identity.externalId)) {
      const roleId = roleByExternal[role.externalId];
      if (!roleId) throw new Error(`seed: unknown role ${role.externalId}`);
      await query('INSERT INTO user_discord_roles (user_id, role_id) VALUES ($1, $2)', [
        userIds[handle],
        roleId,
      ]);
    }
  }

  await query(
    `INSERT INTO groups (id, parent_id, name) VALUES
       ($1, NULL, 'HR'),
       ($2, $1,   'Payroll'),
       ($3, NULL, 'Engineering')`,
    [f.groups.hr, f.groups.payroll, f.groups.engineering],
  );

  await query(
    `INSERT INTO documents (id, group_id, slug, title, state, owner_role_id) VALUES
       ($1, $5, 'hr-handbook',    'Příručka HR',        'Published', $7),
       ($2, $6, 'salaries',       'Ohodnocování',       'Published', $7),
       ($3, $8, 'deploy-runbook', 'Nasazovací runbook', 'Published', $9),
       ($4, $8, 'private-idea',   'Tajný nápad',        'Draft',     $9)`,
    [
      f.documents.handbook,
      f.documents.salaries,
      f.documents.runbook,
      f.documents.privateIdea,
      f.groups.hr,
      f.groups.payroll,
      f.roles.hr,
      f.groups.engineering,
      f.roles.eng,
    ],
  );

  // Grants. One statement each: the multi-row form needs N x 5 placeholders
  // and is far too easy to mis-number, which is exactly what broke here.
  // READ on the HR group reaches Payroll and its documents only by
  // inheritance, which is what the ACL tests assert.
  const grant = (cols: string[], values: unknown[]) =>
    query(
      `INSERT INTO permissions (${cols.join(', ')}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(', ')})`,
      values,
    );

  // role HR: READ on the HR group, inherited down to Payroll
  await grant(['subject_role_id', 'target_group_id', 'permission'], [f.roles.hr, f.groups.hr, 'READ']);
  // role Engineering: READ + WRITE on its own group
  await grant(
    ['subject_role_id', 'target_group_id', 'permission'],
    [f.roles.eng, f.groups.engineering, 'READ'],
  );
  await grant(
    ['subject_role_id', 'target_group_id', 'permission'],
    [f.roles.eng, f.groups.engineering, 'WRITE'],
  );
  // Bona manages the Engineering group personally, not via a role
  await grant(
    ['subject_user_id', 'target_group_id', 'permission'],
    [f.users.bona, f.groups.engineering, 'MANAGE'],
  );
  // Carl: read on exactly one document, granted directly
  await grant(
    ['subject_user_id', 'target_document_id', 'permission'],
    [f.users.carl, f.documents.runbook, 'READ'],
  );
  // Ana is denied one Payroll document even though her HR role grants it:
  // SPEC.md:82's document-level override
  await grant(
    ['subject_user_id', 'target_document_id', 'permission'],
    [f.users.ana, f.documents.salaries, 'NONE'],
  );

  await verifyFixture();
}

/**
 * Assert the seeded graph actually behaves as documented above.
 *
 * This exists because the seed is built from placeholder-numbered INSERTs,
 * which is exactly the kind of code that silently grants the wrong thing: an
 * earlier version pointed a subject column at a document uuid and produced a
 * graph where tests would have "passed" against nonsense. Cheaper to fail here
 * than to trust the SQL by eye.
 */
async function verifyFixture(): Promise<void> {
  const f = FIXTURES;
  const can = async (user: string, doc: string, perm: 'READ' | 'WRITE' | 'MANAGE') => {
    const rows = await query<{ ok: boolean }>(
      'SELECT can_access_document($1, $2::uuid, $3::permission_kind) AS ok',
      [user, doc, perm],
    );
    return rows[0]?.ok === true;
  };

  const expected: Array<[string, string, 'READ' | 'WRITE' | 'MANAGE', boolean]> = [
    // Ana: HR role -> inherited READ on both HR documents, denied on salaries
    ['ana', f.documents.handbook, 'READ', true],
    ['ana', f.documents.salaries, 'READ', false],
    ['ana', f.documents.runbook, 'READ', false],
    // Bona: Engineering role read+write, personal MANAGE on the group
    ['bona', f.documents.runbook, 'READ', true],
    ['bona', f.documents.runbook, 'WRITE', true],
    ['bona', f.documents.privateIdea, 'WRITE', true],
    ['bona', f.documents.handbook, 'READ', false],
    // Carl: exactly one document, granted directly
    ['carl', f.documents.runbook, 'READ', true],
    ['carl', f.documents.privateIdea, 'READ', false],
    // Dana: nothing at all
    ['dana', f.documents.handbook, 'READ', false],
    ['dana', f.documents.runbook, 'READ', false],
  ];

  const names: Record<string, string> = {
    ana: f.users.ana,
    bona: f.users.bona,
    carl: f.users.carl,
    dana: f.users.dana,
  };
  const failures: string[] = [];
  for (const [who, doc, perm, want] of expected) {
    const got = await can(names[who] as string, doc, perm);
    if (got !== want) failures.push(`${who} ${perm} ${doc}: expected ${want}, got ${got}`);
  }
  if (failures.length > 0) {
    throw new Error(`seed fixture is wrong:\n  ${failures.join('\n  ')}`);
  }
}

if (require.main === module) {
  // Same --env=test convention as scripts/migrate.mjs, so `npm run seed` and
  // `npm run seed:test` differ by one flag and both stay portable (no cross-env,
  // no cmd.exe quoting).
  if (process.argv.includes('--env=test')) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('--env=test requires TEST_DATABASE_URL');
    reconfigure({ databaseUrl: url });
  }
  seed()
    .then(async () => {
      // eslint-disable-next-line no-console
      console.log('✓ seed complete');
      await closePool();
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
