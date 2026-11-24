import { create } from 'zustand';
import type { CommandDefinition, Disposer } from '../shared/types';

interface CommandRegistryState {
  commands: Record<string, CommandDefinition>;
  register: (cmd: CommandDefinition) => Disposer;
  execute: (commandId: string, args?: unknown) => Promise<void>;
  list: () => CommandDefinition[];
}

export const useCommandRegistry = create<CommandRegistryState>((set, get) => ({
  commands: {},

  register: (cmd) => {
    set((s) => ({
      commands: { ...s.commands, [cmd.id]: cmd },
    }));
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      set((s) => {
        if (s.commands[cmd.id] !== cmd) return s;
        const next = { ...s.commands };
        delete next[cmd.id];
        return { commands: next };
      });
    };
  },

  execute: async (commandId, args) => {
    const cmd = get().commands[commandId];
    if (!cmd) return;
    if (cmd.when && !cmd.when()) return;
    await cmd.run(args);
  },

  list: () => Object.values(get().commands),
}));

function normalizeShortcut(shortcut: string): {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
} {
  const parts = shortcut
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  let mod = false;
  let shift = false;
  let alt = false;
  let key = '';
  for (const p of parts) {
    if (p === 'mod' || p === 'cmd' || p === 'ctrl' || p === 'cmdorctrl' || p === 'meta') mod = true;
    else if (p === 'shift') shift = true;
    else if (p === 'alt' || p === 'opt' || p === 'option') alt = true;
    else key = p;
  }
  return { mod, shift, alt, key };
}

function matchesKeyboardEvent(e: KeyboardEvent, shortcut: string): boolean {
  const parsed = normalizeShortcut(shortcut);
  const evMod = e.metaKey || e.ctrlKey;
  if (parsed.mod !== evMod) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  return e.key.toLowerCase() === parsed.key;
}

/**
 * Installs a single global `keydown` listener that dispatches shortcuts to registered commands.
 * Replaces hardcoded key switches in `src/App.tsx`.
 */
export function installGlobalKeybindingListener(): Disposer {
  if (typeof window === 'undefined') return () => {};

  const onKeyDown = (e: KeyboardEvent) => {
    const commands = Object.values(useCommandRegistry.getState().commands);
    for (const cmd of commands) {
      if (!cmd.shortcut) continue;
      if (!matchesKeyboardEvent(e, cmd.shortcut)) continue;
      if (cmd.when && !cmd.when()) continue;
      e.preventDefault();
      void Promise.resolve(cmd.run()).catch((err) => {
        console.error(`[CommandRegistry] Shortcut "${cmd.shortcut}" (${cmd.id}) failed:`, err);
      });
      return;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
  };
}
