const PG_CYCLE = `
    CREATE FUNCTION groups_reject_cycle() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE
        -- plpgsql cannot begin an IF condition with WITH, so the walk result is
        -- read into a variable first.
        creates_cycle boolean;
      BEGIN
        IF NEW.parent_id IS NULL THEN
          RETURN NEW;
        END IF;

        IF NEW.parent_id = NEW.id THEN
          RAISE EXCEPTION 'group % cannot be its own parent', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;

        -- The same walk the ACL resolver performs (group_grants_for recurses
        -- over parent_id with UNION ALL and no cycle guard of its own), so a
        -- cycle here is caught at the write that would cause it rather than as
        -- a hung query on every subsequent permission check. Terminates because
        -- it stops at NULL, and a cycle is exactly what makes it find NEW.id.
        WITH RECURSIVE ancestors(id) AS (
          SELECT NEW.parent_id
          UNION ALL
          SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id
          WHERE g.parent_id IS NOT NULL
        )
        SELECT bool_or(a.id = NEW.id) INTO creates_cycle FROM ancestors a;

        IF creates_cycle THEN
          RAISE EXCEPTION 'reparenting group % would create a cycle', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END;
      $fn$;

    CREATE TRIGGER groups_no_cycle
      BEFORE INSERT OR UPDATE OF parent_id ON groups
      FOR EACH ROW EXECUTE FUNCTION groups_reject_cycle();
  `;

/**
 * A cycle in groups is not a bad-looking tree, it is a denial of service.
 * group_grants_for walks parent_id with UNION ALL and no cycle guard, so once a
 * cycle exists every call to accessible_groups / accessible_documents /
 * can_access_document recurses forever — verified against this database with a
 * statement_timeout, which is the only way to survive the experiment. Those
 * functions back every read path in the application, so a single bad row takes
 * down the whole API rather than one route.
 *
 * GroupsController.update already rejects cycles with a 400, which is the
 * user-facing answer. This trigger is the answer for every other way a parent_id
 * can change — seed, migration, or a psql session — and those are exactly the
 * paths that bypass a controller check.
 */
exports.up = (pgm) => {
  // Any existing cycle would make this migration fail rather than silently
  // succeed, which is the point: it must be impossible to be in a cyclic state
  // and pass. With no cycle present the check is instant.
  pgm.sql(PG_CYCLE);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS groups_no_cycle ON groups;
    DROP FUNCTION IF EXISTS groups_reject_cycle();
  `);
};
