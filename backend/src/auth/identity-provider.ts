/**
 * Identity abstraction (PLAN.md §2.2). Nothing outside the provider
 * implementations may know whether an identity came from Discord or from the
 * dev seed — that is what lets the whole ACL be built and tested with no
 * Discord credentials in the environment.
 */
export interface IdentityProvider {
  readonly name: 'discord' | 'dev';
  /** Exchange an auth code (or dev handle) for the external identity. */
  resolveIdentity(credential: string): Promise<ExternalIdentity>;
  /** Current role membership for a user; drives SPEC.md:86 role sync. */
  fetchRoleMembership(externalUserId: string): Promise<ExternalRole[]>;
}

export interface ExternalIdentity {
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ExternalRole {
  externalId: string;
  name: string;
}
