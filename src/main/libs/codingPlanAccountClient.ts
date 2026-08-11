import {
  CodingPlanAccountErrorCode,
  type CodingPlanAccountResult,
  type CodingPlanAccountSnapshot,
  type CodingPlanAccountUser,
  type CodingPlanBoundKey,
  type CodingPlanModel,
  type CodingPlanOverview,
  type CodingPlanPlan,
} from '../../shared/codingPlanAccount/constants';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type CodingPlanAccountClientOptions = {
  fetch: FetchLike;
  getBaseUrl: () => string;
};

type ApiEnvelope<T> = {
  code?: number;
  data?: T;
  message?: string;
};

type AuthCallbackResponse = {
  url?: string;
};

type CodingPlanPrivateBoundKey = CodingPlanBoundKey & {
  keyFull: string;
};

type CodingPlanPrivatePlan = Omit<CodingPlanPlan, 'keys'> & {
  keys: CodingPlanPrivateBoundKey[];
};

type CodingPlanPrivateOverview = Omit<CodingPlanOverview, 'plans' | 'unboundKeys'> & {
  plans: CodingPlanPrivatePlan[];
  unboundKeys: CodingPlanPrivateBoundKey[];
};

type CodingPlanPrivateSnapshot = {
  account: CodingPlanAccountUser | null;
  overview: CodingPlanPrivateOverview | null;
};

export type CodingPlanPreparedConfiguration = {
  apiKey: string;
  models: CodingPlanModel[];
  tokenId: number;
};

const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '');

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function readAccount(value: unknown): CodingPlanAccountUser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const user = value as Record<string, unknown>;
  const emailValue = user.email ?? user.username;
  const email = typeof emailValue === 'string' ? emailValue.trim() : '';
  if (!email) return null;
  const idValue = user.id ?? user.userId;
  return {
    id: typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : email,
    email,
    name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : email,
  };
}

const sanitizeBoundKey = (key: CodingPlanPrivateBoundKey): CodingPlanBoundKey => ({
  tokenId: key.tokenId,
  name: key.name,
  keyMasked: key.keyMasked,
  boundAt: key.boundAt,
});

const sanitizeOverview = (overview: CodingPlanPrivateOverview): CodingPlanOverview => ({
  ...overview,
  plans: overview.plans.map(plan => ({
    ...plan,
    keys: plan.keys.map(sanitizeBoundKey),
  })),
  unboundKeys: overview.unboundKeys.map(sanitizeBoundKey),
});

export class CodingPlanAccountClient {
  constructor(private readonly options: CodingPlanAccountClientOptions) {}

