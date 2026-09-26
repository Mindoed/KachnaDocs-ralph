/* eslint-disable camelcase */

/**
 * user_discord_roles had no primary key: node-pg-migrate's
 * `primaryKey: { columns: [...] }` table option emitted no constraint here, so a
 * repeated role sync inserted duplicate membership rows and /auth/me reported
 * the same Discord role twice. Add the key for real.
 */
exports.up = (pgm) => {
  pgm.sql(`
    -- Deduplicate before adding the key; any duplicates came from repeated
    -- syncs run without the constraint.
    DELETE FROM user_discord_roles a
      USING user_discord_roles b
      WHERE a.user_id = b.user_id AND a.role_id = b.role_id AND a.ctid < b.ctid;

    ALTER TABLE user_discord_roles ADD PRIMARY KEY (user_id, role_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE user_discord_roles DROP CONSTRAINT user_discord_roles_pkey;');
};
