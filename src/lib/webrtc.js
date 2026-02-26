// src/lib/webrtc.js
// WebRTC Manager for Pingo
// Handles peer-to-peer connections, data channels, and media streams

import * as api from './api.js';

// STUN servers for NAT traversal (internet fallback)
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

// DataChannel configuration
const DATA_CHANNEL_CONFIG = {
    ordered: true,
    maxRetransmits: 3,
};

/**
 * WebRTC Connection Manager
 * Manages peer connections, data channels, and signaling
 */
export class WebRTCManager {
    constructor() {
        this.connections = new Map(); // peerId -> RTCPeerConnection
        this.dataChannels = new Map(); // peerId -> RTCDataChannel
        this.mediaStreams = new Map(); // peerId -> MediaStream
        this.pendingCandidates = new Map(); // peerId -> ICE candidates
        this.localScreenShares = new Map(); // peerId -> local screen MediaStream (for hosts)
        this.localDeviceId = null;
        this.onMessage = null;
        this.onPeerConnected = null;
        this.onPeerDisconnected = null;
        this.onScreenShareReceived = null;
        this.onFileReceived = null;
    }

    /**
     * Initialize the WebRTC manager
     * @param {string} deviceId - Local device ID
     */
    async init(deviceId) {
        this.localDeviceId = deviceId;

        // Listen for signaling messages from Rust backend
        api.onSignalingMessage(this.handleSignalingMessage.bind(this));
    }

