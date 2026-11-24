import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PLUGIN_IDS,
  type BuiltinPluginPackage,
  type ConfigFieldSchema,
  type HostPluginModule,
  type PluginManifest,
} from '../../../src/kernel/shared/types';

export interface TerminalBusEvent {
  type: 'data' | 'exit';
  terminalId: string;
  data?: string;
  exitCode?: number;
}

interface PtyEntry {
  proc: ChildProcessWithoutNullStreams;
  buf: string;
  /** Ring buffer of recent terminal output so Client-only HMR re-attaches without blanking screen! */
  replayBuffer: string;
}

const MAX_REPLAY_CHARS = 32_000;

export const paneTerminalConfigSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'fontSizePx',
    label: '터미널 글꼴 크기',
    description: 'xterm.js 인터랙티브 셸 폰트 크기(px)',
    group: '터미널',
    type: 'number',
    widget: 'slider',
    defaultValue: 13,
    min: 10,
    max: 20,
    step: 1,
    keywords: ['터미널', '글꼴', '폰트', 'terminal', 'font'],
  },
  {
    key: 'scrollback',
    label: '스크롤백 줄 수',
    description: '터미널 버퍼에 유지할 최대 출력 줄 수입니다.',
    group: '터미널',
    type: 'number',
    defaultValue: 5000,
    min: 500,
    max: 25000,
    step: 500,
    keywords: ['스크롤백', '버퍼', 'scrollback', 'terminal'],
  },
];

export const paneTerminalManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_TERMINAL,
  name: '인터랙티브 터미널 (zsh)',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: 'xterm.js + Python PTY 브리지 기반 실시간 인터랙티브 셸 패인',
  layer: 'app',
  category: 'pane',
  icon: 'Terminal',
  impactClass: 'stateful-pane',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/pane-terminal/index.ts',
    client: './src/plugins/pane-terminal/index.tsx',
  },
  capabilities: ['process:spawn', 'fs:read'],
  configSchema: paneTerminalConfigSchema,
  contributes: {
    slots: ['pane.type', 'titlebar.actions', 'sidebar.section', 'settings.section'],
    paneTypes: [{ type: 'terminal', label: '터미널 (zsh)', icon: 'Terminal' }],
    commands: [{ id: 'pane-terminal:new-tab', title: '새 터미널 열기', defaultShortcut: 'Mod+Shift+T' }],
  },
};

function resolvePtyHelperPath(): string {
  const candidates = [
    path.join(__dirname, 'pty_helper.py'),
    path.join(__dirname, '../pty_helper.py'),
    path.join(__dirname, '../../electron/pty_helper.py'),
    path.join(__dirname, '../../../electron/pty_helper.py'),
    path.join(process.cwd(), 'dist-electron/pty_helper.py'),
    path.join(process.cwd(), 'electron/pty_helper.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export const paneTerminalHost: HostPluginModule = {
  activate(ctx) {
    const sessions = new Map<string, PtyEntry>();

    const resizePty = (terminalId: string, cols: number, rows: number) => {
      const entry = sessions.get(terminalId);
      if (!entry || entry.proc.stdin.destroyed) return;
      try {
        entry.proc.stdin.write(
          `${JSON.stringify({ t: 'resize', cols: Math.max(10, Math.floor(cols)), rows: Math.max(2, Math.floor(rows)) })}\n`
        );
      } catch {
        // ignore broken pipe
      }
    };

    const killPty = (terminalId: string) => {
      const entry = sessions.get(terminalId);
      if (!entry) return;
      sessions.delete(terminalId);
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    };

    ctx.rpc.handle<
      { terminalId: string; cwd?: string; cols?: number; rows?: number },
      { ok: boolean; error?: string; replay?: string }
    >('pane-terminal:create', ({ terminalId, cwd, cols = 80, rows = 24 }) => {
      const existing = sessions.get(terminalId);
      if (existing) {
        resizePty(terminalId, cols, rows);
        return { ok: true, replay: existing.replayBuffer };
      }

      const helperPath = resolvePtyHelperPath();
      if (!fs.existsSync(helperPath)) {
        return { ok: false, error: `PTY helper not found: ${helperPath}` };
      }

      const validCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: [
          path.join(os.homedir(), '.local/bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          process.env.PATH || '',
        ]
          .filter(Boolean)
          .join(':'),
      };

      const proc = spawn('python3', ['-u', helperPath, validCwd, String(cols), String(rows)], {
        cwd: validCwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const entry: PtyEntry = { proc, buf: '', replayBuffer: '' };
      sessions.set(terminalId, entry);

      const appendReplay = (chunk: string) => {
        entry.replayBuffer += chunk;
        if (entry.replayBuffer.length > MAX_REPLAY_CHARS) {
          entry.replayBuffer = entry.replayBuffer.slice(-MAX_REPLAY_CHARS);
        }
      };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        entry.buf += chunk;
        let idx = entry.buf.indexOf('\n');
        while (idx !== -1) {
          const line = entry.buf.slice(0, idx).trim();
          entry.buf = entry.buf.slice(idx + 1);
          if (line) {
            try {
              const msg = JSON.parse(line) as { t?: string; d?: string; code?: number };
              if (msg.t === 'out' && msg.d) {
                const decoded = Buffer.from(msg.d, 'base64').toString('utf8');
                appendReplay(decoded);
                ctx.bus.publish<TerminalBusEvent>('terminal:event', {
                  type: 'data',
                  terminalId,
                  data: decoded,
                });
              } else if (msg.t === 'exit') {
                sessions.delete(terminalId);
                ctx.bus.publish<TerminalBusEvent>('terminal:event', {
                  type: 'exit',
                  terminalId,
                  exitCode: msg.code ?? 0,
                });
              }
            } catch {
              // ignore malformed frame
            }
          }
          idx = entry.buf.indexOf('\n');
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (errText: string) => {
        if (errText.trim()) {
          appendReplay(`\r\n${errText}`);
          ctx.bus.publish<TerminalBusEvent>('terminal:event', {
            type: 'data',
            terminalId,
            data: `\r\n${errText}`,
          });
        }
      });

      proc.on('close', (code) => {
        if (sessions.has(terminalId)) {
          sessions.delete(terminalId);
          ctx.bus.publish<TerminalBusEvent>('terminal:event', {
            type: 'exit',
            terminalId,
            exitCode: code ?? 0,
          });
        }
      });

      return { ok: true };
    });

    ctx.rpc.onNotify<{ terminalId: string; data: string }>('pane-terminal:write', ({ terminalId, data }) => {
      const entry = sessions.get(terminalId);
      if (!entry || entry.proc.stdin.destroyed) return;
      const encoded = Buffer.from(data, 'utf8').toString('base64');
      try {
        entry.proc.stdin.write(`${JSON.stringify({ t: 'in', d: encoded })}\n`);
      } catch {
        // ignore broken pipe
      }
    });

    ctx.rpc.onNotify<{ terminalId: string; cols: number; rows: number }>(
      'pane-terminal:resize',
      ({ terminalId, cols, rows }) => {
        resizePty(terminalId, cols, rows);
      }
    );

    ctx.rpc.handle<{ terminalId: string }, boolean>('pane-terminal:kill', ({ terminalId }) => {
      killPty(terminalId);
      return true;
    });

    ctx.scope.onDispose(() => {
      for (const id of Array.from(sessions.keys())) {
        killPty(id);
      }
    }, 'pty-sessions-cleanup');
  },
};

export const paneTerminalHostPackage: BuiltinPluginPackage = {
  manifest: paneTerminalManifest,
  host: paneTerminalHost,
};
