import type { ApiFormat, ProviderAuthType } from './constants';

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  /** Main-process credential reference used when a provider secret must not enter the renderer. */
  credentialRef?: string;
  /** Non-secret Coding Plan token identity used only for configured-state display. */
  codingPlanTokenId?: number;
  baseUrl: string;
  apiFormat?: ApiFormat;
  models?: Array<{
    id: string;
    name: string;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    customParams?: Record<string, unknown>;
  }>;
  displayName?: string;
  codingPlanEnabled?: boolean;
  authType?: ProviderAuthType;
  /** OAuth access token (stored separately from apiKey to avoid conflicts) */
  oauthAccessToken?: string;
  /** Base URL returned by OAuth resource_url (stored separately from user-configured baseUrl) */
  oauthBaseUrl?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: number;
}
