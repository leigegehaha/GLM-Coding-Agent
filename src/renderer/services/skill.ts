import type { ClawHubMarketplacePage } from '../../shared/skills/constants';
import { SkillMarketplaceSource } from '../../shared/skills/constants';
import { LocalizedText, LocalSkillInfo, MarketplaceSkill, MarketTag, Skill } from '../types/skill';
import { i18nService } from './i18n';
import { LogReporterAction, reportAnalytics } from './logReporter';

export function resolveLocalizedText(text: string | LocalizedText): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  const lang = i18nService.getLanguage();
  return text[lang] || text.en || '';
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function getSkillAnalyticsSource(skill: Skill): string {
  if (skill.isBuiltIn) return 'built_in';
  if (skill.isOfficial) return 'official';
  return 'custom';
}

type EmailConnectivityCheck = {
  code: 'imap_connection' | 'smtp_connection';
  level: 'pass' | 'fail';
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: 'pass' | 'fail';
  checks: EmailConnectivityCheck[];
};

export type EmailSkillAccountConfig = {
  id: string;
  name: string;
  enabled: boolean;
  provider?: string;
  email: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  imapRejectUnauthorized?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpRejectUnauthorized?: boolean;
  smtpFrom?: string;
  mailbox?: string;
  requireSendConfirmation?: boolean;
};

export type EmailSkillAccountsConfig = {
  version: 1;
  defaultAccountId: string;
  accounts: EmailSkillAccountConfig[];
};

export type MarketplaceCatalog = {
  skills: MarketplaceSkill[];
  tags: MarketTag[];
  clawHubNextCursor: string | null;
};

const CLAWHUB_MARKET_TAG: MarketTag = {
  id: SkillMarketplaceSource.ClawHub,
  en: 'ClawHub',
  zh: 'ClawHub',
};

const mergeMarketplaceSkills = (...skillGroups: MarketplaceSkill[][]): MarketplaceSkill[] => {
  const uniqueSkills = new Map<string, MarketplaceSkill>();
  for (const skill of skillGroups.flat()) {
    const sourceKey = skill.source?.url || skill.url || skill.id;
    uniqueSkills.set(`${skill.source?.from ?? 'unknown'}:${sourceKey}`, skill);
  }
  return [...uniqueSkills.values()];
};

