// src/lib/notifications.js
// Native Windows Notifications for Pingo with Avatar Support
// Shows notifications for chat messages with sender photo, name, and message preview
// When clicked, Windows focuses the app - navigation is handled by a notification handler
// Works even when window is minimized or closed

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import * as api from './api.js';

let permissionGranted = false;

// Check if running in a Tauri environment
const isTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

// Store recent notifications so if app is clicked from notification, we can determine which chat to open
const recentNotifications = [];
const MAX_RECENT_NOTIFICATIONS = 5;

/**
 * Initialize notification system
 */
export async function initNotifications() {
    if (!isTauri) {
        console.warn('[Notifications] Browser mode (notifications simulated)');
        permissionGranted = true;
        return true;
    }

    try {
        permissionGranted = await isPermissionGranted();

        if (!permissionGranted) {
            const permission = await requestPermission();
            permissionGranted = permission === 'granted';
        }
        console.log('[Notifications] Initialized -', permissionGranted ? 'granted' : 'denied');
    } catch (err) {
        console.error('[Notifications] Init failed:', err);
        permissionGranted = false;
    }

    return permissionGranted;
}

/**
 * Show a native notification with sender metadata support
 * @param {string} body - Notification body text (sender: message preview)
 * @param {Object} options - Additional options
 * @param {string} options.tag - Unique identifier (prevents duplicates)
 * @param {string} options.senderId - Sender's device ID (for opening chat)
 * @param {string} options.senderName - Sender's name  
 * @param {string} options.senderAvatar - Sender's avatar (data URL or path)
 */
async function showNotification(body, options = {}) {
    // Check if notifications are muted
    try {
        const isMuted = await api.isNotificationsMuted?.();
        if (isMuted) return;
    } catch { /* ignore */ }

    if (!permissionGranted) {
        await initNotifications();
    }

    if (!permissionGranted) return;

    if (!isTauri) {
        console.log(`[📬 Notification from Pingo] ${body}`);
        if ('Notification' in window && Notification.permission === 'granted') {
            const notification = new Notification('Pingo Messenger', { body, ...options });
            if (options.onClick) {
                notification.addEventListener('click', options.onClick);
            }
        }
        return;
    }

    try {
        const notificationId = options.tag || `notif_${Date.now()}`;

        // Store metadata for potential click handling (if notification driver supports it)
        if (options.senderId) {
            // Add to recent notifications (keep most recent)
            recentNotifications.unshift({
                id: notificationId,
                senderId: options.senderId,
                senderName: options.senderName || 'User',
                senderAvatar: options.senderAvatar,
                timestamp: Date.now(),
                type: 'chat',
            });

            // Keep only recent notifications
            if (recentNotifications.length > MAX_RECENT_NOTIFICATIONS) {
                recentNotifications.pop();
            }
        }

        // Send native Windows notification with "Pingo Messenger" title
        // Format: "Pingo Messenger" with body like "John Doe: Hey bro are you free?"
        await sendNotification({
            title: 'Pingo Messenger',
            body: body,
            tag: notificationId
        });

        console.log('[Notifications] Sent notification with ID:', notificationId);
    } catch (err) {
        console.error('[Notifications] Failed to send:', err);
    }
}

/**
 * Get the most recent notification (for when app is activated from notification)
 * @returns {Object|null} Recent notification metadata or null
 */
export function getLastNotification() {
    return recentNotifications.length > 0 ? recentNotifications[0] : null;
}

/**
 * Clear notification history after handling
 */
export function clearNotificationHistory() {
    recentNotifications.length = 0;
}

/**
 * Show direct message notification with sender avatar and name
 * Displays as: "Pingo Messenger" | "John Doe: Hey bro are you free?"
 * When clicked, automatically opens the specific chat with the sender
 * Designed to work when app is minimized or completely closed
 * 
 * @param {string} senderName - Name of message sender  
 * @param {string} messagePreview - Message content preview
 * @param {string} senderId - Device ID of sender (for opening chat)
 * @param {string} senderAvatar - Sender's avatar (data URL or file path) - OPTIONAL
 */
export async function showMessageNotification(senderName, messagePreview, senderId, senderAvatar = null) {
    // Truncate long messages to reasonable preview length
    const preview = messagePreview.length > 100
        ? messagePreview.substring(0, 100) + '…'
        : messagePreview;

    // Format: "John Doe: Hey bro are you free?"
    const body = `${senderName}: ${preview}`;

    // Use sender ID as tag to prevent duplicate notifications for same sender  
    const notificationTag = `dm_${senderId}_${Date.now()}`;

    await showNotification(body, {
        tag: notificationTag,
        senderId: senderId,
        senderName: senderName,
        senderAvatar: senderAvatar,
    });
}

/**
 * Show group message notification — ALWAYS show, regardless of window visibility
 * Works when app is minimized or closed
 * 
 * @param {string} groupName - Name of the group
 * @param {string} senderName - Name of message sender in group
 * @param {string} messagePreview - Message content preview
 * @param {string} groupId - Group ID (for deduplication)
 */
export async function showGroupMessageNotification(groupName, senderName, messagePreview, groupId) {
    // Truncate long messages
    const preview = messagePreview.length > 120
        ? messagePreview.substring(0, 120) + '…'
        : messagePreview;

    // Format: "ProjectX - John Doe: Let's meet tomorrow"
    const body = `${groupName} - ${senderName}: ${preview}`;
    const notificationTag = `group_${groupId}_${Date.now()}`;

    await showNotification(body, {
        tag: notificationTag,
    });
}

/**
 * Show file received notification (Direct Message)
 * @param {string} senderName - Who sent the file
 * @param {string} fileName - Name of the file
 * @param {string} senderId - Device ID of sender
 * @param {string} fileType - Type of file (image, video, file, etc.)
 */
export async function showFileNotification(senderName, fileName, senderId, fileType = 'file') {
    const notificationTag = `file_${senderId}_${Date.now()}`;
    const typeEmoji = fileType === 'image' ? '🖼️' : fileType === 'video' ? '🎥' : '📎';
    const body = `${typeEmoji} ${senderName} sent ${fileType}: ${fileName}`;

    await showNotification(body, {
        tag: notificationTag,
        senderId: senderId,
        senderName: senderName,
    });
}

/**
 * Show file notification for group messages
 * @param {string} groupName - Name of the group
 * @param {string} senderName - Who sent the file
 * @param {string} fileName - Name of the file
 * @param {string} groupId - Group ID
 * @param {string} fileType - Type of file
 */
export async function showGroupFileNotification(groupName, senderName, fileName, groupId, fileType = 'file') {
    const notificationTag = `group_file_${groupId}_${Date.now()}`;
    const typeEmoji = fileType === 'image' ? '🖼️' : fileType === 'video' ? '🎥' : '📎';
    const body = `${typeEmoji} ${groupName} - ${senderName} sent ${fileType}: ${fileName}`;

    await showNotification(body, {
        tag: notificationTag,
    });
}

/**
 * Show screen share invite notification
 * @param {string} hostName - Name of the host sharing screen
 */
export async function showScreenShareInvite(hostName) {
    const body = `${hostName} wants to share their screen with you`;

    await showNotification(body, {
        tag: 'screen_share'
    });
}
export function isEnabled() {
    return permissionGranted;
}
