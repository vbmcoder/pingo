// src-tauri/src/signaling.rs
// WebRTC Signaling Bridge for Pingo
// Handles SDP/ICE exchange for peer-to-peer connections

use crossbeam_channel::{unbounded, Receiver, Sender};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;

const BUFFER_SIZE: usize = 65535;

/// Signaling message types for WebRTC connection setup
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SignalingMessage {
    /// SDP Offer from initiator
    Offer {
        from: String,
        to: String,
        sdp: String,
        session_id: String,
    },
    /// SDP Answer from responder
    Answer {
        from: String,
        to: String,
        sdp: String,
        session_id: String,
    },
    /// ICE Candidate for NAT traversal
    IceCandidate {
        from: String,
        to: String,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u32>,
        session_id: String,
    },
    /// Connection request
    ConnectionRequest {
        from: String,
        to: String,
        session_id: String,
    },
    /// Connection accepted
    ConnectionAccepted {
        from: String,
        to: String,
        session_id: String,
    },
    /// Connection rejected
    ConnectionRejected {
        from: String,
        to: String,
        session_id: String,
        reason: String,
    },
    /// Screen share invite
    ScreenShareInvite {
        from: String,
        to: String,
        session_id: String,
    },
    /// Screen share response
    ScreenShareResponse {
        from: String,
        to: String,
        session_id: String,
        accepted: bool,
    },
    /// Screen share ended (host closed the meeting)
    ScreenShareEnded {
        from: String,
        to: String,
        session_id: String,
    },
    /// File transfer request
    FileTransferRequest {
        from: String,
        to: String,
        file_name: String,
        file_size: u64,
        file_type: String,
        transfer_id: String,
    },
    /// File transfer response
    FileTransferResponse {
        from: String,
        to: String,
        transfer_id: String,
        accepted: bool,
    },
    /// Ping for keepalive
    Ping { from: String, timestamp: u64 },
    /// Pong response
    Pong { from: String, timestamp: u64 },
    /// Chat message relay (LAN direct delivery via UDP signaling)
    ChatMessage {
        from: String,
        to: String,
        id: String,
        content: String,
        message_type: String,
        sender_name: String,
        timestamp: String,
    },
    /// Delivery acknowledgement from receiver to sender
    DeliveryAck {
        from: String,
        to: String,
        message_id: String,
    },
    /// Profile update broadcast
    ProfileUpdate {
        from: String,
        to: String,
        username: String,
        avatar_url: Option<String>,
        avatar_file_id: Option<String>,
        avatar_file_port: Option<u16>,
        bio: Option<String>,
        designation: Option<String>,
    },
    /// Group created / shared with peer
    GroupCreated {
        from: String,
        to: String,
        id: String,
        name: String,
        member_ids: Vec<String>,
        member_names: Vec<String>,
        created_at: String,
    },
    /// Group chat message relay (separate from DM)
    GroupChatMessage {
        from: String,
        to: String,
        group_id: String,
        id: String,
        content: String,
        message_type: String,
        sender_name: String,
        timestamp: String,
    },
    /// Meeting chat message (ephemeral, NOT stored in DB)
    MeetingChatMessage {
        from: String,
        to: String,
        session_id: String,
        id: String,
        content: String,
        sender_name: String,
        timestamp: String,
    },
    /// Group member added notification
    GroupMemberAdded {
        from: String,
        to: String,
        group_id: String,
        user_id: String,
        username: String,
    },
    /// Group member removed notification
    GroupMemberRemoved {
        from: String,
        to: String,
        group_id: String,
        user_id: String,
    },

    // ─── Meeting signaling (WebRTC-based meetings) ────────────
    /// Invite to a meeting
    MeetingInvite {
        from: String,
        to: String,
        meeting_id: String,
        host_name: String,
    },
    /// Response to meeting invite (accept/decline)
    MeetingInviteResponse {
        from: String,
        to: String,
        meeting_id: String,
        accepted: bool,
        #[serde(default)]
        username: Option<String>,
    },
    /// WebRTC SDP Offer for meeting
    MeetingOffer {
        from: String,
        to: String,
        meeting_id: String,
        sdp: String,
    },
    /// WebRTC SDP Answer for meeting
    MeetingAnswer {
        from: String,
        to: String,
        meeting_id: String,
        sdp: String,
    },
    /// WebRTC ICE Candidate for meeting
    MeetingIceCandidate {
        from: String,
        to: String,
        meeting_id: String,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u32>,
    },
    /// Meeting chat message (ephemeral, via signaling fallback)
    MeetingChat {
        from: String,
        to: String,
        meeting_id: String,
        chat: serde_json::Value,
    },
    /// Participant left meeting
    MeetingLeave {
        from: String,
        to: String,
        meeting_id: String,
    },
    /// Host ended meeting
    MeetingEnded {
        from: String,
        to: String,
        meeting_id: String,
    },
    /// Screen share status in meeting
    MeetingScreenShare {
        from: String,
        to: String,
        meeting_id: String,
        sharing: bool,
    },
    /// Selective screen share invite within meeting
    MeetingScreenShareInvite {
        from: String,
        to: String,
        meeting_id: String,
        host_name: String,
    },
    /// Rejoin request with meeting code
    MeetingRejoinRequest {
        from: String,
        to: String,
        meeting_id: String,
        username: String,
    },
    /// Current participant list (sent to rejoiners)
    MeetingParticipantList {
        from: String,
        to: String,
        meeting_id: String,
        participants: Vec<String>,
    },
}

