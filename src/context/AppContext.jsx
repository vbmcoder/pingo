import React, { createContext, useContext } from 'react';
import { useApp, useChat, useNotes, useGroups, useFileTransfer } from '../hooks/useApp';

const AppContext = createContext(null);

export function AppProvider({ children }) {
    const appState = useApp();
    return <AppContext.Provider value={appState}>{children}</AppContext.Provider>;
}

export function useAppContext() {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useAppContext must be used within AppProvider');
    return ctx;
}

export { useChat, useNotes, useGroups, useFileTransfer };

