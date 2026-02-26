// src/lib/meeting_rtc_webrtc.js
// Meeting WebRTC Manager — handles all peer connections, audio, screen sharing,
// data channels, ICE negotiation, and auto-reconnection for the meetings page.

import {
  sendMeetingOffer,
  sendMeetingAnswer,
  sendMeetingIceCandidate,
  sendMeetingScreenShare,
  meetingLog,
} from './meeting_rtc_api';

// ─── Constants ───────────────────────────────────────────────
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
const RECONNECT_DELAY_MS = 3000;

// ═══════════════════════════════════════════════════════════════
//  MeetingRTCManager
// ═══════════════════════════════════════════════════════════════
export default class MeetingRTCManager {
  constructor({ deviceId, meetingId }) {
    this.deviceId = deviceId;
    this.meetingId = meetingId;

    // Maps
    this.peerConnections = new Map();   // peerId → RTCPeerConnection
    this.dataChannels = new Map();      // peerId → RTCDataChannel
    this.audioStreams = new Map();       // peerId → remote audio MediaStream
    this.audioElements = new Map();     // peerId → HTMLAudioElement
    this.pendingCandidates = new Map(); // peerId → RTCIceCandidate[]
    this.reconnectTimers = new Map();   // peerId → timer id

    // Local streams
    this.localAudioStream = null;
    this.localScreenStream = null;

    // ── Event callbacks (set by the component) ───────────────
    this.onRemoteScreen = null;         // (peerId, stream | null) => void
    this.onRemoteAudio = null;          // (peerId, stream | null) => void
    this.onChatMessage = null;          // (msg) => void
    this.onPeerConnected = null;        // (peerId) => void
    this.onPeerDisconnected = null;     // (peerId) => void
    this.onPeerFailed = null;           // (peerId) => void

    this._destroyed = false;
  }

  // ─── Logging shorthand ────────────────────────────────────
  _log(msg, level = 'info') { meetingLog(msg, level); }

  // ─── Update meetingId (for rejoin) ────────────────────────
  setMeetingId(id) { this.meetingId = id; }

  // ═══════════════════════════════════════════════════════════
  //  Peer Connection Lifecycle
  // ═══════════════════════════════════════════════════════════