/// Peer connection state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Failed,
}

/// Active peer connection info
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PeerConnection {
    #[allow(dead_code)]
    pub peer_id: String,
    pub address: SocketAddr,
    #[allow(dead_code)]
    pub state: ConnectionState,
    #[allow(dead_code)]
    pub session_id: Option<String>,
}

/// Signaling server for LAN communication
pub struct SignalingServer {
    #[allow(dead_code)]
    device_id: String,
    socket: Arc<RwLock<Option<UdpSocket>>>,
    peers: Arc<RwLock<HashMap<String, PeerConnection>>>,
    event_sender: Sender<SignalingMessage>,
    event_receiver: Receiver<SignalingMessage>,
    running: Arc<RwLock<bool>>,
}

impl SignalingServer {
    /// Create a new signaling server
    pub fn new(device_id: String) -> Self {
        let (sender, receiver) = unbounded();

        SignalingServer {
            device_id,
            socket: Arc::new(RwLock::new(None)),
            peers: Arc::new(RwLock::new(HashMap::new())),
            event_sender: sender,
            event_receiver: receiver,
            running: Arc::new(RwLock::new(false)),
        }
    }

    /// Start the signaling server
    pub fn start(&self, port: u16) -> Result<u16, String> {
        // Bind to UDP socket
        let socket = UdpSocket::bind(format!("0.0.0.0:{}", port))
            .or_else(|_| UdpSocket::bind("0.0.0.0:0"))
            .map_err(|e| e.to_string())?;

        let actual_port = socket.local_addr().map_err(|e| e.to_string())?.port();

        socket.set_nonblocking(true).map_err(|e| e.to_string())?;

        {
            let mut sock = self.socket.write().unwrap();
            *sock = Some(socket.try_clone().map_err(|e| e.to_string())?);
        }

        {
            let mut running = self.running.write().unwrap();
            *running = true;
        }

        // Start listener thread
        let socket_clone = socket;
        let event_sender = self.event_sender.clone();
        let peers = Arc::clone(&self.peers);
        let running = Arc::clone(&self.running);
        let device_id = self.device_id.clone();

        thread::spawn(move || {
            let mut buf = [0u8; BUFFER_SIZE];

            while *running.read().unwrap() {
                match socket_clone.recv_from(&mut buf) {
                    Ok((size, src)) => {
                        if let Ok(text) = std::str::from_utf8(&buf[..size]) {
                            if let Ok(msg) = serde_json::from_str::<SignalingMessage>(text) {
                                // Update peer address
                                let peer_id = match &msg {
                                    SignalingMessage::Offer { from, .. } => Some(from.clone()),
                                    SignalingMessage::Answer { from, .. } => Some(from.clone()),
                                    SignalingMessage::IceCandidate { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::ConnectionRequest { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::Ping { from, .. } => Some(from.clone()),
                                    SignalingMessage::ChatMessage { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::ProfileUpdate { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::GroupChatMessage { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::GroupCreated { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingChatMessage { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::GroupMemberAdded { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::GroupMemberRemoved { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::ScreenShareResponse { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::ScreenShareEnded { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingInvite { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingInviteResponse { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingOffer { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingAnswer { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingIceCandidate { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingChat { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingLeave { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingEnded { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingScreenShare { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingScreenShareInvite { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingRejoinRequest { from, .. } => {
                                        Some(from.clone())
                                    }
                                    SignalingMessage::MeetingParticipantList { from, .. } => {
                                        Some(from.clone())
                                    }
                                    _ => None,
                                };

                                if let Some(id) = peer_id {
                                    if id != device_id {
                                        let mut peers_lock = peers.write().unwrap();

                                        // If we already know this peer's address, DO NOT allow an incoming
                                        // packet from a different source to overwrite it. This prevents
                                        // a remote client from spoofing an existing peer id (for
                                        // example: telling others that the host stopped sharing).
                                        if let Some(existing) = peers_lock.get(&id) {
                                            if existing.address != src {
                                                // Possible spoofing attempt — ignore this message.
                                                println!(
                                                    "[Signaling] Ignoring message for '{}' from {} (expected {})",
                                                    id, src, existing.address
                                                );
                                                // skip forwarding the message to the app
                                                continue;
                                            }
                                        } else {
                                            // First time seeing this peer id — record address
                                            peers_lock.insert(
                                                id.clone(),
                                                PeerConnection {
                                                    peer_id: id.clone(),
                                                    address: src,
                                                    state: ConnectionState::Disconnected,
                                                    session_id: None,
                                                },
                                            );
                                        }
                                    }
                                }

                                // Forward validated message to application
                                let _ = event_sender.send(msg);
                            }
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // No data available, sleep briefly
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        });

        Ok(actual_port)
    }

    /// Stop the signaling server
    #[allow(dead_code)]
    pub fn stop(&self) {
        let mut running = self.running.write().unwrap();
        *running = false;
    }

    /// Send a signaling message to a peer
    pub fn send_message(&self, peer_id: &str, message: &SignalingMessage) -> Result<(), String> {
        let socket = self.socket.read().unwrap();
        let socket = socket.as_ref().ok_or("Socket not initialized")?;

        let peers = self.peers.read().unwrap();
        let peer = peers.get(peer_id).ok_or("Peer not found")?;

        let data = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        socket
            .send_to(&data, peer.address)
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Send a message to a specific address
    #[allow(dead_code)]
    pub fn send_to_address(
        &self,
        addr: SocketAddr,
        message: &SignalingMessage,
    ) -> Result<(), String> {
        let socket = self.socket.read().unwrap();
        let socket = socket.as_ref().ok_or("Socket not initialized")?;

        let data = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        socket.send_to(&data, addr).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Register a peer address
    pub fn register_peer(&self, peer_id: &str, ip: &str, port: u16) -> Result<(), String> {
        let addr: SocketAddr = format!("{}:{}", ip, port)
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?;

        let mut peers = self.peers.write().unwrap();
        peers.insert(
            peer_id.to_string(),
            PeerConnection {
                peer_id: peer_id.to_string(),
                address: addr,
                state: ConnectionState::Disconnected,
                session_id: None,
            },
        );

        Ok(())
    }

    /// Update peer connection state
    #[allow(dead_code)]
    pub fn update_peer_state(&self, peer_id: &str, state: ConnectionState) {
        let mut peers = self.peers.write().unwrap();
        if let Some(peer) = peers.get_mut(peer_id) {
            peer.state = state;
        }
    }

    /// Get event receiver
    #[allow(dead_code)]
    pub fn get_event_receiver(&self) -> Receiver<SignalingMessage> {
        self.event_receiver.clone()
    }

    /// Get a peer by ID
    #[allow(dead_code)]
    pub fn get_peer(&self, peer_id: &str) -> Option<PeerConnection> {
        let peers = self.peers.read().unwrap();
        peers.get(peer_id).cloned()
    }

    /// Get all connected peers
    #[allow(dead_code)]
    pub fn get_connected_peers(&self) -> Vec<String> {
        let peers = self.peers.read().unwrap();
        peers
            .iter()
            .filter(|(_, p)| p.state == ConnectionState::Connected)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/*
WEBRTC SIGNALING FLOW:

┌─────────────────────────────────────────────────────────────────────┐
│                    WEBRTC CONNECTION FLOW                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐                                ┌──────────┐           │
│  │ Peer A   │                                │ Peer B   │           │
│  │(Initiator)│                               │(Responder)│          │
│  └────┬─────┘                                └────┬─────┘           │
│       │                                           │                 │
│       │ 1. ConnectionRequest                      │                 │
│       │   {from, to, session_id}                  │                 │
│       ├──────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 2. ConnectionAccepted                     │                 │
│       │   {from, to, session_id}                  │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│       │ 3. Create RTCPeerConnection               │                 │
│       │    Create DataChannel                     │                 │
│       │    Create Offer (SDP)                     │                 │
│       │                                           │                 │
│       │ 4. Offer                                  │                 │
│       │   {from, to, sdp, session_id}             │                 │
│       ├──────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 5. Create RTCPeerConnection               │
│       │    Set Remote Description                 │
│       │    Create Answer (SDP)                    │
│       │                                           │                 │
│       │ 6. Answer                                 │                 │
│       │   {from, to, sdp, session_id}             │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│       │ 7. ICE Candidates (both directions)       │                 │
│       │   {candidate, sdp_mid, sdp_mline_index}   │                 │
│       │◄─────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 8. DataChannel Open                       │                 │
│       │    (P2P connection established)           │                 │
│       │◄═════════════════════════════════════════►│                 │
│       │                                           │                 │
│                                                                     │
│  LAN MODE:                                                          │
│  - Direct UDP signaling between peers                               │
│  - No STUN/TURN needed (local network)                              │
│  - Fastest connection setup                                         │
│                                                                     │
│  INTERNET MODE (fallback):                                          │
│  - Use public STUN servers for ICE candidates                       │
│  - STUN: stun.l.google.com:19302                                    │
│  - No TURN = no relay (privacy preserved)                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

MESSAGE ACKNOWLEDGMENT FLOW:

┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌──────────┐                                ┌──────────┐           │
│  │ Sender   │                                │ Receiver │           │
│  └────┬─────┘                                └────┬─────┘           │
│       │                                           │                 │
│       │ 1. Send Message                           │                 │
│       │    {id, content, timestamp}               │                 │
│       ├──────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 2. Store in pending_acks                  │                 │
│       │    Start retry timer (5s)                 │                 │
│       │                                           │                 │
│       │ 3. ACK                                    │                 │
│       │    {message_id, status: "delivered"}      │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│       │ 4. Remove from pending_acks               │                 │
│       │    Update message status                  │                 │
│       │                                           │                 │
│       │ 5. Read Receipt (optional)                │                 │
│       │    {message_id, status: "read"}           │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│  RETRY LOGIC:                                                       │
│  - Max 3 retries                                                    │
│  - Exponential backoff: 5s, 10s, 20s                               │
│  - After failure: queue for later                                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
*/