    /**
     * Create a new peer connection
     * @param {string} peerId 
     * @param {boolean} isInitiator 
     * @returns {RTCPeerConnection}
     */
    createConnection(peerId, isInitiator = false) {
        const config = {
            iceServers: ICE_SERVERS,
            iceCandidatePoolSize: 10,
        };

        const connection = new RTCPeerConnection(config);
        this.connections.set(peerId, connection);
        this.pendingCandidates.set(peerId, []);

        // Handle ICE candidates
        connection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendIceCandidate(peerId, event.candidate);
            }
        };

        // Handle connection state changes
        connection.onconnectionstatechange = () => {
            console.log(`Connection state with ${peerId}: ${connection.connectionState}`);

            if (connection.connectionState === 'connected') {
                this.onPeerConnected?.(peerId);
            } else if (connection.connectionState === 'disconnected' ||
                connection.connectionState === 'failed') {
                this.onPeerDisconnected?.(peerId);
            }
        };

        // Handle incoming data channels
        connection.ondatachannel = (event) => {
            this.setupDataChannel(peerId, event.channel);
        };

        // Handle incoming streams (screen share)
        connection.ontrack = (event) => {
            console.log(`Received track from ${peerId}`);
            this.mediaStreams.set(peerId, event.streams[0]);
            this.onScreenShareReceived?.(peerId, event.streams[0]);
        };

        // Create data channel if initiator
        if (isInitiator) {
            const channel = connection.createDataChannel('pingo', DATA_CHANNEL_CONFIG);
            this.setupDataChannel(peerId, channel);
        }

        return connection;
    }

    /**
     * Set up data channel event handlers
     * @param {string} peerId 
     * @param {RTCDataChannel} channel 
     */
    setupDataChannel(peerId, channel) {
        this.dataChannels.set(peerId, channel);

        channel.onopen = () => {
            console.log(`Data channel open with ${peerId}`);
        };

        channel.onclose = () => {
            console.log(`Data channel closed with ${peerId}`);
            this.dataChannels.delete(peerId);
        };

        channel.onmessage = (event) => {
            this.handleDataChannelMessage(peerId, event.data);
        };

        channel.onerror = (error) => {
            console.error(`Data channel error with ${peerId}:`, error);
        };
    }

    /**
     * Connect to a peer (initiate connection)
     * @param {string} peerId 
     * @param {string} ip 
     * @param {number} port 
     */
    async connect(peerId, ip, port) {
        // Register peer with signaling server
        await api.registerPeer(peerId, ip, port);

        // Create connection as initiator
        const connection = this.createConnection(peerId, true);

        // Create and send offer
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);

        const sessionId = await api.generateUuid();

        await api.sendSignalingMessage(peerId, {
            type: 'Offer',
            from: this.localDeviceId,
            to: peerId,
            sdp: offer.sdp,
            session_id: sessionId,
        });
    }

    /**
     * Handle incoming signaling message
     * @param {Object} message 
     */
    async handleSignalingMessage(message) {
        const peerId = message.from;

        switch (message.type) {
            case 'Offer':
                await this.handleOffer(peerId, message);
                break;
            case 'Answer':
                await this.handleAnswer(peerId, message);
                break;
            case 'IceCandidate':
                await this.handleIceCandidate(peerId, message);
                break;
            case 'ScreenShareInvite':
                this.onScreenShareInvite?.(peerId, message.session_id);
                break;
            case 'ScreenShareResponse':
                // If peer accepted and we have a local screen stream for them, negotiate
                if (message.accepted && this.localScreenShares.has(peerId)) {
                    const stream = this.localScreenShares.get(peerId);
                    // Ensure connection exists
                    let connection = this.connections.get(peerId);
                    if (!connection) {
                        connection = this.createConnection(peerId, true);
                    }
                    // Add tracks and create Offer
                    stream.getTracks().forEach(track => connection.addTrack(track, stream));
                    try {
                        const offer = await connection.createOffer();
                        await connection.setLocalDescription(offer);
                        await api.sendSignalingMessage(peerId, {
                            type: 'Offer', from: this.localDeviceId, to: peerId,
                            sdp: offer.sdp, session_id: message.session_id,
                        });
                    } catch (err) {
                        console.error('Failed to negotiate screen share (webrtc):', err);
                    }
                }
                break;
            case 'FileTransferRequest':
                this.onFileTransferRequest?.(peerId, message);
                break;
        }
    }

    /**
     * Handle incoming offer
     * @param {string} peerId 
     * @param {Object} message 
     */
    async handleOffer(peerId, message) {
        let connection = this.connections.get(peerId);

        if (!connection) {
            connection = this.createConnection(peerId, false);
        }

        await connection.setRemoteDescription({
            type: 'offer',
            sdp: message.sdp,
        });

        // Apply pending ICE candidates
        const pending = this.pendingCandidates.get(peerId) || [];
        for (const candidate of pending) {
            await connection.addIceCandidate(candidate);
        }
        this.pendingCandidates.set(peerId, []);

        // Create and send answer
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);

        await api.sendSignalingMessage(peerId, {
            type: 'Answer',
            from: this.localDeviceId,
            to: peerId,
            sdp: answer.sdp,
            session_id: message.session_id,
        });
    }

    /**
     * Handle incoming answer
     * @param {string} peerId 
     * @param {Object} message 
     */
    async handleAnswer(peerId, message) {
        const connection = this.connections.get(peerId);

        if (connection) {
            await connection.setRemoteDescription({
                type: 'answer',
                sdp: message.sdp,
            });

            // Apply pending ICE candidates
            const pending = this.pendingCandidates.get(peerId) || [];
            for (const candidate of pending) {
                await connection.addIceCandidate(candidate);
            }
            this.pendingCandidates.set(peerId, []);
        }
    }

    /**
     * Handle incoming ICE candidate
     * @param {string} peerId 
     * @param {Object} message 
     */
    async handleIceCandidate(peerId, message) {
        const connection = this.connections.get(peerId);
        const candidate = new RTCIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdp_mid,
            sdpMLineIndex: message.sdp_mline_index,
        });

        if (connection && connection.remoteDescription) {
            await connection.addIceCandidate(candidate);
        } else {
            // Queue candidate for later
            const pending = this.pendingCandidates.get(peerId) || [];
            pending.push(candidate);
            this.pendingCandidates.set(peerId, pending);
        }
    }

    /**
     * Send ICE candidate to peer
     * @param {string} peerId 
     * @param {RTCIceCandidate} candidate 
     */
    async sendIceCandidate(peerId, candidate) {
        await api.sendSignalingMessage(peerId, {
            type: 'IceCandidate',
            from: this.localDeviceId,
            to: peerId,
            candidate: candidate.candidate,
            sdp_mid: candidate.sdpMid,
            sdp_mline_index: candidate.sdpMLineIndex,
            session_id: '', // Will be set by backend
        });
    }

    /**
     * Send a message to a peer via data channel
     * @param {string} peerId 
     * @param {Object} message 
     */
    sendMessage(peerId, message) {
        const channel = this.dataChannels.get(peerId);

        if (channel && channel.readyState === 'open') {
            channel.send(JSON.stringify(message));
            return true;
        }

        return false;
    }

    /**
     * Send a chat message via DataChannel (plaintext for LAN; caller stores in DB)
     * @param {string} peerId 
     * @param {string} content 
     * @returns {string|null} message id if sent
     */
    async sendChatMessage(peerId, content) {
        const message = {
            type: 'chat',
            id: await api.generateUuid(),
            content,                       // plain text – LAN only, no encryption needed
            timestamp: await api.getTimestamp(),
        };

        if (this.sendMessage(peerId, message)) {
            return message.id;
        }
        return null;
    }

    /**
     * Handle incoming data channel message
     * @param {string} peerId 
     * @param {string} data 
     */
    async handleDataChannelMessage(peerId, data) {
        try {
            const message = JSON.parse(data);

            switch (message.type) {
                case 'chat':
                    // Plain-text on LAN
                    this.onMessage?.(peerId, {
                        id: message.id,
                        content: message.content,
                        timestamp: message.timestamp,
                    });
                    // Send ACK
                    this.sendMessage(peerId, { type: 'ack', messageId: message.id });
                    break;

                case 'ack':
                    // Message delivered confirmation
                    await api.markMessageRead(message.messageId);
                    break;

                case 'file-chunk':
                    // Handle file chunk
                    await this.handleFileChunk(peerId, message);
                    break;

                case 'file-request':
                    this.onFileTransferRequest?.(peerId, message);
                    break;

                case 'file-accept':
                    this.onFileTransferAccepted?.(peerId, message.transferId);
                    break;

                case 'file-reject':
                    this.onFileTransferRejected?.(peerId, message.transferId);
                    break;
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    /**
     * Handle incoming file chunk
     * @param {string} peerId 
     * @param {Object} message 
     */
    async handleFileChunk(peerId, message) {
        const success = await api.receiveFileChunk({
            transfer_id: message.transferId,
            chunk_index: message.chunkIndex,
            data: message.data,
            checksum: message.checksum,
        });

        // Send chunk ACK
        this.sendMessage(peerId, {
            type: 'chunk-ack',
            transferId: message.transferId,
            chunkIndex: message.chunkIndex,
            success,
        });

        // Check if transfer complete
        const progress = await api.getTransferProgress(message.transferId);
        if (progress && progress.chunks_completed === progress.total_chunks) {
            const verified = await api.completeTransfer(message.transferId);
            this.onFileReceived?.(message.transferId, verified);
        }
    }

    /**
     * Send a file to a peer
     * @param {string} peerId 
     * @param {string} filePath 
     */
    async sendFile(peerId, filePath) {
        // Prepare file
        const metadata = await api.prepareFileSend(filePath);

        // Send file request
        this.sendMessage(peerId, {
            type: 'file-request',
            transferId: metadata.transfer_id,
            fileName: metadata.file_name,
            fileSize: metadata.file_size,
            fileType: metadata.file_type,
            totalChunks: metadata.total_chunks,
            checksum: metadata.checksum,
        });

        return metadata.transfer_id;
    }

    /**
     * Accept file transfer
     * @param {string} peerId 
     * @param {Object} metadata 
     */
    async acceptFileTransfer(peerId, metadata) {
        await api.prepareFileReceive(metadata);

        this.sendMessage(peerId, {
            type: 'file-accept',
            transferId: metadata.transfer_id,
        });
    }

    /**
     * Reject file transfer
     * @param {string} peerId 
     * @param {string} transferId 
     */
    rejectFileTransfer(peerId, transferId) {
        this.sendMessage(peerId, {
            type: 'file-reject',
            transferId,
        });
    }

    /**
     * Start sending file chunks
     * @param {string} peerId 
     * @param {string} transferId 
     */
    async startFileSend(peerId, transferId) {
        const progress = await api.getTransferProgress(transferId);
        if (!progress) return;

        for (let i = 0; i < progress.total_chunks; i++) {
            const chunk = await api.getFileChunk(transferId, i);

            this.sendMessage(peerId, {
                type: 'file-chunk',
                transferId: chunk.transfer_id,
                chunkIndex: chunk.chunk_index,
                data: chunk.data,
                checksum: chunk.checksum,
            });

            // Small delay to prevent overwhelming the channel
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /**
     * Start screen sharing
     * @param {string} peerId 
     */
    async startScreenShare(peerId) {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false,
            });

            // Store the local stream so we can negotiate when a peer accepts
            this.localScreenShares.set(peerId, stream);

            const connection = this.connections.get(peerId);
            if (connection) {
                stream.getTracks().forEach(track => {
                    connection.addTrack(track, stream);
                });
            }

            // Notify peer (invite)
            await api.sendSignalingMessage(peerId, {
                type: 'ScreenShareInvite',
                from: this.localDeviceId,
                to: peerId,
                session_id: await api.generateUuid(),
            });

            return stream;
        } catch (error) {
            console.error('Failed to start screen share:', error);
            throw error;
        }
    }

    /**
     * Stop screen sharing
     * @param {string} peerId 
     */
    stopScreenShare(peerId) {
        // Stop remote-view streams
        const stream = this.mediaStreams.get(peerId);
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            this.mediaStreams.delete(peerId);
        }

        // Stop local screen shares (host) if present
        const local = this.localScreenShares.get(peerId);
        if (local) {
            local.getTracks().forEach(track => track.stop());
            this.localScreenShares.delete(peerId);
        }
    }

    /**
     * Disconnect from a peer
     * @param {string} peerId 
     */
    disconnect(peerId) {
        // Close data channel
        const channel = this.dataChannels.get(peerId);
        if (channel) {
            channel.close();
            this.dataChannels.delete(peerId);
        }

        // Stop media streams
        this.stopScreenShare(peerId);

        // Close connection
        const connection = this.connections.get(peerId);
        if (connection) {
            connection.close();
            this.connections.delete(peerId);
        }

        this.pendingCandidates.delete(peerId);
    }

    /**
     * Disconnect from all peers
     */
    disconnectAll() {
        for (const peerId of this.connections.keys()) {
            this.disconnect(peerId);
        }
    }

    /**
     * Check if connected to a peer
     * @param {string} peerId 
     * @returns {boolean}
     */
    isConnected(peerId) {
        const connection = this.connections.get(peerId);
        return connection?.connectionState === 'connected';
    }

    /**
     * Get all connected peer IDs
     * @returns {string[]}
     */
    getConnectedPeers() {
        const connected = [];
        for (const [peerId, connection] of this.connections) {
            if (connection.connectionState === 'connected') {
                connected.push(peerId);
            }
        }
        return connected;
    }
}

// Singleton instance
export const webrtc = new WebRTCManager();
