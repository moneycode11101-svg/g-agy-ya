import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TerminalEvent {
  type: 'data' | 'exit';
  terminalId: string;
  data?: string;
  exitCode?: number;
}

interface PtyEntry {
  proc: ChildProcessWithoutNullStreams;
  buf: string;
}

export class TerminalBridge {
  private sessions = new Map<string, PtyEntry>();
  private emit: (ev: TerminalEvent) => void;

  constructor(emit: (ev: TerminalEvent) => void) {
    this.emit = emit;
  }

  private resolveHelperPath(): string {
    const inDist = path.join(__dirname, 'pty_helper.py');
    if (fs.existsSync(inDist)) return inDist;
    return path.join(__dirname, '../electron/pty_helper.py');
  }

  create(terminalId: string, cwd: string, cols = 80, rows = 24): { ok: boolean; error?: string } {
    if (this.sessions.has(terminalId)) {
      this.resize(terminalId, cols, rows);
      return { ok: true };
    }

    const helperPath = this.resolveHelperPath();
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

    const entry: PtyEntry = { proc, buf: '' };
    this.sessions.set(terminalId, entry);

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
              this.emit({ type: 'data', terminalId, data: decoded });
            } else if (msg.t === 'exit') {
              this.sessions.delete(terminalId);
              this.emit({ type: 'exit', terminalId, exitCode: msg.code ?? 0 });
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
        this.emit({ type: 'data', terminalId, data: `\r\n${errText}` });
      }
    });

    proc.on('close', (code) => {
      if (this.sessions.has(terminalId)) {
        this.sessions.delete(terminalId);
        this.emit({ type: 'exit', terminalId, exitCode: code ?? 0 });
      }
    });

    return { ok: true };
  }

  write(terminalId: string, data: string): void {
    const entry = this.sessions.get(terminalId);
    if (!entry || entry.proc.stdin.destroyed) return;
    const encoded = Buffer.from(data, 'utf8').toString('base64');
    try {
      entry.proc.stdin.write(`${JSON.stringify({ t: 'in', d: encoded })}\n`);
    } catch {
      // ignore broken pipe
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(terminalId);
    if (!entry || entry.proc.stdin.destroyed) return;
    try {
      entry.proc.stdin.write(
        `${JSON.stringify({ t: 'resize', cols: Math.max(10, Math.floor(cols)), rows: Math.max(2, Math.floor(rows)) })}\n`
      );
    } catch {
      // ignore
    }
  }

  kill(terminalId: string): void {
    const entry = this.sessions.get(terminalId);
    if (!entry) return;
    this.sessions.delete(terminalId);
    try {
      entry.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  dispose(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }
  }
}
