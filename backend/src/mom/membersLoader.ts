import { db } from '../config/firebase';
import { Member } from './types';
import { MOM_CONFIG } from './config';
import { isPlaceholderRoll } from './pure';

export interface MembersLoader {
  getMembers(): Promise<Member[]>;
  invalidateCache(): void;
}

export class FirestoreMembersLoader implements MembersLoader {
  private cachedMembers: Member[] | null = null;
  private cacheExpiresAt = 0;
  private inFlightPromise: Promise<Member[]> | null = null;

  public async getMembers(): Promise<Member[]> {
    const now = Date.now();
    if (this.cachedMembers && now < this.cacheExpiresAt) {
      return this.cachedMembers;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = this.fetchFromFirestore().finally(() => {
      this.inFlightPromise = null;
    });

    return this.inFlightPromise;
  }

  public invalidateCache(): void {
    this.cachedMembers = null;
    this.cacheExpiresAt = 0;
  }

  private async fetchFromFirestore(): Promise<Member[]> {
    try {
      // 1. Enumerate domain documents
      const domainDocs = await db.collection('members').listDocuments();
      const allMembers: Member[] = [];

      // 2. Fetch members_listed from each domain document
      const domainPromises = domainDocs.map(async (domainRef) => {
        const domainSlug = domainRef.id;
        const subcoll = await domainRef.collection('members_listed').get();

        const domainMembers: Member[] = [];
        subcoll.forEach((doc) => {
          const data = doc.data();
          const status = String(data.status || 'active').trim().toLowerCase();

          // Only active members count
          if (status !== 'active') {
            return;
          }

          const rollNo = String(data.rollNo || '').trim();
          const email = data.email ? String(data.email).trim().toLowerCase() : undefined;
          const position = String(data.position || '').trim();
          const primaryDomain = String(data.domain || domainSlug).trim().toLowerCase();
          const domains = Array.isArray(data.domains)
            ? data.domains.map((d: any) => String(d).trim().toLowerCase())
            : undefined;

          domainMembers.push({
            id: doc.id,
            name: String(data.name || '').trim(),
            rollNo,
            position,
            domain: primaryDomain,
            domains,
            status: 'active',
            email,
          });
        });

        return domainMembers;
      });

      const results = await Promise.all(domainPromises);
      for (const res of results) {
        allMembers.push(...res);
      }

      this.cachedMembers = allMembers;
      this.cacheExpiresAt = Date.now() + MOM_CONFIG.MEMBERS_CACHE_TTL_MS;

      return allMembers;
    } catch (err) {
      console.error('[MOM] Failed to fetch members from Firestore:', err);
      // If we have stale cache, fallback to it rather than crashing
      if (this.cachedMembers) {
        return this.cachedMembers;
      }
      throw err;
    }
  }
}

/**
 * Fixture-based loader for testing and harness
 */
export class FixtureMembersLoader implements MembersLoader {
  private members: Member[];

  constructor(members: Member[]) {
    this.members = members;
  }

  public async getMembers(): Promise<Member[]> {
    return this.members.filter((m) => m.status === 'active');
  }

  public invalidateCache(): void { }

  public setMembers(members: Member[]): void {
    this.members = members;
  }
}

export const defaultMembersLoader = new FirestoreMembersLoader();

