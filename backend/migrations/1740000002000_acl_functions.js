/* eslint-disable camelcase */

/**
 * ACL resolution in SQL (PLAN.md §3). Every later read path (documents,
 * search, websocket, AI retrieval) filters by calling these functions, so
 * permission logic exists exactly once and cannot be "forgotten" in
 * application code.
 *
 * Semantics:
 *  - Rank hierarchy: MANAGE >= WRITE >= READ. NONE (rank 0) is an explicit
 *    deny, which is what makes SPEC.md:82 ("přepsání zděděného oprávnění na
 *    úrovni dokumentu") expressible — without a deny value an override could
 *    only ever widen access.
 *  - Subjects: the user directly, and any Discord role they hold.
 *  - Propagation: a grant or deny on a group applies to that group, all
 *    descendant groups, and every document inside them. A grant or deny on a
 *    document applies to that document only.
 *  - Default deny: no applicable grant => no access.
 *  - Deny wins: an applicable NONE grant removes access even when another path
 *    would grant it.
 *  - Every row carries a source label for SPEC.md:84 (direct / inherited /
 *    role / role-inherited) including the origin's human-readable name.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION permission_rank(p permission_kind) RETURNS int
      LANGUAGE sql IMMUTABLE AS $fn$
        SELECT CASE p
          WHEN 'NONE' THEN 0
          WHEN 'READ' THEN 1
          WHEN 'WRITE' THEN 2
          WHEN 'MANAGE' THEN 3
        END;
      $fn$;

    -- Subjects the actor acts through: one row for the user themselves, one
    -- per Discord role. Columns are mutually exclusive so a grant can only
    -- ever match through a single subject, which keeps source labels honest.
    CREATE FUNCTION actor_subjects(actor uuid)
      RETURNS TABLE(user_id uuid, role_id uuid, role_name text, via_user boolean)
      LANGUAGE sql STABLE AS $fn$
        SELECT NULL::uuid, NULL::uuid, NULL::text, false
        UNION ALL
        SELECT actor, NULL, NULL, true
        WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = actor)
        UNION ALL
        SELECT NULL, r.id, r.name, false
        FROM user_discord_roles ur
        JOIN discord_roles r ON r.id = ur.role_id
        WHERE ur.user_id = actor;
      $fn$;

    -- Every (group, grant, source) reachable by the actor, with group
    -- hierarchy already expanded. Any permission value may appear, including
    -- NONE; callers decide what that means.
    CREATE FUNCTION group_grants_for(actor uuid)
      RETURNS TABLE(group_id uuid, permission permission_kind, source jsonb)
      LANGUAGE sql STABLE AS $fn$
      WITH RECURSIVE
      direct AS (
        SELECT
          g.id AS group_id,
          g.id AS origin_id,
          g.name AS origin_name,
          p.permission,
          s.via_user,
          s.role_id,
          s.role_name
        FROM permissions p
        JOIN actor_subjects(actor) s ON (
          (s.via_user AND p.subject_user_id = s.user_id) OR
          (NOT s.via_user AND p.subject_role_id = s.role_id)
        )
        JOIN groups g ON g.id = p.target_group_id
      ),
      expanded AS (
        SELECT * FROM direct
        UNION ALL
        SELECT
          c.id, e.origin_id, e.origin_name, e.permission,
          e.via_user, e.role_id, e.role_name
        FROM expanded e
        JOIN groups c ON c.parent_id = e.group_id
      )
      SELECT
        e.group_id,
        e.permission,
        CASE
          WHEN e.via_user AND e.group_id = e.origin_id
            THEN jsonb_build_object('kind', 'direct')
          WHEN e.via_user
            THEN jsonb_build_object(
              'kind', 'inherited',
              'viaTargetKind', 'group',
              'viaTargetId', e.origin_id,
              'viaTargetName', e.origin_name)
          WHEN e.group_id = e.origin_id
            THEN jsonb_build_object(
              'kind', 'role', 'roleId', e.role_id, 'roleName', e.role_name)
          ELSE jsonb_build_object(
              'kind', 'role-inherited',
              'roleId', e.role_id, 'roleName', e.role_name,
              'viaTargetKind', 'group',
              'viaTargetId', e.origin_id,
              'viaTargetName', e.origin_name)
        END AS source
      FROM expanded e;
      $fn$;

    -- Documents reachable through a group grant, plus direct document grants.
    CREATE FUNCTION document_grants_for(actor uuid)
      RETURNS TABLE(document_id uuid, permission permission_kind, source jsonb)
      LANGUAGE sql STABLE AS $fn$
        SELECT d.id, gg.permission, gg.source
        FROM group_grants_for(actor) gg
        JOIN documents d ON d.group_id = gg.group_id
        UNION
        SELECT
          p.target_document_id,
          p.permission,
          CASE WHEN su.id IS NOT NULL
            THEN jsonb_build_object('kind', 'direct')
            ELSE jsonb_build_object(
              'kind', 'role', 'roleId', r.id, 'roleName', r.name)
          END
        FROM permissions p
        LEFT JOIN users su ON su.id = p.subject_user_id
        LEFT JOIN discord_roles r ON r.id = p.subject_role_id
        WHERE p.target_document_id IS NOT NULL
          AND (
            p.subject_user_id = actor
            OR p.subject_role_id IN (
              SELECT ur.role_id FROM user_discord_roles ur WHERE ur.user_id = actor
            )
          );
      $fn$;

    -- Accessible documents: best applicable grant per document, minus any
    -- document carrying an applicable NONE.
    CREATE FUNCTION accessible_documents(
      actor uuid, min_permission permission_kind DEFAULT 'READ'
    ) RETURNS TABLE(document_id uuid, permission permission_kind, source jsonb)
      LANGUAGE sql STABLE AS $fn$
      WITH ranked AS (
        SELECT DISTINCT ON (dg.document_id)
          dg.document_id, dg.permission, dg.source
        FROM document_grants_for(actor) dg
        WHERE dg.permission <> 'NONE'
          AND permission_rank(dg.permission) >= permission_rank(min_permission)
        ORDER BY dg.document_id, permission_rank(dg.permission) DESC,
          -- a direct grant is preferred as the reported source over an
          -- inherited one of the same rank
          ((dg.source->>'kind') IN ('direct', 'role')) DESC
      )
      SELECT r.document_id, r.permission, r.source
      FROM ranked r
      WHERE NOT EXISTS (
        SELECT 1 FROM document_grants_for(actor) d
        WHERE d.document_id = r.document_id AND d.permission = 'NONE'
      );
      $fn$;

    CREATE FUNCTION accessible_groups(actor uuid, min_permission permission_kind DEFAULT 'READ')
      RETURNS SETOF uuid
      LANGUAGE sql STABLE AS $fn$
        SELECT DISTINCT gg.group_id
        FROM group_grants_for(actor) gg
        WHERE gg.permission <> 'NONE'
          AND permission_rank(gg.permission) >= permission_rank(min_permission)
          AND NOT EXISTS (
            SELECT 1 FROM group_grants_for(actor) d
            WHERE d.group_id = gg.group_id AND d.permission = 'NONE'
          );
      $fn$;

    -- Boolean form for single-resource checks and websocket join gates.
    CREATE FUNCTION can_access_document(actor uuid, target uuid, min_permission permission_kind)
      RETURNS boolean
      LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS (
          SELECT 1 FROM accessible_documents(actor, min_permission) ad
          WHERE ad.document_id = target
        );
      $fn$;

    CREATE FUNCTION can_access_group(actor uuid, target uuid, min_permission permission_kind)
      RETURNS boolean
      LANGUAGE sql STABLE AS $fn$
        -- explicit column alias: for SETOF scalar the result column is named
        -- after the function, so rely on an alias list instead
        SELECT EXISTS (
          SELECT 1 FROM accessible_groups(actor, min_permission) ag(grp)
          WHERE ag.grp = target
        );
      $fn$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION can_access_group(uuid, uuid, permission_kind);
    DROP FUNCTION can_access_document(uuid, uuid, permission_kind);
    DROP FUNCTION accessible_groups(uuid, permission_kind);
    DROP FUNCTION accessible_documents(uuid, permission_kind);
    DROP FUNCTION document_grants_for(uuid);
    DROP FUNCTION group_grants_for(uuid);
    DROP FUNCTION actor_subjects(uuid);
    DROP FUNCTION permission_rank(permission_kind);
  `);
};