  async getAccount(): Promise<CodingPlanAccountResult<CodingPlanAccountUser | null>> {
    try {
      return { success: true, data: await this.getSessionAccount() };
    } catch {
      return { success: false, errorCode: CodingPlanAccountErrorCode.Network };
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<CodingPlanAccountResult<CodingPlanAccountUser>> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      return { success: false, errorCode: CodingPlanAccountErrorCode.InvalidRequest };
    }

    try {
      const baseUrl = this.baseUrl();
      const csrfResponse = await this.options.fetch(`${baseUrl}/api/auth/csrf`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const csrfBody = await readJson<{ csrfToken?: string }>(csrfResponse);
      if (!csrfResponse.ok || !csrfBody?.csrfToken) {
        return { success: false, errorCode: CodingPlanAccountErrorCode.Server };
      }

      const loginResponse = await this.options.fetch(`${baseUrl}/api/v1/user/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: normalizedEmail, password }),
      });
      const loginBody = await readJson<ApiEnvelope<unknown>>(loginResponse);
      if (!loginResponse.ok || loginBody?.code !== 0) {
        return {
          success: false,
          errorCode: loginResponse.status >= 500
            ? CodingPlanAccountErrorCode.Server
            : CodingPlanAccountErrorCode.InvalidCredentials,
        };
      }

      const form = new URLSearchParams({
        csrfToken: csrfBody.csrfToken,
        email: normalizedEmail,
        password,
        callbackUrl: `${baseUrl}/`,
      });
      const callbackResponse = await this.options.fetch(
        `${baseUrl}/api/auth/callback/credentials`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Auth-Return-Redirect': '1',
          },
          body: form.toString(),
        },
      );
      if (callbackResponse.status >= 500) {
        return { success: false, errorCode: CodingPlanAccountErrorCode.Server };
      }
      const callbackBody = await readJson<AuthCallbackResponse>(callbackResponse);
      if (!callbackResponse.ok || !callbackBody?.url || this.hasAuthError(callbackBody.url)) {
        return { success: false, errorCode: CodingPlanAccountErrorCode.InvalidCredentials };
      }

      const account = await this.getSessionAccount();
      return account
        ? { success: true, data: account }
        : { success: false, errorCode: CodingPlanAccountErrorCode.InvalidCredentials };
    } catch {
      return { success: false, errorCode: CodingPlanAccountErrorCode.Network };
    }
  }

  async getOverview(): Promise<CodingPlanAccountResult<CodingPlanAccountSnapshot>> {
    const result = await this.getOverviewWithSecrets();
    if (!result.success) return result;
    return {
      success: true,
      data: {
        account: result.data.account,
        overview: result.data.overview ? sanitizeOverview(result.data.overview) : null,
      },
    };
  }

  async prepareConfiguration(
    tokenId: number,
  ): Promise<CodingPlanAccountResult<CodingPlanPreparedConfiguration>> {
    if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
      return { success: false, errorCode: CodingPlanAccountErrorCode.InvalidRequest };
    }
    const overviewResult = await this.getOverviewWithSecrets();
    if (overviewResult.success === false) {
      return {
        success: false,
        errorCode: overviewResult.errorCode,
        message: overviewResult.message,
      };
    }
    const overview = overviewResult.data.overview;
    if (!overview) {
      return { success: false, errorCode: CodingPlanAccountErrorCode.NotAuthenticated };
    }
    const selectedKey = [
      ...overview.plans.flatMap(plan => plan.keys),
      ...overview.unboundKeys,
    ].find(key => key.tokenId === tokenId);
    const apiKey = selectedKey?.keyFull?.trim() ?? '';
    if (!apiKey) {
      return { success: false, errorCode: CodingPlanAccountErrorCode.PlanKeyRejected };
    }
    const modelsResult = await this.getModelsForKey(apiKey);
    if (modelsResult.success === false) {
      return {
        success: false,
        errorCode: modelsResult.errorCode,
        message: modelsResult.message,
      };
    }
    return {
      success: true,
      data: {
        apiKey,
        models: modelsResult.data,
        tokenId,
      },
    };
  }

  private async getOverviewWithSecrets(): Promise<CodingPlanAccountResult<CodingPlanPrivateSnapshot>> {
    try {
      const account = await this.getSessionAccount();
      if (!account) {
        return { success: true, data: { account: null, overview: null } };
      }

      const response = await this.options.fetch(`${this.baseUrl()}/api/v1/user/plan-keys`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const body = await readJson<ApiEnvelope<CodingPlanPrivateOverview>>(response);
      if (response.status === 401 || body?.code === 40100) {
        return { success: false, errorCode: CodingPlanAccountErrorCode.NotAuthenticated };
      }
      if (!response.ok || body?.code !== 0 || !body.data) {
        return {
          success: false,
          errorCode: CodingPlanAccountErrorCode.Server,
          message: body?.message,
        };
      }
      return { success: true, data: { account, overview: body.data } };
    } catch {
      return { success: false, errorCode: CodingPlanAccountErrorCode.Network };
    }
  }

  async getModelsForKey(apiKey: string): Promise<CodingPlanAccountResult<CodingPlanModel[]>> {
    const key = apiKey.trim();
    if (!key) {
      return { success: false, errorCode: CodingPlanAccountErrorCode.InvalidRequest };
    }
    try {
      const response = await this.options.fetch(`${this.baseUrl()}/v1/models`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
      });
      const body = await readJson<{
        data?: Array<{
          id?: string;
          display_name?: string;
          context_length?: number;
        }>;
      }>(response);
      if (!response.ok || !Array.isArray(body?.data)) {
        return {
          success: false,
          errorCode: CodingPlanAccountErrorCode.PlanKeyRejected,
        };
      }
      const models = body.data.flatMap((model): CodingPlanModel[] => {
        const id = typeof model.id === 'string' ? model.id.trim() : '';
        if (!id) return [];
        return [
          {
            id,
            name:
              typeof model.display_name === 'string' && model.display_name.trim()
                ? model.display_name.trim()
                : id,
            ...(typeof model.context_length === 'number' && model.context_length > 0
              ? { contextWindow: model.context_length }
              : {}),
          },
        ];
      });
      if (models.length === 0) {
        return { success: false, errorCode: CodingPlanAccountErrorCode.PlanKeyRejected };
      }
      return { success: true, data: models };
    } catch {
      return { success: false, errorCode: CodingPlanAccountErrorCode.Network };
    }
  }

  async logout(): Promise<CodingPlanAccountResult<null>> {
    try {
      const baseUrl = this.baseUrl();
      const csrfResponse = await this.options.fetch(`${baseUrl}/api/auth/csrf`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const csrfBody = await readJson<{ csrfToken?: string }>(csrfResponse);
      if (csrfResponse.ok && csrfBody?.csrfToken) {
        const form = new URLSearchParams({
          csrfToken: csrfBody.csrfToken,
          redirectTo: `${baseUrl}/`,
        });
        await this.options.fetch(`${baseUrl}/api/auth/signout`, {
          method: 'POST',
          credentials: 'include',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
      }

      const account = await this.getSessionAccount();
      return account
        ? { success: false, errorCode: CodingPlanAccountErrorCode.Server }
        : { success: true, data: null };
    } catch {
      return { success: false, errorCode: CodingPlanAccountErrorCode.Network };
    }
  }

  private baseUrl(): string {
    return normalizeBaseUrl(this.options.getBaseUrl());
  }

  private hasAuthError(url: string): boolean {
    try {
      return new URL(url).searchParams.has('error');
    } catch {
      return true;
    }
  }

  private async getSessionAccount(): Promise<CodingPlanAccountUser | null> {
    const response = await this.options.fetch(`${this.baseUrl()}/api/auth/session`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await readJson<{ user?: unknown }>(response);
    return readAccount(body?.user);
  }
}
