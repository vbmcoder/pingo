// src/lib/avatarCache.js
// Avatar caching and lifecycle management for local filesystem storage
// Ensures avatars persist across app restarts and prevents flicker from presence updates

import * as api from './api';

/**
 * Avatar cache management — separates profile data from presence data
 * Stores avatars locally in Documents/Pingo/avatars/ for persistence
 */

// In-memory cache of device_id -> local_avatar_url (prevents repeated file I/O)
const avatarCache = new Map();

// Track when avatars are being downloaded to prevent race conditions
const avatarDownloadsInFlight = new Map();

// Track whether we've already logged a cache-hit for a device this session
// to avoid spamming the console repeatedly.
const cacheHitLogged = new Set();

/**
 * Get the local avatar URL for a user from cache (synchronous)
 * Returns the cached local file URL if available
 * @param {string} deviceId - User's device ID
 * @returns {string|null} Local avatar file URL or null
 */
export function getLocalAvatarUrl(deviceId) {
    return avatarCache.get(deviceId) || null;
}

/**
 * Cache an avatar URL locally (async)
 * Downloads from remote HTTP server and saves to local filesystem
 * If already cached, returns the existing local URL without re-downloading
 *
 * @param {string} deviceId - User's device ID (unique key)
 * @param {string} remoteUrl - HTTP URL to fetch avatar from
 * @param {string} fileName - Optional name hint (username, email, etc for readability)
 * @returns {Promise<string>} Local file URL (e.g., app-file://path/to/avatars/user_abc123.png)
 */
export async function cacheAvatarFromUrl(deviceId, remoteUrl, fileName = null) {
    if (!deviceId || !remoteUrl) {
        console.warn('[Avatar] Invalid params: deviceId or remoteUrl missing');
        return null;
    }

    // Return cached value immediately if available
    const cached = avatarCache.get(deviceId);
    if (cached) {
        // Avoid spamming logs: only log the first cache-hit seen per device this session
        if (!cacheHitLogged.has(deviceId)) {
            console.log(`[Avatar] Using cached avatar for ${deviceId}`);
            cacheHitLogged.add(deviceId);
        } else {
            // Use debug level for subsequent hits so it can be filtered in devtools
            console.debug && console.debug(`[Avatar] Using cached avatar for ${deviceId}`);
        }
        return cached;
    }

    // Prevent concurrent downloads for same user
    if (avatarDownloadsInFlight.has(deviceId)) {
        const pending = avatarDownloadsInFlight.get(deviceId);
        console.log(`[Avatar] Already downloading avatar for ${deviceId}, waiting...`);
        return pending;
    }

    // Create download promise
    const downloadPromise = (async () => {
        try {
            const localUrl = await api.downloadAndCacheAvatar(deviceId, remoteUrl, fileName || deviceId);
            if (localUrl) {
                avatarCache.set(deviceId, localUrl);
                console.log(`[Avatar] Cached avatar for ${deviceId}: ${localUrl}`);
                return localUrl;
            }
            return null;
        } catch (err) {
            console.error(`[Avatar] Failed to cache avatar for ${deviceId}:`, err);
            return null;
        } finally {
            avatarDownloadsInFlight.delete(deviceId);
        }
    })();

    avatarDownloadsInFlight.set(deviceId, downloadPromise);
    return downloadPromise;
}

/**
 * Pre-populate avatar cache from stored local paths
 * Called during app initialization to hydrate cache from persistent storage
 *
 * @param {Array<Object>} users - User list with id and avatar_path
 */
export function hydrateCacheFromUsers(users = []) {
    if (!Array.isArray(users)) return;

    users.forEach(user => {
        if (user.id && user.avatar_path && isLocalAvatarPath(user.avatar_path)) {
            avatarCache.set(user.id, user.avatar_path);
        }
    });

    console.log(`[Avatar] Hydrated cache with ${avatarCache.size} local avatars`);
}

/**
 * Check if a path is already a local cached avatar (not a remote URL)
 * @param {string} path - Path or URL to check
 * @returns {boolean} True if path is local, false if remote/placeholder
 */
export function isLocalAvatarPath(path) {
    if (!path) return false;
    // Local paths won't start with http://, https://, or filemeta:
    return !path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('filemeta:');
}

/**
 * Clear cached avatar for a user (e.g., when they're deleted)
 * @param {string} deviceId - User's device ID
 */
export function clearCache(deviceId) {
    avatarCache.delete(deviceId);
    avatarDownloadsInFlight.delete(deviceId);
}

/**
 * Invalidate cache to force re-download (e.g., if avatar changed)
 * @param {string} deviceId - User's device ID
 */
export function invalidateCache(deviceId) {
    avatarDownloadsInFlight.delete(deviceId); // Prevent stale promise
    avatarCache.delete(deviceId);
}

/**
 * Update avatar cache with new value
 * Used when we know the new avatar path (e.g., from local storage)
 * @param {string} deviceId - User's device ID
 * @param {string} localUrl - New local avatar URL
 */
export function setLocalAvatarUrl(deviceId, localUrl) {
    if (deviceId && localUrl && isLocalAvatarPath(localUrl)) {
        avatarCache.set(deviceId, localUrl);
    }
}

/**
 * Check if an avatar is currently being downloaded
 * @param {string} deviceId - User's device ID
 * @returns {boolean} True if download is in flight
 */
export function isDownloadInFlight(deviceId) {
    return avatarDownloadsInFlight.has(deviceId);
}

/**
 * Clone current cache state (for debugging / testing)
 * @returns {Object} Copy of internal cache
 */
export function getCacheState() {
    return Object.fromEntries(avatarCache);
}
