import { ipcMain, net } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  type ClawHubMarketplaceQuery,
  SkillIpcChannel,
} from '../../../shared/skills/constants';
import { updatePluginSkillIdsFromReport } from '../../skills';
import {
  buildClawHubMarketplaceUrl,
  parseClawHubMarketplacePage,
} from '../../skills/publicSkillMarketplace';
import type { SkillManager } from '../../skills/skillManager';

export interface SkillHandlerDeps {
  getSkillManager: () => SkillManager;
  getSkillStoreUrl: () => string;
  getOpenClawRuntimeAdapter: () => {
    connectGatewayIfNeeded: () => Promise<void>;
    getGatewayClient: () => {
      request: <T = Record<string, unknown>>(
        method: string,
        params?: unknown,
        opts?: { timeoutMs?: number },
      ) => Promise<T>;
    } | null;
  } | null;
}

const fetchHttpsText = async (url: string): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Request timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export function registerSkillHandlers(deps: SkillHandlerDeps): void {
  const { getSkillManager, getSkillStoreUrl, getOpenClawRuntimeAdapter } = deps;

  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      // Best-effort sync to OpenClaw
      try {
        const adapter = getOpenClawRuntimeAdapter();
        if (adapter) {
          await adapter.connectGatewayIfNeeded();
          const client = adapter.getGatewayClient();
          if (client) {
            await client.request('skills.update', { skillKey: options.id, enabled: options.enabled }, { timeoutMs: 10_000 });
          }
        }
      } catch (ocError) {
        console.warn('[skills] Failed to sync enabled state to OpenClaw:', ocError);
      }
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      // Read _meta.json before deletion to get OpenClaw source path
      let openclawSourceDir: string | null = null;
      try {
        const skillRoot = getSkillManager().getSkillsRoot();
        const metaPath = path.join(skillRoot, id, '_meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.openclawSourceDir) {
            openclawSourceDir = meta.openclawSourceDir;
          }
        }
      } catch { /* best-effort */ }

      const skills = await getSkillManager().deleteSkill(id);

      // Also remove from OpenClaw workspace so the skill won't reappear on next sync
      if (openclawSourceDir && fs.existsSync(openclawSourceDir)) {
        try {
          await fs.promises.rm(openclawSourceDir, { recursive: true, force: true });
          console.log('[skills] Also removed OpenClaw workspace skill:', openclawSourceDir);
        } catch (ocError) {
          console.warn('[skills] Failed to remove skill from OpenClaw workspace:', ocError);
        }
      }

      return { success: true, skills };
    } catch (error) {
      console.error('[skills] Failed to delete skill:', id, error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string) => {
    return getSkillManager().downloadSkill(source);
  });

  ipcMain.handle('skills:upgrade', async (_event, skillId: string, downloadUrl: string) => {
    return getSkillManager().upgradeSkill(skillId, downloadUrl);
  });

  ipcMain.handle('skills:confirmInstall', async (_event, pendingId: string, action: string) => {
    const validActions = ['install', 'installDisabled', 'cancel'];
    if (!validActions.includes(action)) {
      return { success: false, error: 'Invalid action' };
    }
    return getSkillManager().confirmPendingInstall(
      pendingId,
      action as 'install' | 'installDisabled' | 'cancel'
    );
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:getEmailAccountsConfig', (_event, skillId: string) => {
    return getSkillManager().getEmailAccountsConfig(skillId);
  });

  ipcMain.handle('skills:setEmailAccountsConfig', (_event, skillId: string, config: Parameters<SkillManager['setEmailAccountsConfig']>[1]) => {
    return getSkillManager().setEmailAccountsConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailAccountConnectivity', async (
    _event,
    skillId: string,
    account: Parameters<SkillManager['testEmailAccountConnectivity']>[1]
  ) => {
    return getSkillManager().testEmailAccountConnectivity(skillId, account);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  ipcMain.handle(SkillIpcChannel.FetchMarketplace, async () => {
    const url = getSkillStoreUrl();
    console.log(`[SkillMarketplace] fetching from: ${url}`);
    try {
      return {
        success: true,
        data: await fetchHttpsText(url),
      };
    } catch (error) {
      console.warn('[SkillMarketplace] primary catalog unavailable:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace',
      };
    }
  });

  ipcMain.handle(
    SkillIpcChannel.FetchClawHub,
    async (_event, query: ClawHubMarketplaceQuery = {}) => {
      try {
        const data = await fetchHttpsText(buildClawHubMarketplaceUrl(query));
        return {
          success: true,
          page: parseClawHubMarketplacePage(data, Boolean(query.query?.trim())),
        };
      } catch (error) {
        console.warn('[SkillMarketplace] ClawHub request failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch ClawHub skills',
        };
      }
    },
  );

  ipcMain.handle('skills:detectFromOpenClaw', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { skills: [], error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { skills: [], error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return sm.detectSkillsFromOpenClaw(report as any);
    } catch (error) {
      return { skills: [], error: error instanceof Error ? error.message : 'Detection failed' };
    }
  });

  ipcMain.handle('skills:syncFromOpenClaw', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { synced: [], error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { synced: [], error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return sm.syncSkillsFromOpenClaw(report as any);
    } catch (error) {
      return { synced: [], error: error instanceof Error ? error.message : 'Sync failed' };
    }
  });

  ipcMain.handle('skills:refreshPluginSkillIds', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { success: false, error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return { success: true, pluginSkillIds: [...sm.getPluginSkillIds()] };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Refresh failed' };
    }
  });
}
