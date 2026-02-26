// src/lib/screenShare.js
// Screen Sharing Manager for Pingo

import { webrtc } from './webrtc.js';
import * as api from './api.js';

/**
 * Screen Share Session States
 */
export const ScreenShareState = {
    IDLE: 'idle',
    INVITING: 'inviting',
    PENDING: 'pending',
    SHARING: 'sharing',
    VIEWING: 'viewing',
};

/**
 * Participant Status
 */
export const ParticipantStatus = {
    INVITED: 'invited',
    CONNECTED: 'connected',
    DECLINED: 'declined',
    OFFLINE: 'offline',
    LEFT: 'left',
};

/**
 * Screen Share Session
 */
export class ScreenShareSession {
    constructor(sessionId, hostId, isHost = false) {
        this.sessionId = sessionId;
        this.hostId = hostId;
        this.isHost = isHost;
        this.state = ScreenShareState.IDLE;
        this.stream = null;
        this.participants = new Map(); // peerId -> ParticipantStatus
        this.onStateChange = null;
        this.onParticipantUpdate = null;
        this.onStreamReceived = null;
    }

    /**
     * Start sharing (host only)
     * @param {string[]} peerIds - Peers to invite
     */
    async startSharing(peerIds) {
        if (!this.isHost) {
            throw new Error('Only host can start sharing');
        }

        try {
            // Get screen capture
            this.stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    displaySurface: 'monitor',
                },
                audio: false,
            });

            // Handle stream end (user clicked stop)
            this.stream.getVideoTracks()[0].onended = () => {
                this.stopSharing();
            };

            this.state = ScreenShareState.SHARING;
            this.onStateChange?.(this.state);

            // Invite all peers
            for (const peerId of peerIds) {
                await this.invitePeer(peerId);
            }

            return this.stream;
        } catch (error) {
            console.error('Failed to start screen share:', error);
            throw error;
        }
    }

    /**
     * Invite a peer to view the screen share
     * @param {string} peerId 
     */
    async invitePeer(peerId) {
        if (!this.isHost) return;

        this.participants.set(peerId, ParticipantStatus.INVITED);
        this.onParticipantUpdate?.(peerId, ParticipantStatus.INVITED);

        // Send invite via signaling
        await api.sendSignalingMessage(peerId, {
            type: 'ScreenShareInvite',
            from: this.hostId,
            to: peerId,
            session_id: this.sessionId,
        });
    }

    /**
     * Handle invite response from peer
     * @param {string} peerId 
     * @param {boolean} accepted 
     */
    async handleInviteResponse(peerId, accepted, sessionId) {
        // Only handle responses for our active session
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        if (accepted) {
            this.participants.set(peerId, ParticipantStatus.CONNECTED);
            this.onParticipantUpdate?.(peerId, ParticipantStatus.CONNECTED);

            // Ensure there's a PeerConnection for the peer
            let connection = webrtc.connections.get(peerId);
            if (!connection) {
                // Host should be the initiator
                connection = webrtc.createConnection(peerId, true);
            }

            if (connection && this.stream) {
                // Add our screen tracks to the connection
                this.stream.getTracks().forEach(track => {
                    connection.addTrack(track, this.stream);
                });

                try {
                    // Create and send an Offer so the viewer can answer and receive the stream
                    const offer = await connection.createOffer();
                    await connection.setLocalDescription(offer);

                    await api.sendSignalingMessage(peerId, {
                        type: 'Offer', from: this.hostId, to: peerId,
                        sdp: offer.sdp, session_id: sessionId,
                    });
                } catch (err) {
                    console.error('Failed to negotiate screen share with', peerId, err);
                }
            }
        } else {
            this.participants.set(peerId, ParticipantStatus.DECLINED);
            this.onParticipantUpdate?.(peerId, ParticipantStatus.DECLINED);
        }
    }

    /**
     * Accept incoming screen share invite (viewer)
     */
    async acceptInvite() {
        if (this.isHost) return;

        this.state = ScreenShareState.VIEWING;
        this.onStateChange?.(this.state);

        await api.sendSignalingMessage(this.hostId, {
            type: 'ScreenShareResponse',
            from: webrtc.localDeviceId,
            to: this.hostId,
            session_id: this.sessionId,
            accepted: true,
        });
    }

    /**
     * Decline incoming screen share invite (viewer)
     */
    async declineInvite() {
        if (this.isHost) return;

        this.state = ScreenShareState.IDLE;
        this.onStateChange?.(this.state);

        await api.sendSignalingMessage(this.hostId, {
            type: 'ScreenShareResponse',
            from: webrtc.localDeviceId,
            to: this.hostId,
            session_id: this.sessionId,
            accepted: false,
        });
    }

    /**
     * Handle incoming stream (viewer)
     * @param {MediaStream} stream 
     */
    handleStreamReceived(stream) {
        this.stream = stream;
        this.state = ScreenShareState.VIEWING;
        this.onStateChange?.(this.state);
        this.onStreamReceived?.(stream);
    }

    /**
     * Stop sharing (host) or leave (viewer)
     */
    stopSharing() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        this.state = ScreenShareState.IDLE;
        this.onStateChange?.(this.state);

        if (this.isHost) {
            // Notify all participants
            for (const peerId of this.participants.keys()) {
                webrtc.sendMessage(peerId, {
                    type: 'screen-share-ended',
                    sessionId: this.sessionId,
                });
            }
            this.participants.clear();
        }
    }

    /**
     * Get participant list with statuses
     * @returns {Object[]}
     */
    getParticipants() {
        const list = [];
        for (const [peerId, status] of this.participants) {
            list.push({ peerId, status });
        }
        return list;
    }

    /**
     * Get connected participant count
     * @returns {number}
     */
    getConnectedCount() {
        let count = 0;
        for (const status of this.participants.values()) {
            if (status === ParticipantStatus.CONNECTED) {
                count++;
            }
        }
        return count;
    }
}

