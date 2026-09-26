import { Injectable } from '@nestjs/common';
import type { ExternalIdentity, ExternalRole, IdentityProvider } from './identity-provider';

/**
 * Fixed identities for dev and test (PLAN.md §2.2). The credential is simply
 * the handle — `ana`, `bona`, `carl` — so a test can authenticate as anyone
 * without a browser, and the loop never needs Discord credentials.
 *
 * Seeded ACL in src/seed.ts refers to these handles and to the fake roles
 * below; keep the two lists in sync.
 */
const DIRECTORY: Record<string, { identity: ExternalIdentity; roles: ExternalRole[] }> = {
  ana: {
    identity: { externalId: 'dev-ana', displayName: 'Ana Kadlecová', avatarUrl: null },
    // HR: broad read over the whole tree.
    roles: [{ externalId: 'role-hr', name: 'HR' }],
  },
  bona: {
    identity: { externalId: 'dev-bona', displayName: 'Bora Novák', avatarUrl: null },
    // Engineering: reads/writes engineering content only.
    roles: [{ externalId: 'role-eng', name: 'Engineering' }],
  },
  carl: {
    identity: { externalId: 'dev-carl', displayName: 'Carl Dvořák', avatarUrl: null },
    // No roles: only what is granted to him personally.
    roles: [],
  },
  dana: {
    identity: { externalId: 'dev-dana', displayName: 'Dana Svobodová', avatarUrl: null },
    // Nobody: seeded without any grant at all, to prove default deny.
    roles: [],
  },
};

@Injectable()
export class DevIdentityProvider implements IdentityProvider {
  readonly name = 'dev' as const;

  async resolveIdentity(credential: string): Promise<ExternalIdentity> {
    const entry = DIRECTORY[credential.toLowerCase()];
    if (!entry) {
      throw new Error(`Unknown dev identity "${credential}" (known: ${Object.keys(DIRECTORY).join(', ')})`);
    }
    return entry.identity;
  }

  async fetchRoleMembership(externalUserId: string): Promise<ExternalRole[]> {
    const handle = Object.keys(DIRECTORY).find((h) => DIRECTORY[h]?.identity.externalId === externalUserId);
    if (!handle) return [];
    return DIRECTORY[handle]?.roles ?? [];
  }
}
