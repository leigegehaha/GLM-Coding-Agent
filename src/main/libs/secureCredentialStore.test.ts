import { describe, expect, test, vi } from 'vitest';

import {
  SECURE_CREDENTIAL_STORE_KEY,
  SecureCredentialStore,
} from './secureCredentialStore';

const createBacking = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => {
      values.set(key, value);
    },
    delete: (key: string): void => {
      values.delete(key);
    },
  };
};

describe('SecureCredentialStore', () => {
  test('stores only encrypted credential material', () => {
    const backing = createBacking();
    const store = new SecureCredentialStore(backing, {
      isAvailable: () => true,
      encrypt: value => Buffer.from(`encrypted:${value}`, 'utf8'),
      decrypt: value => value.toString('utf8').replace(/^encrypted:/, ''),
    });

    store.set('coding-plan', 'production-secret');

    expect(store.get('coding-plan')).toBe('production-secret');
    expect(JSON.stringify(backing.values.get(SECURE_CREDENTIAL_STORE_KEY)))
      .not.toContain('production-secret');
  });

  test('refuses to persist when operating-system encryption is unavailable', () => {
    const backing = createBacking();
    const encrypt = vi.fn<(value: string) => Buffer>();
    const store = new SecureCredentialStore(backing, {
      isAvailable: () => false,
      encrypt,
      decrypt: () => '',
    });

    expect(() => store.set('coding-plan', 'secret')).toThrow(
      'Operating-system credential encryption is unavailable.',
    );
    expect(encrypt).not.toHaveBeenCalled();
    expect(backing.values.size).toBe(0);
  });

  test('deletes the backing entry after the final credential is removed', () => {
    const backing = createBacking();
    const store = new SecureCredentialStore(backing, {
      isAvailable: () => true,
      encrypt: value => Buffer.from(value, 'utf8'),
      decrypt: value => value.toString('utf8'),
    });
    store.set('coding-plan', 'secret');

    store.delete('coding-plan');

    expect(backing.values.has(SECURE_CREDENTIAL_STORE_KEY)).toBe(false);
  });
});
