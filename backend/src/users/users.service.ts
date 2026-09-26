import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@kachnadocs/shared';
import { query } from '../db';
import type { ExternalIdentity, ExternalRole } from '../auth/identity-provider';

@Injectable()
export class UsersService {
  /** Upsert a user by external id and return the internal row. */
  async upsertFromIdentity(identity: ExternalIdentity): Promise<{ id: string }> {
    const rows = await query<{ id: string }>(
      `INSERT INTO users (external_id, display_name, avatar_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url
       RETURNING id`,
      [identity.externalId, identity.displayName, identity.avatarUrl],
    );
    const row = rows[0];
    if (!row) throw new Error('upsert returned no row');
    return { id: row.id };
  }

  async findById(id: string): Promise<AuthUser | null> {
    const rows = await query<{
      id: string;
      external_id: string;
      display_name: string;
      avatar_url: string | null;
      roles: Array<{ id: string; name: string }>;
    }>(
      `SELECT u.id, u.external_id, u.display_name, u.avatar_url,
              COALESCE(
                json_agg(json_build_object('id', r.id, 'name', r.name))
                  FILTER (WHERE r.id IS NOT NULL),
                '[]'
              ) AS roles
         FROM users u
         LEFT JOIN user_discord_roles ur ON ur.user_id = u.id
         LEFT JOIN discord_roles r ON r.id = ur.role_id
        WHERE u.id = $1
        GROUP BY u.id`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      externalId: row.external_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      roles: row.roles,
    };
  }

  async findByExternalId(externalId: string): Promise<{ id: string } | null> {
    const rows = await query<{ id: string }>('SELECT id FROM users WHERE external_id = $1', [externalId]);
    return rows[0] ?? null;
  }

  /**
   * Replace a user's role membership with the provider's current view
   * (SPEC.md:86). Roles are created on demand: the ACL refers to roles by
   * external id, so a role seen for the first time can already hold grants.
   */
  async syncRoles(userId: string, roles: ExternalRole[]): Promise<void> {
    const roleIds: string[] = [];
    for (const role of roles) {
      const rows = await query<{ id: string }>(
        `INSERT INTO discord_roles (external_id, name)
         VALUES ($1, $2)
         ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [role.externalId, role.name],
      );
      const id = rows[0]?.id;
      if (id) roleIds.push(id);
    }
    await query(
      `DELETE FROM user_discord_roles WHERE user_id = $1 AND NOT (role_id = ANY($2::uuid[]))`,
      [userId, roleIds],
    );
    for (const roleId of roleIds) {
      await query(
        `INSERT INTO user_discord_roles (user_id, role_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, roleId],
      );
    }
  }

  async listAll(): Promise<AuthUser[]> {
    const rows = await query<{ id: string }>(`SELECT id FROM users ORDER BY display_name`);
    const out: AuthUser[] = [];
    for (const row of rows) {
      const user = await this.findById(row.id);
      if (user) out.push(user);
    }
    return out;
  }
}
