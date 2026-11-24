#!/usr/bin/env python3
"""
Lightweight macOS/POSIX PTY bridge for agy Desk.
Protocol (JSON lines):
  stdin  -> {"t":"in","d":"<base64>"} | {"t":"resize","cols":80,"rows":24}
  stdout -> {"t":"out","d":"<base64>"} | {"t":"exit","code":0}
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        rows = max(2, min(500, int(rows)))
        cols = max(10, min(500, int(cols)))
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def emit(obj: dict) -> None:
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        os._exit(0)


def main() -> None:
    cwd = sys.argv[1] if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else os.path.expanduser("~")
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 24
    shell = os.environ.get("SHELL") or "/bin/zsh"
    if not os.path.exists(shell):
        shell = "/bin/sh"

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child process
        try:
            os.chdir(cwd)
        except Exception:
            pass
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        if not os.environ.get("LANG"):
            os.environ["LANG"] = "en_US.UTF-8"
        os.environ.setdefault("TERM_PROGRAM", "agy-desk")
        os.execvp(shell, [shell, "-l"])
        os._exit(127)

    set_winsize(master_fd, rows, cols)

    def handle_term(_signum, _frame):
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        try:
            os.close(master_fd)
        except Exception:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGINT, handle_term)

    stdin_fd = sys.stdin.fileno()
    stdin_buf = b""
    stdin_open = True

    try:
        while True:
            rlist = [master_fd]
            if stdin_open:
                rlist.append(stdin_fd)
            try:
                ready, _, _ = select.select(rlist, [], [], 0.25)
            except (InterruptedError, ValueError):
                break

            if master_fd in ready:
                try:
                    data = os.read(master_fd, 16384)
                except OSError:
                    data = b""
                if not data:
                    break
                emit({"t": "out", "d": base64.b64encode(data).decode("ascii")})

            if stdin_fd in ready:
                try:
                    chunk = os.read(stdin_fd, 16384)
                except OSError:
                    chunk = b""
                if not chunk:
                    stdin_open = False
                    break
                stdin_buf += chunk
                while b"\n" in stdin_buf:
                    line, stdin_buf = stdin_buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        msg = json.loads(line.decode("utf-8", errors="ignore"))
                    except Exception:
                        continue
                    kind = msg.get("t")
                    if kind == "in":
                        raw = base64.b64decode(msg.get("d", ""))
                        if raw:
                            try:
                                os.write(master_fd, raw)
                            except OSError:
                                pass
                    elif kind == "resize":
                        set_winsize(master_fd, msg.get("rows", 24), msg.get("cols", 80))

            # Reap child if already exited
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    # Drain any remaining bytes
                    while True:
                        r, _, _ = select.select([master_fd], [], [], 0.02)
                        if not r:
                            break
                        try:
                            leftover = os.read(master_fd, 16384)
                        except OSError:
                            break
                        if not leftover:
                            break
                        emit({"t": "out", "d": base64.b64encode(leftover).decode("ascii")})
                    code = os.waitstatus_to_exitcode(status)
                    emit({"t": "exit", "code": code})
                    return
            except ChildProcessError:
                emit({"t": "exit", "code": 0})
                return
    finally:
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        try:
            os.close(master_fd)
        except Exception:
            pass

    emit({"t": "exit", "code": 0})


if __name__ == "__main__":
    main()
