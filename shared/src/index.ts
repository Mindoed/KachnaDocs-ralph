/**
 * Permission a subject can be asked to hold over a group or a document
 * (SPEC.md §3). The checks an API endpoint can require.
 */
export const PERMISSIONS = ['READ', 'WRITE', 'MANAGE'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What a stored grant may hold: the required permissions plus NONE, the
 * explicit deny that makes SPEC.md:82 (override an inherited grant at document
 * level) expressible. Nothing may *require* NONE, so it is deliberately absent
 * from `Permission`.
 */
export const GRANT_KINDS = ['NONE', ...PERMISSIONS] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** Ordering implied by the grant itself, used for "does grant X suffice". */
export const PERMISSION_RANK: Record<GrantKind, number> = {
  NONE: 0,
  READ: 1,
  WRITE: 2,
  MANAGE: 3,
};

/** What a permission grant is attached to. */
export type PermissionSubjectKind = 'user' | 'discord_role';
export type PermissionTargetKind = 'group' | 'document';

/** Where an effective permission came from (SPEC.md:84 — "zděděno z HR" vs "přiděleno přímo"). */
export type PermissionSource =
  | { kind: 'direct' }
  | { kind: 'inherited'; viaTargetKind: PermissionTargetKind; viaTargetId: string; viaTargetName: string }
  | { kind: 'role'; roleId: string; roleName: string }
  | { kind: 'role-inherited'; roleId: string; roleName: string; viaTargetKind: PermissionTargetKind; viaTargetId: string; viaTargetName: string };

export interface EffectivePermission {
  permission: Permission;
  source: PermissionSource;
}

export type DocumentState = 'Draft' | 'Published' | 'Archived';

export interface AuthUser {
  id: string;
  /** Discord snowflake as string, or a synthetic `dev-*` id for the dev provider. */
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
  roles: Array<{ id: string; name: string }>;
}

/**
 * Uniform error body. "No READ permission" and "no such document" MUST produce
 * byte-identical responses (PLAN.md §3) so document existence is not a side channel.
 */
export interface ApiErrorBody {
  error: {
    code: 'not_found' | 'forbidden' | 'unauthorized' | 'validation_failed' | 'internal';
    message: string;
    details?: unknown;
  };
}
