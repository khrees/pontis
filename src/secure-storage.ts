/**
 * Secure credential storage using encryption.
 * Uses Node.js crypto module for AES-256-GCM encryption.
 * Falls back to environment variables in non-Node.js environments (Cloudflare Workers).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Check if we're in a Node.js environment
const isNodeEnvironment = typeof process !== 'undefined' && 
                         process.versions !== undefined && 
                         process.versions.node !== undefined;

// In-memory fallback for non-Node environments
const memoryStore: Record<string, string> = {};

// Conditional crypto imports
let crypto: any;
try {
  crypto = require('crypto');
} catch {
  // Crypto not available, will use fallback
}

const STORAGE_DIR = join(homedir(), '.pontis');
const CREDENTIALS_FILE = join(STORAGE_DIR, 'credentials.enc');
const SALT_FILE = join(STORAGE_DIR, '.salt');
const KEY_FILE = join(STORAGE_DIR, '.key');

// Ensure storage directory exists
function ensureStorageDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { mode: 0o700 });
  }
}

// Generate or load encryption key
function getEncryptionKey(): Buffer {
  if (!crypto) {
    throw new Error('Crypto module not available');
  }
  
  ensureStorageDir();
  
  // Use a combination of machine-specific factors for key derivation
  const machineId = process.env.USER || process.env.USERNAME || 'default';
  const hostname = process.env.HOSTNAME || 'localhost';
  const platform = process.platform;
  
  // Generate salt
  let salt: Buffer;
  if (existsSync(SALT_FILE)) {
    salt = readFileSync(SALT_FILE);
  } else {
    salt = crypto.randomBytes(32);
    writeFileSync(SALT_FILE, salt, { mode: 0o600 });
  }
  
  // Derive key using scrypt
  const keyMaterial = `${machineId}:${hostname}:${platform}`;
  return crypto.scryptSync(keyMaterial, salt, 32);
}

// Encrypt data using AES-256-GCM
function encrypt(data: string): { encrypted: string; iv: string; authTag: string } {
  if (!crypto) {
    throw new Error('Crypto module not available');
  }
  
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

// Decrypt data using AES-256-GCM
function decrypt(encryptedData: string, ivHex: string, authTagHex: string): string {
  if (!crypto) {
    throw new Error('Crypto module not available');
  }
  
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Credential storage interface
interface CredentialStore {
  [key: string]: {
    encrypted: string;
    iv: string;
    authTag: string;
    timestamp: number;
  };
}

// Load credential store
function loadCredentialStore(): CredentialStore {
  if (!existsSync(CREDENTIALS_FILE)) {
    return {};
  }
  
  try {
    const data = readFileSync(CREDENTIALS_FILE, 'utf8');
    return JSON.parse(data) as CredentialStore;
  } catch {
    return {};
  }
}

// Save credential store
function saveCredentialStore(store: CredentialStore): void {
  ensureStorageDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

// Store a credential securely
export function storeCredential(key: string, value: string): void {
  if (!isNodeEnvironment) {
    // Fallback to memory storage for Cloudflare Workers
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

// Retrieve a credential securely
export function retrieveCredential(key: string): string | null {
  if (!isNodeEnvironment) {
    // Fallback to memory storage for Cloudflare Workers
    return memoryStore[key] || null;
  }
  
  const store = loadCredentialStore();
  const entry = store[key];
  
  if (!entry) {
    return null;
  }
  
  try {
    return decrypt(entry.encrypted, entry.iv, entry.authTag);
  } catch {
    // If decryption fails, remove the corrupted entry
    delete store[key];
    saveCredentialStore(store);
    return null;
  }
}

// Delete a credential
export function deleteCredential(key: string): void {
  if (!isNodeEnvironment) {
    // Fallback to memory storage for Cloudflare Workers
    delete memoryStore[key];
    return;
  }
  
  const store = loadCredentialStore();
  delete store[key];
  saveCredentialStore(store);
}

// Check if a credential exists
export function hasCredential(key: string): boolean {
  if (!isNodeEnvironment) {
    // Fallback to memory storage for Cloudflare Workers
    return key in memoryStore;
  }
  
  const store = loadCredentialStore();
  return key in store;
}

// List all credential keys (without values)
export function listCredentialKeys(): string[] {
  if (!isNodeEnvironment) {
    // Fallback to memory storage for Cloudflare Workers
    return Object.keys(memoryStore);
  }
  
  const store = loadCredentialStore();
  return Object.keys(store);
}

// Clear all credentials
export function clearAllCredentials(): void {
  if (!isNodeEnvironment) {
    // Fallback to memory storage for Cloudflare Workers
    Object.keys(memoryStore).forEach(key => delete memoryStore[key]);
    return;
  }
  
  if (existsSync(CREDENTIALS_FILE)) {
    // Securely delete by overwriting with random data
    const randomData = crypto.randomBytes(1024);
    writeFileSync(CREDENTIALS_FILE, randomData.toString('hex'));
    // Then delete the file
    const fs = require('fs');
    fs.unlinkSync(CREDENTIALS_FILE);
  }
}

// Migration utility: migrate from plain text to encrypted storage
export function migrateFromPlainText(
  plainTextFile: string,
  credentialKey: string
): boolean {
  if (!isNodeEnvironment || !crypto) {
    // No migration needed in non-Node environments
    return false;
  }
  
  try {
    if (!existsSync(plainTextFile)) {
      return false;
    }
    
    const plainTextKey = readFileSync(plainTextFile, 'utf8').trim();
    if (!plainTextKey) {
      return false;
    }
    
    // Store in encrypted format
    storeCredential(credentialKey, plainTextKey);
    
    // Securely delete the plain text file
    const randomData = crypto.randomBytes(1024);
    writeFileSync(plainTextFile, randomData.toString('hex'));
    const fs = require('fs');
    fs.unlinkSync(plainTextFile);
    
    return true;
  } catch {
    return false;
  }
}

// Specific credential types for Pontis
export const CREDENTIAL_KEYS = {
  OPENCODE_API_KEY: 'opencode_api_key',
  CLOUDFLARE_API_TOKEN: 'cloudflare_api_token',
  LOCAL_API_KEY: 'local_api_key',
} as const;

// Convenience functions for specific credential types
export function storeOpenCodeApiKey(apiKey: string): void {
  storeCredential(CREDENTIAL_KEYS.OPENCODE_API_KEY, apiKey);
}

export function retrieveOpenCodeApiKey(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.OPENCODE_API_KEY);
}

export function storeCloudflareApiToken(apiToken: string): void {
  storeCredential(CREDENTIAL_KEYS.CLOUDFLARE_API_TOKEN, apiToken);
}

export function retrieveCloudflareApiToken(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.CLOUDFLARE_API_TOKEN);
}

export function storeLocalApiKey(apiKey: string): void {
  storeCredential(CREDENTIAL_KEYS.LOCAL_API_KEY, apiKey);
}

export function retrieveLocalApiKey(): string | null {
  return retrieveCredential(CREDENTIAL_KEYS.LOCAL_API_KEY);
}