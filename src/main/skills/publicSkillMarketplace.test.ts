import { describe, expect, test } from 'vitest';

import {
  buildClawHubMarketplaceUrl,
  CLAWHUB_MARKETPLACE_PAGE_SIZE,
  mergePublicSkillMarketplace,
  parseClawHubMarketplacePage,
} from './publicSkillMarketplace';

describe('ClawHub marketplace pages', () => {
  test('requests 50 popular skills by default and preserves the browse cursor', () => {
    const url = new URL(buildClawHubMarketplaceUrl({ cursor: 'next page' }));

    expect(url.pathname).toBe('/api/v1/skills');
    expect(url.searchParams.get('limit')).toBe(String(CLAWHUB_MARKETPLACE_PAGE_SIZE));
    expect(url.searchParams.get('sort')).toBe('downloads');
    expect(url.searchParams.get('cursor')).toBe('next page');
  });

  test('uses the ClawHub search API for queries', () => {
    const url = new URL(buildClawHubMarketplaceUrl({ query: ' GitHub Actions ' }));

    expect(url.pathname).toBe('/api/v1/search');
    expect(url.searchParams.get('q')).toBe('GitHub Actions');
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  test('maps browse results and returns nextCursor', () => {
    const page = parseClawHubMarketplacePage(JSON.stringify({
      items: [{
        slug: 'github',
        displayName: 'GitHub',
        summary: 'Work with GitHub repositories.',
        latestVersion: { version: '1.0.0' },
      }],
      nextCursor: 'cursor-2',
    }), false);

    expect(page.nextCursor).toBe('cursor-2');
    expect(page.skills).toEqual([expect.objectContaining({
      id: 'github',
      url: 'https://clawhub.ai/skills/github',
      version: '1.0.0',
    })]);
  });

  test('maps search results to the exact publisher install source', () => {
    const page = parseClawHubMarketplacePage(JSON.stringify({
      results: [{
        slug: 'github',
        displayName: 'GitHub',
        summary: 'Work with GitHub repositories.',
        ownerHandle: 'steipete',
        canonicalUrl: '/steipete/skills/github',
        version: '2.0.0',
      }],
    }), true);

    expect(page.nextCursor).toBeNull();
    expect(page.skills[0]).toEqual(expect.objectContaining({
      id: 'github',
      url: 'https://clawhub.ai/skills/steipete/github',
      version: '2.0.0',
      source: expect.objectContaining({
        author: 'steipete',
        url: 'https://clawhub.ai/steipete/skills/github',
      }),
    }));
  });

  test('does not expose ClawHub internal version IDs as semantic versions', () => {
    const page = parseClawHubMarketplacePage(JSON.stringify({
      results: [{
        slug: 'github',
        displayName: 'GitHub',
        ownerHandle: 'steipete',
        native: {
          skill: {
            slug: 'github',
            tags: { latest: 'internal-version-record-id' },
          },
        },
      }],
    }), true);

    expect(page.skills[0].version).toBe('0.0.0');
  });
});

describe('mergePublicSkillMarketplace', () => {
  test('adds public ClawHub skills to an empty local catalog', () => {
    const result = JSON.parse(mergePublicSkillMarketplace(null, JSON.stringify({
      items: [{
        slug: 'github',
        displayName: 'GitHub',
        summary: 'Work with GitHub repositories.',
        latestVersion: { version: '1.0.0' },
      }],
    })));

    expect(result.data.value.marketplace).toEqual([expect.objectContaining({
      id: 'github',
      name: 'GitHub',
      url: 'https://clawhub.ai/skills/github',
      version: '1.0.0',
      tags: ['clawhub'],
    })]);
    expect(result.data.value.marketTags).toContainEqual({
      id: 'clawhub',
      en: 'ClawHub',
      zh: 'ClawHub',
    });
  });

  test('preserves the primary catalog and removes duplicate public IDs', () => {
    const primary = JSON.stringify({
      data: {
        value: JSON.stringify({
          marketplace: [{ id: 'github', name: 'Curated GitHub' }],
          marketTags: [{ id: 'official', en: 'Official', zh: '官方' }],
          localSkill: [{ id: 'built-in' }],
        }),
      },
    });
    const merged = JSON.parse(mergePublicSkillMarketplace(primary, JSON.stringify({
      items: [
        { slug: 'github', displayName: 'GitHub' },
        { slug: 'ontology', displayName: 'Ontology', tags: { latest: '1.0.4' } },
      ],
    })));
    const value = JSON.parse(merged.data.value);

    expect(value.marketplace.map((skill: { id: string }) => skill.id)).toEqual([
      'github',
      'ontology',
    ]);
    expect(value.localSkill).toEqual([{ id: 'built-in' }]);
    expect(value.marketTags.map((tag: { id: string }) => tag.id)).toEqual([
      'official',
      'clawhub',
    ]);
  });
});
