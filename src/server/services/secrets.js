'use strict';

/**
 * Secure credential storage for the OpenAI API key (Section 14).
 *
 * The key is encrypted at rest with the operating system's own credential
 * protection -- Electron's safeStorage, which is DPAPI on Windows -- and the
 * ciphertext is kept in the local database. It is never written to a plain-text
 * config file, never logged, and never sent anywhere except api.openai.com.
 *
 * If OS-level encryption is unavailable (for example when the backend is run
 * outside Electron during development), storing a key is REFUSED rather than
 * silently downgraded to plain text. The Assistant then reports itself as
 * unconfigured, which is the Section 14.4 graceful-degradation path.
 */

const { getSetting, setSetting } = require('./settings');

const STORE_KEY = 'openai_api_key_enc';
const HINT_KEY = 'openai_api_key_hint';

let safeStorage;
let checked = false;

function getSafeStorage() {
  if (!checked) {
    checked = true;
    try {
      // Only present when running inside the Electron main process.
      const electron = require('electron');
      safeStorage = electron && electron.safeStorage ? electron.safeStorage : null;
      if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
        && !safeStorage.isEncryptionAvailable()) {
        safeStorage = null;
      }
    } catch {
      safeStorage = null;
    }
  }
  return safeStorage;
}

const encryptionAvailable = () => !!getSafeStorage();

function encryptionStatus() {
  const store = getSafeStorage();
  return {
    available: !!store,
    mechanism: store
      ? (process.platform === 'win32' ? 'Windows DPAPI (via Electron safeStorage)' : 'OS keychain (via Electron safeStorage)')
      : null,
    reason: store
      ? null
      : 'Operating-system encryption is not available in this process, so an API key '
        + 'cannot be stored securely. Run the desktop application to configure the Assistant.',
  };
}

/** Last four characters only, so the UI can show which key is saved. */
function keyHint(plain) {
  const s = String(plain || '');
  return s.length > 4 ? `sk-...${s.slice(-4)}` : 'sk-...';
}

function looksLikeOpenAiKey(plain) {
  const s = String(plain || '').trim();
  return s.startsWith('sk-') && s.length >= 20 && !/\s/.test(s);
}

function hasKey() {
  const stored = getSetting(STORE_KEY, '');
  return !!(stored && String(stored).length);
}

function getHint() {
  return getSetting(HINT_KEY, '') || null;
}

/**
 * Stores the key encrypted.
 * @throws when OS encryption is unavailable or the key is obviously malformed.
 */
function setKey(plain) {
  const store = getSafeStorage();
  if (!store) {
    const err = new Error(encryptionStatus().reason);
    err.status = 400;
    err.code = 'NO_SECURE_STORAGE';
    throw err;
  }
  const value = String(plain || '').trim();
  if (!value) {
    const err = new Error('Paste your OpenAI API key.');
    err.status = 400;
    throw err;
  }
  if (!looksLikeOpenAiKey(value)) {
    const err = new Error('That does not look like an OpenAI API key -- they begin with "sk-".');
    err.status = 400;
    err.code = 'BAD_KEY_FORMAT';
    throw err;
  }
  const encrypted = store.encryptString(value);
  setSetting(STORE_KEY, Buffer.from(encrypted).toString('base64'));
  setSetting(HINT_KEY, keyHint(value));
  return { saved: true, hint: keyHint(value) };
}

/**
 * Decrypts and returns the key. Returns null when none is configured.
 * Callers must never log or echo the result.
 */
function getKey() {
  const stored = getSetting(STORE_KEY, '');
  if (!stored) return null;
  const store = getSafeStorage();
  if (!store) return null;
  try {
    return store.decryptString(Buffer.from(String(stored), 'base64'));
  } catch {
    // Typically means the database was copied to another machine or user
    // account: DPAPI ciphertext is not portable, which is the point.
    return null;
  }
}

function clearKey() {
  setSetting(STORE_KEY, '');
  setSetting(HINT_KEY, '');
  return { cleared: true };
}

module.exports = {
  encryptionAvailable,
  encryptionStatus,
  hasKey,
  getHint,
  setKey,
  getKey,
  clearKey,
  looksLikeOpenAiKey,
};
