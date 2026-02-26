// src/lib/api.js
// Tauri IPC wrapper – all backend communication goes through here

const isTauri = typeof window !== 'undefined' && window.__TAURI__;

async function invoke(cmd, args = {}) {
    if (isTauri) {
        const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
        return tauriInvoke(cmd, args);
    }
    console.warn(`[mock] ${cmd}`, args);
    return null;
}

async function listen(event, handler) {
    if (isTauri) {
        const { listen: tauriListen } = await import('@tauri-apps/api/event');
        return tauriListen(event, (e) => handler(e.payload));
    }
    return () => { };
}

// ============ INITIALIZATION ============
export const initApp = () => invoke('init_app');

// ============ USER ============
export const createUser = (username, avatarPath = null, bio = null, designation = null) =>
    invoke('create_user', { input: { username, avatar_path: avatarPath, bio, designation } });
export const getUser = (id) => invoke('get_user', { id });
export const getAllUsers = () => invoke('get_all_users');
export const getLocalUser = () => invoke('get_local_user');
export const saveAvatar = (imageData) => invoke('save_avatar', { imageData });
export const deleteUser = (userId) => invoke('delete_user', { userId });

// ============ MESSAGES ============
export const sendMessage = (receiverId, content, messageType = 'text', filePath = null) =>
    invoke('send_message', { input: { receiver_id: receiverId, content, message_type: messageType, file_path: filePath } });
export const getMessages = (peerId, limit = 100) => invoke('get_messages', { peerId, limit });
export const getMessagesPaginated = (peerId, before = null, limit = 50) =>
    invoke('get_messages_paginated', { peerId, before, limit });
export const getNewMessagesSince = (peerId, since) => invoke('get_new_messages_since', { peerId, since });
export const markMessageRead = (messageId) => invoke('mark_message_read', { messageId });
export const markMessagesReadFromPeer = (peerId) => invoke('mark_messages_read_from_peer', { peerId });
export const getUnreadCount = () => invoke('get_unread_count');
export const getUnreadCountFromPeer = (peerId) => invoke('get_unread_count_from_peer', { peerId });
export const getLastMessages = () => invoke('get_last_messages');
export const getSharedMedia = (peerId, mediaType = null) => invoke('get_shared_media', { peerId, mediaType });
export const getUsersWithMessages = () => invoke('get_users_with_messages');
export const deleteMessage = (messageId) => invoke('delete_message', { messageId });
export const deleteAllMessagesWithPeer = (peerId) => invoke('delete_all_messages_with_peer', { peerId });

// ============ CHAT RELAY ============
export const relayChatMessage = (peerId, messageId, content, messageType = 'text', senderName = '') =>
    invoke('relay_chat_message', { peerId, messageId, content, messageType, senderName });
export const markMessageDelivered = (messageId) => invoke('mark_message_delivered', { messageId });
export const getUndeliveredMessagesForPeer = (peerId) => invoke('get_undelivered_messages_for_peer', { peerId });

// ============ DISCOVERY ============
export const startDiscovery = (username, port) => invoke('start_discovery', { username, port });
export const stopDiscovery = () => invoke('stop_discovery');
export const getPeers = () => invoke('get_peers');
export const getOnlinePeers = () => invoke('get_online_peers');
export const restartDiscovery = (username, port) => invoke('restart_discovery', { username, port });

// ============ SIGNALING ============
export const startSignaling = (port = 45678) => invoke('start_signaling', { port });
export const registerPeer = (peerId, ip, port) => invoke('register_peer', { peerId, ip, port });
export const sendSignalingMessage = (peerId, message) => invoke('send_signaling_message', { peerId, message });

// ============ ENCRYPTION ============
export const establishSession = (peerId, peerPublicKey) => invoke('establish_session', { peerId, peerPublicKey });
export const encryptMessage = (peerId, message) => invoke('encrypt_message', { peerId, message });
export const decryptMessage = (peerId, envelope) => invoke('decrypt_message', { peerId, envelope });
export const getPublicKey = () => invoke('get_public_key');

// ============ FILE SERVER ============
export const storeSharedFile = (fileId, dataUrl, fileName) => invoke('store_shared_file', { fileId, dataUrl, fileName });
export const getFileServerPort = () => invoke('get_file_server_port');

/// Read file directly from disk as data URL (bypasses HTTP server)
// Provide both camelCase and snake_case keys to be robust to argument-name mapping.
export const readFileAsDataUrl = (fileId) => invoke('read_file_as_data_url', { fileId, file_id: fileId });

// ============ FILE DOWNLOAD & MANAGEMENT ============
export const autoDownloadFile = (url, senderName, fileName, fileType, messageId = null) =>
    invoke('auto_download_file', { url, senderName, fileName, fileType, messageId });
export const openFileLocation = (path) => invoke('open_file_location', { path });
export const saveFileWithDialog = (url, defaultName) => invoke('save_file_with_dialog', { url, defaultName });
export const renameUserDownloadFolder = (oldName, newName) => invoke('rename_user_download_folder', { oldName, newName });
export const getPingoDownloadsBase = () => invoke('get_pingo_downloads_base');
export const checkFileDownloaded = (senderName, fileName, fileType) =>
    invoke('check_file_downloaded', { senderName, fileName, fileType });
export const getLocalFileUrl = (fileId) => invoke('get_local_file_url', { fileId });
// Find the raw file stored by the sender (shared_files dir, by fileId prefix)
export const getSharedFilePath = (fileId) => invoke('get_shared_file_path', { fileId, file_id: fileId });

