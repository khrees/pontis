import { describe, it, expect, afterAll } from 'vitest';
import {
  generateCanonicalSessionId,
  generateMessageId,
} from '../src/http';

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const MESSAGE_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function stripCrypto() {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function restoreCrypto() {
  if (originalCryptoDescriptor) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  } else {
    delete (globalThis as any).crypto;
  }
}

afterAll(restoreCrypto);

describe('ID generation under a runtime without the WebCrypto global', () => {
  it('still generates well-formed IDs (regression: pkg binary "crypto is not defined")', () => {
    stripCrypto();
    try {
      const session1 = generateCanonicalSessionId();
      const session2 = generateCanonicalSessionId();
      const message = generateMessageId();
      expect(session1).toMatch(SESSION_RE);
      expect(session2).not.toBe(session1);
      expect(message).toMatch(MESSAGE_RE);
    } finally {
      restoreCrypto();
    }
  });
});

describe('ID generation with the WebCrypto global present', () => {
  it('produces canonical IDs', () => {
    const session = generateCanonicalSessionId();
    const another = generateCanonicalSessionId();
    const message = generateMessageId();
    expect(session).toMatch(SESSION_RE);
    expect(session).not.toBe(another);
    expect(message).toMatch(MESSAGE_RE);
  });
});