  createPeerConnection(peerId, initiator = false) {
    // Close existing if any
    const existing = this.peerConnections.get(peerId);
    if (existing) {
      try { existing.close(); } catch { }
    }

    this._log(`Creating PeerConnection to ${peerId.slice(0, 8)}… (initiator=${initiator})`);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 10 });
    this.peerConnections.set(peerId, pc);

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendMeetingIceCandidate(
          peerId, this.deviceId, this.meetingId,
          e.candidate.candidate,
          e.candidate.sdpMid,
          e.candidate.sdpMLineIndex,
        ).catch(err => this._log(`ICE send error → ${peerId.slice(0, 8)}: ${err}`, 'error'));
      }
    };

    pc.onicegatheringstatechange = () => {
      this._log(`ICE gathering state [${peerId.slice(0, 8)}]: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      this._log(`ICE connection state [${peerId.slice(0, 8)}]: ${pc.iceConnectionState}`);
    };

    // Connection state
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this._log(`Connection state [${peerId.slice(0, 8)}]: ${state}`);
      if (state === 'connected') {
        this._clearReconnectTimer(peerId);
        this.onPeerConnected?.(peerId);
      }
      if (state === 'disconnected' || state === 'failed') {
        this.onPeerDisconnected?.(peerId);
        this._scheduleReconnect(peerId);
      }
    };

    // Incoming tracks (audio + video/screen)
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      const track = e.track;
      this._log(`Received ${track.kind} track from ${peerId.slice(0, 8)}`);

      if (track.kind === 'audio') {
        this.audioStreams.set(peerId, stream);
        this._playRemoteAudio(peerId, stream);
        this.onRemoteAudio?.(peerId, stream);
      } else if (track.kind === 'video') {
        this.onRemoteScreen?.(peerId, stream);
      }

      track.onended = () => {
        this._log(`Track ${track.kind} ended from ${peerId.slice(0, 8)}`);
        if (track.kind === 'video') {
          this.onRemoteScreen?.(peerId, null);
        }
      };
    };

    // DataChannel
    if (initiator) {
      const ch = pc.createDataChannel('meeting', { ordered: true });
      this._setupDataChannel(peerId, ch);
    }
    pc.ondatachannel = (e) => this._setupDataChannel(peerId, e.channel);

    // Attach local audio
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach(t => {
        try { pc.addTrack(t, this.localAudioStream); } catch { }
      });
    }
    // Attach local screen
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => {
        try { pc.addTrack(t, this.localScreenStream); } catch { }
      });
    }

    return pc;
  }

  // ─── DataChannel setup ────────────────────────────────────
  _setupDataChannel(peerId, ch) {
    this.dataChannels.set(peerId, ch);
    ch.onopen = () => this._log(`DataChannel open [${peerId.slice(0, 8)}]`);
    ch.onclose = () => {
      this._log(`DataChannel closed [${peerId.slice(0, 8)}]`);
      this.dataChannels.delete(peerId);
    };
    ch.onerror = (e) => this._log(`DataChannel error [${peerId.slice(0, 8)}]: ${e.error}`, 'error');
    ch.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'meeting-chat') {
          this.onChatMessage?.(data);
        }
      } catch { }
    };
  }

  // ─── Audio playback ───────────────────────────────────────
  _playRemoteAudio(peerId, stream) {
    let audio = this.audioElements.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.playsInline = true;
      this.audioElements.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch(() => { });
  }

  // ─── ICE candidate queueing ───────────────────────────────
  queueCandidate(peerId, candidate) {
    const q = this.pendingCandidates.get(peerId) || [];
    q.push(candidate);
    this.pendingCandidates.set(peerId, q);
  }

  async flushCandidates(peerId, pc) {
    const q = this.pendingCandidates.get(peerId) || [];
    for (const c of q) {
      try { await pc.addIceCandidate(c); } catch { }
    }
    this.pendingCandidates.set(peerId, []);
  }

  // ─── Negotiation ──────────────────────────────────────────
  async negotiateWithPeer(peerId) {
    let pc = this.peerConnections.get(peerId);
    if (!pc) pc = this.createPeerConnection(peerId, true);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendMeetingOffer(peerId, this.deviceId, this.meetingId, offer.sdp);
      this._log(`Sent offer → ${peerId.slice(0, 8)}`);
    } catch (err) {
      this._log(`Negotiate failed → ${peerId.slice(0, 8)}: ${err}`, 'error');
    }
  }

  async handleOffer(peerId, sdp) {
    let pc = this.peerConnections.get(peerId);
    if (!pc) pc = this.createPeerConnection(peerId, false);

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await this.flushCandidates(peerId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendMeetingAnswer(peerId, this.deviceId, this.meetingId, answer.sdp);
      this._log(`Sent answer → ${peerId.slice(0, 8)}`);
    } catch (err) {
      this._log(`Handle offer failed [${peerId.slice(0, 8)}]: ${err}`, 'error');
    }
  }

  async handleAnswer(peerId, sdp) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) { this._log(`No PC for answer from ${peerId.slice(0, 8)}`, 'warn'); return; }
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await this.flushCandidates(peerId, pc);
      this._log(`Processed answer from ${peerId.slice(0, 8)}`);
    } catch (err) {
      this._log(`Handle answer failed [${peerId.slice(0, 8)}]: ${err}`, 'error');
    }
  }

  async handleIceCandidate(peerId, candidateStr, sdpMid, sdpMLineIndex) {
    const pc = this.peerConnections.get(peerId);
    const candidate = new RTCIceCandidate({
      candidate: candidateStr,
      sdpMid: sdpMid,
      sdpMLineIndex: sdpMLineIndex,
    });
    if (pc && pc.remoteDescription) {
      try { await pc.addIceCandidate(candidate); } catch { }
    } else {
      this.queueCandidate(peerId, candidate);
    }
  }

  // ─── Reconnection ─────────────────────────────────────────
  _scheduleReconnect(peerId) {
    if (this._destroyed) return;
    if (this.reconnectTimers.has(peerId)) return;
    this._log(`Scheduling reconnect to ${peerId.slice(0, 8)} in ${RECONNECT_DELAY_MS}ms`);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(peerId);
      const pc = this.peerConnections.get(peerId);
      if (!pc || pc.connectionState === 'connected') return;
      this._log(`Reconnecting to ${peerId.slice(0, 8)}…`);
      await this.negotiateWithPeer(peerId);
    }, RECONNECT_DELAY_MS);
    this.reconnectTimers.set(peerId, timer);
  }

  _clearReconnectTimer(peerId) {
    const t = this.reconnectTimers.get(peerId);
    if (t) { clearTimeout(t); this.reconnectTimers.delete(peerId); }
  }

  // ═══════════════════════════════════════════════════════════
  //  Audio
  // ═══════════════════════════════════════════════════════════

  async acquireAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.localAudioStream = stream;
      this._log('Microphone acquired');
      return stream;
    } catch (err) {
      this._log(`Microphone error: ${err}`, 'error');
      return null;
    }
  }

  releaseAudio() {
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach(t => t.stop());
      this.localAudioStream = null;
    }
  }

  toggleMic(enabled) {
    if (this.localAudioStream) {
      this.localAudioStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
      this._log(`Mic ${enabled ? 'unmuted' : 'muted'}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Screen Sharing
  // ═══════════════════════════════════════════════════════════

  async startScreenShare(targetPeerIds) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', displaySurface: 'monitor', frameRate: 30 },
        audio: false,
      });
      this.localScreenStream = stream;
      this._log('Screen sharing started');

      // Add track ended handler
      stream.getVideoTracks()[0].onended = () => {
        this._log('Screen share track ended (user stopped from browser UI)');
        this.stopScreenShare(targetPeerIds);
      };

      // Add tracks to target peer connections & renegotiate
      const targets = targetPeerIds || Array.from(this.peerConnections.keys());
      for (const pid of targets) {
        const pc = this.peerConnections.get(pid);
        if (pc) {
          stream.getTracks().forEach(t => {
            try { pc.addTrack(t, stream); } catch { }
          });
          // Renegotiate
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await sendMeetingOffer(pid, this.deviceId, this.meetingId, offer.sdp);
          } catch (err) {
            this._log(`Renegotiate after screen share failed [${pid.slice(0, 8)}]: ${err}`, 'error');
          }
        }
      }

      // Notify peers
      for (const pid of targets) {
        try {
          await sendMeetingScreenShare(pid, this.deviceId, this.meetingId, true);
        } catch { }
      }

      return stream;
    } catch (err) {
      this._log(`Screen share failed: ${err}`, 'error');
      return null;
    }
  }

  stopScreenShare(targetPeerIds) {
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }

    // Remove video senders from all peer connections
    for (const [, pc] of this.peerConnections) {
      const senders = pc.getSenders();
      senders.forEach(s => {
        if (s.track?.kind === 'video') {
          try { pc.removeTrack(s); } catch { }
        }
      });
    }

    // Notify peers
    const targets = targetPeerIds || Array.from(this.peerConnections.keys());
    for (const pid of targets) {
      sendMeetingScreenShare(pid, this.deviceId, this.meetingId, false).catch(() => { });
    }

    this._log('Screen sharing stopped');
  }

  // ═══════════════════════════════════════════════════════════
  //  Chat via DataChannel
  // ═══════════════════════════════════════════════════════════

  sendChatViaDataChannels(msg) {
    const payload = JSON.stringify({ type: 'meeting-chat', ...msg });
    let sent = 0;
    for (const [, ch] of this.dataChannels) {
      try {
        if (ch.readyState === 'open') { ch.send(payload); sent++; }
      } catch { }
    }
    this._log(`Chat sent via DC to ${sent} peers`);
    return sent;
  }

  // ═══════════════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════════════

  cleanupPeer(peerId) {
    this._log(`Cleaning up peer ${peerId.slice(0, 8)}`);
    const pc = this.peerConnections.get(peerId);
    if (pc) { try { pc.close(); } catch { } }
    this.peerConnections.delete(peerId);
    this.dataChannels.delete(peerId);
    this.audioStreams.delete(peerId);
    this.pendingCandidates.delete(peerId);
    const audio = this.audioElements.get(peerId);
    if (audio) { audio.srcObject = null; this.audioElements.delete(peerId); }
    this._clearReconnectTimer(peerId);
  }

  destroy() {
    this._destroyed = true;
    this._log('Destroying MeetingRTCManager');
    this.releaseAudio();
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }
    for (const [pid] of this.peerConnections) {
      this.cleanupPeer(pid);
    }
    for (const [, audio] of this.audioElements) {
      audio.srcObject = null;
    }
    this.audioElements.clear();
    for (const [, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }

  // ─── Debug info ───────────────────────────────────────────
  getDebugInfo() {
    const conns = {};
    for (const [pid, pc] of this.peerConnections) {
      conns[pid.slice(0, 8)] = {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState,
      };
    }
    return {
      meetingId: this.meetingId,
      peerCount: this.peerConnections.size,
      dataChannels: this.dataChannels.size,
      hasLocalAudio: !!this.localAudioStream,
      hasLocalScreen: !!this.localScreenStream,
      connections: conns,
    };
  }
}
