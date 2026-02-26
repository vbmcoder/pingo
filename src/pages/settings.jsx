// src/pages/settings.jsx
// Settings page — general preferences, notifications, storage, about

import React, { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import * as api from '../lib/api';
import * as chatLogger from '../lib/chatLogger';

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
}

function StorageBar({ label, size, totalSize, color }) {
    const pct = totalSize > 0 ? Math.min((size / totalSize) * 100, 100) : 0;
    return (
        <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span style={{ color: 'var(--text)' }}>{label}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{formatBytes(size)}</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: color, transition: 'width 0.5s ease' }} />
            </div>
        </div>
    );
}

function StorageSection() {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const s = await api.getStorageStats();
                setStats(s);
            } catch (e) {
                console.error('Failed to load storage stats:', e);
            } finally { setLoading(false); }
        })();
    }, []);

    if (loading) return <div className="empty-state-sm">Calculating storage…</div>;
    if (!stats) return <div className="empty-state-sm">Unable to load storage info</div>;

    return (
        <div>
            {/* Total usage header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--primary-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                </div>
                <div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{formatBytes(stats.total_size)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Total storage used</div>
                </div>
            </div>

            <StorageBar label="Database" size={stats.db_size} totalSize={stats.total_size} color="#6366f1" />
            <StorageBar label="Shared Files (cache)" size={stats.shared_files_size} totalSize={stats.total_size} color="#0ea5e9" />
            <StorageBar label="Downloads" size={stats.downloads_size} totalSize={stats.total_size} color="#22c55e" />

            {/* Paths */}
            <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div><strong style={{ color: 'var(--text)', fontFamily: 'inherit' }}>DB:</strong> {stats.db_path}</div>
                <div><strong style={{ color: 'var(--text)', fontFamily: 'inherit' }}>Cache:</strong> {stats.shared_files_path}</div>
                <div><strong style={{ color: 'var(--text)', fontFamily: 'inherit' }}>Downloads:</strong> {stats.downloads_path}</div>
            </div>
        </div>
    );
}

