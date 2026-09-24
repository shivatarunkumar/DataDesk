import React, { createContext, useContext, useState } from 'react';

export const light = {
  dark: false,
  bg: '#f1f5f9',
  surface: '#fff',
  border: '#e2e8f0',
  text: '#1e293b',
  textSub: '#64748b',
  textMuted: '#94a3b8',
  accent: '#6366f1',
  accentBg: '#ede9fe',
  accentBorder: '#c4b5fd',
  editorBg: '#0f172a',
  editorText: '#e2e8f0',
  inputBg: '#f8fafc',
  chipBg: '#ede9fe',
  chipText: '#6366f1',
  headerBg: '#fff',
  headerText: '#0f172a',
  toggleBg: '#e2e8f0',
  toggleActive: '#fff',
  errorBg: '#fef2f2',
  errorText: '#ef4444',
  statPillBg: '#ede9fe',
  statPillText: '#4f46e5',
};

export const dark = {
  dark: true,
  bg: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  text: '#f1f5f9',
  textSub: '#94a3b8',
  textMuted: '#64748b',
  accent: '#818cf8',
  accentBg: '#312e81',
  accentBorder: '#4338ca',
  editorBg: '#020617',
  editorText: '#e2e8f0',
  inputBg: '#1e293b',
  chipBg: '#312e81',
  chipText: '#a5b4fc',
  headerBg: '#1e293b',
  headerText: '#f1f5f9',
  toggleBg: '#334155',
  toggleActive: '#475569',
  errorBg: '#450a0a',
  errorText: '#fca5a5',
  statPillBg: '#312e81',
  statPillText: '#a5b4fc',
};

export type Theme = typeof light;

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeCtx>({ theme: light, toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(false);
  return (
    <ThemeContext.Provider value={{ theme: isDark ? dark : light, toggle: () => setIsDark((v) => !v) }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
