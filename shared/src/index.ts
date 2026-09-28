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
  | {
      kind: 'role-inherited';
      roleId: string;
      roleName: string;
      viaTargetKind: PermissionTargetKind;
      viaTargetId: string;
      viaTargetName: string;
    };

export interface EffectivePermission {
  permission: Permission;
  source: PermissionSource;
}

/**
 * One row of `GET /permissions/effective`: an effective grant resolved for a
 * user, naming what it applies to and where it came from. Lives here so the
 * admin view cannot drift from the controller's response.
 */
export interface EffectiveGrant extends EffectivePermission {
  targetKind: PermissionTargetKind;
  targetId: string;
  targetName: string;
}

export type DocumentState = 'Draft' | 'Published' | 'Archived';

/**
 * Display labels for the state badge (SPEC.md §1 "Zobrazovat stav dokumentu").
 *
 * In `shared/` because two panels render the same badge — the tree row and the
 * history header — and a label map duplicated across them is how one of them ends
 * up saying "Publikováno" while the other says "Published". The enum itself stays
 * English: it is what the API and the database store.
 */
export const DOCUMENT_STATE_LABEL: Record<DocumentState, string> = {
  Draft: 'Koncept',
  Published: 'Publikováno',
  Archived: 'Archivováno',
};

/**
 * CMS response shapes (phase 2). They live here rather than in `frontend/src`
 * because PLAN.md §1 makes `shared/` the thing that stops the two sides drifting:
 * a controller that renames a field stops typechecking the panel that reads it,
 * instead of producing `undefined` at runtime.
 */
export interface DocumentDto {
  id: string;
  slug: string;
  title: string;
  state: DocumentState;
  groupId: string;
  groupName: string;
  categoryId: string | null;
  categoryName: string | null;
  position: number;
  /** SPEC.md:95 — a document may be owned by a Discord role rather than a person. */
  ownerRole: { id: string; name: string } | null;
  /** Highest published version number, or null when never published. */
  latestVersion: number | null;
}

export interface GroupDto {
  id: string;
  parentId: string | null;
  name: string;
  documentCount: number;
}

export interface CategoryDto {
  id: string;
  groupId: string;
  name: string;
  position: number;
  documentCount: number;
}

/** One entry of `GET /documents/:id/versions` — SPEC.md §1's history list. */
export interface VersionSummaryDto {
  number: number;
  /** Title as it stood when this version was published, not the current one. */
  title: string;
  authorId: string | null;
  authorName: string | null;
  comment: string | null;
  publishedAt: string;
}

export interface HeadingDto {
  anchor: string;
  level: number;
  text: string;
  ord: number;
}

export interface VersionDto extends VersionSummaryDto {
  body: unknown;
  markdown: string;
  headings: HeadingDto[];
}

/** Body of `GET /documents/:id/content`. */
export interface ContentDto {
  ref: 'draft' | 'published';
  number: number | null;
  title: string;
  body: unknown;
  markdown: string | null;
}

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLineDto {
  op: DiffOp;
  text: string;
  before: number | null;
  after: number | null;
}

/** Body of `GET /documents/:id/versions/:number/diff`. */
export interface DiffDto {
  from: string;
  /** A version label like `v2`, or `draft` when compared against the caller's draft. */
  to: string;
  summary: { added: number; removed: number; unchanged: number };
  lines: DiffLineDto[];
}

/**
 * The y-websocket sub-protocol message ids, in one place instead of two.
 *
 * These are fixed by y-websocket and y-protocols (not ours to choose), but the
 * gateway and the browser client both branch on them, and a value that drifted
 * between the two would misframe every message — a symptom that reads as a
 * networking failure rather than an off-by-one. Naming them here is the only
 * reason they appear twice in the tree.
 */
export const RT_MESSAGE = { sync: 0, awareness: 1, auth: 2, queryAwareness: 3 } as const;
/** Sub-types inside an RT_MESSAGE.sync frame, per y-protocols/sync. */
export const RT_SYNC = { step1: 0, step2: 1, update: 2 } as const;

/** Y.XmlFragment name the Tiptap Collaboration extension binds the draft to. */
export const RT_FRAGMENT = 'prosemirror';

/**
 * Who the websocket announces to other collaborators.
 *
 * Deliberately a fixed, narrow shape rather than `AuthUser`: this is placed on a
 * public awareness record and broadcast to everyone joined to the document, so
 * whatever is added here is disclosed to every reader of that document. `avatarUrl`
 * is left out for exactly that reason — a Discord avatar URL is not something a
 * document reader needs in order to see a caret, and awareness has no ACL of its
 * own once a client holds the ticket.
 */
export interface AwarenessUser {
  id: string;
  displayName: string;
  /** Stable per session; drives the remote cursor colour. */
  color: string;
  /** Whether this connection may write. `READ` joins are read-only (SPEC.md §2). */
  canWrite: boolean;
}

/** Body of `POST /documents/:id/realtime-token`. */
export interface RealtimeTicketDto {
  /** Single-purpose, short-lived credential the websocket presents as a query param. */
  ticket: string;
  /** websocket path, including the document the ticket is valid for. */
  url: string;
  documentId: string;
  /** What the server will enforce for this connection, not what the client guessed. */
  permission: Extract<Permission, 'READ' | 'WRITE'>;
  expiresInSeconds: number;
}

/**
 * A heading resolved from another document, for the live reference node
 * (ralph/PLAN.md §2.5). Resolved at read time against the target's newest
 * published version — never a copy of the target's text.
 */
export interface ResolvedHeadingDto {
  target: 'ok' | 'inaccessible';
  documentId: string;
  slug: string | null;
  title: string | null;
  anchor: string;
  level: number | null;
  /** Current published heading text. Null and withheld when `target` is `inaccessible`. */
  text: string | null;
  /** Version the text came from, so a reader can tell that it moved. */
  version: number | null;
}

/** Query result of `GET /headings/resolve`. */
export interface ResolveHeadingsDto {
  headings: ResolvedHeadingDto[];
}

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
