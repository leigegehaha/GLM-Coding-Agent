import type { SqliteStore } from '../sqliteStore';

export const SECURE_CREDENTIAL_STORE_KEY = 'secure_provider_credentials_v1';

type StoredCredentialEnvelope = {
  version: 1;
  credentials: Record<string, string>;
};

export interface CredentialEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

type CredentialStoreBacking = Pick<SqliteStore, 'delete' | 'get' | 'set'>;

const emptyEnvelope = (): StoredCredentialEnvelope => ({
  version: 1,
  credentials: {},
});

export class SecureCredentialStore {
  constructor(
    private readonly backing: CredentialStoreBacking,
    private readonly encryption: CredentialEncryption,
  ) {}

  isAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  get(reference: string): string | null {
    const normalizedReference = reference.trim();
    if (!normalizedReference || !this.encryption.isAvailable()) return null;
    const encrypted = this.readEnvelope().credentials[normalizedReference];
    if (!encrypted) return null;
    try {
      return this.encryption.decrypt(Buffer.from(encrypted, 'base64'));
    } catch (error) {
      console.warn(`[SecureCredentialStore] Failed to decrypt credential ${normalizedReference}:`, error);
      return null;
    }
  }

  set(reference: string, value: string): void {
    const normalizedReference = reference.trim();
    const normalizedValue = value.trim();
    if (!normalizedReference || !normalizedValue) {
      throw new Error('Credential reference and value are required.');
    }
    if (!this.encryption.isAvailable()) {
      throw new Error('Operating-system credential encryption is unavailable.');
    }
    const envelope = this.readEnvelope();
    envelope.credentials[normalizedReference] = this.encryption
      .encrypt(normalizedValue)
      .toString('base64');
    this.backing.set(SECURE_CREDENTIAL_STORE_KEY, envelope);
  }

  delete(reference: string): void {
    const normalizedReference = reference.trim();
    if (!normalizedReference) return;
    const envelope = this.readEnvelope();
    if (!(normalizedReference in envelope.credentials)) return;
    delete envelope.credentials[normalizedReference];
    if (Object.keys(envelope.credentials).length === 0) {
      this.backing.delete(SECURE_CREDENTIAL_STORE_KEY);
      return;
    }
    this.backing.set(SECURE_CREDENTIAL_STORE_KEY, envelope);
  }

  private readEnvelope(): StoredCredentialEnvelope {
    const stored = this.backing.get<StoredCredentialEnvelope>(SECURE_CREDENTIAL_STORE_KEY);
    if (!stored || stored.version !== 1 || !stored.credentials || typeof stored.credentials !== 'object') {
      return emptyEnvelope();
    }
    return {
      version: 1,
      credentials: { ...stored.credentials },
    };
  }
}
