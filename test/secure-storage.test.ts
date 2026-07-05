import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  storeCredential,
  retrieveCredential,
  hasCredential,
  deleteCredential,
  clearAllCredentials,
  listCredentialKeys
} from '../src/secure-storage';

const STORAGE_DIR = join(homedir(), '.pontis');
const CREDENTIALS_FILE = join(STORAGE_DIR, 'credentials.enc');

describe('Secure Storage', () => {
  beforeEach(() => {
    // Clear storage before each test
    clearAllCredentials();
  });

  afterEach(() => {
    // Clean up
    clearAllCredentials();
  });

  it('can store and retrieve a credential', () => {
    const key = 'test_key';
    const value = 'sk-test-secret-value-12345';

    storeCredential(key, value);
    expect(hasCredential(key)).toBe(true);
    expect(retrieveCredential(key)).toBe(value);
  });

  it('returns null for non-existent credential', () => {
    expect(retrieveCredential('non_existent')).toBeNull();
    expect(hasCredential('non_existent')).toBe(false);
  });

  it('can list stored keys', () => {
    storeCredential('key1', 'val1');
    storeCredential('key2', 'val2');

    const keys = listCredentialKeys();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
  });

  it('can delete a credential', () => {
    const key = 'delete_me';
    storeCredential(key, 'value');
    expect(hasCredential(key)).toBe(true);

    deleteCredential(key);
    expect(hasCredential(key)).toBe(false);
    expect(retrieveCredential(key)).toBeNull();
  });

  it('can clear all credentials', () => {
    storeCredential('k1', 'v1');
    storeCredential('k2', 'v2');
    expect(listCredentialKeys().length).toBe(2);

    clearAllCredentials();
    expect(listCredentialKeys().length).toBe(0);
    expect(existsSync(CREDENTIALS_FILE)).toBe(false);
  });
});
