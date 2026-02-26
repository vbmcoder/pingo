// src/lib/index.js
// Pingo Library - Main Export

// Tauri API wrapper
export * from './api.js';

// WebRTC connection manager
export { WebRTCManager, webrtc } from './webrtc.js';

// Screen sharing
export {
    ScreenShareManager,
    ScreenShareSession,
    ScreenShareState,
    ParticipantStatus,
    screenShare
} from './screenShare.js';

// Notifications
export * as notifications from './notifications.js';

// Re-export commonly used functions
export {
    initApp,
    createUser,
    getLocalUser,
    sendMessage,
    getMessages,
    startDiscovery,
    stopDiscovery,
    getPeers,
    getOnlinePeers,
    prepareFileSend,
    getTransferProgress,
    setSetting,
    getSetting,
    minimizeToTray,
    showWindow,
} from './api.js';