function UsersList() {
    const { deviceId } = useAppContext();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const all = await api.getAllUsers();
                if (mounted) setUsers(all || []);
            } catch (e) {
                console.error('Failed to load users:', e);
            } finally { if (mounted) setLoading(false); }
        })();
        return () => { mounted = false; };
    }, []);

    const handleDelete = async (user) => {
        if (user.id === deviceId) {
            alert('Cannot delete the local user');
            return;
        }
        const ok = window.confirm(`Delete user \"${user.username}\"? This will also remove messages with this user.`);
        if (!ok) return;
        try {
            await api.deleteUser(user.id);
            setUsers(prev => prev.filter(u => u.id !== user.id));
        } catch (e) {
            console.error('Failed to delete user', e);
            alert('Failed to delete user: ' + (e?.toString?.() || e));
        }
    };

    if (loading) return <div className="empty-state-sm">Loading users…</div>;

    if (!users || users.length === 0) return <div className="empty-state-sm">No users found.</div>;

    const handleRemoveTestUsers = async () => {
        const pattern = /^(user\d+|user a|user b)$/i;
        const matches = users.filter(u => pattern.test(u.username));
        if (matches.length === 0) return alert('No test users found');
        const ok = window.confirm(`Delete ${matches.length} test user(s)? This will also remove messages with them.`);
        if (!ok) return;
        for (const m of matches) {
            try { await api.deleteUser(m.id); } catch (e) { console.error('Failed deleting', m, e); }
        }
        setUsers(prev => prev.filter(u => !pattern.test(u.username)));
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn-secondary btn-sm" onClick={handleRemoveTestUsers}>Remove test users</button>
            </div>
            {users.map(u => (
                <div key={u.id} className="settings-row" style={{ alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <div style={{ fontWeight: 600 }}>{u.username}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{u.id.slice(0, 12)}…</div>
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                        <button className="btn-secondary btn-sm" onClick={() => handleDelete(u)} disabled={u.id === deviceId}>Delete</button>
                    </div>
                </div>
            ))}
        </div>
    );
}


function ChatLogsSection() {
    const [loggingEnabled, setLoggingEnabled] = useState(chatLogger.isEnabled());
    const [logs, setLogs] = useState([]);
    const [showLogs, setShowLogs] = useState(false);
    const [filter, setFilter] = useState('all'); // 'all' | 'send' | 'receive' | 'relay' | 'ack' | 'flush' | 'error' | 'profile'

    const refreshLogs = useCallback(() => {
        setLogs(chatLogger.getLogs());
    }, []);

    useEffect(() => {
        if (showLogs) refreshLogs();
    }, [showLogs, refreshLogs]);

    const handleToggle = () => {
        const next = !loggingEnabled;
        chatLogger.setEnabled(next);
        setLoggingEnabled(next);
    };

    const handleClear = () => {
        chatLogger.clearLogs();
        setLogs([]);
    };

    const handleExport = () => {
        const json = chatLogger.exportLogsAsJson();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pingo_chat_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const filteredLogs = filter === 'all' ? logs : logs.filter(l => l.type === filter);

    const typeColors = {
        send: '#22c55e',
        receive: '#3b82f6',
        relay: '#a855f7',
        ack: '#06b6d4',
        flush: '#f59e0b',
        error: '#ef4444',
        profile: '#ec4899',
        discovery: '#8b5cf6',
        info: '#6b7280',
    };

    return (
        <div>
            <div className="settings-row clickable" onClick={handleToggle}>
                <span className="settings-label">Enable chat logging</span>
                <div className={`toggle-switch ${loggingEnabled ? 'active' : ''}`}>
                    <div className="toggle-knob" />
                </div>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 12px' }}>
                When enabled, chat send/receive/relay events are logged for debugging. Logs are stored locally.
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button className="btn-sm btn-secondary" onClick={() => { setShowLogs(!showLogs); if (!showLogs) refreshLogs(); }}>
                    {showLogs ? 'Hide Logs' : `View Logs (${chatLogger.getLogs().length})`}
                </button>
                {showLogs && (
                    <>
                        <button className="btn-sm btn-secondary" onClick={refreshLogs}>Refresh</button>
                        <button className="btn-sm btn-secondary" onClick={handleExport}>Export JSON</button>
                        <button className="btn-sm btn-secondary" onClick={handleClear} style={{ color: 'var(--danger)' }}>Clear</button>
                    </>
                )}
            </div>

            {showLogs && (
                <div>
                    {/* Filter tabs */}
                    <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                        {['all', 'send', 'receive', 'relay', 'ack', 'flush', 'error', 'profile'].map(f => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                style={{
                                    padding: '3px 10px', fontSize: 11, borderRadius: 12,
                                    border: filter === f ? '1px solid var(--primary)' : '1px solid var(--border)',
                                    background: filter === f ? 'var(--primary-bg)' : 'transparent',
                                    color: filter === f ? 'var(--primary)' : 'var(--text-secondary)',
                                    cursor: 'pointer', fontWeight: filter === f ? 600 : 400,
                                }}
                            >
                                {f}
                            </button>
                        ))}
                    </div>

                    <div style={{
                        maxHeight: 400, overflowY: 'auto', background: 'var(--bg-secondary)',
                        borderRadius: 8, border: '1px solid var(--border)', fontSize: 11,
                        fontFamily: 'monospace',
                    }}>
                        {filteredLogs.length === 0 ? (
                            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>
                                {loggingEnabled ? 'No logs yet. Chat events will appear here.' : 'Enable logging to start capturing events.'}
                            </div>
                        ) : (
                            filteredLogs.slice(-200).reverse().map((entry, i) => (
                                <div key={i} style={{
                                    padding: '6px 10px', borderBottom: '1px solid var(--border-light)',
                                    display: 'flex', gap: 8, alignItems: 'flex-start',
                                }}>
                                    <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: 10 }}>
                                        {new Date(entry.ts).toLocaleTimeString()}
                                    </span>
                                    <span style={{
                                        flexShrink: 0, padding: '1px 6px', borderRadius: 4, fontSize: 9,
                                        fontWeight: 600, textTransform: 'uppercase',
                                        background: (typeColors[entry.type] || '#6b7280') + '20',
                                        color: typeColors[entry.type] || '#6b7280',
                                    }}>
                                        {entry.type}
                                    </span>
                                    <span style={{ color: 'var(--text)', wordBreak: 'break-all' }}>
                                        {entry.message}
                                        {entry.data && (
                                            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                                                {JSON.stringify(entry.data)}
                                            </span>
                                        )}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}


export default function SettingsPage() {
    const { localUser, updateProfile, deviceId } = useAppContext();
    const [settings, setSettings] = useState({});
    const [notifMuted, setNotifMuted] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const all = await api.getAllSettings();
                if (all) {
                    const map = {};
                    all.forEach(s => { map[s.key] = s.value; });
                    setSettings(map);
                }
                const muted = await api.isNotificationsMuted();
                setNotifMuted(!!muted);
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        })();
    }, []);

    const handleToggleNotif = useCallback(async () => {
        const result = await api.toggleNotificationsMute();
        setNotifMuted(result);
    }, []);

    const handleSetSetting = useCallback(async (key, value) => {
        await api.setSetting(key, value);
        setSettings(prev => ({ ...prev, [key]: value }));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    }, []);

    return (
        <div className="settings-page">
            <div className="settings-container">
                <h2>Settings</h2>

                {/* ── Profile section ── */}
                <section className="settings-section">
                    <h3>Profile</h3>
                    <div className="settings-profile-info">
                        <div className="settings-row">
                            <span className="settings-label">Username</span>
                            <span className="settings-value">{localUser?.username || '—'}</span>
                        </div>
                        <div className="settings-row">
                            <span className="settings-label">Device ID</span>
                            <span className="settings-value" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                                {deviceId?.slice(0, 24)}…
                            </span>
                        </div>
                        <div className="settings-row">
                            <span className="settings-label">Bio</span>
                            <span className="settings-value">{localUser?.bio || 'Not set'}</span>
                        </div>
                    </div>
                </section>

                {/* ── Notifications section ── */}
                <section className="settings-section">
                    <h3>Notifications</h3>
                    <div className="settings-row clickable" onClick={handleToggleNotif}>
                        <span className="settings-label">Mute all notifications</span>
                        <div className={`toggle-switch ${notifMuted ? 'active' : ''}`}>
                            <div className="toggle-knob" />
                        </div>
                    </div>
                </section>

                {/* ── Chat Logs section ── */}
                <section className="settings-section">
                    <h3>Chat Logs</h3>
                    <ChatLogsSection />
                </section>

                {/* ── Storage & Data section ── */}
                <section className="settings-section">
                    <h3>Storage & Data</h3>
                    <StorageSection />
                </section>

                {/* ── Users management ── */}
                <section className="settings-section">
                    <h3>Users</h3>
                    <div style={{ marginBottom: 12, color: 'var(--text-secondary)' }}>
                        Manage stored users (remove test accounts or stale peers).
                    </div>
                    <div>
                        {/* Lazy load users */}
                        <UsersList />
                    </div>
                </section>

                {/* ── Network section ── */}
                <section className="settings-section">
                    <h3>Network</h3>
                    <div className="settings-row">
                        <span className="settings-label">Discovery Port</span>
                        <span className="settings-value">15353 (UDP)</span>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label">Signaling Port</span>
                        <span className="settings-value">45678 (UDP)</span>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label">File Server Port</span>
                        <span className="settings-value">18080 (HTTP)</span>
                    </div>
                </section>

                {/* ── About section ── */}
                <section className="settings-section">
                    <h3>About</h3>
                    <div className="settings-row">
                        <span className="settings-label">Version</span>
                        <span className="settings-value">1.0.0</span>
                    </div>
                    <div className="settings-row">
                        <span className="settings-label">Encryption</span>
                        <span className="settings-value">X25519 + AES-256-GCM</span>
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
                        Pingo — Secure LAN Communication
                    </p>
                </section>

                {saved && (
                    <div style={{ color: 'var(--success)', fontSize: 13, marginTop: 8 }}>
                        ✓ Settings saved
                    </div>
                )}
            </div>
        </div>
    );
}
