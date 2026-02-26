// src/pages/meetings.jsx
// Meetings page — WebRTC screen sharing + audio + meeting chat
// Google Meet / Teams-like interface with invite, rejoin, selective sharing
//
// Libraries:
//   meeting_rtc_api.js   — signaling helpers, localStorage chat, log system
//   meeting_rtc_webrtc.js — WebRTC PeerConnection manager

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import UserAvatar from '../components/UserAvatar';
import MeetingRTCManager from '../lib/meeting_rtc_webrtc';
import {
  MSG,
  sendMeetingInvite,
  sendMeetingInviteResponse,
  sendMeetingChat,
  sendMeetingLeave,
  sendMeetingEnded,
  sendMeetingScreenShareInvite,
  sendMeetingRejoinRequest,
  sendMeetingParticipantList,
  broadcastMeeting,
  loadMeetingChat,
  saveMeetingChat,
  clearMeetingChat,
  generateMeetingId,
  onSignalingMessage,
  meetingLog,
  onMeetingLog,
  isMeetingSignal,
} from '../lib/meeting_rtc_api';

// ─── Simple ID generator ─────────────────────────────────────
let _idCounter = 0;
function localId() { return `m_${Date.now()}_${++_idCounter}`; }

// ═══════════════════════════════════════════════════════════════
//  MeetingsPage
// ═══════════════════════════════════════════════════════════════
export default function MeetingsPage() {
  const { localUser, deviceId, allUsers, peers } = useAppContext();
  const location = useLocation();

  // ─── State ──────────────────────────────────────────────────
  const [view, setView] = useState('lobby'); // lobby | meeting
  const [meetingId, setMeetingId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState([]); // { peerId, username }
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [selectedPeersForShare, setSelectedPeersForShare] = useState([]);
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [joinCode, setJoinCode] = useState('');
  const [screenStream, setScreenStream] = useState(null);
  const [remoteScreens, setRemoteScreens] = useState(new Map());
  const [focusedScreen, setFocusedScreen] = useState(null);
  const [logs, setLogs] = useState([]);

  // ─── Refs ───────────────────────────────────────────────────
  const chatEndRef = useRef(null);
  const logsEndRef = useRef(null);
  const meetingIdRef = useRef('');
  const isHostRef = useRef(false);
  const participantsRef = useRef([]);
  const rtcRef = useRef(null); // MeetingRTCManager instance

  // Keep refs synced
  useEffect(() => { meetingIdRef.current = meetingId; }, [meetingId]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);

  // Online peers lookup
  const onlinePeers = useMemo(() =>
    (allUsers || []).filter(u => u.is_online && u.id !== deviceId),
    [allUsers, deviceId]
  );

  const peerNameMap = useMemo(() => {
    const m = {};
    (allUsers || []).forEach(u => { m[u.id || u.device_id] = u.username || 'User'; });
    return m;
  }, [allUsers]);

  // ─── Live log listener ─────────────────────────────────────
  useEffect(() => {
    const unsub = onMeetingLog(entry => {
      setLogs(prev => [...prev.slice(-200), entry]);
    });
    return unsub;
  }, []);

  // ─── Toast helper ──────────────────────────────────────────
  const showToast = useCallback((message, type = 'info') => {
    const id = localId();
    setToasts(prev => [...prev.slice(-3), { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // ─── Init / destroy RTC manager ──────────────────────────
  const initRTC = useCallback((mid) => {
    if (rtcRef.current) rtcRef.current.destroy();
    const mgr = new MeetingRTCManager({ deviceId, meetingId: mid });

    mgr.onRemoteScreen = (peerId, stream) => {
      if (stream) {
        setRemoteScreens(prev => { const n = new Map(prev); n.set(peerId, stream); return n; });
        setFocusedScreen(prev => prev || peerId);
        meetingLog(`Remote screen from ${peerId.slice(0, 8)}`);
      } else {
        setRemoteScreens(prev => { const n = new Map(prev); n.delete(peerId); return n; });
        setFocusedScreen(prev => prev === peerId ? null : prev);
      }
    };

    mgr.onChatMessage = (data) => {
      const msg = { sender: data.sender, senderName: data.senderName, text: data.text, timestamp: data.timestamp };
      setChatMessages(prev => {
        if (prev.find(m => m.timestamp === msg.timestamp && m.sender === msg.sender)) return prev;
        const next = [...prev, msg];
        saveMeetingChat(meetingIdRef.current, next);
        return next;
      });
    };

    mgr.onPeerConnected = (peerId) => {
      meetingLog(`Peer connected: ${peerId.slice(0, 8)}`);
    };

    mgr.onPeerDisconnected = (peerId) => {
      meetingLog(`Peer disconnected: ${peerId.slice(0, 8)}`, 'warn');
    };

    rtcRef.current = mgr;
    return mgr;
  }, [deviceId]);

  // ─── Broadcast meeting message via signaling ───────────────
  const broadcastMeetingMsg = useCallback(async (type, payload = {}, targetPeers = null) => {
    const targets = targetPeers || participantsRef.current.map(p => p.peerId);
    const errors = await broadcastMeeting(type, payload, targets, deviceId, meetingIdRef.current);
    if (errors.length) meetingLog(`Broadcast ${type} failed for ${errors.length} peer(s)`, 'warn');
  }, [deviceId]);

  // ─── Send chat via DataChannels + signaling fallback ───────
  const sendChatToAll = useCallback(async (msg) => {
    const mgr = rtcRef.current;
    if (mgr) mgr.sendChatViaDataChannels(msg);
    // Signaling fallback
    const targets = participantsRef.current.map(p => p.peerId);
    for (const pid of targets) {
      try { await sendMeetingChat(pid, deviceId, meetingIdRef.current, msg); } catch { }
    }
  }, [deviceId]);

  // ─── Negotiate with a peer ────────────────────────────────
  const negotiateWithPeer = useCallback(async (peerId) => {
    const mgr = rtcRef.current;
    if (!mgr) return;
    await mgr.negotiateWithPeer(peerId);
  }, []);

  // ─── Handle signaling messages ─────────────────────────────
  useEffect(() => {
    const unsub = onSignalingMessage(async (msg) => {
      if (!msg || !isMeetingSignal(msg)) return;
      if (msg.from === deviceId) return;

      meetingLog(`← ${msg.type} from ${(msg.from || '').slice(0, 8)}`);

      // Meeting invite
      if (msg.type === MSG.INVITE) {
        setPendingInvites(prev => {
          if (prev.find(i => i.meeting_id === msg.meeting_id && i.from === msg.from)) return prev;
          return [...prev, msg];
        });
        showToast(`${peerNameMap[msg.from] || 'Someone'} invited you to a meeting`, 'info');
        try {
          const { showScreenShareInvite } = await import('../lib/notifications.js');
          showScreenShareInvite(peerNameMap[msg.from] || 'Someone');
        } catch { }
        return;
      }

      // Meeting invite response
      if (msg.type === MSG.INVITE_RESPONSE && msg.meeting_id === meetingIdRef.current) {
        if (msg.accepted) {
          showToast(`${peerNameMap[msg.from] || 'User'} joined the meeting`, 'success');
          setParticipants(prev => {
            if (prev.find(p => p.peerId === msg.from)) return prev;
            return [...prev, { peerId: msg.from, username: msg.username || peerNameMap[msg.from] || 'User' }];
          });
          await negotiateWithPeer(msg.from);
        } else {
          showToast(`${peerNameMap[msg.from] || 'User'} declined the invite`, 'error');
        }
        return;
      }

      // Meeting offer
      if (msg.type === MSG.OFFER && msg.meeting_id === meetingIdRef.current) {
        const mgr = rtcRef.current;
        if (!mgr) return;
        // Ensure peer connection exists
        if (!mgr.peerConnections.has(msg.from)) mgr.createPeerConnection(msg.from, false);
        await mgr.handleOffer(msg.from, msg.sdp);
        setParticipants(prev => {
          if (prev.find(p => p.peerId === msg.from)) return prev;
          return [...prev, { peerId: msg.from, username: peerNameMap[msg.from] || 'User' }];
        });
        return;
      }

      // Meeting answer
      if (msg.type === MSG.ANSWER && msg.meeting_id === meetingIdRef.current) {
        const mgr = rtcRef.current;
        if (mgr) await mgr.handleAnswer(msg.from, msg.sdp);
        return;
      }

      // Meeting ICE candidate
      if (msg.type === MSG.ICE_CANDIDATE && msg.meeting_id === meetingIdRef.current) {
        const mgr = rtcRef.current;
        if (mgr) await mgr.handleIceCandidate(msg.from, msg.candidate, msg.sdp_mid, msg.sdp_mline_index);
        return;
      }

      // Meeting chat via signaling fallback
      if (msg.type === MSG.CHAT && msg.meeting_id === meetingIdRef.current && msg.chat) {
        const chatMsg = msg.chat;
        setChatMessages(prev => {
          if (prev.find(m => m.timestamp === chatMsg.timestamp && m.sender === chatMsg.sender)) return prev;
          const next = [...prev, chatMsg];
          saveMeetingChat(meetingIdRef.current, next);
          return next;
        });
        return;
      }

      // Participant left
      if (msg.type === MSG.LEAVE && msg.meeting_id === meetingIdRef.current) {
        showToast(`${peerNameMap[msg.from] || 'User'} left the meeting`);
        const mgr = rtcRef.current;
        if (mgr) mgr.cleanupPeer(msg.from);
        setParticipants(prev => prev.filter(p => p.peerId !== msg.from));
        setRemoteScreens(prev => { const n = new Map(prev); n.delete(msg.from); return n; });
        setFocusedScreen(prev => prev === msg.from ? null : prev);
        return;
      }

      // Meeting ended by host
      if (msg.type === MSG.ENDED && msg.meeting_id === meetingIdRef.current) {
        showToast('Meeting ended by host', 'error');
        leaveMeeting(true);
        return;
      }

      // Screen share notification
      if (msg.type === MSG.SCREEN_SHARE && msg.meeting_id === meetingIdRef.current) {
        if (msg.sharing) {
          showToast(`${peerNameMap[msg.from] || 'User'} started screen sharing`);
          await negotiateWithPeer(msg.from);
        } else {
          // Defensive: only honour "stop" if we currently have that peer's screen.
          // This mitigates spoofed "stop" notifications from other participants.
          setRemoteScreens(prev => {
            if (!prev.has(msg.from)) {
              meetingLog(`Ignored spoofed SCREEN_SHARE stop from ${msg.from.slice(0, 8)}`, 'warn');
              return prev;
            }
            const n = new Map(prev); n.delete(msg.from); return n;
          });
          setFocusedScreen(prev => prev === msg.from ? null : prev);
          showToast(`${peerNameMap[msg.from] || 'User'} stopped screen sharing`);
        }
        return;
      }

      // Selective screen share invite
      if (msg.type === MSG.SCREEN_SHARE_INVITE) {
        setPendingInvites(prev => {
          if (prev.find(i => i.meeting_id === msg.meeting_id && i.type === MSG.SCREEN_SHARE_INVITE && i.from === msg.from)) return prev;
          return [...prev, msg];
        });
        showToast(`${peerNameMap[msg.from] || 'Someone'} wants to share screen with you`, 'info');
        return;
      }

      // Rejoin request — someone is trying to join via code
      if (msg.type === MSG.REJOIN_REQUEST && msg.meeting_id === meetingIdRef.current) {
        meetingLog(`Rejoin request from ${msg.username || msg.from.slice(0, 8)}`);
        setParticipants(prev => {
          if (prev.find(p => p.peerId === msg.from)) return prev;
          return [...prev, { peerId: msg.from, username: msg.username || peerNameMap[msg.from] || 'User' }];
        });
        showToast(`${msg.username || peerNameMap[msg.from] || 'User'} joined`, 'success');
        await negotiateWithPeer(msg.from);
        // Send back participant list
        const currentParts = participantsRef.current.map(p => p.peerId);
        try {
          await sendMeetingParticipantList(msg.from, deviceId, meetingIdRef.current, currentParts);
        } catch { }
        return;
      }

      // Participant list (for rejoiners)
      if (msg.type === MSG.PARTICIPANT_LIST && msg.meeting_id === meetingIdRef.current) {
        meetingLog(`Received participant list: ${(msg.participants || []).length} peers`);
        const peerIds = msg.participants || [];
        for (const pid of peerIds) {
          if (pid === deviceId) continue;
          setParticipants(prev => {
            if (prev.find(p => p.peerId === pid)) return prev;
            return [...prev, { peerId: pid, username: peerNameMap[pid] || 'User' }];
          });
          const mgr = rtcRef.current;
          if (mgr && !mgr.peerConnections.has(pid)) {
            await mgr.negotiateWithPeer(pid);
          }
        }
        return;
      }
    });

    return () => { unsub.then?.(fn => fn?.()); };
  }, [deviceId, peerNameMap, showToast, negotiateWithPeer]);

  // ─── Handle auto-accept from NotificationCenter ────────────
  useEffect(() => {
    const autoAcceptInvite = location.state?.autoAcceptInvite;
    if (autoAcceptInvite && autoAcceptInvite.meeting_id) {
      handleAcceptInvite(autoAcceptInvite);
    }

    const handler = (e) => {
      const invite = e.detail;
      if (invite?.meeting_id) handleAcceptInvite(invite);
    };
    window.addEventListener('meeting-invite-accepted', handler);
    return () => window.removeEventListener('meeting-invite-accepted', handler);
  }, [location.state]);

  // ─── Auto scroll chat & logs ──────────────────────────────
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  // ─── Cleanup on unmount ───────────────────────────────────
  useEffect(() => {
    return () => {
      if (meetingIdRef.current) {
        const targets = participantsRef.current.map(p => p.peerId);
        broadcastMeeting(MSG.LEAVE, {}, targets, deviceId, meetingIdRef.current);
      }
      if (rtcRef.current) rtcRef.current.destroy();
    };
  }, []);

  // ─── Cleanup a single peer ────────────────────────────────
  const cleanupPeer = useCallback((peerId) => {
    const mgr = rtcRef.current;
    if (mgr) mgr.cleanupPeer(peerId);
    setParticipants(prev => prev.filter(p => p.peerId !== peerId));
    setRemoteScreens(prev => { const n = new Map(prev); n.delete(peerId); return n; });
    setFocusedScreen(prev => prev === peerId ? null : prev);
  }, []);

  // ─── Cleanup all ──────────────────────────────────────────
  const cleanupAll = useCallback(() => {
    if (rtcRef.current) rtcRef.current.destroy();
    rtcRef.current = null;
    setRemoteScreens(new Map());
    setFocusedScreen(null);
    setScreenStream(null);
    setIsScreenSharing(false);
  }, []);

  // ─── Create Meeting (Host) ────────────────────────────────
  const createMeeting = useCallback(async () => {
    const id = await generateMeetingId();
    meetingLog(`Creating meeting ${id.slice(0, 8)}…`);
    setMeetingId(id);
    meetingIdRef.current = id;
    setIsHost(true);
    isHostRef.current = true;
    setView('meeting');
    setParticipants([]);
    setChatMessages([]);
    setLogs([]);
    const mgr = initRTC(id);
    await mgr.acquireAudio();
    showToast('Meeting created! Invite others to join.', 'success');
  }, [initRTC, showToast]);

  // ─── Join Meeting by Code ─────────────────────────────────
  const joinMeetingByCode = useCallback(async (code) => {
    if (!code?.trim()) return;
    const trimmed = code.trim();
    meetingLog(`Joining meeting by code: ${trimmed.slice(0, 8)}…`);
    setMeetingId(trimmed);
    meetingIdRef.current = trimmed;
    setIsHost(false);
    isHostRef.current = false;
    setView('meeting');
    setParticipants([]);
    setChatMessages(loadMeetingChat(trimmed));
    setLogs([]);
    const mgr = initRTC(trimmed);
    await mgr.acquireAudio();

    // Broadcast rejoin request to ALL online peers — whoever has this meeting will respond
    let sentCount = 0;
    for (const peer of onlinePeers) {
      const pid = peer.id || peer.device_id;
      try {
        await sendMeetingRejoinRequest(pid, deviceId, trimmed, localUser?.username || 'User');
        sentCount++;
      } catch (err) {
        meetingLog(`Rejoin request failed → ${pid.slice(0, 8)}: ${err}`, 'warn');
      }
    }

    meetingLog(`Sent rejoin requests to ${sentCount} online peer(s)`);
    showToast(sentCount > 0 ? 'Joining meeting…' : 'No online peers found. Share the code with others.', sentCount > 0 ? 'info' : 'error');
  }, [initRTC, deviceId, localUser, onlinePeers, showToast]);

  // ─── Accept meeting invite ────────────────────────────────
  const handleAcceptInvite = useCallback(async (invite) => {
    const mid = invite.meeting_id;
    meetingLog(`Accepting invite to meeting ${mid.slice(0, 8)} from ${(invite.from || '').slice(0, 8)}`);
    setPendingInvites(prev => prev.filter(i => !(i.meeting_id === mid && i.from === invite.from)));

    setMeetingId(mid);
    meetingIdRef.current = mid;
    setIsHost(false);
    isHostRef.current = false;
    setView('meeting');
    setParticipants([]);
    setChatMessages(loadMeetingChat(mid));
    setLogs([]);
    const mgr = initRTC(mid);
    await mgr.acquireAudio();

    setParticipants([{ peerId: invite.from, username: peerNameMap[invite.from] || invite.host_name || 'User' }]);

    try {
      await sendMeetingInviteResponse(invite.from, deviceId, mid, true, localUser?.username || 'User');
      meetingLog(`Sent invite response (accepted) → ${invite.from.slice(0, 8)}`);
    } catch (err) {
      meetingLog(`Failed to send invite response: ${err}`, 'error');
    }

    showToast('Joined meeting!', 'success');
  }, [initRTC, deviceId, localUser, peerNameMap, showToast]);

  // ─── Decline meeting invite ───────────────────────────────
  const handleDeclineInvite = useCallback(async (invite) => {
    setPendingInvites(prev => prev.filter(i => !(i.meeting_id === invite.meeting_id && i.from === invite.from)));
    try {
      await sendMeetingInviteResponse(invite.from, deviceId, invite.meeting_id, false);
    } catch { }
  }, [deviceId]);

  // ─── Invite peers to meeting ──────────────────────────────
  const invitePeers = useCallback(async (peerIds) => {
    for (const pid of peerIds) {
      try {
        await sendMeetingInvite(pid, deviceId, meetingIdRef.current, localUser?.username || 'User');
        meetingLog(`Sent invite → ${pid.slice(0, 8)}`);
      } catch (err) {
        meetingLog(`Invite failed → ${pid.slice(0, 8)}: ${err}`, 'error');
      }
    }
    setShowInviteModal(false);
    showToast(`Invited ${peerIds.length} user(s)`, 'success');
  }, [deviceId, localUser, showToast]);

  // ─── Leave Meeting ────────────────────────────────────────
  const leaveMeeting = useCallback((silent = false) => {
    meetingLog('Leaving meeting');
    if (!silent) {
      const targets = participantsRef.current.map(p => p.peerId);
      if (isHostRef.current) {
        for (const pid of targets) { sendMeetingEnded(pid, deviceId, meetingIdRef.current).catch(() => { }); }
      } else {
        for (const pid of targets) { sendMeetingLeave(pid, deviceId, meetingIdRef.current).catch(() => { }); }
      }
    }

    clearMeetingChat(meetingIdRef.current);
    cleanupAll();
    setView('lobby');
    setMeetingId('');
    setIsHost(false);
    setParticipants([]);
    setChatMessages([]);
    setIsChatOpen(false);
    setIsParticipantsOpen(false);
    setIsLogsOpen(false);
    setPendingInvites([]);
    showToast('Left the meeting');
  }, [deviceId, cleanupAll, showToast]);

  // ─── Toggle Mic ───────────────────────────────────────────
  const toggleMic = useCallback(() => {
    const mgr = rtcRef.current;
    if (mgr) {
      const newState = !isMicOn;
      mgr.toggleMic(newState);
      setIsMicOn(newState);
    }
  }, [isMicOn]);

  // ─── Start Screen Share ───────────────────────────────────
  const startScreenShare = useCallback(async (targetPeerIds = null) => {
    const mgr = rtcRef.current;
    if (!mgr) return;
    const stream = await mgr.startScreenShare(targetPeerIds);
    if (stream) {
      setScreenStream(stream);
      setIsScreenSharing(true);
      stream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };
      showToast('Screen sharing started');
    } else {
      showToast('Screen share cancelled', 'error');
    }
  }, [showToast]);

  // ─── Stop Screen Share ────────────────────────────────────
  const stopScreenShare = useCallback(() => {
    const mgr = rtcRef.current;
    if (mgr) mgr.stopScreenShare();
    setScreenStream(null);
    setIsScreenSharing(false);
    showToast('Screen sharing stopped');
  }, [showToast]);

  // ─── Selective Screen Share ───────────────────────────────
  const startSelectiveShare = useCallback(async () => {
    if (selectedPeersForShare.length === 0) return;
    setShowSharePicker(false);

    for (const pid of selectedPeersForShare) {
      try {
        await sendMeetingScreenShareInvite(pid, deviceId, meetingIdRef.current, localUser?.username || 'User');
      } catch { }
    }

    await startScreenShare(selectedPeersForShare);
    setSelectedPeersForShare([]);
  }, [selectedPeersForShare, deviceId, localUser, startScreenShare]);

  // ─── Send Chat Message ────────────────────────────────────
  const handleSendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text) return;

    const msg = {
      sender: deviceId,
      senderName: localUser?.username || 'You',
      text,
      timestamp: Date.now(),
    };

    setChatMessages(prev => {
      const next = [...prev, msg];
      saveMeetingChat(meetingIdRef.current, next);
      return next;
    });
    setChatInput('');

    await sendChatToAll(msg);
  }, [chatInput, deviceId, localUser, sendChatToAll]);

  // ─── Copy meeting code ────────────────────────────────────
  const copyMeetingCode = useCallback(() => {
    navigator.clipboard?.writeText(meetingId).then(() => showToast('Meeting code copied!')).catch(() => { });
  }, [meetingId, showToast]);

  // ─── Close any open side panel ────────────────────────────
  const closeSidePanel = useCallback(() => {
    setIsChatOpen(false);
    setIsParticipantsOpen(false);
    setIsLogsOpen(false);
  }, []);

  // ═══════════════════════════════════════════════════════════════
  //  RENDER: Lobby
  // ═══════════════════════════════════════════════════════════════
  if (view === 'lobby') {
    return (
      <div className="mt-page">
        {/* Toasts */}
        <div className="mt-toasts">
          {toasts.map(t => (
            <div key={t.id} className={`mt-toast mt-toast-${t.type}`}>{t.message}</div>
          ))}
        </div>

        {/* Pending Invites */}
        {pendingInvites.length > 0 && (
          <div className="mt-invites-bar">
            {pendingInvites.map(inv => (
              <div key={`${inv.meeting_id}_${inv.from}`} className="mt-invite-card">
                <div className="mt-invite-info">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  <div>
                    <span className="mt-invite-host">{inv.host_name || peerNameMap[inv.from] || 'Someone'}</span>
                    <span className="mt-invite-label">
                      {inv.type === 'MeetingScreenShareInvite' ? ' wants to share screen' : ' invites you to a meeting'}
                    </span>
                  </div>
                </div>
                <div className="mt-invite-actions">
                  <button className="btn-sm btn-secondary" onClick={() => handleDeclineInvite(inv)}>Decline</button>
                  <button className="btn-sm btn-primary" onClick={() => handleAcceptInvite(inv)}>Join</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Main Lobby */}
        <div className="mt-lobby">
          <div className="mt-lobby-hero">
            <div className="mt-lobby-icon">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <h1 className="mt-lobby-title">Meetings</h1>
            <p className="mt-lobby-sub">Share your screen, talk with your team, and collaborate in real-time</p>
          </div>

          <div className="mt-lobby-actions">
            <button className="mt-lobby-btn mt-lobby-btn-create" onClick={createMeeting}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Meeting
            </button>

            <div className="mt-lobby-join">
              <input
                className="mt-join-input"
                placeholder="Enter meeting code..."
                value={joinCode}
                onChange={e => setJoinCode(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && joinMeetingByCode(joinCode)}
              />
              <button className="btn-primary btn-sm" onClick={() => joinMeetingByCode(joinCode)} disabled={!joinCode.trim()}>
                Join
              </button>
            </div>
          </div>

          {/* Online Peers */}
          {onlinePeers.length > 0 && (
            <div className="mt-lobby-peers">
              <h3 className="mt-lobby-peers-title">Online ({onlinePeers.length})</h3>
              <div className="mt-lobby-peers-grid">
                {onlinePeers.map(peer => (
                  <div key={peer.id} className="mt-peer-chip">
                    <UserAvatar name={peer.username} size={28} avatarUrl={peer.avatar_path} />
                    <span>{peer.username || 'User'}</span>
                    <span className="mt-peer-online-dot" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  RENDER: Meeting Room
  // ═══════════════════════════════════════════════════════════════
  const allScreens = new Map(remoteScreens);
  if (screenStream) allScreens.set('local', screenStream);

  const focusStream = focusedScreen
    ? (focusedScreen === 'local' ? screenStream : remoteScreens.get(focusedScreen))
    : (allScreens.size > 0 ? allScreens.values().next().value : null);

  const focusLabel = focusedScreen
    ? (focusedScreen === 'local' ? 'You' : (peerNameMap[focusedScreen] || 'User'))
    : (allScreens.size > 0
      ? (allScreens.keys().next().value === 'local' ? 'You' : (peerNameMap[allScreens.keys().next().value] || 'User'))
      : null);

  return (
    <div className="mt-page mt-page-meeting">
      {/* Toasts */}
      <div className="mt-toasts">
        {toasts.map(t => (
          <div key={t.id} className={`mt-toast mt-toast-${t.type}`}>{t.message}</div>
        ))}
      </div>

      {/* Pending Invites inside meeting */}
      {pendingInvites.length > 0 && (
        <div className="mt-invites-bar mt-invites-bar-meeting">
          {pendingInvites.map(inv => (
            <div key={`${inv.meeting_id}_${inv.from}`} className="mt-invite-card mt-invite-card-compact">
              <span>{peerNameMap[inv.from] || 'User'}
                {inv.type === 'MeetingScreenShareInvite' ? ' wants to share screen' : ' invites you'}
              </span>
              <div className="mt-invite-actions">
                <button className="btn-sm btn-secondary" onClick={() => handleDeclineInvite(inv)}>Decline</button>
                <button className="btn-sm btn-primary" onClick={() => handleAcceptInvite(inv)}>Accept</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="mt-header">
        <div className="mt-header-left">
          <div className="mt-meeting-badge">
            <span className="mt-meeting-dot" />
            <span className="mt-meeting-label">{isHost ? 'Hosting' : 'In Meeting'}</span>
          </div>
          <button className="mt-code-btn" onClick={copyMeetingCode} title="Copy meeting code">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {meetingId.substring(0, 8)}...
          </button>
        </div>
        <div className="mt-header-right">
          <span className="mt-participant-count">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            {participants.length + 1}
          </span>
        </div>
      </div>

      {/* Main Content */}
      <div className="mt-body">
        {/* Video / Screen Area */}
        <div className={`mt-stage ${isChatOpen || isParticipantsOpen || isLogsOpen ? 'mt-stage-shrink' : ''}`}>
          {focusStream ? (
            <div className="mt-stage-main">
              <VideoTile stream={focusStream} label={focusLabel} muted={focusedScreen === 'local'} />
            </div>
          ) : (
            <div className="mt-stage-empty">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <p>No screen being shared</p>
              <span>Click the screen share button to present</span>
            </div>
          )}

          {/* Thumbnail strip */}
          {allScreens.size > 1 && (
            <div className="mt-thumbstrip">
              {Array.from(allScreens.entries()).map(([pid, stream]) => (
                <button
                  key={pid}
                  className={`mt-thumb ${(focusedScreen || allScreens.keys().next().value) === pid ? 'mt-thumb-active' : ''}`}
                  onClick={() => setFocusedScreen(pid)}
                >
                  <VideoTile stream={stream} label={pid === 'local' ? 'You' : (peerNameMap[pid] || 'User')} muted mini />
                </button>
              ))}
            </div>
          )}

          {/* Participant Avatars (when no screen) */}
          {allScreens.size === 0 && (
            <div className="mt-avatars-grid">
              <div className="mt-avatar-tile">
                <UserAvatar name={localUser?.username} size={64} avatarUrl={localUser?.avatar_path} />
                <span className="mt-avatar-name">You {isMicOn && <MicIcon />}</span>
              </div>
              {participants.map(p => (
                <div key={p.peerId} className="mt-avatar-tile">
                  <UserAvatar name={p.username} size={64} avatarUrl={(allUsers || []).find(u => u.id === p.peerId)?.avatar_path} />
                  <span className="mt-avatar-name">{p.username}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Side Panel: Chat, Participants, or Logs */}
        {(isChatOpen || isParticipantsOpen || isLogsOpen) && (
          <div className="mt-sidepanel">
            <div className="mt-sidepanel-header">
              <span className="mt-sidepanel-title">{isChatOpen ? 'Meeting Chat' : isParticipantsOpen ? 'Participants' : 'Debug Logs'}</span>
              <button className="icon-btn-sm" onClick={closeSidePanel}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {isChatOpen && (
              <div className="mt-chat-panel">
                <div className="mt-chat-messages">
                  {chatMessages.length === 0 && (
                    <div className="mt-chat-empty">
                      <p>No messages yet</p>
                      <span>Chat messages are temporary and will be cleared after the meeting ends.</span>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`mt-chat-msg ${msg.sender === deviceId ? 'mt-chat-msg-self' : ''}`}>
                      <span className="mt-chat-sender">{msg.sender === deviceId ? 'You' : msg.senderName}</span>
                      <span className="mt-chat-text">{msg.text}</span>
                      <span className="mt-chat-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <div className="mt-chat-input-row">
                  <input
                    className="mt-chat-input"
                    placeholder="Type a message..."
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                  />
                  <button className="mt-chat-send" onClick={handleSendChat} disabled={!chatInput.trim()}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {isParticipantsOpen && (
              <div className="mt-participants-panel">
                <div className="mt-participant-row">
                  <UserAvatar name={localUser?.username} size={32} avatarUrl={localUser?.avatar_path} />
                  <div className="mt-participant-info">
                    <span className="mt-participant-name">{localUser?.username || 'You'} (You)</span>
                    <span className="mt-participant-role">{isHost ? 'Host' : 'Participant'}</span>
                  </div>
                  {isMicOn ? <MicIcon /> : <MicOffIcon />}
                </div>
                {participants.map(p => (
                  <div key={p.peerId} className="mt-participant-row">
                    <UserAvatar name={p.username} size={32} avatarUrl={(allUsers || []).find(u => u.id === p.peerId)?.avatar_path} />
                    <div className="mt-participant-info">
                      <span className="mt-participant-name">{p.username}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {isLogsOpen && (
              <div className="mt-logs-panel">
                <div className="mt-logs-toolbar">
                  <span className="mt-logs-count">{logs.length} entries</span>
                  <button className="btn-sm btn-secondary" onClick={() => setLogs([])}>Clear</button>
                </div>
                <div className="mt-logs-messages">
                  {logs.length === 0 && (
                    <div className="mt-chat-empty">
                      <p>No logs yet</p>
                      <span>Meeting events, WebRTC states, and errors will appear here in real-time.</span>
                    </div>
                  )}
                  {logs.map((entry, i) => (
                    <div key={i} className={`mt-log-entry mt-log-${entry.level}`}>
                      <span className="mt-log-time">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      <span className={`mt-log-level mt-log-level-${entry.level}`}>{entry.level.toUpperCase()}</span>
                      <span className="mt-log-msg">{entry.message}</span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Control Bar */}
      <div className="mt-controls">
        <div className="mt-controls-group">
          <button className={`mt-ctrl-btn ${!isMicOn ? 'mt-ctrl-btn-off' : ''}`} onClick={toggleMic} title={isMicOn ? 'Mute' : 'Unmute'}>
            {isMicOn ? <MicIcon /> : <MicOffIcon />}
            <span>{isMicOn ? 'Mute' : 'Unmute'}</span>
          </button>

          <button
            className={`mt-ctrl-btn ${isScreenSharing ? 'mt-ctrl-btn-active' : ''}`}
            onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
            title="Share Screen"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>{isScreenSharing ? 'Stop Share' : 'Share Screen'}</span>
          </button>

          <button className="mt-ctrl-btn" onClick={() => setShowSharePicker(true)} title="Share to specific people">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            <span>Selective Share</span>
          </button>
        </div>

        <div className="mt-controls-group">
          <button
            className={`mt-ctrl-btn ${isChatOpen ? 'mt-ctrl-btn-active' : ''}`}
            onClick={() => { const v = !isChatOpen; closeSidePanel(); if (v) setIsChatOpen(true); }}
            title="Chat"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Chat</span>
          </button>

          <button
            className={`mt-ctrl-btn ${isParticipantsOpen ? 'mt-ctrl-btn-active' : ''}`}
            onClick={() => { const v = !isParticipantsOpen; closeSidePanel(); if (v) setIsParticipantsOpen(true); }}
            title="Participants"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>People</span>
          </button>

          <button className="mt-ctrl-btn" onClick={() => setShowInviteModal(true)} title="Invite">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
            </svg>
            <span>Invite</span>
          </button>

          <button
            className={`mt-ctrl-btn ${isLogsOpen ? 'mt-ctrl-btn-active' : ''}`}
            onClick={() => { const v = !isLogsOpen; closeSidePanel(); if (v) setIsLogsOpen(true); }}
            title="Debug Logs"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Logs</span>
          </button>
        </div>

        <div className="mt-controls-group">
          <button className="mt-ctrl-btn mt-ctrl-btn-leave" onClick={() => leaveMeeting()} title="Leave">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            <span>{isHost ? 'End Meeting' : 'Leave'}</span>
          </button>
        </div>
      </div>

      {/* Invite Modal */}
      {showInviteModal && (
        <InviteModal
          peers={onlinePeers}
          participants={participants}
          peerNameMap={peerNameMap}
          allUsers={allUsers}
          meetingCode={meetingId}
          onInvite={invitePeers}
          onClose={() => setShowInviteModal(false)}
          onCopy={copyMeetingCode}
        />
      )}

      {/* Selective Share Picker */}
      {showSharePicker && (
        <SelectiveShareModal
          participants={participants}
          peerNameMap={peerNameMap}
          allUsers={allUsers}
          selected={selectedPeersForShare}
          setSelected={setSelectedPeersForShare}
          onShare={startSelectiveShare}
          onClose={() => setShowSharePicker(false)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  VideoTile — renders a MediaStream in a <video> element
// ═══════════════════════════════════════════════════════════════
function VideoTile({ stream, label, muted = false, mini = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className={`mt-video-tile ${mini ? 'mt-video-tile-mini' : ''}`}>
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {label && <span className="mt-video-label">{label}</span>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  InviteModal
// ═══════════════════════════════════════════════════════════════
function InviteModal({ peers, participants, peerNameMap, allUsers, meetingCode, onInvite, onClose, onCopy }) {
  const [selected, setSelected] = useState([]);
  const alreadyIn = participants.map(p => p.peerId);

  const togglePeer = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  return (
    <div className="mt-modal-overlay" onClick={onClose}>
      <div className="mt-modal" onClick={e => e.stopPropagation()}>
        <div className="mt-modal-header">
          <h3>Invite People</h3>
          <button className="icon-btn-sm" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="mt-modal-body">
          <div className="mt-code-share">
            <span className="mt-code-share-label">Meeting Code</span>
            <div className="mt-code-share-row">
              <code className="mt-code-text">{meetingCode}</code>
              <button className="btn-sm btn-secondary" onClick={onCopy}>Copy</button>
            </div>
          </div>

          <div className="mt-invite-list">
            {peers.filter(p => !alreadyIn.includes(p.id)).map(peer => (
              <label key={peer.id} className="mt-invite-row">
                <input
                  type="checkbox"
                  checked={selected.includes(peer.id)}
                  onChange={() => togglePeer(peer.id)}
                />
                <UserAvatar name={peer.username} size={28} avatarUrl={peer.avatar_path} />
                <span>{peer.username || 'User'}</span>
              </label>
            ))}
            {peers.filter(p => !alreadyIn.includes(p.id)).length === 0 && (
              <p className="mt-invite-empty">No online users available to invite</p>
            )}
          </div>
        </div>

        <div className="mt-modal-footer">
          <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onInvite(selected)} disabled={selected.length === 0}>
            Invite ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  SelectiveShareModal
// ═══════════════════════════════════════════════════════════════
function SelectiveShareModal({ participants, peerNameMap, allUsers, selected, setSelected, onShare, onClose }) {
  const togglePeer = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  return (
    <div className="mt-modal-overlay" onClick={onClose}>
      <div className="mt-modal" onClick={e => e.stopPropagation()}>
        <div className="mt-modal-header">
          <h3>Share Screen To</h3>
          <button className="icon-btn-sm" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="mt-modal-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Select which participants can see your screen
          </p>
          <div className="mt-invite-list">
            {participants.map(p => (
              <label key={p.peerId} className="mt-invite-row">
                <input
                  type="checkbox"
                  checked={selected.includes(p.peerId)}
                  onChange={() => togglePeer(p.peerId)}
                />
                <UserAvatar name={p.username} size={28} avatarUrl={(allUsers || []).find(u => u.id === p.peerId)?.avatar_path} />
                <span>{p.username}</span>
              </label>
            ))}
            {participants.length === 0 && (
              <p className="mt-invite-empty">No participants in the meeting yet</p>
            )}
          </div>
        </div>

        <div className="mt-modal-footer">
          <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={onShare} disabled={selected.length === 0}>
            Share Screen ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  Icon Components
// ═══════════════════════════════════════════════════════════════
function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .99-.2 1.93-.57 2.78" />
      <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}
