import React from 'react';
import { create } from 'zustand';

export type ContextMenuItem =
  | { type: 'separator' }
  | { type: 'label'; label: string }
  | {
      type: 'item';
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      type: 'submenu';
      label: string;
      icon?: React.ReactNode;
      items: ContextMenuItem[];
    }
  | {
      type: 'color-picker';
      label: string;
      value: string | null;
      onSelect: (color: string | null) => void;
    };

export const TAB_COLOR_SWATCHES: Array<{ label: string; value: string | null }> = [
  { label: '없음', value: null },
  { label: '파랑', value: '#3b82f6' },
  { label: '보라', value: '#a855f7' },
  { label: '핑크', value: '#ec4899' },
  { label: '빨강', value: '#ef4444' },
  { label: '주황', value: '#f97316' },
  { label: '초록', value: '#22c55e' },
  { label: '회색', value: '#64748b' },
];

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  showMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  closeMenu: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  showMenu: (x, y, items) => set({ open: true, x, y, items }),
  closeMenu: () => set({ open: false, items: [] }),
}));
