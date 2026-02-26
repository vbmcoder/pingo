// src/pages/chat.jsx
// Chat page — DM + Group messaging, file/image transfer via HTTP, message deletion

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppContext, useChat, useGroups } from '../context/AppContext';
import UserAvatar from '../components/UserAvatar';
import Profile from '../components/Profile';
import * as avatarCache from '../lib/avatarCache';
import ScreenshotCrop from '../components/ScreenshotCrop';
import ImageLightbox from '../components/ImageLightbox';
import * as api from '../lib/api';

// ═══════════════════════════════════════════════════════════════
//  Helper to resolve file URL from message content
// ═══════════════════════════════════════════════════════════════
function resolveFileUrl(content, senderIp, localPort) {
    // Message content for files is JSON: { fileId, fileName, port, type }
    try {
        const info = JSON.parse(content);
        if (info.fileId) {
            // Return the fileId for lazy loading via direct file read
            return {
                fileId: info.fileId,
                fileName: info.fileName || 'file',
                type: info.type || 'file',
                senderIp: senderIp,
                port: info.port || localPort,
                preferLocal: true,
            };
        }
    } catch { /* not JSON, treat as plain */ }
    if (content?.startsWith('data:')) {
        return { fileId: null, url: content, fileName: 'file', type: 'image' };
    }
    if (content?.startsWith('http')) {
        return { fileId: null, url: content, fileName: 'file', type: 'image' };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
//  ChatPage
// ═══════════════════════════════════════════════════════════════
export default function ChatPage() {
    const {
        localUser, deviceId, peers, allUsers, unreadCounts,
        lastMessages, clearUnread, refreshLastMessages, fileServerPort,
        flushPendingMessages, setActiveChatPeerId,
    } = useAppContext();
    const chat = useChat();
    const groupsHook = useGroups();

    const [search, setSearch] = useState('');
    const [tab, setTab] = useState('dm'); // 'dm' | 'groups'
    const [showProfile, setShowProfile] = useState(null); // peer for profile view
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [contextMenu, setContextMenu] = useState(null); // { x, y, messageId }
    const [confirmClearChat, setConfirmClearChat] = useState(false);
    const [screenshotData, setScreenshotData] = useState(null);
    const [showSharedMedia, setShowSharedMedia] = useState(false);
    const [sharedMediaList, setSharedMediaList] = useState([]);
    const [sharedMediaTab, setSharedMediaTab] = useState('images'); // 'images' | 'files'

    // Group chat state
    const [activeGroup, setActiveGroup] = useState(null);
    const [groupMessages, setGroupMessages] = useState([]);
    const [groupMembers, setGroupMembers] = useState([]);
    const [showGroupInfo, setShowGroupInfo] = useState(false);
    const [groupLastMessages, setGroupLastMessages] = useState({}); // groupId -> { content, message_type, created_at, sender_name }

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const [inputText, setInputText] = useState('');
    const [dragOver, setDragOver] = useState(false);
    const [lightbox, setLightbox] = useState(null); // { url, fileName }
    const [toasts, setToasts] = useState([]); // toast notifications
    const [loadedFileUrls, setLoadedFileUrls] = useState({}); // fileId -> dataUrl cache for direct file reading
    const loadingFilesRef = useRef(new Set()); // Track files currently being loaded to prevent duplicate loads
    const loadedFileIdsRef = useRef(new Set()); // fileIds already loaded — avoids re-running effect on every state update
    const [uploadProgress, setUploadProgress] = useState({}); // uploadId -> { name, progress (0-100), error? }
    const [downloadProgress, setDownloadProgress] = useState({}); // fileId -> { name, progress, stage }

    // Toast helper
    const showToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
    }, []);

    // Peer IP lookup
    const peerIpMap = useMemo(() => {
        const map = {};
        (peers || []).forEach(p => {
            map[p.device_id] = p.ip_address;
        });
        return map;
    }, [peers]);

    // Resolve display username for a device id (prefer DB/allUsers, then peers)
    const resolveUsernameById = useCallback((id) => {
        if (!id) return undefined;
        const fromUsers = (allUsers || []).find(u => u.id === id)?.username;
        if (fromUsers) return fromUsers;
        const fromPeers = (peers || []).find(p => p.device_id === id)?.username;
        if (fromPeers) return fromPeers;
        return undefined;
    }, [peers, allUsers]);

    // Load file data URL by reading directly from disk (bypasses HTTP server)
    const loadFileDataUrl = useCallback(async (fileId) => {
        // Check if already cached in ref (fast path — no state access)
        if (loadedFileIdsRef.current.has(fileId)) {
            return loadedFileUrls[fileId] || null;
        }
        try {
            const dataUrl = await api.readFileAsDataUrl(fileId);
            if (dataUrl) {
                loadedFileIdsRef.current.add(fileId);
                // Cache the loaded URL
                setLoadedFileUrls(prev => ({ ...prev, [fileId]: dataUrl }));
            }
            return dataUrl;
        } catch (err) {
            console.warn('[Pingo] Failed to load file directly:', err);
            return null;
        }
    }, [loadedFileUrls]);

    const handleImageError = useCallback(async (msg) => {
        try {
            const info = JSON.parse(msg.content);
            const fileId = info.fileId;
            const port = info.port || fileServerPort || null;

            if (!fileId) {
                console.warn('[Pingo] handleImageError: no fileId in message');
                return;
            }

            // Skip if already loading this file
            if (loadingFilesRef.current.has(fileId)) return;

            // Skip if already loaded (check ref, not state, to avoid stale closure)
            if (loadedFileIdsRef.current.has(fileId)) return;

            loadingFilesRef.current.add(fileId);

            // Get sender IP from multiple sources
            let senderIp = peerIpMap[msg.sender_id];
            if (!senderIp) {
                const peerData = peers?.find(p => p.device_id === msg.sender_id);
                senderIp = peerData?.ip_address;
            }
            if (!senderIp) {
                const userData = allUsers?.find(u => u.id === msg.sender_id);
                senderIp = userData?.ip_address;
            }

            // First — try to read the file directly from disk via Tauri/Rust (preferred)
            try {
                const dataUrl = await api.readFileAsDataUrl(fileId);
                if (dataUrl) {
                    loadedFileIdsRef.current.add(fileId);
                    setLoadedFileUrls(prev => ({ ...prev, [fileId]: dataUrl }));
                    console.log('[Pingo] Loaded file via direct read for', fileId);
                    loadingFilesRef.current.delete(fileId);
                    return;
                }
            } catch (readErr) {
                console.warn('[Pingo] Direct read failed for', fileId, readErr);
            }

            // If no sender IP or port, we can't fetch remotely
            if (!senderIp || !port) {
                console.warn('[Pingo] handleImageError: no sender IP/port available for', msg.sender_id);
                loadingFilesRef.current.delete(fileId);
                return;
            }

            // Try auto-downloading from remote peer (file will be stored locally)
            const remoteUrl = `http://${senderIp.split(':')[0]}:${port}/file/${fileId}`;
            const senderName = msg.sender_name || resolveUsernameById(msg.sender_id) || 'Unknown';
            const fileType = msg.message_type || 'file';

            console.log('[Pingo] Auto-downloading file:', info.fileName, 'from', remoteUrl);
            try {
                await api.autoDownloadFile(remoteUrl, senderName, info.fileName || 'file', fileType, msg.id);

                // After download, read as data URL (not HTTP)
                const dataUrl = await api.readFileAsDataUrl(fileId).catch(() => null);
                if (dataUrl) {
                    loadedFileIdsRef.current.add(fileId);
                    setLoadedFileUrls(prev => ({ ...prev, [fileId]: dataUrl }));
                    console.log('[Pingo] File downloaded and loaded directly');
                }
            } catch (dlErr) {
                console.warn('[Pingo] Auto-download failed:', dlErr);
            }

            loadingFilesRef.current.delete(fileId);
        } catch (e) {
            console.error('[Pingo] Image error handler failed:', e);
        }
    }, [peerIpMap, fileServerPort, peers, allUsers, resolveUsernameById]);

    // ─── Combined user list (online + offline from DB) ─────
    const userList = useMemo(() => {
        const map = new Map();
        // Add all users from DB
        (allUsers || []).forEach(u => {
            if (u.id !== deviceId) {
                map.set(u.id, {
                    ...u,
                    device_id: u.device_id || u.id,
                    is_online: false,
                });
            }
        });
        // Merge presence but preserve authoritative profile fields from DB
        // ProfileUpdate signaling messages update both allUsers AND peers,
        // so the latest username is whichever was updated most recently.
        (peers || []).forEach(p => {
            const existing = map.get(p.device_id) || {};
            map.set(p.device_id, {
                ...existing,
                ...p,
                id: p.device_id,
                is_online: true,
                // Use the most recently updated username:
                // - If allUsers (DB) has a username, use it (authoritative from ProfileUpdate)
                // - If peers has a different one, use peers (live from presence/ProfileUpdate)
                // - The ProfileUpdate handler updates BOTH, so both should be in sync
                username: p.username || existing.username,
                avatar_path: p.avatar_path || existing.avatar_path,
            });
        });

        let list = Array.from(map.values());

        // Sort: online first, then by last message time, then alphabetical
        list.sort((a, b) => {
            if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
            const aTime = lastMessages[a.device_id || a.id]?.created_at || '';
            const bTime = lastMessages[b.device_id || b.id]?.created_at || '';
            if (aTime !== bTime) return bTime.localeCompare(aTime);
            return (a.username || '').localeCompare(b.username || '');
        });

        if (search) {
            const q = search.toLowerCase();
            list = list.filter(u => u.username?.toLowerCase().includes(q));
        }
        return list;
    }, [allUsers, peers, deviceId, lastMessages, search]);

    // ─── Scroll to bottom on new messages ──────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chat.messages, groupMessages]);

    // ─── Select DM peer ────────────────────────────────────
    const selectDmPeer = useCallback((user) => {
        setActiveGroup(null);
        setShowGroupInfo(false);
        const peerId = user.device_id || user.id;
        const peerObj = {
            device_id: peerId,
            username: user.username,
            is_online: user.is_online,
            ip_address: user.ip_address || peerIpMap[peerId],
            // Prefer whatever avatar we have in the user record, otherwise use hydrated local cache
            avatar_path: user.avatar_path || avatarCache.getLocalAvatarUrl(peerId) || undefined,
        };
        chat.selectPeer(peerObj);
        clearUnread(peerId);
        // Track active peer to suppress unread badge for this conversation
        if (setActiveChatPeerId) setActiveChatPeerId(peerId);
    }, [chat.selectPeer, clearUnread, peerIpMap, setActiveChatPeerId]);

    // ─── Select group ──────────────────────────────────────
    const selectGroup = useCallback(async (group) => {
        chat.selectPeer(null);        // Clear active DM peer tracking when switching to group
        if (setActiveChatPeerId) setActiveChatPeerId(null);
        setActiveGroup(group);
        setShowGroupInfo(false);
        try {
            const msgs = await api.getGroupMessages(group.id, 200);
            const port = fileServerPort || await api.getFileServerPort().catch(() => 0);
            // IMPROVED: Ensure chronological order and properly annotate media messages with local URLs
            const chronological = (msgs || []).slice().reverse().map(m => {
                try {
                    if (m.message_type === 'image' || m.message_type === 'video' || m.message_type === 'file') {
                        const info = JSON.parse(m.content);
                        if (info && info.fileId) {
                            const p = info.port || port || 0;
                            // Use local URL as primary for faster loading
                            const localUrl = `http://127.0.0.1:${p}/file/${info.fileId}`;
                            m._localDataUrl = localUrl;
                            m._fileName = info.fileName || 'file';
                            m._fileType = info.type || m.message_type;
                            m._fileId = info.fileId;
                            m._isLocal = true; // Mark as local for UI feedback
                        }
                    }
                } catch { /* ignore non-json */ }
                return m;
            });
            setGroupMessages(chronological);
            const members = await api.getGroupMembers(group.id);
            setGroupMembers(members || []);
        } catch (e) {
            console.error('Failed to load group:', e);
            showToast('Failed to load group messages', 'error');
        }
    }, [chat.selectPeer, setActiveChatPeerId, fileServerPort, showToast]);

    // ─── Send DM text ──────────────────────────────────────
    const handleSendDm = useCallback(async () => {
        const text = inputText.trim();
        if (!text || !chat.activePeer) return;
        setInputText('');
        await chat.sendText(chat.activePeer.device_id, text, localUser?.username || '');
        refreshLastMessages();
    }, [inputText, chat.activePeer, chat.sendText, localUser, refreshLastMessages]);

    // ─── Send group text ───────────────────────────────────
    const handleSendGroup = useCallback(async () => {
        const text = inputText.trim();
        if (!text || !activeGroup) return;
        setInputText('');
        try {
            const msg = await api.sendGroupMessage(activeGroup.id, text, 'text');
            if (msg) {
                setGroupMessages(prev => [...prev, msg]);
                // Update group last message for sidebar preview
                setGroupLastMessages(prev => ({
                    ...prev,
                    [activeGroup.id]: { content: text, message_type: 'text', created_at: msg.created_at, sender_name: msg.sender_name },
                }));
            }
        } catch (e) {
            console.error('Failed to send group message:', e);
        }
    }, [inputText, activeGroup]);

    // ─── Send group file/image ─────────────────────────────
    const groupFileInputRef = useRef(null);
    const handleGroupFileSelect = useCallback(async (e) => {
        const file = e.target.files?.[0];
        if (!file || !activeGroup) return;
        e.target.value = '';

        const MAX_SIZE = 250 * 1024 * 1024;
        if (file.size > MAX_SIZE) {
            showToast(`File too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Max 250 MB.`, 'error');
            return;
        }

        const uploadId = `up_${Date.now()}`;
        setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 5 } }));

        const reader = new FileReader();
        reader.onprogress = (ev) => {
            if (ev.lengthComputable) {
                const pct = Math.max(5, Math.round(ev.loaded / ev.total * 60));
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: pct } }));
            }
        };
        reader.onload = async (ev) => {
            const dataUrl = ev.target.result;
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');
            const msgType = isImage ? 'image' : isVideo ? 'video' : 'file';
            setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 70 } }));
            try {
                const fileId = `gf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                await api.storeSharedFile(fileId, dataUrl, file.name);
                const port = await api.getFileServerPort();
                const fileInfo = JSON.stringify({ fileId, fileName: file.name, port, type: msgType });
                const msg = await api.sendGroupMessage(activeGroup.id, fileInfo, msgType);
                if (msg) {
                    // Use the original dataUrl for sender's immediate view (no HTTP needed)
                    loadedFileIdsRef.current.add(fileId);
                    setLoadedFileUrls(prev => ({ ...prev, [fileId]: dataUrl }));
                    setGroupMessages(prev => [...prev, {
                        ...msg,
                        _localDataUrl: dataUrl,
                        _fileId: fileId,
                        _fileName: file.name,
                        _fileType: msgType,
                        _isLocal: true
                    }]);
                    setGroupLastMessages(prev => ({
                        ...prev,
                        [activeGroup.id]: {
                            content: `📎 ${file.name}`,
                            message_type: msgType,
                            created_at: msg.created_at,
                            sender_name: msg.sender_name
                        },
                    }));
                }
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 100 } }));
                setTimeout(() => setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; }), 1500);
            } catch (err) {
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 0, error: true } }));
                setTimeout(() => setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; }), 3000);
                showToast('Failed to send file', 'error');
            }
        };
        reader.onerror = () => {
            setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; });
            showToast('Failed to read file', 'error');
        };
        reader.readAsDataURL(file);
    }, [activeGroup, showToast]);

    // ─── Send handler (DM or Group) ────────────────────────
    const handleSend = useCallback(() => {
        if (activeGroup) handleSendGroup();
        else handleSendDm();
    }, [activeGroup, handleSendDm, handleSendGroup]);

    // ─── File/Image send ───────────────────────────────────
    const handleFileSelect = useCallback(async (e) => {
        const file = e.target.files?.[0];
        if (!file || !chat.activePeer) return;
        e.target.value = '';

        // Block absurdly large files upfront
        const MAX_SIZE = 250 * 1024 * 1024; // 250 MB
        if (file.size > MAX_SIZE) {
            showToast(`File too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Max 250 MB.`, 'error');
            return;
        }

        const uploadId = `up_${Date.now()}`;
        setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 5 } }));

        const reader = new FileReader();
        reader.onprogress = (ev) => {
            if (ev.lengthComputable) {
                // Reading takes 0→60 of the progress bar
                const pct = Math.max(5, Math.round(ev.loaded / ev.total * 60));
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: pct } }));
            }
        };
        reader.onload = async (ev) => {
            const dataUrl = ev.target.result;
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');
            const msgType = isImage ? 'image' : isVideo ? 'video' : 'file';
            const senderIp = getLocalIp();

            setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 70 } }));
            try {
                await chat.sendFile(
                    chat.activePeer.device_id,
                    dataUrl, file.name, msgType,
                    localUser?.username || '', senderIp,
                );
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 100 } }));
                setTimeout(() => setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; }), 1500);
                refreshLastMessages();
            } catch (err) {
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 0, error: true } }));
                setTimeout(() => setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; }), 3000);
                showToast(`Failed to send ${file.name}`, 'error');
            }
        };
        reader.onerror = () => {
            setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; });
            showToast('Failed to read file', 'error');
        };
        reader.readAsDataURL(file);
    }, [chat.activePeer, chat.sendFile, localUser, refreshLastMessages, showToast]);

    // ─── Dev helper: resend pending messages for active peer (manual test)
    const handleResendPending = useCallback(async () => {
        const peerId = chat.activePeer?.device_id;
        if (!peerId) {
            showToast && showToast('No active peer selected', 'warning');
            console.warn('[Pingo] Resend pending: no active peer');
            return;
        }
        console.log('[Pingo] Resend pending clicked — peerId=', peerId);
        try {
            const pending = await api.getUndeliveredMessagesForPeer(peerId).catch(e => { throw e; });
            console.log('[Pingo] Undelivered messages for', peerId, pending || []);
            showToast && showToast(`Found ${(pending || []).length} pending message(s)`, 'info');
        } catch (err) {
            console.error('[Pingo] getUndeliveredMessagesForPeer failed', err);
            showToast && showToast('Failed to read pending messages', 'error');
        }

        try {
            await flushPendingMessages(peerId);
            console.log('[Pingo] flushPendingMessages completed for', peerId);
            showToast && showToast('Resend attempted', 'success');
            refreshLastMessages().catch(() => { });
            if (chat.activePeer) chat.loadMessages(peerId).catch(() => { });
        } catch (err) {
            console.error('[Pingo] flushPendingMessages error', err);
            showToast && showToast('Resend failed', 'error');
        }
    }, [chat.activePeer, chat.loadMessages, flushPendingMessages, refreshLastMessages, showToast]);

    // ─── Drag & drop files ─────────────────────────────────
    const handleDrop = useCallback(async (e) => {
        e.preventDefault();
        setDragOver(false);
        if (!chat.activePeer) return;
        const file = e.dataTransfer.files?.[0];
        if (!file) return;

        const MAX_SIZE = 250 * 1024 * 1024;
        if (file.size > MAX_SIZE) {
            showToast(`File too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Max 250 MB.`, 'error');
            return;
        }

        const uploadId = `up_${Date.now()}`;
        setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 5 } }));

        const reader = new FileReader();
        reader.onprogress = (ev) => {
            if (ev.lengthComputable) {
                const pct = Math.max(5, Math.round(ev.loaded / ev.total * 60));
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: pct } }));
            }
        };
        reader.onload = async (ev) => {
            const dataUrl = ev.target.result;
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');
            const msgType = isImage ? 'image' : isVideo ? 'video' : 'file';
            setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 70 } }));
            try {
                await chat.sendFile(
                    chat.activePeer.device_id,
                    dataUrl, file.name, msgType,
                    localUser?.username || '', getLocalIp(),
                );
                setUploadProgress(prev => ({ ...prev, [uploadId]: { name: file.name, progress: 100 } }));
                setTimeout(() => setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; }), 1500);
                refreshLastMessages();
            } catch (err) {
                setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; });
                showToast(`Failed to send ${file.name}`, 'error');
            }
        };
        reader.onerror = () => setUploadProgress(prev => { const n = { ...prev }; delete n[uploadId]; return n; });
        reader.readAsDataURL(file);
    }, [chat.activePeer, chat.sendFile, localUser, refreshLastMessages, showToast]);

    // ─── Screenshot capture — uses native Rust backend ────
    const handleScreenshot = useCallback(async () => {
        // Show dialog immediately with loading state
        setScreenshotData({ loading: true, imageDataUrl: null });

        try {
            // Capture in background
            const imageDataUrl = await api.captureScreenPrimary();
            if (imageDataUrl) {
                // Update with captured image
                setScreenshotData({ loading: false, imageDataUrl });
            } else {
                console.warn('Failed to capture screen');
                setScreenshotData(null);
            }
        } catch (err) {
            console.warn('Screenshot capture failed:', err);
            setScreenshotData(null);
        }
    }, []);

    const handleScreenshotCrop = useCallback(async (croppedDataUrl) => {
        setScreenshotData(null);
        if (!chat.activePeer) return;
        await chat.sendFile(
            chat.activePeer.device_id,
            croppedDataUrl, 'screenshot.png', 'image',
            localUser?.username || '', getLocalIp(),
        );
        refreshLastMessages();
    }, [chat.activePeer, chat.sendFile, localUser, refreshLastMessages]);

    // ─── Key handler ───────────────────────────────────────
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // ─── Context menu (right-click on message) ─────────────
    const handleMsgContextMenu = useCallback((e, msg) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, message: msg });
    }, []);

    const handleDeleteMessage = useCallback(async () => {
        if (!contextMenu?.message) return;
        await chat.deleteMsg(contextMenu.message.id);
        setContextMenu(null);
        refreshLastMessages();
    }, [contextMenu, chat.deleteMsg, refreshLastMessages]);

    const handleClearAllChat = useCallback(async () => {
        const peerId = chat.activePeer?.device_id;
        if (!peerId) return;
        await chat.deleteAllMessages(peerId);
        setConfirmClearChat(false);
        refreshLastMessages();
    }, [chat.activePeer, chat.deleteAllMessages, refreshLastMessages]);

    // ─── Download file (native save dialog) ───────────────
    const handleDownload = useCallback(async (url, fileName) => {
        try {
            const result = await api.saveFileWithDialog(url, fileName || 'download');
            if (result) {
                showToast(`Saved: ${fileName || 'file'}`, 'success');
            }
        } catch (e) {
            console.error('[Pingo] Save failed:', e);
            showToast('Save failed', 'error');
            // Fallback: simple anchor download
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }, [showToast]);

    // ─── Open file location in explorer ───────────────
    const handleOpenFileLocation = useCallback(async (msg) => {
        try {
            const info = JSON.parse(msg.content);
            const isMine = msg.sender_id === deviceId;
            const fileType = msg.message_type || 'file';
            const fileName = info.fileName || 'file';
            const fileId = info.fileId;

            let localPath = null;

            if (isMine) {
                // For sender's own files: look in shared_files dir by fileId first (fastest)
                if (fileId) {
                    localPath = await api.getSharedFilePath(fileId).catch(() => null);
                }
                // Fallback: check organized downloads with own username
                if (!localPath) {
                    const senderName = localUser?.username || 'Me';
                    localPath = await api.checkFileDownloaded(senderName, fileName, fileType).catch(() => null);
                }
            } else {
                // For received files: check organized downloads folder
                const senderName = msg.sender_name || resolveUsernameById(msg.sender_id) || 'Unknown';
                localPath = await api.checkFileDownloaded(senderName, fileName, fileType).catch(() => null);
                // Fallback: check shared_files by fileId (auto-download saves there too)
                if (!localPath && fileId) {
                    localPath = await api.getSharedFilePath(fileId).catch(() => null);
                }
            }

            if (localPath) {
                await api.openFileLocation(localPath);
            } else {
                showToast('File not found on this device. It may not have been downloaded yet.', 'error');
            }
        } catch (e) {
            console.warn('[Pingo] Open file location failed:', e);
            showToast('Could not locate file', 'error');
        }
    }, [deviceId, localUser, resolveUsernameById, showToast]);

    // Close context menu on click elsewhere
    useEffect(() => {
        const handleClick = () => setContextMenu(null);
        if (contextMenu) window.addEventListener('click', handleClick);
        return () => window.removeEventListener('click', handleClick);
    }, [contextMenu]);

    // ─── Listen for group messages in real-time ─────────
    useEffect(() => {
        // Listen globally for all group messages (for last message tracking)
        const globalUnsub = api.onGroupMessageReceived(msg => {
            // Update group last message for sidebar preview
            const previewContent = msg.message_type === 'text'
                ? msg.content.substring(0, 40) + (msg.content.length > 40 ? '...' : '')
                : `📎 ${msg.message_type === 'image' ? 'Image' : msg.message_type === 'video' ? 'Video' : 'File'}`;

            setGroupLastMessages(prev => ({
                ...prev,
                [msg.group_id]: {
                    content: previewContent,
                    message_type: msg.message_type,
                    created_at: msg.created_at,
                    sender_name: msg.sender_name,
                },
            }));

            // If this message belongs to the active group, add it to the message list
            if (activeGroup && msg.group_id === activeGroup.id) {
                setGroupMessages(prev => {
                    if (prev.find(m => m.id === msg.id)) return prev;
                    const newMsg = { ...msg };
                    try {
                        if (msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'file') {
                            const info = JSON.parse(msg.content);
                            if (info && info.fileId) {
                                const senderIp = peerIpMap[msg.sender_id];
                                const p = info.port || fileServerPort || 0;
                                newMsg._fileId = info.fileId;
                                newMsg._fileName = info.fileName || 'file';
                                newMsg._fileType = info.type || msg.message_type;
                                // If it's from another peer, trigger background download so the file
                                // becomes available and `pingo:file-downloaded` will update loadedFileUrls
                                if (msg.sender_id !== deviceId && senderIp && p) {
                                    const remoteUrl = `http://${senderIp.split(':')[0]}:${p}/file/${info.fileId}`;
                                    const senderName = msg.sender_name || 'Unknown';
                                    api.autoDownloadFile(remoteUrl, senderName, info.fileName || 'file', newMsg._fileType, msg.id)
                                        .then(async () => {
                                            try {
                                                const dataUrl = await api.readFileAsDataUrl(info.fileId);
                                                if (dataUrl && typeof window !== 'undefined') {
                                                    window.dispatchEvent(new CustomEvent('pingo:file-downloaded', {
                                                        detail: { fileId: info.fileId, dataUrl }
                                                    }));
                                                }
                                            } catch { /* ignore */ }
                                        })
                                        .catch(() => { /* ignore */ });
                                }
                            }
                        }
                    } catch { /* ignore */ }
                    return [...prev, newMsg];
                });
            }
        });
        return () => { globalUnsub.then?.(fn => fn?.()); };
    }, [activeGroup, peerIpMap, fileServerPort, deviceId]);

    // ─── Listen for group member changes in real-time ─────
    useEffect(() => {
        if (!activeGroup) return;
        const unsubs = [];
        unsubs.push(api.onGroupMemberAdded(async (data) => {
            if (data?.group_id === activeGroup.id) {
                const members = await api.getGroupMembers(activeGroup.id);
                setGroupMembers(members || []);
            }
        }));
        unsubs.push(api.onGroupMemberRemoved(async (data) => {
            if (data?.group_id === activeGroup.id) {
                const members = await api.getGroupMembers(activeGroup.id);
                setGroupMembers(members || []);
            }
        }));
        return () => { unsubs.forEach(async u => { const fn = await u; fn?.(); }); };
    }, [activeGroup]);

    // ─── Clear active peer when leaving chat page ─────
    useEffect(() => {
        return () => {
            if (setActiveChatPeerId) setActiveChatPeerId(null);
        };
    }, [setActiveChatPeerId]);

    // ─── Load shared media for sidebar ─────────────────
    useEffect(() => {
        if (!showSharedMedia || !chat.activePeer) {
            setSharedMediaList([]);
            return;
        }
        const peerId = chat.activePeer.device_id;
        (async () => {
            try {
                // Load all media messages from DB
                const media = await api.getSharedMedia(peerId);
                if (media) {
                    // Annotate each with resolved URLs
                    const port = fileServerPort || await api.getFileServerPort().catch(() => 0);
                    const annotated = (media || []).map(m => {
                        try {
                            if (m.message_type === 'image' || m.message_type === 'video' || m.message_type === 'file') {
                                const info = JSON.parse(m.content);
                                if (info && info.fileId) {
                                    const p = info.port || port || 0;
                                    m._localDataUrl = `http://127.0.0.1:${p}/file/${info.fileId}`;
                                    m._fileName = info.fileName || 'file';
                                    m._fileType = info.type || m.message_type;
                                    m._fileId = info.fileId;
                                }
                            }
                        } catch { /* not JSON */ }
                        return m;
                    });
                    setSharedMediaList(annotated);
                }
            } catch (e) {
                console.warn('[Pingo] Failed to load shared media:', e);
            }
        })();
    }, [showSharedMedia, chat.activePeer, fileServerPort]);

    // ─── handle notification click — open specific chat ──────
    useEffect(() => {
        const handleOpenChat = (event) => {
            const { peerId, peerName } = event.detail;
            console.log('[ChatPage] Opening chat from notification - peerId:', peerId, 'peerName:', peerName);

            // Find the peer in allUsers
            const peer = allUsers?.find(u => u.id === peerId || u.device_id === peerId);
            if (peer) {
                // Switch to DM tab
                setTab('dm');
                // Select the peer (this will open the chat)
                chat.selectPeer(peer);  // chat.selectPeer is stable (useCallback)
                console.log('[ChatPage] Chat opened for peer:', peer.username);
            } else {
                console.warn('[ChatPage] Could not find peer with ID:', peerId);
            }
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('pingo:open-chat', handleOpenChat);
            return () => {
                window.removeEventListener('pingo:open-chat', handleOpenChat);
            };
        }
    }, [allUsers, chat.selectPeer]);

    // Auto-load all file data URLs from messages (for direct file system reading)
    // Also triggers auto-download for files not available locally.
    // FIX: loadedFileUrls is NOT in the dep array — we use loadedFileIdsRef (a ref) for dedup
    // so that setLoadedFileUrls doesn't re-trigger this effect (would cause O(n²) runs).
    useEffect(() => {
        if (!chat.messages || chat.messages.length === 0) return;

        let cancelled = false;
        let pendingTimer = null;

        const loadFile = async (msg, info) => {
            const fileId = info.fileId;
            if (!fileId) return;

            // Skip if already loaded (use ref, not state — avoids stale closure & re-trigger loop)
            if (loadedFileIdsRef.current.has(fileId)) return;
            if (loadingFilesRef.current.has(fileId)) return;

            loadingFilesRef.current.add(fileId);

            // First try to read directly from local disk
            try {
                const dataUrl = await api.readFileAsDataUrl(fileId);
                if (dataUrl && !cancelled) {
                    loadedFileIdsRef.current.add(fileId);
                    setLoadedFileUrls(prev => ({ ...prev, [fileId]: dataUrl }));
                    loadingFilesRef.current.delete(fileId);
                    return;
                }
            } catch { /* file not on disk yet */ }

            if (cancelled) {
                loadingFilesRef.current.delete(fileId);
                return;
            }

            // File not available locally — trigger auto-download from remote peer
            const isMine = msg.sender_id === deviceId;
            if (isMine) {
                loadingFilesRef.current.delete(fileId);
                return; // We sent it, must be local already
            }

            // Find sender IP
            let senderIp = peerIpMap[msg.sender_id];
            if (!senderIp) senderIp = peers?.find(p => p.device_id === msg.sender_id)?.ip_address;
            if (!senderIp) senderIp = allUsers?.find(u => u.id === msg.sender_id)?.ip_address;

            if (senderIp && info.port) {
                const remoteUrl = `http://${senderIp.split(':')[0]}:${info.port}/file/${fileId}`;
                const senderName = msg.sender_name || 'Unknown';
                const fileType = msg.message_type || 'file';
                try {
                    await api.autoDownloadFile(remoteUrl, senderName, info.fileName || 'file', fileType, msg.id);
                    if (!cancelled) {
                        const dataUrl = await api.readFileAsDataUrl(fileId).catch(() => null);
                        if (dataUrl) {
                            loadedFileIdsRef.current.add(fileId);
                            setLoadedFileUrls(prev => ({ ...prev, [fileId]: dataUrl }));
                        }
                    }
                } catch { /* ignore — UI shows retry button */ }
            }
            loadingFilesRef.current.delete(fileId);
        };

        // Collect only file messages that haven't been loaded yet
        const filesToLoad = [];
        chat.messages.forEach(msg => {
            if (msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'file') {
                try {
                    const info = JSON.parse(msg.content);
                    if (info.fileId && !loadedFileIdsRef.current.has(info.fileId) && !loadingFilesRef.current.has(info.fileId)) {
                        filesToLoad.push({ msg, info });
                    }
                } catch { /* not JSON */ }
            }
        });

        if (filesToLoad.length > 0) {
            let idx = 0;
            const processNext = () => {
                if (cancelled || idx >= filesToLoad.length) return;
                const { msg, info } = filesToLoad[idx];
                loadFile(msg, info).finally(() => {
                    idx++;
                    if (!cancelled && idx < filesToLoad.length) {
                        pendingTimer = setTimeout(processNext, 150);
                    }
                });
            };
            processNext();
        }

        return () => {
            cancelled = true;
            if (pendingTimer) clearTimeout(pendingTimer);
        };
        // ⚠ DO NOT add loadedFileUrls here — that would re-run on every file load (O(n²))
    }, [chat.messages, deviceId, peerIpMap, peers, allUsers]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Listen for completed downloads (emitted by useApp.js autoDownloadFileMessage) ─────
    // When autoDownloadFileMessage finishes in the background, it dispatches this window event
    // so we can update loadedFileUrls without waiting for the next chat.messages render cycle.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handler = (e) => {
            const { fileId, dataUrl } = e.detail || {};
            if (fileId && dataUrl) {
                loadedFileIdsRef.current.add(fileId);
                setLoadedFileUrls(prev => {
                    if (prev[fileId]) return prev; // already cached
                    return { ...prev, [fileId]: dataUrl };
                });
            }
        };
        window.addEventListener('pingo:file-downloaded', handler);
        return () => window.removeEventListener('pingo:file-downloaded', handler);
    }, []);

    // ─── Listen for Tauri file-download-progress events (emitted by Rust auto_download_file) ─────
    useEffect(() => {
        const unsub = api.onFileDownloadProgress(data => {
            const { fileId, fileName, stage, progress } = data || {};
            if (!fileId) return;
            if (stage === 'complete' || stage === 'cached' || stage === 'error') {
                setDownloadProgress(prev => {
                    if (!prev[fileId]) return prev;
                    const n = { ...prev };
                    delete n[fileId];
                    return n;
                });
            } else {
                setDownloadProgress(prev => ({ ...prev, [fileId]: { name: fileName, progress, stage } }));
            }
        });
        return () => { unsub.then?.(fn => fn?.()); };
    }, []);

    // ═══════════════════════════════════════════════════════════
    //  Render
    // ═══════════════════════════════════════════════════════════
    const activePeer = chat.activePeer;
    const isOnline = activePeer && peerIpMap[activePeer.device_id];

    // Sync activePeer display info (name/avatar) from authoritative sources
    // CRITICAL: Use updatePeerInfo instead of selectPeer to avoid tearing down
    // the onChatMessageReceived listener and reloading messages (which causes message loss)
    useEffect(() => {
        if (!activePeer) return;
        const id = activePeer.device_id || activePeer.id;
        const peerFromPeers = peers.find(p => p.device_id === id);
        const userFromAll = allUsers.find(u => u.id === id);
        const resolvedName = (userFromAll && userFromAll.username) || (peerFromPeers && peerFromPeers.username) || activePeer.username || '';
        const resolvedAvatar = (userFromAll && userFromAll.avatar_path) || (peerFromPeers && peerFromPeers.avatar_path) || activePeer.avatar_path;

        // Only update if something actually changed
        if ((resolvedName && resolvedName !== activePeer.username) || (resolvedAvatar && resolvedAvatar !== activePeer.avatar_path)) {
            // Use updatePeerInfo (cosmetic update only — does NOT reload messages or re-subscribe listeners)
            chat.updatePeerInfo({
                ...activePeer,
                username: resolvedName,
                avatar_path: resolvedAvatar,
            });
        }
    }, [activePeer?.device_id, peers, allUsers, chat.updatePeerInfo]); // Only re-run on actual peer list changes, not activePeer object changes

    // Safe derived display values for header (fallbacks) — always use latest from peers/allUsers
    const displayActivePeerName = useMemo(() => {
        if (!activePeer) return '';
        const id = activePeer.device_id;
        return peers.find(p => p.device_id === id)?.username
            || allUsers.find(u => u.id === id)?.username
            || activePeer.username || 'Unknown';
    }, [activePeer?.device_id, peers, allUsers]);

    const displayActivePeerAvatar = useMemo(() => {
        if (!activePeer) return undefined;
        const id = activePeer.device_id;
        return peers.find(p => p.device_id === id)?.avatar_path
            || allUsers.find(u => u.id === id)?.avatar_path
            || activePeer.avatar_path;
    }, [activePeer?.device_id, peers, allUsers]);

    return (
        <div className="chat-page">
            {/* ─── Sidebar ─────────────────────────────────── */}
            <div className="chat-sidebar">
                <div className="chat-sidebar-header">
                    <h2>Chat</h2>
                    <div className="chat-sidebar-actions">
                        <button className="icon-btn" title="New Group" onClick={() => setShowNewGroup(true)}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <line x1="23" y1="11" x2="17" y2="11" /><line x1="20" y1="8" x2="20" y2="14" />
                            </svg>
                        </button>
                    </div>
                </div>

                <div className="chat-search">
                    <input placeholder="Search contacts…" value={search} onChange={e => setSearch(e.target.value)} />
                </div>

                {/* Tabs */}
                <div className="chat-tabs">
                    <button className={`chat-tab ${tab === 'dm' ? 'active' : ''}`} onClick={() => setTab('dm')}>
                        Direct
                    </button>
                    <button className={`chat-tab ${tab === 'groups' ? 'active' : ''}`} onClick={() => setTab('groups')}>
                        Groups ({groupsHook.groups.length})
                    </button>
                </div>

                <div className="chat-peer-list">
                    {tab === 'dm' ? (
                        userList.length === 0 ? (
                            <div className="empty-state-sm">
                                <p>No contacts found</p>
                                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    Peers on your network will appear here
                                </p>
                            </div>
                        ) : (
                            userList.map(u => {
                                const uid = u.device_id || u.id;
                                const lm = lastMessages[uid];
                                const unread = unreadCounts[uid] || 0;
                                const isActive = activePeer?.device_id === uid && !activeGroup;
                                return (
                                    <div
                                        key={uid}
                                        className={`peer-item ${isActive ? 'active' : ''}`}
                                        onClick={() => selectDmPeer(u)}
                                    >
                                        <div className="peer-avatar-wrap">
                                            <UserAvatar name={u.username} size={38} avatarUrl={u.avatar_path} />
                                            <span className={`status-dot ${u.is_online ? 'online' : 'offline'}`} />
                                        </div>
                                        <div className="peer-info">
                                            <span className="peer-name">{u.username || 'Unknown'}</span>
                                            <span className="peer-preview">
                                                {lm ? ((lm.message_type === 'text' || !lm.message_type) ? lm.content?.slice(0, 40) : `📎 ${lm.message_type}`) : (u.is_online ? 'Online' : 'Offline')}
                                            </span>
                                        </div>
                                        <div className="peer-meta">
                                            {lm?.created_at && (
                                                <span className="peer-time">{formatTime(lm.created_at)}</span>
                                            )}
                                            {unread > 0 && <span className="unread-badge">{unread}</span>}
                                        </div>
                                    </div>
                                );
                            })
                        )
                    ) : (
                        /* Groups tab */
                        groupsHook.groups.length === 0 ? (
                            <div className="empty-state-sm">
                                <p>No groups yet</p>
                                <button className="btn-sm btn-primary" onClick={() => setShowNewGroup(true)}>
                                    Create Group
                                </button>
                            </div>
                        ) : (
                            groupsHook.groups.map(g => {
                                const glm = groupLastMessages[g.id];
                                const glmPreview = glm
                                    ? ((glm.message_type === 'text' || !glm.message_type)
                                        ? `${glm.sender_name ? glm.sender_name + ': ' : ''}${glm.content?.slice(0, 35) || ''}`
                                        : `${glm.sender_name ? glm.sender_name + ': ' : ''}📎 ${glm.message_type}`)
                                    : 'No messages yet';
                                return (
                                    <div
                                        key={g.id}
                                        className={`peer-item ${activeGroup?.id === g.id ? 'active' : ''}`}
                                        onClick={() => selectGroup(g)}
                                    >
                                        <div className="peer-avatar-wrap">
                                            <div className="group-avatar" style={{ background: g.avatar_color || '#4f46e5' }}>
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                                    <circle cx="9" cy="7" r="4" />
                                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                                </svg>
                                            </div>
                                        </div>
                                        <div className="peer-info">
                                            <span className="peer-name">{g.name}</span>
                                            <span className="peer-preview">{glmPreview}</span>
                                        </div>
                                        {glm?.created_at && (
                                            <div className="peer-meta">
                                                <span className="peer-time">{formatTime(glm.created_at)}</span>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )
                    )}
                </div>
            </div>

            {/* ─── Main chat area ──────────────────────────── */}
            {!activePeer && !activeGroup ? (
                <div className="chat-main">
                    <div className="chat-empty">
                        <div className="chat-empty-inner">
                            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                            <h3>Select a conversation</h3>
                            <p>Choose a contact or group to start chatting</p>
                        </div>
                    </div>
                </div>
            ) : activeGroup ? (
                /* ── Group Chat View ── */
                <div className="chat-main">
                    <div className="chat-header">
                        <div className="chat-header-left" onClick={() => setShowGroupInfo(true)}>
                            <div className="group-avatar-sm" style={{ background: activeGroup.avatar_color || '#4f46e5' }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                    <circle cx="9" cy="7" r="4" />
                                </svg>
                            </div>
                            <div>
                                <div className="chat-header-name">{activeGroup.name}</div>
                                <div className="chat-header-status">{groupMembers.length} members</div>
                            </div>
                        </div>
                        <div className="chat-header-actions">
                            <button className="icon-btn" title="Group Info" onClick={() => setShowGroupInfo(!showGroupInfo)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                                </svg>
                            </button>
                            <button className="icon-btn danger" title="Leave Group" onClick={() => {
                                groupsHook.leaveGroup(activeGroup.id);
                                setActiveGroup(null);
                            }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    <div className="chat-messages">
                        {groupMessages.map(msg => {
                            const isMine = msg.sender_id === deviceId;
                            const isMedia = msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'file';
                            let fileData = null;
                            if (isMedia) {
                                if (msg._localDataUrl) {
                                    fileData = { url: msg._localDataUrl, fileName: msg._fileName || 'file', type: msg._fileType || msg.message_type, fileId: msg._fileId };
                                } else {
                                    const senderIp = isMine ? '127.0.0.1' : peerIpMap[msg.sender_id];
                                    fileData = resolveFileUrl(msg.content, senderIp, fileServerPort);
                                }
                            }

                            // Determine the final URL to use (direct file load, local, or fallback)
                            let displayUrl = null;
                            if (fileData) {
                                if (fileData.fileId && loadedFileUrls[fileData.fileId]) {
                                    // Use newly loaded direct file data URL
                                    displayUrl = loadedFileUrls[fileData.fileId];
                                } else if (fileData.url) {
                                    // Use existing URL (data URL, HTTP URL, or fallback)
                                    displayUrl = fileData.url;
                                }
                            }

                            return (
                                <div key={msg.id} className={`msg ${isMine ? 'msg-out' : 'msg-in'}`}>
                                    {!isMine && (
                                        <span className="msg-sender">{msg.sender_name || resolveUsernameById(msg.sender_id) || 'Unknown'}</span>
                                    )}
                                    <div className="msg-bubble">
                                        {isMedia && fileData ? (
                                            <div className="msg-media">
                                                {msg.message_type === 'image' ? (
                                                    <img
                                                        src={displayUrl || ''}
                                                        alt={fileData.fileName}
                                                        className="msg-image"
                                                        loading="lazy"
                                                        onClick={() => setLightbox({ url: displayUrl || '', fileName: fileData.fileName })}
                                                    />
                                                ) : msg.message_type === 'video' ? (
                                                    <video src={displayUrl || ''} controls className="msg-video" style={{ maxWidth: 300, borderRadius: 8 }} preload="metadata" />
                                                ) : (
                                                    <div className="msg-file-card" style={{ cursor: 'pointer' }}>
                                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                            <polyline points="14 2 14 8 20 8" />
                                                        </svg>
                                                        <span>{fileData.fileName}</span>
                                                    </div>
                                                )}
                                                {displayUrl && (
                                                    <div className="msg-media-actions" style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                                                        <button className="download-btn" onClick={() => handleDownload(displayUrl, fileData.fileName)} title="Save As...">
                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                                                            </svg>
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="msg-text">{msg.content}</span>
                                        )}
                                        <span className="msg-time">{formatTime(msg.created_at)}</span>
                                    </div>
                                </div>
                            );
                        })}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* ── Upload Progress Bar (group chat) ── */}
                    {Object.keys(uploadProgress).length > 0 && (
                        <div style={{
                            padding: '6px 12px', background: 'var(--bg-secondary, #1e1e1e)',
                            borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4
                        }}>
                            {Object.entries(uploadProgress).map(([id, p]) => (
                                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                                        {p.error ? '✗' : '↑'} {p.name}
                                    </span>
                                    {p.error ? (
                                        <span style={{ color: 'var(--danger, #ef4444)', fontSize: 11 }}>Failed</span>
                                    ) : (
                                        <>
                                            <div style={{ width: 100, background: '#333', borderRadius: 4, height: 5 }}>
                                                <div style={{ width: `${p.progress}%`, background: p.progress === 100 ? '#22c55e' : 'var(--primary, #4f46e5)', borderRadius: 4, height: 5, transition: 'width 0.2s' }} />
                                            </div>
                                            <span style={{ color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>{p.progress}%</span>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="chat-input-bar">
                        <button className="icon-btn" title="Attach file" onClick={() => groupFileInputRef.current?.click()}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                        </button>
                        <input ref={groupFileInputRef} type="file" hidden onChange={handleGroupFileSelect} />
                        <input
                            className="chat-input"
                            placeholder="Type a message…"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />
                        <button className="send-btn" onClick={handleSend} disabled={!inputText.trim()}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                            </svg>
                        </button>
                    </div>

                    {/* Group info sidebar */}
                    {showGroupInfo && (
                        <div className="chat-profile-sidebar">
                            <div className="profile-sidebar-header">
                                <h4>Group Info</h4>
                                <button className="icon-btn" onClick={() => setShowGroupInfo(false)}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                            </div>
                            <div className="profile-sidebar-body">
                                <h5 style={{ margin: '16px 0 8px' }}>Members ({groupMembers.length})</h5>
                                {groupMembers.map(m => (
                                    <div key={m.user_id} className="group-member-item">
                                        <UserAvatar name={m.username} size={30} avatarUrl={m.avatar_path} />
                                        <span>{m.username}</span>
                                        {m.role === 'admin' && <span className="admin-badge">Admin</span>}
                                        {activeGroup.created_by === deviceId && m.user_id !== deviceId && (
                                            <button className="icon-btn-sm danger" title="Remove"
                                                onClick={() => groupsHook.removeMember(activeGroup.id, m.user_id)}>
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                ))}
                                {activeGroup.created_by === deviceId && (
                                    <button className="btn-sm btn-secondary" style={{ marginTop: 12 }}
                                        onClick={() => {
                                            setShowGroupInfo(false);
                                            setShowNewGroup('add-member');
                                        }}>
                                        + Add Member
                                    </button>
                                )}
                                <hr style={{ margin: '16px 0', borderColor: 'var(--border)' }} />
                                {activeGroup.created_by === deviceId && (
                                    <button className="btn-sm" style={{ color: 'var(--danger)' }}
                                        onClick={() => {
                                            groupsHook.deleteGroup(activeGroup.id);
                                            setActiveGroup(null);
                                        }}>
                                        Delete Group
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                /* ── DM Chat View ── */
                <div
                    className={`chat-main ${dragOver ? 'drag-over' : ''}`}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                >
                    <div className="chat-header">
                        <div className="chat-header-left" onClick={() => setShowProfile(activePeer)}>
                            <UserAvatar name={displayActivePeerName} size={34} avatarUrl={displayActivePeerAvatar} />
                            <div>
                                <div className="chat-header-name">{displayActivePeerName}</div>
                                <div className="chat-header-status">
                                    {isOnline ? '🟢 Online' : '⚫ Offline'}
                                </div>
                            </div>
                        </div>
                        <div className="chat-header-actions">
                            <button className="icon-btn" title="Shared Media" onClick={() => setShowSharedMedia(true)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                    <polyline points="21 15 16 10 5 21" />
                                </svg>
                            </button>
                            <button className="icon-btn" title="Attach file" onClick={() => fileInputRef.current?.click()}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                                </svg>
                            </button>
                            <button className="icon-btn danger" title="Clear all chat" onClick={() => setConfirmClearChat(true)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                            </button>
                            <input ref={fileInputRef} type="file" hidden onChange={handleFileSelect} />
                        </div>
                    </div>

                    <div className="chat-messages">
                        {chat.loading && <div className="empty-state-sm">Loading messages…</div>}
                        {chat.messages.map(msg => {
                            const isMine = msg.sender_id === deviceId;
                            const senderIp = !isMine ? peerIpMap[msg.sender_id] : '127.0.0.1';
                            const isMedia = msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'file';
                            let fileData = null;
                            let fileId = null;
                            if (isMedia) {
                                // Parse file info from message content
                                try {
                                    const info = JSON.parse(msg.content);
                                    fileId = info.fileId;
                                    fileData = {
                                        fileName: info.fileName || msg._fileName || 'file',
                                        type: info.type || msg._fileType || msg.message_type,
                                        fileId: info.fileId,
                                    };
                                } catch {
                                    fileData = resolveFileUrl(msg.content, senderIp, fileServerPort);
                                }
                            }

                            // Determine the final URL to use - ONLY from loadedFileUrls cache or msg._localDataUrl (for sent files)
                            let displayUrl = null;
                            if (fileData) {
                                if (fileId && loadedFileUrls[fileId]) {
                                    // Use cached data URL
                                    displayUrl = loadedFileUrls[fileId];
                                } else if (msg._localDataUrl && msg._localDataUrl.startsWith('data:')) {
                                    // Use existing data URL (sender's view)
                                    displayUrl = msg._localDataUrl;
                                }
                                // Do NOT use HTTP URLs - they cause freezing
                            }

                            // Check if this file is still loading (not cached yet)
                            const isFileLoading = isMedia && fileId && !loadedFileUrls[fileId] && !displayUrl;

                            // Use separate key for img element to force remount when src changes
                            const imgKey = `${msg.id}-${displayUrl ? 'loaded' : 'pending'}`;

                            return (
                                <div
                                    key={msg.id}
                                    className={`msg ${isMine ? 'msg-out' : 'msg-in'}`}
                                    onContextMenu={(e) => handleMsgContextMenu(e, msg)}
                                >
                                    <div className="msg-bubble">
                                        {isMedia && fileData ? (
                                            <div className="msg-media">
                                                {(msg.message_type === 'image') ? (
                                                    isFileLoading ? (
                                                        <div className="msg-loading-placeholder" style={{
                                                            width: 200, minHeight: 90,
                                                            background: 'var(--surface, #2a2a2a)',
                                                            borderRadius: 8, padding: '12px 16px',
                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                                                            color: 'var(--text-muted, #888)'
                                                        }}>
                                                            {downloadProgress[fileId] ? (
                                                                <>
                                                                    <span style={{ fontSize: 12 }}>⬇ Downloading image…</span>
                                                                    <div style={{ width: '100%', background: '#444', borderRadius: 4, height: 6 }}>
                                                                        <div style={{ width: `${downloadProgress[fileId].progress}%`, background: 'var(--primary, #4f46e5)', borderRadius: 4, height: 6, transition: 'width 0.3s' }} />
                                                                    </div>
                                                                    <span style={{ fontSize: 10 }}>{downloadProgress[fileId].progress}%</span>
                                                                </>
                                                            ) : (
                                                                <span style={{ fontSize: 12 }}>⟳ Loading image…</span>
                                                            )}
                                                        </div>
                                                    ) : !displayUrl ? (
                                                        <div className="msg-loading-placeholder" style={{
                                                            width: 200, height: 80,
                                                            background: 'var(--surface, #2a2a2a)',
                                                            borderRadius: 8,
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            color: 'var(--text-muted, #888)', flexDirection: 'column', gap: 4
                                                        }}>
                                                            <span>Image unavailable</span>
                                                            <button onClick={() => handleImageError(msg)} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Retry</button>
                                                        </div>
                                                    ) : (
                                                        <img
                                                            key={imgKey}
                                                            src={displayUrl}
                                                            alt={fileData.fileName}
                                                            className="msg-image"
                                                            loading="lazy"
                                                            onError={() => handleImageError(msg)}
                                                            onClick={() => setLightbox({ url: displayUrl, fileName: fileData.fileName })}
                                                        />
                                                    )
                                                ) : msg.message_type === 'video' ? (
                                                    isFileLoading ? (
                                                        <div className="msg-loading-placeholder" style={{
                                                            width: 220, minHeight: 90,
                                                            background: 'var(--surface, #2a2a2a)',
                                                            borderRadius: 8, padding: '12px 16px',
                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                                                            color: 'var(--text-muted, #888)'
                                                        }}>
                                                            {downloadProgress[fileId] ? (
                                                                <>
                                                                    <span style={{ fontSize: 12 }}>⬇ Downloading video…</span>
                                                                    <div style={{ width: '100%', background: '#444', borderRadius: 4, height: 6 }}>
                                                                        <div style={{ width: `${downloadProgress[fileId].progress}%`, background: 'var(--primary, #4f46e5)', borderRadius: 4, height: 6, transition: 'width 0.3s' }} />
                                                                    </div>
                                                                    <span style={{ fontSize: 10 }}>{downloadProgress[fileId].progress}%</span>
                                                                </>
                                                            ) : (
                                                                <span style={{ fontSize: 12 }}>⟳ Loading video…</span>
                                                            )}
                                                        </div>
                                                    ) : !displayUrl ? (
                                                        <div className="msg-loading-placeholder" style={{
                                                            width: 200, height: 80,
                                                            background: 'var(--surface, #2a2a2a)',
                                                            borderRadius: 8,
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            color: 'var(--text-muted, #888)', flexDirection: 'column', gap: 4
                                                        }}>
                                                            <span>Video unavailable</span>
                                                            <button onClick={() => handleImageError(msg)} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Retry</button>
                                                        </div>
                                                    ) : (
                                                        <video
                                                            src={displayUrl}
                                                            controls
                                                            className="msg-video"
                                                            style={{ maxWidth: 300, borderRadius: 8 }}
                                                            preload="metadata"
                                                            onError={() => handleImageError(msg)}
                                                        />
                                                    )
                                                ) : (
                                                    <div className="msg-file-card" onClick={() => handleOpenFileLocation(msg)} style={{ cursor: 'pointer' }}>
                                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                            <polyline points="14 2 14 8 20 8" />
                                                        </svg>
                                                        <span>{fileData.fileName}</span>
                                                        <span className="file-click-hint" style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>Click to open</span>
                                                    </div>
                                                )}
                                                <div className="msg-media-actions" style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                                                    {displayUrl && (
                                                        <button
                                                            className="download-btn"
                                                            onClick={() => handleDownload(displayUrl, fileData.fileName)}
                                                            title="Save As..."
                                                        >
                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                                <polyline points="7 10 12 15 17 10" />
                                                                <line x1="12" y1="15" x2="12" y2="3" />
                                                            </svg>
                                                        </button>
                                                    )}
                                                    <button
                                                        className="download-btn"
                                                        onClick={() => handleOpenFileLocation(msg)}
                                                        title="Open file location"
                                                        style={{ marginLeft: 2 }}
                                                    >
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                                        </svg>
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <span className="msg-text">{msg.content}</span>
                                        )}
                                        <span className="msg-time">{formatTime(msg.created_at)}</span>
                                    </div>
                                </div>
                            );
                        })}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* ── Upload Progress Bar (shown while sending files) ── */}
                    {Object.keys(uploadProgress).length > 0 && (
                        <div style={{
                            padding: '6px 12px', background: 'var(--bg-secondary, #1e1e1e)',
                            borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4
                        }}>
                            {Object.entries(uploadProgress).map(([id, p]) => (
                                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                                        {p.error ? '✗' : '↑'} {p.name}
                                    </span>
                                    {p.error ? (
                                        <span style={{ color: 'var(--danger, #ef4444)', fontSize: 11 }}>Failed</span>
                                    ) : (
                                        <>
                                            <div style={{ width: 100, background: '#333', borderRadius: 4, height: 5 }}>
                                                <div style={{ width: `${p.progress}%`, background: p.progress === 100 ? '#22c55e' : 'var(--primary, #4f46e5)', borderRadius: 4, height: 5, transition: 'width 0.2s' }} />
                                            </div>
                                            <span style={{ color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>{p.progress}%</span>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="chat-input-bar">
                        <button className="icon-btn" title="Attach" onClick={() => fileInputRef.current?.click()}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                        </button>
                        <input
                            className="chat-input"
                            placeholder="Type a message…"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />
                        <button className="send-btn" onClick={handleSend} disabled={!inputText.trim()}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                            </svg>
                        </button>
                    </div>

                    {/* ── Shared Media Sidebar ── */}
                    {showSharedMedia && (
                        <div className="chat-profile-sidebar shared-media-sidebar">
                            <div className="profile-sidebar-header">
                                <h4>Shared Media</h4>
                                <button className="icon-btn" onClick={() => setShowSharedMedia(false)}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                            </div>
                            <div className="shared-media-tabs">
                                <button className={`shared-media-tab ${sharedMediaTab === 'images' ? 'active' : ''}`} onClick={() => setSharedMediaTab('images')}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                                    </svg>
                                    Images
                                </button>
                                <button className={`shared-media-tab ${sharedMediaTab === 'files' ? 'active' : ''}`} onClick={() => setSharedMediaTab('files')}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                                    </svg>
                                    Files
                                </button>
                            </div>
                            <div className="shared-media-body">
                                {sharedMediaTab === 'images' ? (
                                    (() => {
                                        const images = sharedMediaList.filter(m => m.message_type === 'image' || m.message_type === 'video');
                                        if (images.length === 0) return <div className="shared-media-empty">No images shared yet</div>;
                                        return (
                                            <div className="shared-media-grid">
                                                {images.map(m => {
                                                    let url = m._localDataUrl || '';
                                                    if (m._fileId && loadedFileUrls[m._fileId]) url = loadedFileUrls[m._fileId];
                                                    return (
                                                        <div key={m.id} className="shared-media-thumb" onClick={() => setLightbox({ url, fileName: m._fileName || 'image' })}>
                                                            {m.message_type === 'video' ? (
                                                                <video src={url} className="shared-media-img" preload="metadata" />
                                                            ) : (
                                                                <img src={url} alt={m._fileName || 'image'} className="shared-media-img" loading="lazy" />
                                                            )}
                                                            <span className="shared-media-date">{formatTime(m.created_at)}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })()
                                ) : (
                                    (() => {
                                        const files = sharedMediaList.filter(m => m.message_type === 'file');
                                        if (files.length === 0) return <div className="shared-media-empty">No files shared yet</div>;
                                        return (
                                            <div className="shared-media-file-list">
                                                {files.map(m => {
                                                    let url = m._localDataUrl || '';
                                                    if (m._fileId && loadedFileUrls[m._fileId]) url = loadedFileUrls[m._fileId];
                                                    const isMine = m.sender_id === deviceId;
                                                    return (
                                                        <div key={m.id} className="shared-media-file-item" onClick={() => handleOpenFileLocation(m)}>
                                                            <div className="shared-media-file-icon">
                                                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                                    <polyline points="14 2 14 8 20 8" />
                                                                </svg>
                                                            </div>
                                                            <div className="shared-media-file-info">
                                                                <span className="shared-media-file-name">{m._fileName || 'file'}</span>
                                                                <span className="shared-media-file-meta">
                                                                    {isMine ? 'Sent' : 'Received'} · {formatTime(m.created_at)}
                                                                </span>
                                                            </div>
                                                            {url && (
                                                                <button className="icon-btn" onClick={(e) => { e.stopPropagation(); handleDownload(url, m._fileName || 'file'); }} title="Download">
                                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                                                                    </svg>
                                                                </button>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        );
                                    })()
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ─── Context menu for message deletion ───────── */}
            {contextMenu && (
                <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
                    <button onClick={handleDeleteMessage}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                        Delete message
                    </button>
                </div>
            )}

            {/* ─── Clear all chat confirm ──────────────────── */}
            {confirmClearChat && (
                <div className="modal-overlay" onClick={() => setConfirmClearChat(false)}>
                    <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
                        <h4>Clear all messages?</h4>
                        <p>This will delete all messages with {activePeer?.username}. This cannot be undone.</p>
                        <div className="modal-actions">
                            <button className="btn-secondary" onClick={() => setConfirmClearChat(false)}>Cancel</button>
                            <button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={handleClearAllChat}>
                                Clear All
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── New group dialog ────────────────────────── */}
            {showNewGroup && (
                <NewGroupDialog
                    allUsers={allUsers}
                    deviceId={deviceId}
                    mode={showNewGroup === 'add-member' ? 'add' : 'create'}
                    activeGroup={activeGroup}
                    onClose={() => setShowNewGroup(false)}
                    onCreate={async (name, ids, names) => {
                        await groupsHook.createGroup(name, ids, names);
                        setShowNewGroup(false);
                        setTab('groups');
                    }}
                    onAddMember={async (userId, username) => {
                        if (activeGroup) {
                            await groupsHook.addMember(activeGroup.id, userId, username);
                            // Refresh members
                            const members = await api.getGroupMembers(activeGroup.id);
                            setGroupMembers(members || []);
                        }
                        setShowNewGroup(false);
                    }}
                />
            )}

            {/* ─── Profile view ────────────────────────────── */}
            {showProfile && (
                <Profile isOpen={true} onClose={() => setShowProfile(null)} peer={showProfile} />
            )}

            {/* ─── Screenshot crop ─────────────────────────── */}
            {screenshotData && (
                <ScreenshotCrop
                    imageDataUrl={screenshotData.imageDataUrl}
                    isLoading={screenshotData.loading}
                    onCrop={handleScreenshotCrop}
                    onCancel={() => setScreenshotData(null)}
                />
            )}

            {/* ─── Image lightbox ─────────────────────────── */}
            {lightbox && (
                <ImageLightbox url={lightbox.url} fileName={lightbox.fileName} onClose={() => setLightbox(null)} />
            )}

            {/* ─── Toast notifications ─────────────────────── */}
            {toasts.length > 0 && (
                <div className="toast-container">
                    {toasts.map(t => (
                        <div key={t.id} className={`toast toast-${t.type}`}>
                            {t.type === 'success' && (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                                </svg>
                            )}
                            {t.type === 'error' && (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                                </svg>
                            )}
                            {t.type === 'info' && (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                                </svg>
                            )}
                            <span>{t.message}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
//  NewGroupDialog
// ═══════════════════════════════════════════════════════════════
function NewGroupDialog({ allUsers, deviceId: myDeviceId = '', mode, activeGroup, onClose, onCreate, onAddMember }) {
    const [groupName, setGroupName] = useState('');
    const [selected, setSelected] = useState(new Set());

    const toggle = (id) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const available = (allUsers || []).filter(u => u.id !== myDeviceId);

    const handleCreate = () => {
        if (!groupName.trim() || selected.size === 0) return;
        const ids = Array.from(selected);
        const names = ids.map(id => available.find(u => u.id === id)?.username || 'User');
        onCreate(groupName.trim(), ids, names);
    };

    const handleAdd = () => {
        const id = Array.from(selected)[0];
        if (!id) return;
        const user = available.find(u => u.id === id);
        if (user) onAddMember(user.id, user.username);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="confirm-dialog" onClick={e => e.stopPropagation()} style={{ minWidth: 340 }}>
                <h4>{mode === 'add' ? 'Add Member' : 'New Group'}</h4>
                {mode !== 'add' && (
                    <input
                        placeholder="Group name…"
                        value={groupName}
                        onChange={e => setGroupName(e.target.value)}
                        style={{ width: '100%', marginBottom: 12, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
                        autoFocus
                    />
                )}
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                    {available.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No users available</p>}
                    {available.map(u => (
                        <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', cursor: 'pointer' }}>
                            <input
                                type={mode === 'add' ? 'radio' : 'checkbox'}
                                name="member"
                                checked={selected.has(u.id)}
                                onChange={() => toggle(u.id)}
                            />
                            <UserAvatar name={u.username} size={28} avatarUrl={u.avatar_path} />
                            <span style={{ fontSize: 13 }}>{u.username}</span>
                        </label>
                    ))}
                </div>
                <div className="modal-actions" style={{ marginTop: 12 }}>
                    <button className="btn-secondary" onClick={onClose}>Cancel</button>
                    {mode === 'add' ? (
                        <button className="btn-primary" onClick={handleAdd} disabled={selected.size === 0}>Add</button>
                    ) : (
                        <button className="btn-primary" onClick={handleCreate} disabled={!groupName.trim() || selected.size === 0}>
                            Create
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════
function formatTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

function getLocalIp() {
    // In Tauri, we can't easily get the local IP from JS.
    // The peer will use the sender's discovery IP instead.
    // Return null so the receiver uses the sender's IP from discovery.
    return null;
}
