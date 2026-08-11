/**
 * 集中管理所有业务 API 端点。
 * 后续新增的业务接口也应在此文件中配置。
 */

import { configService } from './config';

const GLM_CODE_SITE_URL = 'https://glmcoding.cn';
const GLM_CODE_API_BASE_URL = `${GLM_CODE_SITE_URL}/api`;

export const isTestModeEnabled = () => {
  return configService.getConfig().app?.testMode === true;
};

// 自动更新
export const getUpdateCheckUrl = () => `${GLM_CODE_API_BASE_URL}/desktop/update`;

// 手动检查更新
export const getManualUpdateCheckUrl = () => `${GLM_CODE_API_BASE_URL}/desktop/update-manual`;

export const getFallbackDownloadUrl = () => `${GLM_CODE_SITE_URL}/download`;

// Skill 商店
export const getSkillStoreUrl = () => `${GLM_CODE_API_BASE_URL}/desktop/skill-store`;

// Kit 商店
export const getKitStoreUrl = () => `${GLM_CODE_API_BASE_URL}/desktop/kit-store`;

// 登录地址
export const getLoginOvermindUrl = () => `${GLM_CODE_API_BASE_URL}/desktop/login-url`;

// Portal 页面
const getPortalBase = () => GLM_CODE_SITE_URL;

export const PortalPricingKeyfrom = {
  HtmlShare: 'html_share',
} as const;

export type PortalPricingKeyfrom =
  (typeof PortalPricingKeyfrom)[keyof typeof PortalPricingKeyfrom];

export const getPortalLoginUrl = () => `${getPortalBase()}/login`;
export const getPortalRegisterUrl = () => `${getPortalBase()}/register`;
export const getPortalPricingUrl = (keyfrom?: PortalPricingKeyfrom) => (
  `${getPortalBase()}/pricing${keyfrom ? `?keyfrom=${encodeURIComponent(keyfrom)}` : ''}`
);
export const getPortalProfileUrl = () => `${getPortalBase()}/profile`;
export const getPortalRechargeUrl = () => `${getPortalBase()}/`;
export const getPortalInvitationUrl = () => `${getPortalBase()}/invitation`;
export const getPortalCreditsResetActivityUrl = (campaignCode?: string) => (
  `${getPortalBase()}/profile?activity=credits_reset${campaignCode ? `&campaignCode=${encodeURIComponent(campaignCode)}` : ''}`
);
