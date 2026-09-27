/**
 * The phase-2 immutability trigger is too blunt as written: a BEFORE DELETE
 * trigger also fires for an ON DELETE CASCADE, so deleting any document that
 * had ever been published failed with "document_versions are immutable" —
 * discovered by deleting a document over HTTP, not by any version-level test.
 *
 * Distinguishing the two cases: Postgres cascades a parent delete *after* the
 * parent row is gone. Verified against this database before writing it —
 * a probe trigger reports the parent present for a direct version DELETE and
 * absent for the cascaded one.
 *
 * That makes the guard precise: deleting a version while its document still
 * exists is exactly the history-rewriting we want to forbid; deleting the
 * document takes its history with it, which SPEC.md §1's delete requires.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION document_versions_are_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        -- A cascaded delete arrives after its parent document row is removed.
        IF TG_OP = 'DELETE' AND NOT EXISTS (
          SELECT 1 FROM documents WHERE id = OLD.document_id
        ) THEN
          RETURN OLD;
        END IF;

        RAISE EXCEPTION 'document_versions are immutable (published snapshot %)', COALESCE(OLD.id, NEW.id)
          USING ERRCODE = 'check_violation';
      END;
      $fn$;
  `);
};

exports.down = (pgm) => {
  // Restores the phase-2 behaviour, cascade included.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION document_versions_are_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'document_versions are immutable (published snapshot %)', OLD.id
          USING ERRCODE = 'check_violation';
      END;
      $fn$;
  `);
};
