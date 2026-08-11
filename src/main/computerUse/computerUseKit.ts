import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  ComputerUseKitBundle,
  ComputerUseKitBundleIntegrity,
  ComputerUseKitId,
  ComputerUseKitMetadata,
  ComputerUseSkillId,
} from '../../shared/computerUse/constants';
import {
  type InstalledKitRecord,
  type InstalledKitSkills,
  type KitSkillMetadata,
  KitStoreKey,
} from '../../shared/kit/constants';
import type { SqliteStore } from '../sqliteStore';
import { ComputerUseRuntime } from './computerUseRuntime';

const SKILLS_DIR_NAME = 'SKILLs';
const SKILL_STATE_KEY = 'skills_state';
const COMPUTER_USE_KIT_ICON_URL = 'https://ydhardwarecommon.nosdn.127.net/f02f8c2d2af8b1f88426327944f6e1f5.png';
const COMPUTER_USE_MCP_REF = {
  id: ComputerUseKitId.BuiltIn,
  name: 'Computer Use',
  description: 'Built-in local Windows desktop control MCP server.',
};

type InstalledKitsMap = Record<string, InstalledKitRecord>;
type SkillStateMap = Record<string, { enabled: boolean }>;

export function isComputerUseKitSupportedPlatform(): boolean {
  return process.platform === ComputerUseRuntime.Platform
    && process.arch === ComputerUseRuntime.Arch;
}

export function buildComputerUseMarketplaceKit(): Record<string, unknown> {
  return {
    id: ComputerUseKitId.BuiltIn,
    name: ComputerUseKitMetadata.Name,
    description: ComputerUseKitMetadata.Description,
    icon: COMPUTER_USE_KIT_ICON_URL,
    author: '智码 GLM 科技',
    version: ComputerUseRuntime.Version,
    tryAsking: [
      {
        en: 'Open Notepad and type a short note',
        zh: '打开记事本并输入一段简短笔记',
      },
      {
        en: 'List the desktop applications I can control',
        zh: '列出可以操作的桌面应用',
      },
    ],
    skills: {
      bundle: ComputerUseKitBundle.BuiltIn,
      bundleSha256: ComputerUseKitBundleIntegrity.Sha256,
      bundleSizeBytes: ComputerUseKitBundleIntegrity.SizeBytes,
      list: [
        {
          id: ComputerUseSkillId.BuiltIn,
          name: ComputerUseKitMetadata.SkillName,
          description: ComputerUseKitMetadata.SkillDescription,
        },
      ],
    },
    mcpServers: [COMPUTER_USE_MCP_REF],
    connectors: [],
  };
}

export function getInstalledKitsMap(store: SqliteStore): InstalledKitsMap {
  return store.get<InstalledKitsMap>(KitStoreKey.Installed) ?? {};
}

export function isComputerUseKitInstalled(store: SqliteStore): boolean {
  return isComputerUseKitSupportedPlatform()
    && Boolean(getInstalledKitsMap(store)[ComputerUseKitId.BuiltIn]);
}

export function buildInstalledComputerUseKitRecord(
  skillIds: string[],
  metadata: Record<string, KitSkillMetadata>,
): InstalledKitRecord {
  const skills: InstalledKitSkills = {
    skillIds,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  return {
    id: ComputerUseKitId.BuiltIn,
    version: ComputerUseRuntime.Version,
    installedAt: Date.now(),
    skills,
    mcpServers: [COMPUTER_USE_MCP_REF],
    connectors: [],
  };
}

function getUserComputerUseSkillDir(): string {
  return path.join(app.getPath('userData'), SKILLS_DIR_NAME, ComputerUseSkillId.BuiltIn);
}

export function removeComputerUseSkillArtifacts(store: SqliteStore): void {
  fs.rmSync(getUserComputerUseSkillDir(), { recursive: true, force: true });
  const stateMap = store.get<SkillStateMap>(SKILL_STATE_KEY) ?? {};
  delete stateMap[ComputerUseSkillId.BuiltIn];
  store.set(SKILL_STATE_KEY, stateMap);
}
