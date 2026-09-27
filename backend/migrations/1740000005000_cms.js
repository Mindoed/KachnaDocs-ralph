const PgType = { jsonb: 'jsonb', text: 'text', uuid: 'uuid' };

/**
 * Phase 2: the CMS data model — categories, drafts, immutable versions, headings.
 *
 * Two design points come straight from ralph/PLAN.md and are worth stating
 * because they constrain everything above this file:
 *
 *  - PLAN.md 2.3: a published version is a self-contained snapshot (ProseMirror
 *    JSON + rendered Markdown + heading anchors), never reconstructed by
 *    replaying Yjs updates. So every column a reader needs lives on the version
 *    row itself.
 *  - PLAN.md 2.4: anchors are created once and never derived from heading text,
 *    hence a stored nanoid text column rather than a generated slug.
 *
 * Categories are deliberately NOT a new ACL target. They belong to a group and
 * are visible exactly where that group is, which keeps the phase-1 SQL functions
 * (accessible_groups / accessible_documents) the single source of truth instead
 * of adding a third resolution path to get wrong. Per-category grants are
 * recorded in ralph/DEFERRED.md.
 */
exports.up = (pgm) => {
  pgm.createTable('categories', {
    id: { type: PgType.uuid, primaryKey: true, default: pgm.func('gen_random_uuid()') },
    group_id: { type: PgType.uuid, notNull: true, references: 'groups(id)', onDelete: 'CASCADE' },
    name: { type: PgType.text, notNull: true },
    // Sibling order within a group, for the documentation tree.
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('categories', 'group_id');
  pgm.createIndex('categories', ['group_id', 'position']);

  // A category may be null: documents sit directly under a group in the phase-1
  // fixture, and forcing every document into a category would rewrite it.
  pgm.addColumns('documents', {
    category_id: { type: PgType.uuid, references: 'categories(id)', onDelete: 'SET NULL' },
    position: { type: 'integer', notNull: true, default: 0 },
    // The working copy. Deliberately nullable and, for now, the only writable
    // body: phase 3 moves this into y_state (PLAN.md 2.3) and this column
    // becomes what a publish reads from when there is no Yjs document.
    draft_body: { type: PgType.jsonb },
    draft_markdown: { type: PgType.text },
    draft_updated_at: { type: 'timestamptz' },
  });
  pgm.createIndex('documents', 'category_id');
  pgm.createIndex('documents', ['group_id', 'position']);

  pgm.createTable(
    'document_versions',
    {
      id: { type: PgType.uuid, primaryKey: true, default: pgm.func('gen_random_uuid()') },
      document_id: { type: PgType.uuid, notNull: true, references: 'documents(id)', onDelete: 'CASCADE' },
      // 1-based and contiguous per document: the version number is what a human
      // reads in the history panel, so it must not be the insertion order.
      number: { type: 'integer', notNull: true },
      // Title is snapshotted too: renaming a document must not rewrite history.
      title: { type: PgType.text, notNull: true },
      body: { type: PgType.jsonb, notNull: true },
      markdown: { type: PgType.text, notNull: true },
      author_id: { type: PgType.uuid, references: 'users(id)', onDelete: 'SET NULL' },
      comment: { type: PgType.text },
      published_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    // NOTE: no primaryKey/table-level option here. node-pg-migrate's
    // primaryKey: { columns: [...] } table option silently emits no constraint
    // (see 1740000003000_membership_pk) — use createIndex(unique) instead.
    {},
  );
  pgm.createIndex('document_versions', ['document_id', 'number'], { unique: true });
  pgm.createIndex('document_versions', 'document_id');

  pgm.createTable(
    'headings',
    {
      id: { type: PgType.uuid, primaryKey: true, default: pgm.func('gen_random_uuid()') },
      version_id: {
        type: PgType.uuid,
        notNull: true,
        references: 'document_versions(id)',
        onDelete: 'CASCADE',
      },
      anchor: { type: PgType.text, notNull: true },
      level: { type: 'integer', notNull: true },
      text: { type: PgType.text, notNull: true },
      ord: { type: 'integer', notNull: true, default: 0 },
    },
    {},
  );
  // Anchors address /documents/:slug#anchor, so lookups are by anchor. Unique
  // per version rather than globally, since a restored-as-draft copy legitimately
  // reuses the anchors it was published with.
  pgm.createIndex('headings', ['version_id', 'anchor'], { unique: true });
  pgm.createIndex('headings', 'anchor');

  // Immutability, enforced in the database rather than by convention. The
  // phase-2 test suite asserts an UPDATE fails, and a trigger is the only way
  // that assertion stays true once raw SQL helpers exist.
  pgm.sql(`
    CREATE FUNCTION document_versions_are_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'document_versions are immutable (published snapshot %)', OLD.id
          USING ERRCODE = 'check_violation';
      END;
      $fn$;

    CREATE TRIGGER document_versions_no_update
      BEFORE UPDATE ON document_versions
      FOR EACH ROW EXECUTE FUNCTION document_versions_are_immutable();

    CREATE TRIGGER document_versions_no_delete
      BEFORE DELETE ON document_versions
      FOR EACH ROW EXECUTE FUNCTION document_versions_are_immutable();
  `);
};

exports.down = (pgm) => {
  // The triggers guard against exactly the statements dropTable would issue if
  // a CASCADE had to remove rows, so they go first.
  pgm.sql(`
    DROP TRIGGER IF EXISTS document_versions_no_delete ON document_versions;
    DROP TRIGGER IF EXISTS document_versions_no_update ON document_versions;
    DROP FUNCTION IF EXISTS document_versions_are_immutable();
  `);
  pgm.dropTable('headings');
  pgm.dropTable('document_versions');
  pgm.dropColumns('documents', [
    'category_id',
    'position',
    'draft_body',
    'draft_markdown',
    'draft_updated_at',
  ]);
  pgm.dropTable('categories');
};
