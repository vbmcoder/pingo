// src/pages/notes.jsx
// Notes page — DB-backed sticky notes with categories, search, pin, color picker

import React, { useState, useCallback, useMemo } from 'react';
import { useNotes } from '../context/AppContext';
import * as api from '../lib/api';

const COLORS = ['#fef3c7','#fce7f3','#dbeafe','#d1fae5','#ede9fe','#fee2e2','#f3f4f6','#fef9c3'];

export default function NotesPage() {
    const { notes, loading, save, remove, togglePin } = useNotes();
    const [editing, setEditing] = useState(null);      // note being edited/created
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');

    // ── categories extracted from notes ─────
    const categories = useMemo(() => {
        const set = new Set(notes.map(n => n.category || '').filter(Boolean));
        return ['all', ...Array.from(set)];
    }, [notes]);

    const filtered = useMemo(() => {
        let list = notes;
        if (selectedCategory !== 'all') list = list.filter(n => (n.category || '') === selectedCategory);
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            list = list.filter(n => n.title.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q));
        }
        return list;
    }, [notes, selectedCategory, searchQuery]);

    // ── new note ────────────────────────────
    const startNew = () => setEditing({ id: '', title: '', content: '', color: '#fef3c7', pinned: false, category: '' });

    // ── save note ───────────────────────────
    const handleSave = useCallback(async () => {
        if (!editing || !editing.title.trim()) return;
        const id = editing.id || await api.generateUuid();
        await save({
            id, title: editing.title.trim(), content: editing.content || '',
            color: editing.color, pinned: editing.pinned, category: editing.category || '',
            created_at: editing.created_at || undefined,
        });
        setEditing(null);
    }, [editing, save]);

    const handleDelete = useCallback(async (id) => {
        await remove(id);
        if (editing?.id === id) setEditing(null);
    }, [remove, editing]);

    return (
        <div className="notes-page">
            {/* ── toolbar ──────────────────── */}
            <div className="notes-toolbar">
                <h2>Notes</h2>
                <div className="notes-toolbar-right">
                    <div className="notes-search">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input placeholder="Search notes…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                    </div>
                    <button className="btn-primary" onClick={startNew}>+ New Note</button>
                </div>
            </div>

            {/* ── categories ───────────────── */}
            {categories.length > 1 && (
                <div className="notes-categories">
                    {categories.map(c => (
                        <button key={c} className={`cat-chip ${selectedCategory === c ? 'active' : ''}`} onClick={() => setSelectedCategory(c)}>
                            {c === 'all' ? 'All' : c}
                        </button>
                    ))}
                </div>
            )}

            {/* ── notes grid ───────────────── */}
            <div className="notes-grid">
                {loading && <div className="empty-state-sm">Loading…</div>}
                {!loading && filtered.length === 0 && (
                    <div className="notes-empty">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                        <p>No notes yet — click <strong>+ New Note</strong> to create one</p>
                    </div>
                )}
                {filtered.map(note => (
                    <div key={note.id} className="note-card" style={{ background: note.color || '#fef3c7' }} onClick={() => setEditing({ ...note })}>
                        <div className="note-card-header">
                            <span className="note-card-title">{note.title}</span>
                            <div className="note-card-actions">
                                <button className={`icon-btn-sm ${note.pinned ? 'pinned' : ''}`} title="Pin"
                                    onClick={e => { e.stopPropagation(); togglePin(note.id); }}>
                                    📌
                                </button>
                                <button className="icon-btn-sm" title="Delete"
                                    onClick={e => { e.stopPropagation(); handleDelete(note.id); }}>
                                    🗑️
                                </button>
                            </div>
                        </div>
                        <p className="note-card-content">{note.content?.slice(0, 120)}{note.content?.length > 120 ? '…' : ''}</p>
                        <div className="note-card-footer">
                            {note.category && <span className="note-cat-tag">{note.category}</span>}
                            <span className="note-date">{new Date(note.updated_at).toLocaleDateString()}</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* ── editor modal ─────────────── */}
            {editing && (
                <div className="modal-overlay" onClick={() => setEditing(null)}>
                    <div className="note-editor-modal" onClick={e => e.stopPropagation()}>
                        <input className="note-editor-title" placeholder="Note title…" value={editing.title}
                            onChange={e => setEditing(p => ({ ...p, title: e.target.value }))} autoFocus />
                        <textarea className="note-editor-content" placeholder="Write something…" value={editing.content}
                            onChange={e => setEditing(p => ({ ...p, content: e.target.value }))} rows={10} />
                        <input className="note-editor-category" placeholder="Category (optional)" value={editing.category || ''}
                            onChange={e => setEditing(p => ({ ...p, category: e.target.value }))} />
                        <div className="note-color-row">
                            {COLORS.map(c => (
                                <button key={c} className={`color-dot ${editing.color === c ? 'active' : ''}`}
                                    style={{ background: c }} onClick={() => setEditing(p => ({ ...p, color: c }))} />
                            ))}
                        </div>
                        <div className="modal-actions">
                            <button className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
                            <button className="btn-primary" onClick={handleSave} disabled={!editing.title.trim()}>Save</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
