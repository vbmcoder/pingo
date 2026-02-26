// src/hooks/useApp.js
// Core application hooks for Pingo

import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../lib/api';
import * as avatarCache from '../lib/avatarCache';
import * as chatLogger from '../lib/chatLogger';
import { compressDataUrlIfNeeded } from '../lib/avatarUtils';
import { initNotifications, showMessageNotification, getLastNotification, clearNotificationHistory } from '../lib/notifications';

// ═══════════════════════════════════════════════════════════════
//  useApp  —  top-level app state
// ═══════════════════════════════════════════════════════════════
export function useApp() {
    const [localUser, setLocalUser] = useState(null);
    const [deviceId, setDeviceId] = useState('');
    const [peers, setPeers] = useState([]);
    const [allUsers, setAllUsers] = useState([]);
    const [initialized, setInitialized] = useState(false);
    const [error, setError] = useState(null);
    const [unreadCounts, setUnreadCounts] = useState({});
    const [lastMessages, setLastMessages] = useState({});
    const [fileServerPort, setFileServerPort] = useState(0);
    const peerMapRef = useRef(new Map());

    // Refs for values needed in event handlers (avoids stale closures)
    const localUserRef = useRef(null);
    const deviceIdRef = useRef('');
    const fileServerPortRef = useRef(0);
    // Track currently active chat peer — messages from this peer won't increment unread
    const activeChatPeerIdRef = useRef(null);
    const allUsersRef = useRef([]);

    // Keep refs in sync
    useEffect(() => { localUserRef.current = localUser; }, [localUser]);
    useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);
    useEffect(() => { fileServerPortRef.current = fileServerPort; }, [fileServerPort]);
    useEffect(() => { allUsersRef.current = allUsers || []; }, [allUsers]);

    // Allow external code (chat page) to track which peer chat is currently open
    const setActiveChatPeerId = useCallback((peerId) => {
        activeChatPeerIdRef.current = peerId;
    }, []);

    // Helper: infer message type from content when DB doesn't provide it
    const inferMessageType = (content) => {
        if (!content) return 'text';
        try {
            const obj = JSON.parse(content);
            if (obj && obj.type) return obj.type;
            return 'file';
        } catch (e) {
            // Not JSON — check data URL / http for image/video
            if (content.startsWith('data:')) {
                if (content.startsWith('data:image')) return 'image';
                if (content.startsWith('data:video')) return 'video';
                return 'file';
            }
            if (content.startsWith('http')) {
                // best-effort: treat as image if url ends with image ext
                if (content.match(/\.(png|jpe?g|gif|webp)(\?|$)/i)) return 'image';
                if (content.match(/\.(mp4|webm|ogg)(\?|$)/i)) return 'video';
                return 'image';
            }
            return 'text';
        }
    };

    // ─── Helper: broadcast our profile to a specific peer ────
    const broadcastProfileToPeer = useCallback(async (peerDeviceId) => {
        const lu = localUserRef.current;
        const did = deviceIdRef.current;
        const port = fileServerPortRef.current || await api.getFileServerPort().catch(() => 0);
        if (!lu || !did) return;
        try {
            if (lu.avatar_path && lu.avatar_path.startsWith('data:')) {
                // Compress data URL if it's large to avoid sending huge blobs via signaling
                const toSend = await compressDataUrlIfNeeded(lu.avatar_path, 64 * 1024).catch(() => lu.avatar_path);
                // Send the data URL immediately so peers can display the avatar at once.
                await api.sendSignalingMessage(peerDeviceId, {
                    type: 'ProfileUpdate', from: did, to: peerDeviceId,
                    username: lu.username || '', avatar_url: toSend,
                    bio: lu.bio || '', designation: lu.designation || '',
                });
                // Also store it on our file server for compatibility with peers that prefer HTTP fetch.
                // Fire-and-forget to avoid blocking the fast-path broadcast.
                const fileId = `avatar_${did}`;
                api.storeSharedFile(fileId, toSend, 'avatar.png').catch(() => { });
            } else {
                await api.sendSignalingMessage(peerDeviceId, {
                    type: 'ProfileUpdate', from: did, to: peerDeviceId,
                    username: lu.username || '', bio: lu.bio || '', designation: lu.designation || '',
                });
            }
        } catch (e) { /* peer might not be registered in signaling yet */ }
    }, []);

    // ─── Helper: trigger auto-download for a file message ─────
    const autoDownloadFileMessage = useCallback(async (msg) => {
        if (!msg || !msg.content) return;
        const msgType = msg.message_type || inferMessageType(msg.content);
        if (msgType !== 'image' && msgType !== 'video' && msgType !== 'file') return;
        try {
            const info = JSON.parse(msg.content);
            if (!info.fileId || !info.port) return;

            // Try multiple sources for sender IP
            let senderIp = null;
            let senderName = msg.sender_name || 'Unknown';

            // 1. Try peerMapRef
            const peerData = peerMapRef.current.get(msg.sender_id);
            if (peerData?.ip_address) {
                senderIp = peerData.ip_address;
                senderName = msg.sender_name || peerData.username || senderName;
            }

            // 2. Try allUsers ref
            if (!senderIp && allUsersRef.current) {
                const userData = allUsersRef.current.find(u => u.id === msg.sender_id);
                if (userData?.ip_address) {
                    senderIp = userData.ip_address;
                    senderName = msg.sender_name || userData.username || senderName;
                }
            }

            // 3. Try to get online peers from API
            if (!senderIp) {
                try {
                    const onlinePeers = await api.getOnlinePeers();
                    const peer = onlinePeers?.find(p => p.device_id === msg.sender_id);
                    if (peer?.ip_address) {
                        senderIp = peer.ip_address;
                        senderName = msg.sender_name || peer.username || senderName;
                    }
                } catch { /* ignore */ }
            }

            if (!senderIp) {
                console.warn('[Pingo] Auto-download: no sender IP for', msg.sender_id?.slice(0, 8));
                return;
            }

            const url = `http://${senderIp.split(':')[0]}:${info.port}/file/${info.fileId}`;
            console.log('[Pingo] Auto-downloading file:', info.fileName, 'from', url);
            api.autoDownloadFile(url, senderName, info.fileName || 'file', msgType, msg.id)
                .then(async () => {
                    // After download completes, read the file as a data URL and notify the chat UI
                    // so it can display the preview immediately without waiting for the next render cycle
                    try {
                        const dataUrl = await api.readFileAsDataUrl(info.fileId);
                        if (dataUrl && typeof window !== 'undefined') {
                            window.dispatchEvent(new CustomEvent('pingo:file-downloaded', {
                                detail: { fileId: info.fileId, dataUrl }
                            }));
                        }
                    } catch { /* ignore — UI will lazy-load via effect */ }
                })
                .catch(e => console.warn('[Pingo] Auto-download failed:', e));
        } catch (e) { /* not JSON, skip */ }
    }, []);

    // ─── bootstrap ────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        let finished = false;
        // watchdog to detect long bootstrap
        const wb = setTimeout(() => {
            if (!finished) {
                console.warn('[Pingo] bootstrap still not complete after 10s');
                api.appendDevLog && api.appendDevLog('[Pingo] bootstrap still not complete after 10s').catch(() => { });
            }
        }, 10000);

        (async () => {
            try {
                console.log('[Pingo] bootstrap started');
                api.appendDevLog && api.appendDevLog('[Pingo] bootstrap started').catch(() => { });

                const init = await api.initApp();
                api.appendDevLog && api.appendDevLog('[Pingo] initApp returned').catch(() => { });
                if (cancelled) return;
                setDeviceId(init.device_id);
                deviceIdRef.current = init.device_id;

                const user = await api.getLocalUser();
                if (user) {
                    setLocalUser(user);
                    localUserRef.current = user;
                }

                // Start signaling
                await api.startSignaling(45678);
                api.appendDevLog && api.appendDevLog('[Pingo] startSignaling returned').catch(() => { });

                // Start discovery
                const username = user?.username || 'Pingo User';
                await api.startDiscovery(username, 45678);
                api.appendDevLog && api.appendDevLog('[Pingo] startDiscovery returned').catch(() => { });

                // Get file server port
                try {
                    const port = await api.getFileServerPort();
                    setFileServerPort(port || 0);
                    fileServerPortRef.current = port || 0;
                    api.appendDevLog && api.appendDevLog('[Pingo] file server port=' + (port || 0)).catch(() => { });
                } catch { /* ignore */ }

                // If local user has an avatar, pre-store it in file server for sharing
                if (user && user.avatar_path && user.avatar_path.startsWith('data:')) {
                    try {
                        const fileId = `avatar_${init.device_id}`;
                        await api.storeSharedFile(fileId, user.avatar_path, 'avatar.png');
                    } catch { /* ignore */ }
                }

                // Load ALL known users from DB (offline users persist)
                try {
                    const users = await api.getAllUsers();
                    if (users) {
                        const filtered = users.filter(u => u.id !== init.device_id);
                        setAllUsers(filtered);
                        // CRITICAL FIX: Hydrate avatar cache from stored local paths
                        // This prevents re-downloading avatars and fixes the "disappearing avatar" bug
                        avatarCache.hydrateCacheFromUsers(filtered);

                        // Migrate any legacy file:// avatar paths to local file-server URLs
                        (async () => {
                            for (const u of filtered) {
                                try {
                                    if (!u?.id || !u?.avatar_path) continue;
                                    if (u.avatar_path.startsWith('file://')) {
                                        // Register the existing file with the file server and get local http URL
                                        try {
                                            const localUrl = await api.registerLocalAvatar(u.id, u.avatar_path).catch(() => null);
                                            if (localUrl) {
                                                avatarCache.setLocalAvatarUrl(u.id, localUrl);
                                                setAllUsers(prev => prev.map(p => p.id === u.id ? { ...p, avatar_path: localUrl } : p));
                                            }
                                        } catch (e) { /* ignore */ }
                                    }
                                } catch (e) { /* ignore */ }
                            }
                        })();
                    }
                } catch { /* ignore */ }

                // Load last messages for sidebar preview
                try {
                    const lm = await api.getLastMessages();
                    if (lm) {
                        const map = {};
                        lm.forEach(m => {
                            map[m.peer_id] = {
                                ...m,
                                // DB doesn't return message_type — infer it for preview
                                message_type: m.message_type || inferMessageType(m.content),
                            };
                        });
                        setLastMessages(map);
                    }
                } catch { /* ignore */ }

                // Load unread counts
                try {
                    const total = await api.getUnreadCount();
                    if (total) {
                        // We need per-peer counts. Use allUsers to iterate.
                    }
                } catch { /* ignore */ }

                await initNotifications();
                setInitialized(true);
                finished = true;
                clearTimeout(wb);
                api.appendDevLog && api.appendDevLog('[Pingo] bootstrap complete').catch(() => { });
            } catch (err) {
                console.error('[Pingo] Init failed:', err);
                api.appendDevLog && api.appendDevLog('[Pingo] init failed: ' + String(err)).catch(() => { });
                setError(String(err));
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // ─── refresh last messages ────────────────────────────────
    const refreshLastMessages = useCallback(async () => {
        try {
            const lm = await api.getLastMessages();
            if (lm) {
                const map = {};
                lm.forEach(m => {
                    map[m.peer_id] = {
                        ...m,
                        message_type: m.message_type || inferMessageType(m.content),
                    };
                });
                setLastMessages(map);
            }
        } catch { /* ignore */ }
    }, []);

    // Track rate limiting and deduplication for flush operations
    const lastFlushTimeRef = useRef(new Map()); // peerId -> timestamp
    const flushInProgressRef = useRef(new Set()); // peerIds currently flushing
    const ackedMessagesRef = useRef(new Set()); // messageIds we've received acks for

    // Flush queued (undelivered) messages to a peer when they come online
    // Rate limited to prevent infinite loops and excessive network traffic
    const flushPendingMessages = useCallback(async (peerDeviceId) => {
        if (!peerDeviceId) return;

        // Rate limiting: Don't flush same peer more than once per 30 seconds
        const now = Date.now();
        const lastFlush = lastFlushTimeRef.current.get(peerDeviceId) || 0;
        if (now - lastFlush < 30000) {
            console.debug('[Pingo] Skipping flush for', peerDeviceId.slice(0, 8), '- rate limited');
            return;
        }

        // Prevent concurrent flushes for same peer
        if (flushInProgressRef.current.has(peerDeviceId)) {
            console.debug('[Pingo] Skipping flush for', peerDeviceId.slice(0, 8), '- already in progress');
            return;
        }

        flushInProgressRef.current.add(peerDeviceId);
        lastFlushTimeRef.current.set(peerDeviceId, now);

        try {
            const pending = await api.getUndeliveredMessagesForPeer(peerDeviceId);
            if (!pending || pending.length === 0) {
                flushInProgressRef.current.delete(peerDeviceId);
                return;
            }

            // Filter out messages we've already received acks for (local dedup)
            const toSend = pending.filter(p => !ackedMessagesRef.current.has(p.id));
            if (toSend.length === 0) {
                flushInProgressRef.current.delete(peerDeviceId);
                return;
            }

            chatLogger.log('flush', `Flushing ${toSend.length} pending message(s) → ${peerDeviceId.slice(0, 8)}…`, { peerId: peerDeviceId, count: toSend.length });
            const myName = localUserRef.current?.username || '';

            // Send messages with small delay between each to avoid overwhelming
            for (const p of toSend) {
                try {
                    await api.relayChatMessage(peerDeviceId, p.id, p.content, p.message_type || 'text', myName);
                    chatLogger.log('flush', `Re-relayed: ${p.id.slice(0, 8)}… → ${peerDeviceId.slice(0, 8)}…`, { messageId: p.id, peerId: peerDeviceId });
                    // Small delay between messages
                    await new Promise(r => setTimeout(r, 100));
                } catch (err) {
                    chatLogger.log('error', `Flush relay failed: ${p.id.slice(0, 8)}…`, { messageId: p.id, peerId: peerDeviceId, error: String(err) });
                    console.warn('[Pingo] Failed to deliver pending message', p.id, err);
                }
            }
            refreshLastMessages().catch(() => { });
        } catch (err) {
            chatLogger.log('error', `flushPendingMessages error for ${peerDeviceId.slice(0, 8)}…`, { peerId: peerDeviceId, error: String(err) });
            console.warn('[Pingo] flushPendingMessages error:', err);
        } finally {
            flushInProgressRef.current.delete(peerDeviceId);
        }
    }, [refreshLastMessages]);

    // ─── discovery events ────────────────────────────────────
    useEffect(() => {
        if (!initialized) return;
        const unsubs = [];

        unsubs.push(api.onPeerDiscovered(async peer => {
            const existingUser = peerMapRef.current.get(peer.device_id);
            console.debug('[Pingo][debug] onPeerDiscovered — id=%s incomingUsername=%s existingUsername=%s', peer.device_id, peer.username, existingUser?.username);

            peerMapRef.current.set(peer.device_id, { ...peer, is_online: true });
            setPeers(Array.from(peerMapRef.current.values()));
            // Also merge into allUsers
            setAllUsers(prev => {
                const exists = prev.find(u => u.id === peer.device_id);
                if (exists) {
                    return prev.map(u => u.id === peer.device_id
                        ? { ...u, username: peer.username, is_online: true }
                        : u
                    );
                }
                return [...prev, {
                    id: peer.device_id, username: peer.username, device_id: peer.device_id,
                    is_online: true, public_key: peer.public_key,
                    // If we already have a cached local avatar URL for this peer, use it immediately
                    avatar_path: avatarCache.getLocalAvatarUrl(peer.device_id) || undefined,
                }];
            });

            // Broadcast our profile (including avatar) to newly discovered peer
            setTimeout(() => { broadcastProfileToPeer(peer.device_id); }, 500);

            // Send any queued (undelivered) messages for this peer now that they're online
            flushPendingMessages(peer.device_id).catch(() => { /* ignore */ });
        }));

        unsubs.push(api.onPeerUpdated(peer => {
            // ═══════════════════════════════════════════════════════════
            // CRITICAL FIX: Separate presence data from profile data
            //
            // Problem: onPeerUpdated fires for presence updates (IP, port, connection)
            //          but doesn't include avatar data. If we set avatar_path:undefined,
            //          the UI renders nothing and avatars "disappear" 1-2 seconds later.
            //
            // Solution: Only update presence fields, preserve avatar_path from cache
            // ═══════════════════════════════════════════════════════════

            const ip = peer.ip_address || peer.ip || peer.address || undefined;
            const port = peer.port || peer.file_server_port || undefined;

            // Get existing user to preserve their profile data (avatar, bio, designation)
            const existingUser = peerMapRef.current.get(peer.device_id);
            console.debug('[Pingo][debug] onPeerUpdated — id=%s incomingUsername=%s existingUsername=%s ip=%s port=%s', peer.device_id, peer.username, existingUser?.username, ip, port);
            const preservedAvatar = existingUser?.avatar_path || avatarCache.getLocalAvatarUrl(peer.device_id);

            // If this update includes a local avatar path (e.g., data: or local file), cache it immediately
            if (peer.avatar_path && avatarCache.isLocalAvatarPath(peer.avatar_path)) {
                avatarCache.setLocalAvatarUrl(peer.device_id, peer.avatar_path);
            }

            // If presence includes a username but we already have an authoritative one, suppress it (prevents flicker)
            if (peer.username && existingUser?.username && peer.username !== existingUser.username) {
                console.debug('[Pingo][debug] onPeerUpdated: suppressed presence username update — incoming=%s existing=%s id=%s', peer.username, existingUser.username, peer.device_id);
            }

            // Update ONLY presence data, keep existing profile data — DO NOT overwrite authoritative username from presence.
            // Build a presence-only object and only patch the peer map when something actually changed.
            const prev = existingUser || {};

            // Decide username: prefer authoritative `prev.username`; if missing, accept the first `peer.username`
            // and lock it so subsequent presence username changes are ignored until a ProfileUpdate/DB change arrives.
            const prevPresenceLocked = Boolean(prev._presenceUsernameLocked);
            let resolvedUsername = prev.username;
            let presenceUsernameLocked = prevPresenceLocked;

            if (!resolvedUsername && peer.username) {
                if (!prevPresenceLocked) {
                    // Accept first-seen presence username as a temporary display name and lock it
                    resolvedUsername = peer.username;
                    presenceUsernameLocked = true;
                    console.debug('[Pingo][debug] onPeerUpdated: accepted presence-derived username=%s for id=%s', resolvedUsername, peer.device_id);
                } else {
                    // Already locked to a presence-derived username — ignore changes
                    if (prev.username && prev.username !== peer.username) {
                        console.debug('[Pingo][debug] onPeerUpdated: ignored changed presence username (locked) — incoming=%s locked=%s id=%s', peer.username, prev.username, peer.device_id);
                    }
                }
            }

            const nextPeer = {
                id: peer.device_id,
                device_id: peer.device_id,
                // username may be authoritative (from DB/signaling) or presence-derived (locked)
                username: resolvedUsername,
                bio: prev.bio,
                designation: prev.designation,
                is_online: true,
                ip_address: ip,
                port: port,
                public_key: peer.public_key || prev.public_key,
                // prefer preserved avatar, then previously-known, then whatever presence supplied
                avatar_path: preservedAvatar || prev.avatar_path || peer.avatar_path,
                // internal flag to indicate username was derived from presence and should be treated as sticky
                _presenceUsernameLocked: presenceUsernameLocked,
            };

            const presenceChanged = !prev ||
                prev.ip_address !== nextPeer.ip_address ||
                prev.port !== nextPeer.port ||
                prev.is_online !== nextPeer.is_online ||
                prev.avatar_path !== nextPeer.avatar_path ||
                prev.public_key !== nextPeer.public_key ||
                prev.username !== nextPeer.username ||
                prev._presenceUsernameLocked !== nextPeer._presenceUsernameLocked;

            if (presenceChanged) {
                peerMapRef.current.set(peer.device_id, nextPeer);
                setPeers(Array.from(peerMapRef.current.values()));
            }

            // Update allUsers, but DO NOT overwrite profile fields from presence updates.
            // The authoritative source for profile changes is the 'ProfileUpdate' signaling message.
            setAllUsers(prev => prev.map(u => u.id === peer.device_id
                ? {
                    ...u,
                    // preserve existing username (fallback to discovery only if missing)
                    username: u.username || peer.username,
                    is_online: true,
                    ip_address: ip,
                    // CRITICAL: Don't overwrite avatar_path
                    avatar_path: preservedAvatar || u.avatar_path,
                }
                : u
            ));

            // Flush pending messages once per peer when presence changes
            // Rate limiting in flushPendingMessages prevents duplicate/spam calls
            if (!existingUser || !existingUser.is_online) {
                // Peer just came online - flush pending messages
                flushPendingMessages(peer.device_id).catch(() => { /* ignore */ });
            }
        }));

        unsubs.push(api.onPeerLost(data => {
            const id = data.device_id || data;
            peerMapRef.current.delete(id);
            setPeers(Array.from(peerMapRef.current.values()));
            setAllUsers(prev => prev.map(u => u.id === id ? { ...u, is_online: false } : u));
        }));

        // Listen for server-side deletion of a user and remove from local caches
        unsubs.push(api.onUserDeleted(payload => {
            const id = payload?.user_id || payload;
            setAllUsers(prev => prev.filter(u => u.id !== id));
            setPeers(prev => prev.filter(p => p.device_id !== id));
            setLastMessages(prev => { const next = { ...prev }; delete next[id]; return next; });
            setUnreadCounts(prev => { const next = { ...prev }; delete next[id]; return next; });
            // Also clear cached avatar for deleted user
            avatarCache.clearCache(id);
        }));

        // *** NEW: Listen for ProfileUpdate signaling messages from peers ***
        // This ensures username, bio, and designation updates are applied immediately
        // without needing to wait for re-discovery (fixes flickering bug)
        unsubs.push(api.onSignalingMessage(msg => {
            // Handle delivery acknowledgements from peers
            if (msg?.type === 'DeliveryAck' && msg?.from && msg?.message_id) {
                const peerId = msg.from;
                const messageId = msg.message_id;
                chatLogger.log('ack', `DeliveryAck: ${messageId.slice(0, 8)}… from ${peerId.slice(0, 8)}…`, { peerId, messageId });

                // CRITICAL: Track this messageId as acknowledged to prevent re-sending
                if (ackedMessagesRef.current) {
                    ackedMessagesRef.current.add(messageId);
                    // Limit set size to prevent memory leak
                    if (ackedMessagesRef.current.size > 1000) {
                        const arr = Array.from(ackedMessagesRef.current);
                        ackedMessagesRef.current = new Set(arr.slice(-500));
                    }
                }

                // Update our local DB/UI to mark message delivered
                api.markMessageDelivered(messageId).catch(() => { /* ignore */ });
                try {
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('pingo:pending-delivered', { detail: { peerId, messageId } }));
                    }
                } catch (e) { /* ignore */ }
                // Refresh sidebar previews
                refreshLastMessages().catch(() => { });
                return;
            }

            if (msg?.type === 'ProfileUpdate' && msg?.from) {
                const peerId = msg.from;
                const existingUser = peerMapRef.current.get(peerId);
                console.debug('[Pingo][debug] ProfileUpdate received — peerId=%s msg.username=%s existingUsername=%s avatar=%s', peerId, msg.username, existingUser?.username, msg.avatar_url ? 'yes' : 'no');

                // Build the updated profile — works for both existing and new peers
                const base = existingUser || { id: peerId, device_id: peerId, is_online: true };
                const updated = {
                    ...base,
                    // AUTHORITATIVE: ProfileUpdate is the definitive source for profile fields
                    ...(msg.username && { username: msg.username }),
                    ...(msg.bio !== undefined && { bio: msg.bio }),
                    ...(msg.designation !== undefined && { designation: msg.designation }),
                    // Clear the presence-lock flag so the new name sticks
                    _presenceUsernameLocked: false,
                };

                // If avatar_url is provided, cache it or use it as path
                if (msg.avatar_url) {
                    if (msg.avatar_url.startsWith('data:')) {
                        // Data URL — cache it locally
                        avatarCache.setLocalAvatarUrl(peerId, msg.avatar_url);
                        updated.avatar_path = msg.avatar_url;
                    } else if (msg.avatar_url.startsWith('http')) {
                        // HTTP URL — cache from it asynchronously
                        // Set it immediately for display, then cache in background
                        updated.avatar_path = msg.avatar_url;
                        avatarCache.invalidateCache(peerId); // force re-download
                        avatarCache.cacheAvatarFromUrl(peerId, msg.avatar_url, msg.username || peerId)
                            .then(localUrl => {
                                if (localUrl) {
                                    const cached = peerMapRef.current.get(peerId);
                                    if (cached) {
                                        peerMapRef.current.set(peerId, { ...cached, avatar_path: localUrl });
                                        setPeers(Array.from(peerMapRef.current.values()));
                                        setAllUsers(prev => prev.map(u => u.id === peerId
                                            ? { ...u, avatar_path: localUrl }
                                            : u
                                        ));
                                    }
                                }
                            })
                            .catch(() => { /* ignore caching errors */ });
                    }
                }

                // Update peer map and state
                peerMapRef.current.set(peerId, updated);
                console.debug('[Pingo][debug] ProfileUpdate applied — peerId=%s newUsername=%s avatar_path=%s', peerId, updated.username, updated.avatar_path ? 'set' : 'none');
                setPeers(Array.from(peerMapRef.current.values()));

                // Also update allUsers with new authoritative profile data
                setAllUsers(prev => {
                    const exists = prev.find(u => u.id === peerId);
                    if (exists) {
                        return prev.map(u => u.id === peerId
                            ? {
                                ...u,
                                ...(msg.username && { username: msg.username }),
                                ...(msg.bio !== undefined && { bio: msg.bio }),
                                ...(msg.designation !== undefined && { designation: msg.designation }),
                                ...(updated.avatar_path && { avatar_path: updated.avatar_path }),
                            }
                            : u
                        );
                    }
                    // New user from profile update
                    return [...prev, {
                        id: peerId,
                        device_id: peerId,
                        username: msg.username || 'User',
                        is_online: true,
                        avatar_path: updated.avatar_path,
                        bio: msg.bio,
                        designation: msg.designation,
                    }];
                });
            }
        }));

        return () => { unsubs.forEach(async u => { const fn = await u; fn?.(); }); };
    }, [initialized, broadcastProfileToPeer]);

    // ─── Auto-cache remote avatar URLs to local filesystem ────
    // Extracted into a function so we can re-run on demand if earlier attempts failed
    const lastAvatarCacheRunRef = useRef(0);
    const cacheAvatarsForAllUsers = useCallback(async () => {
        // Throttle repeated runs triggered by frequent presence updates (reduce CPU / log spam)
        if (Date.now() - lastAvatarCacheRunRef.current < 2000) return;
        lastAvatarCacheRunRef.current = Date.now();

        if (!initialized || !allUsers.length) return;
        const tasks = [];
        for (const user of allUsers) {
            if (!user.id || !user.avatar_path) continue;

            // If already local, hydrate cache and skip
            if (avatarCache.isLocalAvatarPath(user.avatar_path)) {
                avatarCache.setLocalAvatarUrl(user.id, user.avatar_path);
                continue;
            }

            // Skip if we already have a local cached copy or a download is in flight
            if (avatarCache.getLocalAvatarUrl(user.id) || avatarCache.isDownloadInFlight?.(user.id)) {
                continue;
            }

            if (user.avatar_path.startsWith('http://') || user.avatar_path.startsWith('https://')) {
                // queue download
                tasks.push((async () => {
                    try {
                        const localUrl = await avatarCache.cacheAvatarFromUrl(user.id, user.avatar_path, user.username);
                        if (localUrl) {
                            setAllUsers(prev => prev.map(u => u.id === user.id ? { ...u, avatar_path: localUrl } : u));
                        }
                    } catch (err) {
                        console.warn(`[Pingo] Failed to cache avatar for ${user.username}:`, err);
                    }
                })());
            }
        }
        await Promise.all(tasks).catch(err => console.warn('[Pingo] Avatar caching batch failed:', err));
    }, [initialized, allUsers]);

    // Run cache when users list changes or on startup
    useEffect(() => { cacheAvatarsForAllUsers(); }, [cacheAvatarsForAllUsers]);

    // Sometimes backend command wasn't available at first (e.g., hot reload). Retry once after short delay.
    useEffect(() => {
        if (!initialized) return;
        const id = setTimeout(() => { cacheAvatarsForAllUsers(); }, 3000);
        return () => clearTimeout(id);
    }, [initialized, cacheAvatarsForAllUsers]);

    // ─── incoming chat messages — update sidebar ─────────────
    useEffect(() => {
        if (!initialized) return;
        const unsub = api.onChatMessageReceived(msg => {
            // Skip meeting chat messages — they are ephemeral and should NOT affect DM state.
            if (msg.content?.startsWith('[MEETING_CHAT]')) return;

            chatLogger.log('receive', `Received ${msg.message_type || 'text'} from ${msg.sender_name || msg.sender_id?.slice(0, 8)}`, {
                messageId: msg.id, senderId: msg.sender_id, senderName: msg.sender_name,
                messageType: msg.message_type, contentLen: msg.content?.length,
            });

            // Update last messages
            setLastMessages(prev => ({
                ...prev,
                [msg.sender_id]: {
                    peer_id: msg.sender_id,
                    content: msg.content,
                    message_type: msg.message_type || inferMessageType(msg.content),
                    created_at: msg.created_at,
                    sender_id: msg.sender_id,
                    username: msg.sender_name || 'User',
                }
            }));
            // Only increment unread if NOT currently chatting with this peer
            if (activeChatPeerIdRef.current !== msg.sender_id) {
                setUnreadCounts(prev => ({
                    ...prev,
                    [msg.sender_id]: (prev[msg.sender_id] || 0) + 1,
                }));
                // Show Windows notification (works when app is minimized/closed)
                const preview = msg.message_type === 'text'
                    ? msg.content
                    : `Sent ${msg.message_type}`;

                // Get sender's avatar from allUsers (use ref to avoid stale closure)
                let senderAvatar = null;
                const sender = allUsersRef.current.find(u => u.id === msg.sender_id);
                if (sender?.avatar_path) {
                    senderAvatar = sender.avatar_path;
                }

                showMessageNotification(msg.sender_name || 'User', preview, msg.sender_id, senderAvatar);
            }
            // Auto-download file/image/video messages
            autoDownloadFileMessage(msg);
        });
        return () => { unsub.then?.(fn => fn?.()); };
    }, [initialized, autoDownloadFileMessage]); // allUsers accessed via ref — no re-subscription needed

    // ─── handle notification clicks — open specific chat ────
    useEffect(() => {
        const handleNotificationClick = (event) => {
            const { senderId, senderName } = event.detail;
            console.log('[Pingo] Notification clicked - opening chat with', senderName, '(', senderId, ')');

            // Dispatch event for chat page to handle navigation
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('pingo:open-chat', {
                    detail: { peerId: senderId, peerName: senderName }
                }));
            }
        };

        // Also listen for app focus to check for recent notifications
        const handleWindowFocus = () => {
            const lastNotif = getLastNotification();
            if (lastNotif && lastNotif.senderId) {
                console.log('[Pingo] App focused - checking for pending notifications');
                // Auto-open the most recent notification chat
                window.dispatchEvent(new CustomEvent('pingo:open-chat', {
                    detail: { peerId: lastNotif.senderId, peerName: lastNotif.senderName }
                }));
                clearNotificationHistory();
            }
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('pingo:notification-clicked', handleNotificationClick);
            window.addEventListener('focus', handleWindowFocus);
            return () => {
                window.removeEventListener('pingo:notification-clicked', handleNotificationClick);
                window.removeEventListener('focus', handleWindowFocus);
            };
        }
    }, []);

    // ─── update user profile ─────────────────────────────────
    const updateProfile = useCallback(async (fields) => {
        if (!localUser) return;
        const oldUsername = localUser.username;
        const updated = await api.createUser(
            fields.username ?? localUser.username,
            fields.avatar_path ?? localUser.avatar_path,
            fields.bio ?? localUser.bio,
            fields.designation ?? localUser.designation,
        );
        if (updated) setLocalUser(updated);

        // *** CRITICAL: Broadcast profile update to ALL peers immediately ***
        // This ensures peers get the new username/bio/designation synchronously
        // without waiting for re-discovery or next message
        const hasChanges =
            (fields.username && fields.username !== localUser.username) ||
            (fields.bio && fields.bio !== localUser.bio) ||
            (fields.designation && fields.designation !== localUser.designation) ||
            (fields.avatar_path && fields.avatar_path !== localUser.avatar_path);

        if (hasChanges) {
            try {
                const onlinePeers = await api.getOnlinePeers();
                if (onlinePeers && onlinePeers.length > 0) {
                    for (const peer of onlinePeers) {
                        try {
                            // Always send profile update with new values (not just avatar)
                            let message = {
                                type: 'ProfileUpdate',
                                from: deviceId,
                                to: peer.device_id,
                                username: fields.username ?? (updated?.username ?? ''),
                                bio: fields.bio ?? (updated?.bio ?? ''),
                                designation: fields.designation ?? (updated?.designation ?? ''),
                            };

                            // If avatar is a data URL, compress it
                            if (fields.avatar_path && fields.avatar_path.startsWith('data:')) {
                                const compressed = await compressDataUrlIfNeeded(fields.avatar_path, 64 * 1024)
                                    .catch(() => fields.avatar_path);
                                message.avatar_url = compressed;
                            }

                            await api.sendSignalingMessage(peer.device_id, message);
                        } catch (e) { /* ok */ }
                    }
                }

                // Store avatar in file server if it's a data URL
                if (fields.avatar_path && fields.avatar_path.startsWith('data:')) {
                    const compressed = await compressDataUrlIfNeeded(fields.avatar_path, 64 * 1024)
                        .catch(() => fields.avatar_path);
                    const fileId = `avatar_${deviceId}`;
                    api.storeSharedFile(fileId, compressed, 'avatar.png').catch(() => { });
                }
            } catch (e) { /* ignore */ }
        }

        // Restart discovery with new username
        if (fields.username && fields.username !== localUser.username) {
            try { await api.restartDiscovery(fields.username, 45678); } catch { /* ok */ }
            // Rename download folder for old username
            try { await api.renameUserDownloadFolder(oldUsername, fields.username); } catch { /* ok */ }
        }

        return updated;
    }, [localUser, deviceId]);

    // ─── save avatar ──────────────────────────────────────────
    const saveAvatar = useCallback(async (imageData) => {
        const result = await api.saveAvatar(imageData);
        if (result) {
            setLocalUser(prev => prev ? { ...prev, avatar_path: result } : prev);
        }
        // Broadcast avatar to online peers via signaling
        try {
            const onlinePeers = await api.getOnlinePeers();

            if (imageData) {
                // If we have a data URL, compress it if needed and broadcast avatar_url immediately
                if (imageData.startsWith('data:')) {
                    const compressed = await compressDataUrlIfNeeded(imageData, 64 * 1024).catch(() => imageData);
                    if (onlinePeers) {
                        for (const peer of onlinePeers) {
                            try {
                                await api.sendSignalingMessage(peer.device_id, {
                                    type: 'ProfileUpdate', from: deviceId, to: peer.device_id,
                                    username: localUser?.username || '', avatar_url: compressed,
                                    bio: localUser?.bio || '', designation: localUser?.designation || '',
                                });
                            } catch (e) { /* ok */ }
                        }
                    }
                    // Also store to file server in background
                    const fileId = `avatar_${deviceId}`;
                    api.storeSharedFile(fileId, compressed, 'avatar.png').catch(() => { });
                } else {
                    const port = fileServerPort || await api.getFileServerPort();
                    if (port) {
                        const fileId = `avatar_${deviceId}`;
                        await api.storeSharedFile(fileId, imageData, 'avatar.png');
                        if (onlinePeers) {
                            for (const peer of onlinePeers) {
                                try {
                                    await api.sendSignalingMessage(peer.device_id, {
                                        type: 'ProfileUpdate', from: deviceId, to: peer.device_id,
                                        username: localUser?.username || '', avatar_file_id: fileId, avatar_file_port: port,
                                        bio: localUser?.bio || '', designation: localUser?.designation || '',
                                    });
                                } catch { /* ok */ }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Pingo] Avatar broadcast failed:', e);
        }
        return result;
    }, [deviceId, fileServerPort, localUser]);

    // ─── clear unread for peer ────────────────────────────────
    const clearUnread = useCallback((peerId) => {
        setUnreadCounts(prev => {
            const next = { ...prev };
            delete next[peerId];
            return next;
        });
        api.markMessagesReadFromPeer(peerId).catch(() => { });
    }, []);

    /* refreshLastMessages moved earlier to fix TDZ (see where it is used by flushPendingMessages) */

    // Expose flushPendingMessages for manual triggering and testing
    useEffect(() => {
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
            // development-only helper for console debugging
            window.pingoFlushPending = (peerId) => flushPendingMessages(peerId).catch(e => console.warn('[Pingo] pingoFlushPending failed', e));
        }
        return () => { if (typeof window !== 'undefined') delete window.pingoFlushPending; };
    }, [flushPendingMessages]);

    return {
        localUser, deviceId, peers, allUsers, initialized, error,
        unreadCounts, lastMessages, fileServerPort,
        updateProfile, saveAvatar, clearUnread, refreshLastMessages,
        flushPendingMessages, // exported for UI/debug
        setLocalUser, setActiveChatPeerId, peerMapRef,
    };
}

// ═══════════════════════════════════════════════════════════════
//  useChat  —  messages for a single peer conversation
// ═══════════════════════════════════════════════════════════════
export function useChat() {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [activePeer, setActivePeer] = useState(null);
    const activePeerRef = useRef(null); // Stable ref for event handlers (no re-subscribe on peer object changes)
    const pollRef = useRef(null);

    // Load messages for a peer
    const loadMessages = useCallback(async (peerId) => {
        if (!peerId) return;
        setLoading(true);
        try {
            const msgs = await api.getMessages(peerId, 200);
            // API returns messages newest-first (DESC). Reverse to chronological order (oldest-first)
            const chronological = (msgs || []).slice().reverse();

            // Annotate media messages so previews work after reload
            const port = await (async () => {
                try { return await api.getFileServerPort(); } catch { return null; }
            })();

            // Get our own device ID from backend (useful because this hook doesn't have access to useApp scope)
            const localDeviceId = await (async () => {
                try { return await api.getDeviceId(); } catch { return null; }
            })();

            const processed = chronological.map(m => {
                // If message appears to be a file/image/video encoded in JSON, parse it
                try {
                    if (m.message_type === 'image' || m.message_type === 'video' || m.message_type === 'file') {
                        const info = JSON.parse(m.content);
                        if (info && info.fileId) {
                            // Always use local file server (works for sent & auto-downloaded files)
                            const p = info.port || port || 0;
                            m._localDataUrl = `http://127.0.0.1:${p}/file/${info.fileId}`;
                            m._fileName = info.fileName || m._fileName || 'file';
                            m._fileType = info.type || m._fileType || m.message_type;
                            m._fileId = info.fileId;
                        }
                    }
                } catch (e) { /* ignore non-json content */ }
                return m;
            });

            setMessages(processed);
        } catch (err) {
            console.error('Failed to load messages:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    // Select a peer (full switch — reloads messages)
    const selectPeer = useCallback((peer) => {
        setActivePeer(peer);
        const peerId = peer ? (peer.device_id || peer.id) : null;
        activePeerRef.current = peerId;
        if (peer) {
            loadMessages(peerId);
        } else {
            setMessages([]);
        }
    }, [loadMessages]);

    // Update peer cosmetic info (name/avatar) WITHOUT reloading messages
    // This prevents tearing down the message listener and losing incoming messages
    const updatePeerInfo = useCallback((updatedPeer) => {
        setActivePeer(updatedPeer);
        // DO NOT update activePeerRef or reload messages — just update the display object
    }, []);

    // Listen for incoming messages — uses stable activePeerRef to avoid re-subscribing
    // on every cosmetic peer update (name/avatar change). This prevents dropping messages.
    useEffect(() => {
        const unsub = api.onChatMessageReceived(async (msg) => {
            const currentPeerId = activePeerRef.current;
            if (!currentPeerId) return;
            if (msg.sender_id === currentPeerId) {
                // Annotate file messages with basic info - the UI will handle loading
                const newMsg = { ...msg };
                try {
                    if (msg.message_type === 'image' || msg.message_type === 'video' || msg.message_type === 'file') {
                        const info = JSON.parse(msg.content);
                        if (info && info.fileId) {
                            newMsg._fileId = info.fileId;
                            newMsg._fileName = info.fileName || 'file';
                            newMsg._fileType = info.type || msg.message_type;
                            // NO async file loading here - let chat.jsx handle it via loadedFileUrls
                        }
                    }
                } catch { /* ignore */ }

                setMessages(prev => {
                    if (prev.find(m => m.id === msg.id)) return prev;
                    return [...prev, newMsg];
                });
            }
        });
        return () => { unsub.then?.(fn => fn?.()); };
    }, []); // Empty deps — never re-subscribes. Uses ref for current peer ID.

    // Listen for pending-delivered events and update active chat messages
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handler = (e) => {
            try {
                const { peerId, messageId } = e?.detail || {};
                const currentPeerId = activePeerRef.current;
                if (!peerId || !messageId) return;
                if (peerId === currentPeerId) {
                    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, is_delivered: true } : m));
                }
            } catch (err) { /* ignore */ }
        };
        window.addEventListener('pingo:pending-delivered', handler);
        return () => window.removeEventListener('pingo:pending-delivered', handler);
    }, []); // Empty deps — uses ref

    // Send text message
    const sendText = useCallback(async (peerId, text, senderName) => {
        chatLogger.log('send', `Sending text to ${peerId.slice(0, 8)}…`, { peerId, textLen: text.length });
        const msg = await api.sendMessage(peerId, text, 'text');
        if (msg) {
            setMessages(prev => [...prev, msg]);
            chatLogger.log('send', `Message saved: ${msg.id.slice(0, 8)}…`, { messageId: msg.id, peerId });
            // Relay via UDP signaling
            try {
                await api.relayChatMessage(peerId, msg.id, text, 'text', senderName || '');
                chatLogger.log('relay', `Relay attempted: ${msg.id.slice(0, 8)}… → ${peerId.slice(0, 8)}…`, { messageId: msg.id, peerId });
            } catch (e) {
                chatLogger.log('error', `Relay failed: ${msg.id.slice(0, 8)}… → ${peerId.slice(0, 8)}…`, { messageId: msg.id, peerId, error: String(e) });
                console.warn('Relay failed:', e);
            }
        } else {
            chatLogger.log('error', `Failed to save message to DB`, { peerId });
        }
        return msg;
    }, []);

    // Send file/image via HTTP file server
    const sendFile = useCallback(async (peerId, dataUrl, fileName, messageType, senderName, senderIp) => {
        try {
            chatLogger.log('send', `Sending ${messageType}: ${fileName} → ${peerId.slice(0, 8)}…`, { peerId, fileName, messageType });
            const fileId = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            // Store in file server
            await api.storeSharedFile(fileId, dataUrl, fileName);
            const port = await api.getFileServerPort();

            const fileInfo = JSON.stringify({ fileId, fileName, port, type: messageType });
            const msg = await api.sendMessage(peerId, fileInfo, messageType);
            if (msg) {
                // Use the original dataUrl directly for sender view (no HTTP needed)
                setMessages(prev => [...prev, {
                    ...msg,
                    _localDataUrl: dataUrl, // Use data URL directly, not HTTP
                    _fileId: fileId,
                    _fileName: fileName,
                    _fileType: messageType,
                    _isLoading: false,
                }]);
                chatLogger.log('send', `File message saved: ${msg.id.slice(0, 8)}…`, { messageId: msg.id, fileId, fileName });
                // Relay file metadata to peer
                try {
                    await api.relayChatMessage(peerId, msg.id, fileInfo, messageType, senderName || '');
                    chatLogger.log('relay', `File relay attempted: ${msg.id.slice(0, 8)}…`, { messageId: msg.id, peerId });
                } catch (e) {
                    chatLogger.log('error', `File relay failed: ${msg.id.slice(0, 8)}…`, { messageId: msg.id, peerId, error: String(e) });
                    console.warn('File relay failed:', e);
                }
            }
            return msg;
        } catch (err) {
            chatLogger.log('error', `sendFile failed: ${fileName}`, { peerId, fileName, error: String(err) });
            console.error('sendFile failed:', err);
            throw err;
        }
    }, []);

    // Delete single message
    const deleteMsg = useCallback(async (messageId) => {
        await api.deleteMessage(messageId);
        setMessages(prev => prev.filter(m => m.id !== messageId));
    }, []);

    // Delete all messages with peer
    const deleteAllMessages = useCallback(async (peerId) => {
        await api.deleteAllMessagesWithPeer(peerId);
        setMessages([]);
    }, []);

    return {
        messages, loading, activePeer,
        selectPeer, updatePeerInfo, sendText, sendFile, loadMessages,
        deleteMsg, deleteAllMessages, setMessages,
    };
}

// ═══════════════════════════════════════════════════════════════
//  useNotes  —  sticky notes
// ═══════════════════════════════════════════════════════════════
export function useNotes() {
    const [notes, setNotes] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const all = await api.getAllNotes();
                setNotes(all || []);
            } catch (e) {
                console.error('Failed to load notes:', e);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const save = useCallback(async (note) => {
        const saved = await api.saveNote(note);
        if (saved) setNotes(prev => {
            const idx = prev.findIndex(n => n.id === saved.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
            return [saved, ...prev];
        });
        return saved;
    }, []);

    const remove = useCallback(async (id) => {
        await api.deleteNote(id);
        setNotes(prev => prev.filter(n => n.id !== id));
    }, []);

    const togglePin = useCallback(async (id) => {
        await api.toggleNotePin(id);
        setNotes(prev => prev.map(n => n.id === id ? { ...n, pinned: !n.pinned } : n));
    }, []);

    return { notes, loading, save, remove, togglePin };
}

// ═══════════════════════════════════════════════════════════════
//  useGroups  —  group chats
// ═══════════════════════════════════════════════════════════════
export function useGroups() {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const all = await api.getGroups();
                setGroups(all || []);
            } catch (e) {
                console.error('Failed to load groups:', e);
            } finally {
                setLoading(false);
            }
        })();

        const unsubs = [];

        // Subscribe to group creation events from other peers
        unsubs.push(api.onGroupCreated((group) => {
            setGroups(prev => {
                if (prev.find(g => g.id === group.id)) return prev;
                return [group, ...prev];
            });
        }));

        // Subscribe to member added/removed events (for live updates)
        unsubs.push(api.onGroupMemberAdded(() => {
            // Refresh groups in case a new member was added
        }));

        unsubs.push(api.onGroupMemberRemoved((data) => {
            // If we were removed, remove the group from our list
            if (data?.user_id) {
                api.getDeviceId().then(myId => {
                    if (data.user_id === myId) {
                        setGroups(prev => prev.filter(g => g.id !== data.group_id));
                    }
                }).catch(() => { });
            }
        }));

        return () => { unsubs.forEach(async u => { const fn = await u; fn?.(); }); };
    }, []);

    const createGroup = useCallback(async (name, memberIds, memberNames) => {
        const group = await api.createGroup(name, memberIds, memberNames);
        if (group) setGroups(prev => [...prev, group]);
        return group;
    }, []);

    const deleteGroup = useCallback(async (groupId) => {
        await api.deleteGroup(groupId);
        setGroups(prev => prev.filter(g => g.id !== groupId));
    }, []);

    const leaveGroup = useCallback(async (groupId) => {
        await api.leaveGroup(groupId);
        setGroups(prev => prev.filter(g => g.id !== groupId));
    }, []);

    const addMember = useCallback(async (groupId, userId, username) => {
        await api.addGroupMember(groupId, userId, username);
    }, []);

    const removeMember = useCallback(async (groupId, userId) => {
        await api.removeGroupMember(groupId, userId);
    }, []);

    const refresh = useCallback(async () => {
        const all = await api.getGroups();
        setGroups(all || []);
    }, []);

    return { groups, loading, createGroup, deleteGroup, leaveGroup, addMember, removeMember, refresh };
}

// ═══════════════════════════════════════════════════════════════
//  useFileTransfer  —  placeholder for WebRTC file transfer
// ═══════════════════════════════════════════════════════════════
export function useFileTransfer() {
    const [transfers, setTransfers] = useState([]);

    return { transfers, setTransfers };
}