/**
 * Screen Share Manager
 * Manages screen sharing sessions
 */
export class ScreenShareManager {
    constructor() {
        this.activeSessions = new Map(); // sessionId -> ScreenShareSession
        this.pendingInvites = new Map(); // sessionId -> invite info
        this.onInviteReceived = null;
        this.onSessionEnded = null;
    }

    /**
     * Initialize the manager
     */
    init() {
        // Listen for screen share events
        webrtc.onScreenShareReceived = (peerId, stream) => {
            this.handleStreamReceived(peerId, stream);
        };

        // Listen for signaling messages so the manager can act on invites/responses
        api.onSignalingMessage((msg) => {
            if (!msg) return;

            if (msg.type === 'ScreenShareInvite') {
                // Viewer side: show invite
                this.handleInvite(msg.from, msg.session_id);
            }

            if (msg.type === 'ScreenShareResponse') {
                // Host side: peer accepted/declined
                const session = this.activeSessions.get(msg.session_id);
                if (session && session.isHost) {
                    session.handleInviteResponse(msg.from, !!msg.accepted, msg.session_id);
                }
            }
        });
    }

    /**
     * Create a new screen share session (as host)
     * @returns {ScreenShareSession}
     */
    async createSession() {
        const sessionId = await api.generateUuid();
        const hostId = await api.getDeviceId();

        const session = new ScreenShareSession(sessionId, hostId, true);
        this.activeSessions.set(sessionId, session);

        return session;
    }

    /**
     * Handle incoming screen share invite
     * @param {string} hostId 
     * @param {string} sessionId 
     */
    handleInvite(hostId, sessionId) {
        this.pendingInvites.set(sessionId, { hostId, sessionId });
        this.onInviteReceived?.(hostId, sessionId);
    }

    /**
     * Accept pending invite
     * @param {string} sessionId 
     * @returns {ScreenShareSession}
     */
    async acceptInvite(sessionId) {
        const invite = this.pendingInvites.get(sessionId);
        if (!invite) {
            throw new Error('Invite not found');
        }

        const session = new ScreenShareSession(sessionId, invite.hostId, false);
        await session.acceptInvite();

        this.activeSessions.set(sessionId, session);
        this.pendingInvites.delete(sessionId);

        return session;
    }

    /**
     * Decline pending invite
     * @param {string} sessionId 
     */
    async declineInvite(sessionId) {
        const invite = this.pendingInvites.get(sessionId);
        if (!invite) return;

        const session = new ScreenShareSession(sessionId, invite.hostId, false);
        await session.declineInvite();

        this.pendingInvites.delete(sessionId);
    }

    /**
     * Handle incoming stream
     * @param {string} peerId 
     * @param {MediaStream} stream 
     */
    handleStreamReceived(peerId, stream) {
        // Find session for this peer
        for (const session of this.activeSessions.values()) {
            if (session.hostId === peerId && !session.isHost) {
                session.handleStreamReceived(stream);
                break;
            }
        }
    }

    /**
     * End a session
     * @param {string} sessionId 
     */
    endSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.stopSharing();
            this.activeSessions.delete(sessionId);
            this.onSessionEnded?.(sessionId);
        }
    }

    /**
     * Get active session
     * @param {string} sessionId 
     * @returns {ScreenShareSession|undefined}
     */
    getSession(sessionId) {
        return this.activeSessions.get(sessionId);
    }

    /**
     * Get all active sessions
     * @returns {ScreenShareSession[]}
     */
    getAllSessions() {
        return Array.from(this.activeSessions.values());
    }
}

// Singleton instance
export const screenShare = new ScreenShareManager();

/*
SCREEN SHARING FLOW:

┌─────────────────────────────────────────────────────────────────────┐
│                    SCREEN SHARING PROTOCOL                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  HOST FLOW:                                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ 1. User clicks "Share Screen"                                 │  │
│  │ 2. createSession() creates new ScreenShareSession             │  │
│  │ 3. startSharing(peerIds) captures screen                      │  │
│  │ 4. For each peer: sendSignalingMessage(ScreenShareInvite)     │  │
│  │ 5. Wait for responses (accepted/declined)                     │  │
│  │ 6. For accepted: addTrack to RTCPeerConnection                │  │
│  │ 7. Host sees: connected/declined/offline status per peer      │  │
│  │ 8. stopSharing() ends session and notifies all viewers        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  VIEWER FLOW:                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ 1. Receive ScreenShareInvite notification                     │  │
│  │ 2. Show invite dialog: Accept / Decline / Join Later          │  │
│  │ 3a. Accept: sendSignalingMessage(ScreenShareResponse, true)   │  │
│  │     - Receive MediaStream via ontrack                         │  │
│  │     - Display in video element                                │  │
│  │ 3b. Decline: sendSignalingMessage(ScreenShareResponse, false) │  │
│  │ 4. View-only mode (no controls sent to host)                  │  │
│  │ 5. Session ends when host stops or viewer leaves              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  PARTICIPANT STATUSES:                                              │
│  ├── INVITED: Invite sent, waiting response                        │
│  ├── CONNECTED: Actively viewing                                    │
│  ├── DECLINED: User declined invite                                 │
│  ├── OFFLINE: User not reachable                                    │
│  └── LEFT: User left the session                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
*/
