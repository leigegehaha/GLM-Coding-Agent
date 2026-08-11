import type {
  ClawHubMarketplacePage,
  ClawHubMarketplaceQuery,
  SkillMarketplaceItem,
} from '../../shared/skills/constants';
import { SkillMarketplaceSource } from '../../shared/skills/constants';

export const CLAWHUB_MARKET_TAG = {
  id: 'clawhub',
  en: 'ClawHub',
  zh: 'ClawHub',
};

export const CLAWHUB_MARKETPLACE_PAGE_SIZE = 50;

const CLAWHUB_SKILLS_API_URL = 'https://clawhub.ai/api/v1/skills';
const CLAWHUB_SEARCH_API_URL = 'https://clawhub.ai/api/v1/search';

type MarketplaceValue = {
  localSkill?: unknown[];
  marketplace?: unknown[];
  marketTags?: unknown[];
  [key: string]: unknown;
};

type ClawHubSkill = {
  slug?: unknown;
  displayName?: unknown;
  summary?: unknown;
  description?: unknown;
  tags?: { latest?: unknown };
  latestVersion?: { version?: unknown };
};

type ClawHubSearchResult = ClawHubSkill & {
  canonicalUrl?: unknown;
  ownerHandle?: unknown;
  version?: unknown;
  native?: {
    ownerHandle?: unknown;
    skill?: ClawHubSkill;
    latestVersion?: { version?: unknown };
  };
};

const parseRecord = (data: string | null): Record<string, unknown> | null => {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const readMarketplaceValue = (root: Record<string, unknown>): {
  value: MarketplaceValue;
  valueWasString: boolean;
} => {
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : {};
  const rawValue = data.value;
  if (typeof rawValue === 'string') {
    const parsedValue = parseRecord(rawValue);
    return { value: parsedValue ?? {}, valueWasString: true };
  }
  return {
    value: rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
      ? rawValue as MarketplaceValue
      : {},
    valueWasString: false,
  };
};

const readString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const buildClawHubSkill = (
  rawSkill: ClawHubSearchResult,
  fallbackSkill?: ClawHubSkill,
): SkillMarketplaceItem | null => {
  const skill = fallbackSkill ?? rawSkill;
  const slug = readString(rawSkill.slug) || readString(skill.slug);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null;
  const ownerHandle = readString(rawSkill.ownerHandle) || readString(rawSkill.native?.ownerHandle);
  const displayName = readString(rawSkill.displayName) || readString(skill.displayName) || slug;
  const description = readString(rawSkill.summary)
    || readString(skill.summary)
    || readString(rawSkill.description)
    || readString(skill.description)
    || displayName;
  const latestVersion = rawSkill.version
    ?? rawSkill.latestVersion?.version
    ?? rawSkill.native?.latestVersion?.version
    ?? skill.latestVersion?.version
    ?? (rawSkill.native ? undefined : skill.tags?.latest);
  const version = readString(latestVersion) || '0.0.0';
  const installUrl = ownerHandle
    ? `https://clawhub.ai/skills/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(slug)}`
    : `https://clawhub.ai/skills/${encodeURIComponent(slug)}`;
  const canonicalPath = readString(rawSkill.canonicalUrl);
  const sourceUrl = canonicalPath.startsWith('/')
    ? `https://clawhub.ai${canonicalPath}`
    : installUrl;
  return {
    id: slug,
    name: displayName,
    description,
    tags: [SkillMarketplaceSource.ClawHub],
    url: installUrl,
    version,
    source: {
      from: 'ClawHub',
      url: sourceUrl,
      ...(ownerHandle ? { author: ownerHandle } : {}),
    },
  };
};

const mapClawHubSkills = (items: unknown[]): SkillMarketplaceItem[] => {
  return items.flatMap((item): SkillMarketplaceItem[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const rawSkill = item as ClawHubSearchResult;
    const mapped = buildClawHubSkill(rawSkill, rawSkill.native?.skill);
    return mapped ? [mapped] : [];
  });
};

export function buildClawHubMarketplaceUrl(query: ClawHubMarketplaceQuery): string {
  const searchQuery = readString(query.query).slice(0, 200);
  const requestedLimit = Number.isFinite(query.limit) ? Math.floor(query.limit ?? 0) : 0;
  const limit = Math.min(Math.max(requestedLimit || CLAWHUB_MARKETPLACE_PAGE_SIZE, 1), 50);
  const url = new URL(searchQuery ? CLAWHUB_SEARCH_API_URL : CLAWHUB_SKILLS_API_URL);
  url.searchParams.set('limit', String(limit));
  if (searchQuery) {
    url.searchParams.set('q', searchQuery);
  } else {
    url.searchParams.set('sort', 'downloads');
    const cursor = readString(query.cursor);
    if (cursor) url.searchParams.set('cursor', cursor);
  }
  return url.toString();
}

export function parseClawHubMarketplacePage(
  data: string,
  isSearch: boolean,
): ClawHubMarketplacePage {
  const root = parseRecord(data);
  if (!root) throw new Error('Invalid ClawHub response');
  const rawItems = isSearch ? root.results : root.items;
  if (!Array.isArray(rawItems)) throw new Error('Invalid ClawHub skill list');
  return {
    skills: mapClawHubSkills(rawItems),
    nextCursor: isSearch ? null : readString(root.nextCursor) || null,
  };
}

export function mergePublicSkillMarketplace(
  primaryData: string | null,
  clawHubData: string | null,
): string {
  const root = parseRecord(primaryData) ?? { data: { value: {} } };
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : {};
  root.data = data;

  const { value, valueWasString } = readMarketplaceValue(root);
  const existingSkills = Array.isArray(value.marketplace) ? value.marketplace : [];
  const existingIds = new Set(existingSkills.flatMap((skill): string[] => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return [];
    const id = (skill as Record<string, unknown>).id;
    return typeof id === 'string' ? [id] : [];
  }));
  const clawHubRoot = parseRecord(clawHubData);
  const publicSkills = mapClawHubSkills(
    clawHubRoot && Array.isArray(clawHubRoot.items) ? clawHubRoot.items : [],
  ).filter(skill => (
    !existingIds.has(String(skill.id))
  ));
  const existingTags = Array.isArray(value.marketTags) ? value.marketTags : [];
  const hasClawHubTag = existingTags.some(tag => (
    tag && typeof tag === 'object' && !Array.isArray(tag)
      && (tag as Record<string, unknown>).id === CLAWHUB_MARKET_TAG.id
  ));
  const nextValue: MarketplaceValue = {
    ...value,
    marketplace: [...existingSkills, ...publicSkills],
    marketTags: hasClawHubTag || publicSkills.length === 0
      ? existingTags
      : [...existingTags, CLAWHUB_MARKET_TAG],
  };
  data.value = valueWasString ? JSON.stringify(nextValue) : nextValue;
  return JSON.stringify(root);
}
