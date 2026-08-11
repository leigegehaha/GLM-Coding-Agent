import { CODING_PLAN_CREDENTIAL_REF } from '../../shared/codingPlanAccount/constants';
import { ProviderName, ProviderRegistry } from '../../shared/providers';

type ManagedProviderCredentialOptions = {
  url: string;
  headers: Record<string, string>;
  credentialRef?: string;
  credentialIsActive: boolean;
  readCredential: (credentialRef: string) => string | null;
};

const getCodingPlanApiBaseUrl = (): string => {
  const baseUrl = ProviderRegistry.get(ProviderName.ZhimaCoding)?.defaultBaseUrl;
  if (!baseUrl) {
    throw new Error('Coding Plan API endpoint is unavailable.');
  }
  return baseUrl;
};

export const injectManagedProviderCredential = (
  options: ManagedProviderCredentialOptions,
): Record<string, string> => {
  if (!options.credentialRef) return options.headers;
  if (options.credentialRef !== CODING_PLAN_CREDENTIAL_REF) {
    throw new Error('Unknown managed provider credential.');
  }
  if (!options.credentialIsActive) {
    throw new Error('Coding Plan credential is not active.');
  }

  const target = new URL(options.url);
  const allowedBase = new URL(getCodingPlanApiBaseUrl());
  if (
    target.protocol !== 'https:'
    || target.username
    || target.password
    || target.origin !== allowedBase.origin
  ) {
    throw new Error('Managed provider credential target is not allowed.');
  }

  const allowedPath = allowedBase.pathname.replace(/\/+$/, '') || '/';
  if (target.pathname !== allowedPath && !target.pathname.startsWith(`${allowedPath}/`)) {
    throw new Error('Managed provider credential path is not allowed.');
  }

  const apiKey = options.readCredential(options.credentialRef)?.trim();
  if (!apiKey) {
    throw new Error('Coding Plan credential is unavailable.');
  }
  const sanitizedHeaders = Object.fromEntries(
    Object.entries(options.headers).filter(([name]) => ![
      'authorization',
      'x-api-key',
      'x-goog-api-key',
    ].includes(name.toLowerCase())),
  );
  return {
    ...sanitizedHeaders,
    Authorization: `Bearer ${apiKey}`,
  };
};
