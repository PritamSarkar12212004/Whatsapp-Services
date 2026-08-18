/**
 * Pure helpers for WhatsApp -> CRM contact synchronization.
 * No module state, no model dependencies — safe to import anywhere.
 *
 * @module contactSync/contactSync.helpers
 */

// ---------------------------------------------------------------------------
// Pagination defaults (used by the sync endpoint and list handlers)
// ---------------------------------------------------------------------------
export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// Retry policy: controlled retry, max 3 attempts with backoff [2s, 5s, 10s].
export const RETRY_DELAYS_MS = [2000, 5000, 10000];

// How long to wait for the app-state sync after connection is ready.
export const APP_STATE_GRACE_MS = 3000;

// The USync directory query can hang on some accounts.
export const USYNC_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// JID detection
// ---------------------------------------------------------------------------

/** True for real phone JIDs, e.g. "919876543210@s.whatsapp.net". */
export const isPnJid = (jid) => /^\d+@s\.whatsapp\.net$/i.test(jid);

/** True for LID (privacy) JIDs, e.g. "1234567890@lid". */
export const isLidJid = (jid) => /^\d+@lid$/i.test(jid);

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Resolve after `ms` milliseconds (promise-based sleep). */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
