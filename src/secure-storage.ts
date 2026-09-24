import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, chmodSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as cryptoModule from 'crypto';

const isNodeEnvironment = typeof process !== 'undefined' && 
                         process.versions !== undefined && 
                         process.versions.node !== undefined;

const memoryStore: Record<string, string> = {};
const crypto = cryptoModule && typeof cryptoModule.randomBytes === 'function' ? cryptoModule : null;

function getStorageDir(): string {
  return process.env.PONTIS_DIR || join(homedir(), '.pontis');
}
function getCredentialsFile(): string {
  return join(getStorageDir(), 'credentials.enc');
}
function getSecretKeyFile(): string {
  return join(getStorageDir(), '.secret');
}

function ensureStorageDir(): void {
  const dir = getStorageDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

function warn(message: string): void {
  try {
    process.stderr.write(`pontis: ${message}\n`);
  } catch {}
}

// The key file exists but is malformed. Regenerating silently would
// permanently brick every stored credential, so back it up and warn instead.
function handleCorruptKey(secretFile: string): void {
  try {
    copyFileSync(secretFile, `${secretFile}.corrupt`);
  } catch {}
  warn(
    `the credential vault key (${secretFile}) is invalid — expected 32 bytes. ` +
    `A new key was generated and the old one backed up to ${secretFile}.corrupt. ` +
    `Credentials stored under the old key can no longer be decrypted; re-add them with \`pontis auth set\`.`,
  );
}

function getEncryptionKey(): Buffer {
  if (!crypto) throw new Error('Crypto module not available');

  ensureStorageDir();
  const secretFile = getSecretKeyFile();
  if (existsSync(secretFile)) {
    try {
      const key = readFileSync(secretFile);
      if (key.length === 32) return key;
      handleCorruptKey(secretFile);
    } catch {}
  }

  const newKey = crypto.randomBytes(32);
  try {
    writeFileSync(secretFile, newKey, { mode: 0o600 });
    // mode only applies on creation, so enforce it explicitly in case the file
    // already existed with looser permissions.
    try { chmodSync(secretFile, 0o600); } catch {}
  } catch {}
  return newKey;
}

function encrypt(data: string): { encrypted: string; iv: string; authTag: string } {
  if (!crypto) throw new Error('Crypto module not available');
  
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

function decrypt(encryptedData: string, ivHex: string, authTagHex: string): string {
  if (!crypto) throw new Error('Crypto module not available');
  
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

interface CredentialStore {
  [key: string]: {
    encrypted: string;
    iv: string;
    authTag: string;
    timestamp: number;
  };
}

function loadCredentialStore(): CredentialStore {
  const file = getCredentialsFile();
  if (!existsSync(file)) return {};
  try {
    const data = readFileSync(file, 'utf8');
    return JSON.parse(data) as CredentialStore;
  } catch {
    return {};
  }
}

function saveCredentialStore(store: CredentialStore): void {
  ensureStorageDir();
  const file = getCredentialsFile();
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(store, null, 2);
  // Write to a temp file then rename so a crash mid-write can't truncate the
  // store and silently wipe every credential.
  writeFileSync(tmp, json, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch {
    // rename-over-existing can fail on some platforms; fall back to a direct write.
    writeFileSync(file, json, { mode: 0o600 });
    try { unlinkSync(tmp); } catch {}
  }
  try { chmodSync(file, 0o600); } catch {}
}

export function storeCredential(key: string, value: string): void {
  if (!isNodeEnvironment) {
    memoryStore[key] = value;
    return;
  }
  
  ensureStorageDir();
  const store = loadCredentialStore();
  const { encrypted, iv, authTag } = encrypt(value);
  store[key] = {
    encrypted,
    iv,
    authTag,
    timestamp: Date.now(),
  };
  saveCredentialStore(store);
}

export function retrieveCredential(key: string): string | null {
  if (!isNodeEnvironment) return memoryStore[key] || null;
  
  const store = loadCredentialStore();
  const entry = store[key];
  if (!entry) return null;
  
  try {
    return decrypt(entry.encrypted, entry.iv, entry.authTag);
  } catch {
    // The entry exists but won't decrypt (corrupt store or a rotated key).
    // Surface this rather than silently acting as if no credential is stored.
    warn(
      `stored credential "${key}" could not be decrypted (the vault key may have changed). ` +
      `Re-add it with \`pontis auth set\`.`,
    );
    return null;
  }
}

export function deleteCredential(key: string): void {
  if (!isNodeEnvironment) {
    delete memoryStore[key];
    return;
  }
  
  const store = loadCredentialStore();
  delete store[key];
  saveCredentialStore(store);
}

export function hasCredential(key: string): boolean {
  if (!isNodeEnvironment) return key in memoryStore;
  const store = loadCredentialStore();
  return key in store;
}

export function listCredentialKeys(): string[] {
  if (!isNodeEnvironment) return Object.keys(memoryStore);
  const store = loadCredentialStore();
  return Object.keys(store);
}

export function clearAllCredentials(): void {
  if (!isNodeEnvironment) {
    Object.keys(memoryStore).forEach(key => delete memoryStore[key]);
    return;
  }

  // Overwriting with random data does not reliably erase data on CoW/SSD/
  // journaled filesystems, so just delete the store and the encryption key.
  for (const file of [getCredentialsFile(), getSecretKeyFile()]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {}
  }
}

export const CREDENTIAL_KEYS = {
  OPENCODE_API_KEY: 'opencode_api_key',
  CLOUDFLARE_API_TOKEN: 'cloudflare_api_token',
  LOCAL_API_KEY: 'local_api_key',
  GOOGLE_API_KEY: 'google_api_key',
} as const;

export function storeOpenCodeApiKey(apiKey: string): void {
  storeCredential(CREDENTIAL_KEYS.OPENCODE_API_KEY, apiKey);
}

export function retrieveOpenCodeApiKey(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.OPENCODE_API_KEY);
}

export function deleteOpenCodeApiKey(): void {
  deleteCredential(CREDENTIAL_KEYS.OPENCODE_API_KEY);
}

export function storeCloudflareApiToken(apiToken: string): void {
  storeCredential(CREDENTIAL_KEYS.CLOUDFLARE_API_TOKEN, apiToken);
}

export function retrieveCloudflareApiToken(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.CLOUDFLARE_API_TOKEN);
}

export function deleteCloudflareApiToken(): void {
  deleteCredential(CREDENTIAL_KEYS.CLOUDFLARE_API_TOKEN);
}

export function storeLocalApiKey(apiKey: string): void {
  storeCredential(CREDENTIAL_KEYS.LOCAL_API_KEY, apiKey);
}

export function retrieveLocalApiKey(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.LOCAL_API_KEY);
}

export function deleteLocalApiKey(): void {
  deleteCredential(CREDENTIAL_KEYS.LOCAL_API_KEY);
}

export function storeGoogleApiKey(apiKey: string): void {
  storeCredential(CREDENTIAL_KEYS.GOOGLE_API_KEY, apiKey);
}

export function retrieveGoogleApiKey(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.GOOGLE_API_KEY);
}

export function deleteGoogleApiKey(): void {
  deleteCredential(CREDENTIAL_KEYS.GOOGLE_API_KEY);
}