// ============ FILE TRANSFER ============
export const prepareFileSend = (filePath) => invoke('prepare_file_send', { filePath });
export const prepareFileReceive = (metadata) => invoke('prepare_file_receive', { metadata });
export const getFileChunk = (transferId, chunkIndex) => invoke('get_file_chunk', { transferId, chunkIndex });
export const receiveFileChunk = (chunk) => invoke('receive_file_chunk', { chunk });
export const getTransferProgress = (transferId) => invoke('get_transfer_progress', { transferId });
export const getMissingChunks = (transferId) => invoke('get_missing_chunks', { transferId });
export const completeTransfer = (transferId) => invoke('complete_transfer', { transferId });
export const cancelTransfer = (transferId) => invoke('cancel_transfer', { transferId });

// ============ SETTINGS ============
export const setSetting = (key, value) => invoke('set_setting', { key, value });
export const getSetting = (key) => invoke('get_setting', { key });
export const getAllSettings = () => invoke('get_all_settings');

// ============ NOTIFICATIONS ============
export const toggleNotificationsMute = () => invoke('toggle_notifications_mute');
export const isNotificationsMuted = () => invoke('is_notifications_muted');

// ============ WINDOW ============
export const minimizeToTray = () => invoke('minimize_to_tray');
export const showWindow = () => invoke('show_window');
export const isWindowVisible = () => invoke('is_window_visible');

// ============ UTILITY ============
export const getDeviceId = () => invoke('get_device_id');
export const generateUuid = () => invoke('generate_uuid');
export const getTimestamp = () => invoke('get_timestamp');
export const appendDevLog = (message) => invoke('append_dev_log', { message });
export const getDownloadsDir = () => invoke('get_downloads_dir');
export const getStorageStats = () => invoke('get_storage_stats');
export const upsertPeerUser = (deviceId, username, publicKey = null) =>
    invoke('upsert_peer_user', { deviceId, username, publicKey });

// ============ NOTES ============
export const saveNote = (input) => invoke('save_note', { input });
export const getAllNotes = () => invoke('get_all_notes');
export const deleteNote = (id) => invoke('delete_note', { id });
export const toggleNotePin = (id) => invoke('toggle_note_pin', { id });

// ============ GROUPS ============
export const createGroup = (name, memberIds, memberNames) =>
    invoke('create_group', { input: { name, member_ids: memberIds, member_names: memberNames } });
export const getGroups = () => invoke('get_groups');
export const getGroupMembers = (groupId) => invoke('get_group_members', { groupId });
export const sendGroupMessage = (groupId, content, messageType = 'text') =>
    invoke('send_group_message', { input: { group_id: groupId, content, message_type: messageType } });
export const getGroupMessages = (groupId, limit = 100) => invoke('get_group_messages', { groupId, limit });
export const deleteGroup = (groupId) => invoke('delete_group', { groupId });
export const addGroupMember = (groupId, userId, username) => invoke('add_group_member', { groupId, userId, username });
export const removeGroupMember = (groupId, userId) => invoke('remove_group_member', { groupId, userId });
export const leaveGroup = (groupId) => invoke('leave_group', { groupId });
export const getAllUsersForGroup = () => invoke('get_all_users_for_group');

// ============ AVATAR MANAGEMENT ============
export const downloadAndCacheAvatar = (deviceId, remoteUrl, hintName = null) =>
    // Tauri requires args to match Rust function parameter names (camelCase). Provide both
    // camelCase and snake_case keys to remain robust across versions.
    invoke('download_and_cache_avatar', {
        deviceId: deviceId,
        remoteUrl: remoteUrl,
        hintName: hintName,
        // Backwards-compatible keys
        device_id: deviceId,
        remote_url: remoteUrl,
        hint_name: hintName,
    });

// Register existing local avatar file with file server and return local http URL
export const registerLocalAvatar = (deviceId, filePath) =>
    invoke('register_local_avatar', {
        deviceId: deviceId,
        filePath: filePath,
        device_id: deviceId,
        file_path: filePath,
    });

// ============ DISCOVERY EVENTS ============
export const onPeerDiscovered = (handler) => listen('peer-discovered', handler);
export const onPeerUpdated = (handler) => listen('peer-updated', handler);
export const onPeerLost = (handler) => listen('peer-lost', handler);

export const onSignalingMessage = (handler) => listen('signaling-message', handler);
export const onChatMessageReceived = (handler) => listen('chat-message-received', handler);
export const onUserDeleted = (handler) => listen('user-deleted', handler);
export const onGroupCreated = (handler) => listen('group-created', handler);
export const onGroupMessageReceived = (handler) => listen('group-message-received', handler);
export const onMeetingChatReceived = (handler) => listen('meeting-chat-received', handler);
export const onGroupMemberAdded = (handler) => listen('group-member-added', handler);
export const onGroupMemberRemoved = (handler) => listen('group-member-removed', handler);
// File download progress events from Rust (stage: 'downloading'|'saving'|'complete'|'error'|'cached')
// payload: { fileId, fileName, stage, progress, localPath? }
export const onFileDownloadProgress = (handler) => listen('file-download-progress', handler);
// ============ SCREEN CAPTURE ============
/**
 * Capture primary display with native Rust backend
 * @returns {Promise<string>} PNG image as base64 data URL
 */
export const captureScreenPrimary = async () => {
    const dataUrl = await invoke('capture_screen_primary');
    return dataUrl;
};

/**
 * Capture specific display by index
 * @param {number} displayIndex - Display index (0 = primary)
 * @returns {Promise<string>} PNG image as base64 data URL
 */
export const captureScreen = async (displayIndex = 0) => {
    const dataUrl = await invoke('capture_screen', { display_index: displayIndex });
    return dataUrl;
};

/**
 * List all available displays
 * @returns {Promise<Array>} Array of display info {index, width, height, name}
 */
export const listDisplays = () => invoke('list_displays');