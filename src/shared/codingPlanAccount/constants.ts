export const CodingPlanAccountIpc = {
  Configure: 'coding-plan-account:configure',
  GetAccount: 'coding-plan-account:getAccount',
  GetOverview: 'coding-plan-account:getOverview',
  Login: 'coding-plan-account:login',
  Logout: 'coding-plan-account:logout',
} as const;

export type CodingPlanAccountIpc = (typeof CodingPlanAccountIpc)[keyof typeof CodingPlanAccountIpc];

export const CodingPlanAccountErrorCode = {
  InvalidCredentials: 'invalid_credentials',
  InvalidRequest: 'invalid_request',
  Network: 'network_error',
  NotAuthenticated: 'not_authenticated',
  PlanKeyRejected: 'plan_key_rejected',
  SecureStorageUnavailable: 'secure_storage_unavailable',
  Server: 'server_error',
} as const;

export type CodingPlanAccountErrorCode =
  (typeof CodingPlanAccountErrorCode)[keyof typeof CodingPlanAccountErrorCode];

export interface CodingPlanAccountUser {
  id: string;
  email: string;
  name: string;
}

export interface CodingPlanBoundKey {
  tokenId: number;
  name: string;
  keyMasked: string;
  boundAt: string;
}

export interface CodingPlanQuota {
  granted: number;
  used?: number;
  remaining?: number;
  usedPercent?: number;
}

export interface CodingPlanWindowUsage {
  used?: number;
  limit?: number;
  usedPercent?: number;
  saturated?: boolean;
  windowStart?: string;
  resetAt?: string;
}

export interface CodingPlanPlan {
  userPlanId: number;
  planId: number;
  planName: string;
  price: number;
  calls: number;
  expiresAt: string | null;
  source: string | null;
  paidAt: string | null;
  quota: CodingPlanQuota | null;
  windows: {
    fiveHour: CodingPlanWindowUsage | null;
    weekly: CodingPlanWindowUsage | null;
    monthly: CodingPlanWindowUsage | null;
  };
  keys: CodingPlanBoundKey[];
}

export interface CodingPlanOverview {
  plans: CodingPlanPlan[];
  unboundKeys: CodingPlanBoundKey[];
  ratiosOnly?: boolean;
}

export interface CodingPlanModel {
  id: string;
  name: string;
  contextWindow?: number;
}

export const CODING_PLAN_CREDENTIAL_REF = 'coding-plan-account-key';

export interface CodingPlanConfiguration {
  credentialRef: typeof CODING_PLAN_CREDENTIAL_REF;
  models: CodingPlanModel[];
  tokenId: number;
}

export type CodingPlanAccountResult<T> =
  | { success: true; data: T }
  | { success: false; errorCode: CodingPlanAccountErrorCode; message?: string };

export interface CodingPlanAccountSnapshot {
  account: CodingPlanAccountUser | null;
  overview: CodingPlanOverview | null;
}
