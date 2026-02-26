// src/lib/meeting_rtc_api.js
// Meeting-specific signaling API & helpers
// All meeting signaling messages and localStorage chat go through here.

import * as api from './api';

// ─── Message type constants ──────────────────────────────────
export const MSG = Object.freeze({
  INVITE:              'MeetingInvite',
  INVITE_RESPONSE:     'MeetingInviteResponse',
  OFFER:               'MeetingOffer',
  ANSWER:              'MeetingAnswer',
  ICE_CANDIDATE:       'MeetingIceCandidate',
  CHAT:                'MeetingChat',
  LEAVE:               'MeetingLeave',
  ENDED:               'MeetingEnded',
  SCREEN_SHARE:        'MeetingScreenShare',
  SCREEN_SHARE_INVITE: 'MeetingScreenShareInvite',
  REJOIN_REQUEST:      'MeetingRejoinRequest',
  PARTICIPANT_LIST:    'MeetingParticipantList',
});

// ─── Send helpers (typed, validated) ─────────────────────────

export async function sendMeetingInvite(peerId, from, meetingId, hostName) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.INVITE,
    from,
    to: peerId,
    meeting_id: meetingId,
    host_name: hostName,
  });
}

export async function sendMeetingInviteResponse(peerId, from, meetingId, accepted, username = null) {
  const msg = {
    type: MSG.INVITE_RESPONSE,
    from,
    to: peerId,
    meeting_id: meetingId,
    accepted,
  };
  if (username) msg.username = username;
  return api.sendSignalingMessage(peerId, msg);
}

export async function sendMeetingOffer(peerId, from, meetingId, sdp) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.OFFER,
    from,
    to: peerId,
    meeting_id: meetingId,
    sdp,
  });
}

export async function sendMeetingAnswer(peerId, from, meetingId, sdp) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.ANSWER,
    from,
    to: peerId,
    meeting_id: meetingId,
    sdp,
  });
}

export async function sendMeetingIceCandidate(peerId, from, meetingId, candidate, sdpMid, sdpMLineIndex) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.ICE_CANDIDATE,
    from,
    to: peerId,
    meeting_id: meetingId,
    candidate,
    sdp_mid: sdpMid ?? null,
    sdp_mline_index: sdpMLineIndex ?? null,
  });
}

export async function sendMeetingChat(peerId, from, meetingId, chat) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.CHAT,
    from,
    to: peerId,
    meeting_id: meetingId,
    chat,
  });
}

export async function sendMeetingLeave(peerId, from, meetingId) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.LEAVE,
    from,
    to: peerId,
    meeting_id: meetingId,
  });
}

export async function sendMeetingEnded(peerId, from, meetingId) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.ENDED,
    from,
    to: peerId,
    meeting_id: meetingId,
  });
}

export async function sendMeetingScreenShare(peerId, from, meetingId, sharing) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.SCREEN_SHARE,
    from,
    to: peerId,
    meeting_id: meetingId,
    sharing,
  });
}

export async function sendMeetingScreenShareInvite(peerId, from, meetingId, hostName) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.SCREEN_SHARE_INVITE,
    from,
    to: peerId,
    meeting_id: meetingId,
    host_name: hostName,
  });
}

export async function sendMeetingRejoinRequest(peerId, from, meetingId, username) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.REJOIN_REQUEST,
    from,
    to: peerId,
    meeting_id: meetingId,
    username,
  });
}

export async function sendMeetingParticipantList(peerId, from, meetingId, participants) {
  return api.sendSignalingMessage(peerId, {
    type: MSG.PARTICIPANT_LIST,
    from,
    to: peerId,
    meeting_id: meetingId,
    participants,
  });
}

// ─── Broadcast helper ────────────────────────────────────────
// Sends a meeting signaling message to every peer in `targets`.

export async function broadcastMeeting(type, payload, targets, from, meetingId) {
  const errors = [];
  for (const pid of targets) {
    try {
      await api.sendSignalingMessage(pid, {
        type,
        from,
        to: pid,
        meeting_id: meetingId,
        ...payload,
      });
    } catch (err) {
      errors.push({ peerId: pid, error: err });
    }
  }
  return errors;
}

// ─── Meeting Chat localStorage helpers ───────────────────────
const CHAT_KEY = 'pingo_meeting_chat';

export function loadMeetingChat(meetingId) {
  try {
    const raw = localStorage.getItem(`${CHAT_KEY}_${meetingId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveMeetingChat(meetingId, messages) {
  try {
    localStorage.setItem(`${CHAT_KEY}_${meetingId}`, JSON.stringify(messages));
  } catch { /* quota exceeded or similar */ }
}

export function clearMeetingChat(meetingId) {
  try { localStorage.removeItem(`${CHAT_KEY}_${meetingId}`); } catch { }
}

export function clearAllMeetingChats() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CHAT_KEY)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch { }
}

// ─── Meeting Log system ──────────────────────────────────────
// In-memory log buffer for live UI display.  Also appends to Tauri
// dev log when available.

let _logListeners = [];

export function onMeetingLog(fn) {
  _logListeners.push(fn);
  return () => { _logListeners = _logListeners.filter(l => l !== fn); };
}

export function meetingLog(message, level = 'info') {
  const entry = { timestamp: Date.now(), level, message };
  _logListeners.forEach(fn => { try { fn(entry); } catch { } });
  // Also push to Tauri dev log
  try { api.appendDevLog(`[Meeting/${level}] ${message}`); } catch { }
  // Console
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[Meeting/${level}]`, message);
  return entry;
}

// ─── isMeetingSignal helper ──────────────────────────────────
export function isMeetingSignal(msg) {
  return msg?.type?.startsWith('Meeting');
}

// ─── Re-export generateUuid from api ─────────────────────────
export const generateMeetingId = () => api.generateUuid();
export const getDeviceId = () => api.getDeviceId();
export const onSignalingMessage = (handler) => api.onSignalingMessage(handler);
