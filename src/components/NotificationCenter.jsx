// src/components/NotificationCenter.jsx
// Toast notifications + screen share invite handling

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { MSG, sendMeetingInviteResponse, onSignalingMessage, meetingLog } from '../lib/meeting_rtc_api';

export default function NotificationCenter() {
    const [toasts, setToasts] = useState([]);
    const [invites, setInvites] = useState([]);
    const timerRef = useRef(new Map());

    const addToast = useCallback((message, type = 'info', duration = 4000) => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev.slice(-4), { id, message, type }]);
        const timer = setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
            timerRef.current.delete(id);
        }, duration);
        timerRef.current.set(id, timer);
    }, []);

    const dismissToast = useCallback((id) => {
        setToasts(prev => prev.filter(t => t.id !== id));
        const timer = timerRef.current.get(id);
        if (timer) { clearTimeout(timer); timerRef.current.delete(id); }
    }, []);

    // Listen for signaling events (screen share invites, meeting invites, etc.)
    useEffect(() => {
        const unsub = onSignalingMessage(msg => {
            if (!msg) return;
            if (msg.type === 'ScreenShareInvite') {
                setInvites(prev => {
                    if (prev.find(i => i.session_id === msg.session_id)) return prev;
                    return [...prev, msg];
                });
                addToast(`Screen share invite received`, 'info', 8000);
            }
            if (msg.type === MSG.INVITE) {
                meetingLog(`Notification: Meeting invite from ${msg.host_name || msg.from}`);
                setInvites(prev => {
                    if (prev.find(i => i.meeting_id === msg.meeting_id && i.from === msg.from)) return prev;
                    return [...prev, { ...msg, _isMeeting: true }];
                });
                addToast(`${msg.host_name || 'Someone'} invited you to a meeting`, 'info', 8000);
            }
        });

        return () => {
            unsub.then?.(fn => fn?.());
        };
    }, [addToast]);

    const navigate = useNavigate();

    const handleInviteResponse = useCallback(async (invite, accepted) => {
        // Meeting invite handling
        if (invite._isMeeting || invite.type === MSG.INVITE) {
            if (!accepted) {
                try {
                    await sendMeetingInviteResponse(invite.from, invite.to, invite.meeting_id, false);
                    meetingLog(`Declined meeting invite from ${invite.host_name || invite.from}`);
                } catch (e) {
                    meetingLog(`Failed to decline meeting invite: ${e}`, 'error');
                }
                setInvites(prev => prev.filter(i => !(i.meeting_id === invite.meeting_id && i.from === invite.from)));
                return;
            }
            setInvites(prev => prev.filter(i => !(i.meeting_id === invite.meeting_id && i.from === invite.from)));
            try {
                meetingLog(`Accepted meeting invite → navigating to meetings`);
                navigate('/meetings', { state: { autoAcceptInvite: invite } });
                window.dispatchEvent(new CustomEvent('meeting-invite-accepted', { detail: invite }));
            } catch (e) {
                meetingLog(`Navigation after accept failed: ${e}`, 'error');
            }
            return;
        }

        // Screen share invite handling (legacy)
        if (!accepted) {
            try {
                await api.sendSignalingMessage(invite.from, {
                    type: 'ScreenShareResponse',
                    from: invite.to,
                    to: invite.from,
                    session_id: invite.session_id,
                    accepted: false,
                });
            } catch (e) {
                console.warn('Failed to respond to invite:', e);
            }
            setInvites(prev => prev.filter(i => i.session_id !== invite.session_id));
            return;
        }

        setInvites(prev => prev.filter(i => i.session_id !== invite.session_id));

        try {
            navigate('/meetings', { state: { autoAcceptInvite: invite } });
            window.dispatchEvent(new CustomEvent('meeting-invite-accepted', { detail: invite }));
        } catch (e) {
            console.warn('Navigation after accept failed:', e);
        }
    }, [navigate]);

    if (toasts.length === 0 && invites.length === 0) return null;

    return (
        <div className="notification-center">
            {invites.map(inv => (
                <div key={inv.session_id || `${inv.meeting_id}_${inv.from}`} className="toast toast-invite">
                    <div className="toast-content">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                            <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                        <span style={{ fontWeight: 500 }}>
                            {inv._isMeeting
                                ? `${inv.host_name || 'Someone'} invites you to a meeting`
                                : 'Screen Share Invitation'}
                        </span>
                    </div>
                    <div className="toast-actions" style={{ gap: 8 }}>
                        <button className="btn-sm btn-secondary" onClick={() => handleInviteResponse(inv, false)}>Decline</button>
                        <button className="btn-sm btn-primary" onClick={() => handleInviteResponse(inv, true)}>Accept</button>
                    </div>
                </div>
            ))}
            {toasts.map(t => (
                <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismissToast(t.id)}>
                    <span>{t.message}</span>
                </div>
            ))}
        </div>
    );
}
