// src/App.jsx
import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAppContext } from './context/AppContext';
import Aside from './components/Aside';
import ChatPage from './pages/chat';
import MeetingsPage from './pages/meetings';
import NotesPage from './pages/notes';
import SettingsPage from './pages/settings';
import NotificationCenter from './components/NotificationCenter';
import './App.css';

// ─── Error Boundary ───────────────────────────────────────────
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        console.error('[Pingo] Render error:', error, info);
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="error-boundary">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <h3>Something went wrong</h3>
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {this.state.error?.message || 'An unexpected error occurred'}
                    </p>
                    <button className="btn-primary" onClick={() => this.setState({ hasError: false, error: null })}>
                        Try Again
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

// ─── Loading / Setup Screens ──────────────────────────────────
function LoadingScreen() {
    return (
        <div className="loading-screen">
            <div className="loading-spinner" />
            <p>Starting Pingo…</p>
        </div>
    );
}

function SetupScreen({ onComplete }) {
    const [username, setUsername] = React.useState('');
    const handleSubmit = (e) => {
        e.preventDefault();
        if (username.trim()) onComplete(username.trim());
    };
    return (
        <div className="setup-screen">
            <div className="setup-card">
                <h1>Welcome to Pingo</h1>
                <p>Set up your profile to get started</p>
                <form onSubmit={handleSubmit}>
                    <input
                        type="text" placeholder="Enter your name…"
                        value={username} onChange={e => setUsername(e.target.value)}
                        autoFocus maxLength={30}
                    />
                    <button className="btn-primary" type="submit" disabled={!username.trim()}>
                        Get Started
                    </button>
                </form>
            </div>
        </div>
    );
}

// ─── Main App ─────────────────────────────────────────────────
export default function App() {
    const { initialized, localUser, updateProfile, error } = useAppContext();

    if (!initialized) return <LoadingScreen />;

    if (!localUser || !localUser.username) {
        return (
            <SetupScreen onComplete={async (name) => {
                await updateProfile({ username: name });
            }} />
        );
    }

    return (
        <div className="app-shell">
            <Aside />
            <main className="main-content">
                <ErrorBoundary>
                    <Routes>
                        <Route path="/" element={<Navigate to="/chat" replace />} />
                        <Route path="/chat" element={<ChatPage />} />
                        <Route path="/meetings" element={<MeetingsPage />} />
                        <Route path="/notes" element={<NotesPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                    </Routes>
                </ErrorBoundary>
            </main>
            <NotificationCenter />
        </div>
    );
}