class SkillService {
  private skills: Skill[] = [];
  private initialized = false;
  private localSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private marketplaceSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private installedKitSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private primaryMarketplaceCache: { skills: MarketplaceSkill[]; tags: MarketTag[] } | null = null;
  private primaryMarketplaceFetchPromise: Promise<{ skills: MarketplaceSkill[]; tags: MarketTag[] }> | null = null;
  private clawHubBrowseCache: ClawHubMarketplacePage | null = null;
  private clawHubBrowseFetchPromise: Promise<ClawHubMarketplacePage> | null = null;
  private clawHubSearchCache = new Map<string, ClawHubMarketplacePage>();
  private marketplaceCacheGeneration = 0;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadSkills();
    this.initialized = true;
  }

  async loadSkills(): Promise<Skill[]> {
    try {
      const result = await window.electron.skills.list();
      if (result.success && result.skills) {
        this.skills = result.skills;
      } else {
        this.skills = [];
      }
      await this.loadInstalledKitSkillDescriptions();
      return this.skills;
    } catch (error) {
      console.error('Failed to load skills:', error);
      this.skills = [];
      return this.skills;
    }
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    try {
      const previousSkill = this.skills.find(skill => skill.id === id);
      const result = await window.electron.skills.setEnabled({ id, enabled });
      if (result.success && result.skills) {
        this.skills = result.skills;
        const updatedSkill = this.skills.find(skill => skill.id === id) ?? previousSkill;
        if (enabled && previousSkill?.enabled !== true && updatedSkill) {
          void reportAnalytics({
            action: LogReporterAction.SkillEnabled,
            skillId: updatedSkill.id,
            skillName: updatedSkill.name,
            skillSource: getSkillAnalyticsSource(updatedSkill),
            isBuiltIn: updatedSkill.isBuiltIn,
            isOfficial: updatedSkill.isOfficial,
            version: updatedSkill.version,
          });
        }
        return this.skills;
      }
      throw new Error(result.error || 'Failed to update skill');
    } catch (error) {
      console.error('Failed to update skill:', error);
      throw error;
    }
  }

  async deleteSkill(id: string): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const result = await window.electron.skills.delete(id);
      if (result.success && result.skills) {
        this.skills = result.skills;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete skill';
      console.error('Failed to delete skill:', error);
      return { success: false, error: message };
    }
  }

  async downloadSkill(source: string): Promise<{
    success: boolean;
    skills?: Skill[];
    error?: string;
    auditReport?: any;
    pendingInstallId?: string;
  }> {
    try {
      const result = await window.electron.skills.download(source);
      if (result.success && result.skills) {
        this.skills = result.skills;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download skill';
      console.error('Failed to download skill:', error);
      return { success: false, error: message };
    }
  }

  async confirmInstall(
    pendingId: string,
    action: string
  ): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const result = await window.electron.skills.confirmInstall(pendingId, action);
      if (result.success && result.skills) {
        this.skills = result.skills;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to confirm install';
      console.error('Failed to confirm install:', error);
      return { success: false, error: message };
    }
  }

  async upgradeSkill(skillId: string, downloadUrl: string): Promise<{
    success: boolean;
    skills?: Skill[];
    error?: string;
    auditReport?: any;
    pendingInstallId?: string;
  }> {
    try {
      const result = await window.electron.skills.upgrade(skillId, downloadUrl);
      if (result.success && result.skills) {
        this.skills = result.skills;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upgrade skill';
      console.error('Failed to upgrade skill:', error);
      return { success: false, error: message };
    }
  }

  async getSkillsRoot(): Promise<string | null> {
    try {
      const result = await window.electron.skills.getRoot();
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to get skills root:', error);
      return null;
    }
  }

  onSkillsChanged(callback: () => void): () => void {
    return window.electron.skills.onChanged(callback);
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getEnabledSkills(): Skill[] {
    return this.skills.filter(s => s.enabled);
  }

  getSkillById(id: string): Skill | undefined {
    return this.skills.find(s => s.id === id);
  }

  async getSkillConfig(skillId: string): Promise<Record<string, string>> {
    try {
      const result = await window.electron.skills.getConfig(skillId);
      if (result.success && result.config) {
        return result.config;
      }
      return {};
    } catch (error) {
      console.error('Failed to get skill config:', error);
      return {};
    }
  }

  async setSkillConfig(skillId: string, config: Record<string, string>): Promise<boolean> {
    try {
      const result = await window.electron.skills.setConfig(skillId, config);
      return result.success;
    } catch (error) {
      console.error('Failed to set skill config:', error);
      return false;
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<EmailConnectivityTestResult | null> {
    try {
      const result = await window.electron.skills.testEmailConnectivity(skillId, config);
      if (result.success && result.result) {
        return result.result;
      }
      return null;
    } catch (error) {
      console.error('Failed to test email connectivity:', error);
      return null;
    }
  }

  async getEmailAccountsConfig(skillId: string): Promise<EmailSkillAccountsConfig> {
    try {
      console.debug('[EmailSkill] loading email accounts config', { skillId });
      const result = await window.electron.skills.getEmailAccountsConfig(skillId);
      if (result.success && result.config) {
        console.debug('[EmailSkill] loaded email accounts config', {
          skillId,
          accountCount: result.config.accounts.length,
          enabledAccountCount: result.config.accounts.filter(account => account.enabled).length,
          defaultAccountId: result.config.defaultAccountId,
        });
        return result.config;
      }
      console.warn('[EmailSkill] failed to load email accounts config', { skillId, error: result.error });
      return { version: 1, defaultAccountId: '', accounts: [] };
    } catch (error) {
      console.error('Failed to get email accounts config:', error);
      return { version: 1, defaultAccountId: '', accounts: [] };
    }
  }

  async setEmailAccountsConfig(
    skillId: string,
    config: EmailSkillAccountsConfig,
  ): Promise<boolean> {
    try {
      console.debug('[EmailSkill] saving email accounts config', {
        skillId,
        accountCount: config.accounts.length,
        enabledAccountCount: config.accounts.filter(account => account.enabled).length,
        defaultAccountId: config.defaultAccountId,
      });
      const result = await window.electron.skills.setEmailAccountsConfig(skillId, config);
      if (!result.success) {
        console.warn('[EmailSkill] failed to save email accounts config', { skillId, error: result.error });
      }
      return result.success;
    } catch (error) {
      console.error('Failed to set email accounts config:', error);
      return false;
    }
  }

  async testEmailAccountConnectivity(
    skillId: string,
    account: EmailSkillAccountConfig,
  ): Promise<EmailConnectivityTestResult | null> {
    try {
      console.debug('[EmailSkill] testing email account connectivity', {
        skillId,
        accountId: account.id,
        hasEmail: Boolean(account.email),
        hasPassword: Boolean(account.password),
        hasImapHost: Boolean(account.imapHost),
        hasSmtpHost: Boolean(account.smtpHost),
      });
      const result = await window.electron.skills.testEmailAccountConnectivity(skillId, account);
      if (result.success && result.result) {
        console.debug('[EmailSkill] email account connectivity test completed', {
          skillId,
          accountId: account.id,
          verdict: result.result.verdict,
        });
        return result.result;
      }
      console.warn('[EmailSkill] email account connectivity test failed', {
        skillId,
        accountId: account.id,
        error: result.error,
      });
      return null;
    } catch (error) {
      console.error('Failed to test email account connectivity:', error);
      return null;
    }
  }

  async getAutoRoutingPrompt(): Promise<string | null> {
    try {
      const result = await window.electron.skills.autoRoutingPrompt();
      return result.success ? (result.prompt || null) : null;
    } catch (error) {
      console.error('Failed to get auto-routing prompt:', error);
      return null;
    }
  }
  hasLocalizedSkillDescriptions(): boolean {
    return this.localSkillDescriptions.size > 0
      || this.marketplaceSkillDescriptions.size > 0
      || this.installedKitSkillDescriptions.size > 0;
  }

  async fetchMarketplaceSkills(
    options: { forceRefresh?: boolean } = {},
  ): Promise<MarketplaceCatalog> {
    if (options.forceRefresh) this.clearMarketplaceCache();
    const [primary, clawHub] = await Promise.all([
      this.loadPrimaryMarketplace(),
      this.loadInitialClawHubMarketplace(),
    ]);
    const tags = [...primary.tags];
    if (clawHub.skills.length > 0 && !tags.some(tag => tag.id === SkillMarketplaceSource.ClawHub)) {
      tags.push(CLAWHUB_MARKET_TAG);
    }
    const skills = mergeMarketplaceSkills(primary.skills, clawHub.skills);
    this.rememberMarketplaceDescriptions(skills);
    return {
      skills,
      tags,
      clawHubNextCursor: clawHub.nextCursor,
    };
  }

  async loadMoreClawHubSkills(): Promise<ClawHubMarketplacePage> {
    const current = await this.loadInitialClawHubMarketplace();
    if (!current.nextCursor) return current;
    const generation = this.marketplaceCacheGeneration;
    const nextPage = await this.requestClawHubMarketplace({ cursor: current.nextCursor });
    const mergedPage = {
      skills: mergeMarketplaceSkills(current.skills, nextPage.skills),
      nextCursor: nextPage.nextCursor,
    };
    if (generation === this.marketplaceCacheGeneration) {
      this.clawHubBrowseCache = mergedPage;
      this.rememberMarketplaceDescriptions(nextPage.skills);
    }
    return mergedPage;
  }

  async searchClawHubSkills(query: string): Promise<ClawHubMarketplacePage> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!normalizedQuery) return this.loadInitialClawHubMarketplace();
    const cached = this.clawHubSearchCache.get(normalizedQuery);
    if (cached) return cached;
    const generation = this.marketplaceCacheGeneration;
    const page = await this.requestClawHubMarketplace({ query: normalizedQuery });
    if (generation === this.marketplaceCacheGeneration) {
      this.clawHubSearchCache.set(normalizedQuery, page);
      this.rememberMarketplaceDescriptions(page.skills);
    }
    return page;
  }

  clearMarketplaceCache(): void {
    this.marketplaceCacheGeneration += 1;
    this.primaryMarketplaceCache = null;
    this.primaryMarketplaceFetchPromise = null;
    this.clawHubBrowseCache = null;
    this.clawHubBrowseFetchPromise = null;
    this.clawHubSearchCache.clear();
  }

  private async loadPrimaryMarketplace(): Promise<{ skills: MarketplaceSkill[]; tags: MarketTag[] }> {
    if (this.primaryMarketplaceCache) return this.primaryMarketplaceCache;
    if (this.primaryMarketplaceFetchPromise) return this.primaryMarketplaceFetchPromise;
    const generation = this.marketplaceCacheGeneration;
    this.primaryMarketplaceFetchPromise = this.requestPrimaryMarketplace();
    const result = await this.primaryMarketplaceFetchPromise;
    if (generation === this.marketplaceCacheGeneration) {
      this.primaryMarketplaceCache = result;
      this.primaryMarketplaceFetchPromise = null;
    }
    return result;
  }

  private async requestPrimaryMarketplace(): Promise<{ skills: MarketplaceSkill[]; tags: MarketTag[] }> {
    try {
      const result = await window.electron.skills.fetchMarketplace();
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch');
      }
      const json = JSON.parse(result.data);
      const rawValue = json?.data?.value;
      const value = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
      // Store local skill descriptions for i18n lookup
      const localSkills: LocalSkillInfo[] = Array.isArray(value?.localSkill) ? value.localSkill : [];
      this.localSkillDescriptions.clear();
      for (const ls of localSkills) {
        this.localSkillDescriptions.set(ls.name, ls.description);
        this.localSkillDescriptions.set(ls.id, ls.description);
      }
      const skills: MarketplaceSkill[] = Array.isArray(value?.marketplace) ? value.marketplace : [];
      const tags: MarketTag[] = Array.isArray(value?.marketTags) ? value.marketTags : [];
      return { skills, tags };
    } catch (error) {
      console.warn('Failed to fetch primary marketplace skills:', error);
      return { skills: [], tags: [] };
    }
  }

  private async loadInitialClawHubMarketplace(): Promise<ClawHubMarketplacePage> {
    if (this.clawHubBrowseCache) return this.clawHubBrowseCache;
    if (this.clawHubBrowseFetchPromise) return this.clawHubBrowseFetchPromise;
    const generation = this.marketplaceCacheGeneration;
    this.clawHubBrowseFetchPromise = this.requestClawHubMarketplace({}).catch((error) => {
      console.warn('Failed to fetch ClawHub marketplace skills:', error);
      return { skills: [], nextCursor: null };
    });
    const result = await this.clawHubBrowseFetchPromise;
    if (generation === this.marketplaceCacheGeneration) {
      this.clawHubBrowseCache = result;
      this.clawHubBrowseFetchPromise = null;
    }
    return result;
  }

  private async requestClawHubMarketplace(
    query: { cursor?: string; query?: string },
  ): Promise<ClawHubMarketplacePage> {
    const result = await window.electron.skills.fetchClawHub(query);
    if (!result.success || !result.page) {
      throw new Error(result.error || 'Failed to fetch ClawHub skills');
    }
    return {
      skills: result.page.skills as MarketplaceSkill[],
      nextCursor: result.page.nextCursor,
    };
  }

  private rememberMarketplaceDescriptions(skills: MarketplaceSkill[]): void {
    for (const skill of skills) {
      if (typeof skill.description === 'object') {
        this.marketplaceSkillDescriptions.set(skill.id, skill.description);
      }
    }
  }

  private async loadInstalledKitSkillDescriptions(): Promise<void> {
    this.installedKitSkillDescriptions.clear();
    try {
      const result = await window.electron.kits.listInstalled();
      if (!result.success || !result.installed) return;

      for (const kit of Object.values(result.installed)) {
        const metadata = kit.skills?.metadata ?? {};
        for (const [skillId, skillMetadata] of Object.entries(metadata)) {
          if (skillMetadata.description != null) {
            this.installedKitSkillDescriptions.set(skillId, skillMetadata.description);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load installed kit skill descriptions:', error);
    }
  }

  getLocalizedSkillDescription(skillId: string, skillName: string, fallback: string): string {
    const localDesc = this.localSkillDescriptions.get(skillName) ?? this.localSkillDescriptions.get(skillId);
    if (localDesc != null) return resolveLocalizedText(localDesc);
    const marketDesc = this.marketplaceSkillDescriptions.get(skillId);
    if (marketDesc != null) return resolveLocalizedText(marketDesc);
    const kitDesc = this.installedKitSkillDescriptions.get(skillId);
    if (kitDesc != null) return resolveLocalizedText(kitDesc);
    return fallback;
  }
}

export const skillService = new SkillService();
