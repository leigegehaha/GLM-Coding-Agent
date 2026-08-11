import {
  ArrowPathIcon,
  ArrowRightOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  KeyIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useState } from 'react';

import {
  CodingPlanAccountErrorCode,
  type CodingPlanAccountSnapshot,
  type CodingPlanBoundKey,
  type CodingPlanPlan,
  type CodingPlanWindowUsage,
} from '../../../shared/codingPlanAccount/constants';
import { getPortalPricingUrl, getPortalRegisterUrl } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';

interface CodingPlanSettingsSectionProps {
  configuredTokenId?: number;
  onAccountChange?: (account: CodingPlanAccountSnapshot['account']) => void;
  onConfigure: (tokenId: number, planName: string) => Promise<boolean>;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const formatCount = (value: number | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '--';

const formatDate = (value: string | null | undefined): string => {
  if (!value) return i18nService.t('codingPlanNoExpiry');
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
};

const getErrorMessage = (errorCode: string): string => {
  switch (errorCode) {
    case CodingPlanAccountErrorCode.InvalidCredentials:
      return i18nService.t('codingPlanInvalidCredentials');
    case CodingPlanAccountErrorCode.InvalidRequest:
      return i18nService.t('codingPlanLoginRequiredFields');
    case CodingPlanAccountErrorCode.Network:
      return i18nService.t('codingPlanNetworkError');
    case CodingPlanAccountErrorCode.NotAuthenticated:
      return i18nService.t('codingPlanSessionExpired');
    case CodingPlanAccountErrorCode.SecureStorageUnavailable:
      return i18nService.t('codingPlanSecureStorageUnavailable');
    default:
      return i18nService.t('codingPlanLoadFailed');
  }
};

const UsageBar: React.FC<{ percent?: number }> = ({ percent }) => {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const normalized = clampPercent(percent);
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-raised">
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${normalized}%` }}
      />
    </div>
  );
};

const WindowUsageRow: React.FC<{
  label: string;
  usage: CodingPlanWindowUsage | null;
}> = ({ label, usage }) => {
  if (!usage) return null;
  const summary =
    typeof usage.used === 'number' && typeof usage.limit === 'number'
      ? `${formatCount(usage.used)} / ${formatCount(usage.limit)}`
      : typeof usage.usedPercent === 'number'
        ? `${Math.round(usage.usedPercent)}%`
        : '--';
  return (
    <div className="border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-secondary">{label}</span>
        <span className="font-medium text-foreground">{summary}</span>
      </div>
      <UsageBar percent={usage.usedPercent} />
      {usage.resetAt && (
        <div className="mt-1.5 text-xs text-secondary">
          {i18nService.t('codingPlanResetsAt')} {formatDate(usage.resetAt)}
        </div>
      )}
    </div>
  );
};

const PlanKeyRow: React.FC<{
  planName: string;
  planKey: CodingPlanBoundKey;
  configuredTokenId?: number;
  configuringTokenId: number | null;
  onConfigure: (planKey: CodingPlanBoundKey, planName: string) => void;
}> = ({ planName, planKey, configuredTokenId, configuringTokenId, onConfigure }) => {
  const isConfigured = configuredTokenId === planKey.tokenId;
  const isConfiguring = configuringTokenId === planKey.tokenId;
  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border py-3 first:border-t-0">
      <KeyIcon className="h-5 w-5 shrink-0 text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{planKey.name}</div>
        <div className="truncate font-mono text-xs text-secondary">{planKey.keyMasked}</div>
      </div>
      <button
        type="button"
        onClick={() => onConfigure(planKey, planName)}
        disabled={isConfiguring || isConfigured}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isConfigured ? <CheckCircleIcon className="h-4 w-4" /> : null}
        {isConfigured
          ? i18nService.t('codingPlanConfigured')
          : isConfiguring
            ? i18nService.t('codingPlanConfiguring')
            : i18nService.t('codingPlanConfigure')}
      </button>
    </div>
  );
};

const PlanItem: React.FC<{
  plan: CodingPlanPlan;
  configuredTokenId?: number;
  configuringTokenId: number | null;
  onConfigure: (planKey: CodingPlanBoundKey, planName: string) => void;
}> = ({ plan, configuredTokenId, configuringTokenId, onConfigure }) => (
  <section className="rounded-lg border border-border bg-surface px-4 py-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{plan.planName}</h4>
        <p className="mt-1 text-xs text-secondary">
          {i18nService.t('codingPlanExpiresAt')} {formatDate(plan.expiresAt)}
        </p>
      </div>
      <span className="rounded-md bg-primary-muted px-2 py-1 text-xs font-medium text-primary">
        {i18nService.t('codingPlanCalls')} {formatCount(plan.calls)}
      </span>
    </div>

    {plan.quota && (
      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-secondary">{i18nService.t('codingPlanTotalQuota')}</span>
          <span className="font-medium text-foreground">
            {typeof plan.quota.remaining === 'number'
              ? `${formatCount(plan.quota.remaining)} / ${formatCount(plan.quota.granted)}`
              : formatCount(plan.quota.granted)}
          </span>
        </div>
        <UsageBar percent={plan.quota.usedPercent} />
      </div>
    )}

    <div className="mt-4 border-t border-border pt-3">
      <WindowUsageRow
        label={i18nService.t('codingPlanFiveHourWindow')}
        usage={plan.windows.fiveHour}
      />
      <WindowUsageRow label={i18nService.t('codingPlanWeeklyWindow')} usage={plan.windows.weekly} />
      <WindowUsageRow
        label={i18nService.t('codingPlanMonthlyWindow')}
        usage={plan.windows.monthly}
      />
    </div>

    <div className="mt-4 border-t border-border pt-1">
      {plan.keys.length > 0 ? (
        plan.keys.map(planKey => (
          <PlanKeyRow
            key={planKey.tokenId}
            planName={plan.planName}
            planKey={planKey}
            configuredTokenId={configuredTokenId}
            configuringTokenId={configuringTokenId}
            onConfigure={onConfigure}
          />
        ))
      ) : (
        <p className="pt-3 text-sm text-secondary">{i18nService.t('codingPlanNoKeys')}</p>
      )}
    </div>
  </section>
);

const CodingPlanSettingsSection: React.FC<CodingPlanSettingsSectionProps> = ({
  configuredTokenId,
  onAccountChange,
  onConfigure,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [snapshot, setSnapshot] = useState<CodingPlanAccountSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [configuringTokenId, setConfiguringTokenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const result = await window.electron.codingPlan.getOverview();
    if (result.success) {
      setSnapshot(result.data);
      onAccountChange?.(result.data.account);
    } else {
      setSnapshot(null);
      onAccountChange?.(null);
      setError(getErrorMessage(result.errorCode));
    }
    setIsLoading(false);
  }, [onAccountChange]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    if (!email.trim() || !password) {
      setError(i18nService.t('codingPlanLoginRequiredFields'));
      return;
    }
    setIsLoggingIn(true);
    setError(null);
    const result = await window.electron.codingPlan.login(email, password);
    setPassword('');
    if (result.success) {
      await loadOverview();
    } else {
      setError(getErrorMessage(result.errorCode));
    }
    setIsLoggingIn(false);
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setError(null);
    const result = await window.electron.codingPlan.logout();
    if (result.success) {
      setSnapshot({ account: null, overview: null });
      onAccountChange?.(null);
      setEmail('');
      setPassword('');
    } else {
      setError(getErrorMessage(result.errorCode));
    }
    setIsLoggingOut(false);
  };

  const handleConfigure = async (planKey: CodingPlanBoundKey, planName: string) => {
    setConfiguringTokenId(planKey.tokenId);
    await onConfigure(planKey.tokenId, planName);
    setConfiguringTokenId(null);
  };

  const openExternal = (url: string) => {
    void window.electron.shell.openExternal(url);
  };

  if (isLoading && !snapshot) {
    return (
      <div className="flex min-h-48 items-center justify-center text-sm text-secondary">
        <ArrowPathIcon className="mr-2 h-5 w-5 animate-spin" />
        {i18nService.t('codingPlanLoading')}
      </div>
    );
  }

  if (!snapshot?.account) {
    return (
      <div className="mx-auto w-full max-w-md py-4">
        <div className="mb-6 text-center">
          <UserCircleIcon className="mx-auto h-11 w-11 text-primary" />
          <h4 className="mt-3 text-base font-semibold text-foreground">
            {i18nService.t('codingPlanLoginTitle')}
          </h4>
          <p className="mt-1 text-sm text-secondary">
            {i18nService.t('codingPlanLoginDescription')}
          </p>
        </div>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {i18nService.t('codingPlanEmail')}
            </span>
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              autoComplete="username"
              placeholder={i18nService.t('codingPlanEmailPlaceholder')}
              className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {i18nService.t('codingPlanPassword')}
            </span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleLogin();
                }
              }}
              autoComplete="current-password"
              placeholder={i18nService.t('codingPlanPasswordPlaceholder')}
              className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          {error && <p className="text-sm text-error">{error}</p>}
          <button
            type="button"
            onClick={() => {
              void handleLogin();
            }}
            disabled={isLoggingIn}
            className="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoggingIn ? i18nService.t('codingPlanLoggingIn') : i18nService.t('codingPlanLogin')}
          </button>
          <button
            type="button"
            onClick={() => openExternal(getPortalRegisterUrl())}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
          >
            {i18nService.t('codingPlanRegister')}
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  const plans = snapshot.overview?.plans ?? [];
  const unboundKeys = snapshot.overview?.unboundKeys ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {snapshot.account.name}
          </div>
          <div className="truncate text-xs text-secondary">{snapshot.account.email}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void loadOverview();
            }}
            disabled={isLoading}
            title={i18nService.t('codingPlanRefresh')}
            className="rounded-lg p-2 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            <ArrowPathIcon className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleLogout();
            }}
            disabled={isLoggingOut}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            <ArrowRightOnRectangleIcon className="h-4 w-4" />
            {i18nService.t('codingPlanLogout')}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">
          {i18nService.t('codingPlanMyPlans')}
        </h4>
        <button
          type="button"
          onClick={() => openExternal(getPortalPricingUrl())}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover"
        >
          {i18nService.t('codingPlanViewPlans')}
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
        </button>
      </div>

      {plans.length > 0 ? (
        plans.map(plan => (
          <PlanItem
            key={plan.userPlanId}
            plan={plan}
            configuredTokenId={configuredTokenId}
            configuringTokenId={configuringTokenId}
            onConfigure={handleConfigure}
          />
        ))
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-secondary">
          {i18nService.t('codingPlanNoPlans')}
        </div>
      )}

      {unboundKeys.length > 0 && (
        <section className="rounded-lg border border-border bg-surface px-4 py-3">
          <h4 className="mb-1 text-sm font-semibold text-foreground">
            {i18nService.t('codingPlanUnboundKeys')}
          </h4>
          {unboundKeys.map(planKey => (
            <PlanKeyRow
              key={planKey.tokenId}
              planName={i18nService.t('codingPlanUnboundKeyName')}
              planKey={planKey}
              configuredTokenId={configuredTokenId}
              configuringTokenId={configuringTokenId}
              onConfigure={handleConfigure}
            />
          ))}
        </section>
      )}
    </div>
  );
};

export default CodingPlanSettingsSection;
