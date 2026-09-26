/* eslint-disable camelcase */

/**
 * Fine-grained permissions (SPEC.md §3).
 *
 * A grant is (subject, target, permission) where the subject is a user or a
 * Discord role and the target is a group or a document. Resolution order is
 * document grant > group grant, direct > via-role, default deny. Inheritance
 * from an ancestor group is resolved in the SQL functions created by the next
 * migration so that callers never reimplement it.
 *
 * Note the target columns: exactly one of target_group_id / target_document_id
 * must be set. The same holds for the subject side.
 */
exports.up = (pgm) => {
  // Minimal document/group tables for phase 1; phase 2 extends them
  // (draft/published split, versions). Kept minimal deliberately: permission
  // targets must exist before ACL can be tested.
  pgm.createTable('groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    parent_id: { type: 'uuid', references: 'groups(id)', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Enum types must be created before the tables that reference them;
  // pgm.createEnum emits a CREATE TYPE statement, so its return value is not a
  // usable column type.
  pgm.createType('document_state', ['Draft', 'Published', 'Archived']);

  pgm.createTable('documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    group_id: { type: 'uuid', notNull: true, references: 'groups(id)', onDelete: 'CASCADE' },
    slug: { type: 'text', notNull: true, unique: true },
    title: { type: 'text', notNull: true },
    state: { type: 'document_state', notNull: true, default: 'Draft' },
    // Owner is a Discord role (SPEC.md:87 — prefer role-owned documents).
    owner_role_id: { type: 'uuid', references: 'discord_roles(id)', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // NONE is the explicit-deny value: SPEC.md:82 requires overriding an
  // inherited permission at document level, which is inexpressible if grants
  // can only widen access. Read paths must treat NONE as "no access".
  pgm.createType('permission_kind', ['NONE', 'READ', 'WRITE', 'MANAGE']);

  pgm.createTable('permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    subject_user_id: { type: 'uuid', references: 'users(id)', onDelete: 'CASCADE' },
    subject_role_id: { type: 'uuid', references: 'discord_roles(id)', onDelete: 'CASCADE' },
    target_group_id: { type: 'uuid', references: 'groups(id)', onDelete: 'CASCADE' },
    target_document_id: { type: 'uuid', references: 'documents(id)', onDelete: 'CASCADE' },
    permission: { type: 'permission_kind', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('permissions', 'subject_user_id');
  pgm.createIndex('permissions', 'subject_role_id');
  pgm.createIndex('permissions', 'target_group_id');
  pgm.createIndex('permissions', 'target_document_id');

  // Exactly-one constraints on both sides of a grant.
  pgm.addConstraint('permissions', 'chk_permission_subject', {
    check: `(subject_user_id IS NOT NULL)::int + (subject_role_id IS NOT NULL)::int = 1`,
  });
  pgm.addConstraint('permissions', 'chk_permission_target', {
    check: `(target_group_id IS NOT NULL)::int + (target_document_id IS NOT NULL)::int = 1`,
  });
};

exports.down = (pgm) => {
  pgm.dropTable('permissions');
  pgm.dropType('permission_kind');
  pgm.dropTable('documents');
  pgm.dropType('document_state');
  pgm.dropTable('groups');
};
