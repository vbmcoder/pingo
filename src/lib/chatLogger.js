// src/lib/chatLogger.js
// Chat debugging logger — stores logs in memory and localStorage for debugging
// Enabled/disabled via settings page

const MAX_LOGS = 500;
const STORAGE_KEY = 'pingo_chat_logs';
const ENABLED_KEY = 'pingo_chat_logging_enabled';

let logs = [];
let enabled = false;

// Initialize from localStorage
try {
    enabled = localStorage.getItem(ENABLED_KEY) === 'true';
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        logs = JSON.parse(stored);
        if (!Array.isArray(logs)) logs = [];
    }
} catch { logs = []; }

/**
 * Check if chat logging is enabled
 */
export function isEnabled() {
    return enabled;
}

/**
 * Enable/disable chat logging
 */
export function setEnabled(val) {
    enabled = !!val;
    try { localStorage.setItem(ENABLED_KEY, String(enabled)); } catch { /* ignore */ }
}

/**
 * Log a chat event
 * @param {'send' | 'receive' | 'relay' | 'ack' | 'flush' | 'error' | 'profile' | 'discovery' | 'info'} type
 * @param {string} message - Human-readable description
 * @param {object} [data] - Optional structured data
 */
export function log(type, message, data = null) {
    if (!enabled) return;
    const entry = {
        ts: new Date().toISOString(),
        type,
        message,
        ...(data ? { data } : {}),
    };
    logs.push(entry);
    // Trim to max
    if (logs.length > MAX_LOGS) {
        logs = logs.slice(-MAX_LOGS);
    }
    // Persist (debounced via microtask to avoid blocking)
    queueMicrotask(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(logs)); } catch { /* ignore */ }
    });
    // Also output to console for dev tools
    const prefix = `[ChatLog][${type}]`;
    if (type === 'error') {
        console.error(prefix, message, data || '');
    } else {
        console.debug(prefix, message, data || '');
    }
}

/**
 * Get all stored logs
 * @returns {Array} Log entries
 */
export function getLogs() {
    return [...logs];
}

/**
 * Clear all stored logs
 */
export function clearLogs() {
    logs = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Export logs as downloadable JSON string
 */
export function exportLogsAsJson() {
    return JSON.stringify(logs, null, 2);
}
