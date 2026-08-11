import { afterEach, expect, test, vi } from 'vitest';

import { configService } from './config';
import {
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalPricingUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
  getPortalRegisterUrl,
  PortalPricingKeyfrom,
} from './endpoints';

const mockTestMode = (testMode: boolean) => {
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    app: { testMode },
  } as ReturnType<typeof configService.getConfig>);
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('portal account urls use production base when test mode is disabled', () => {
  mockTestMode(false);

  expect(getPortalProfileUrl()).toBe('https://glmcoding.cn/profile');
  expect(getPortalRechargeUrl()).toBe('https://glmcoding.cn/');
  expect(getPortalRegisterUrl()).toBe('https://glmcoding.cn/register');
  expect(getPortalInvitationUrl()).toBe('https://glmcoding.cn/invitation');
  expect(getPortalCreditsResetActivityUrl()).toBe(
    'https://glmcoding.cn/profile?activity=credits_reset',
  );
  expect(getPortalCreditsResetActivityUrl('credits_final_reward_2026_07')).toBe(
    'https://glmcoding.cn/profile?activity=credits_reset&campaignCode=credits_final_reward_2026_07',
  );
});

test('portal account urls use test base when test mode is enabled', () => {
  mockTestMode(true);

  expect(getPortalProfileUrl()).toBe('https://glmcoding.cn/profile');
  expect(getPortalRechargeUrl()).toBe('https://glmcoding.cn/');
  expect(getPortalInvitationUrl()).toBe('https://glmcoding.cn/invitation');
  expect(getPortalCreditsResetActivityUrl()).toBe(
    'https://glmcoding.cn/profile?activity=credits_reset',
  );
});

test('portal pricing url can include html share keyfrom', () => {
  mockTestMode(false);

  expect(getPortalPricingUrl(PortalPricingKeyfrom.HtmlShare)).toBe(
    'https://glmcoding.cn/pricing?keyfrom=html_share',
  );
});
