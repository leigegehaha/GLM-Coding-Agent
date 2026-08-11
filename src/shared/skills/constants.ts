export const SkillIpcChannel = {
  FetchMarketplace: 'skills:fetchMarketplace',
  FetchClawHub: 'skills:fetchClawHub',
} as const;

export const SkillMarketplaceSource = {
  ClawHub: 'clawhub',
} as const;

export interface SkillMarketplaceItem {
  id: string;
  name: string;
  description: string | { en: string; zh: string };
  tags?: string[];
  url: string;
  version: string;
  source: {
    from: string;
    url: string;
    author?: string;
  };
}

export interface ClawHubMarketplaceQuery {
  cursor?: string;
  query?: string;
  limit?: number;
}

export interface ClawHubMarketplacePage {
  skills: SkillMarketplaceItem[];
  nextCursor: string | null;
}
