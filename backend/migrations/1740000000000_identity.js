/* eslint-disable camelcase */

/**
 * Identity tables (SPEC.md §3). Discord is the identity provider: users and
 * roles originate there (or from DevIdentityProvider in dev/test), and
 * permissions attach to either kind of subject.
 */
exports.up = (pgm) => {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    external_id: { type: 'text', notNull: true, unique: true },
    display_name: { type: 'text', notNull: true },
    avatar_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('discord_roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    external_id: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
  });

  // Membership is synced from Discord (SPEC.md:86) and is authoritative only
  // as of the last sync; permissions reference role ids, never membership.
  pgm.createTable(
    'user_discord_roles',
    {
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users(id)',
        onDelete: 'CASCADE',
      },
      role_id: {
        type: 'uuid',
        notNull: true,
        references: 'discord_roles(id)',
        onDelete: 'CASCADE',
      },
      synced_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { primaryKey: { columns: ['user_id', 'role_id'] } },
  );
};

exports.down = (pgm) => {
  pgm.dropTable('user_discord_roles');
  pgm.dropTable('discord_roles');
  pgm.dropTable('users');
};
