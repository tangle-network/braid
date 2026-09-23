#!/usr/bin/env python3
"""Capability probe for the Braid 0.3.0 launch comparison.

Each step runs one harness CLI in a fresh throwaway directory and records the
exact argv, exit code, duration, and redacted output. The probe observes whether
a capability is present; it does not rank answer quality.

Usage: probe.py <step> <harness> [args]
  turn1   <harness>             remember a random nonce, structured output
  resume  <harness>             new process, resume the turn1 session, recall nonce
  control <harness>             new process, fresh session, same question (negative control)
  hangup  <harness>             start a 20 s shell task under a pty, close the pty, check the task
  bg      claude                claude --bg: detached background session
  serve   opencode              opencode serve + run --attach, close the client pty
"""

import json
import os
import re
import secrets
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK_ROOT = Path(os.environ.get('PROBE_WORK_ROOT', tempfile.gettempdir())) / 'braid-probe'
OUTPUT_ROOT = Path(os.environ.get('PROBE_OUTPUT_DIR', WORK_ROOT / 'capture'))
RAW = OUTPUT_ROOT / 'raw'
STATE = OUTPUT_ROOT / 'state.json'
RESULTS = OUTPUT_ROOT / 'results.jsonl'

# Claude Code, OpenCode, and Pi request GLM-5.2 on the Z.AI coding plan.
# The provider reported GLM-5.3 for Pi in the first recorded turn.
# Codex uses this host's configured default at low effort.
# Claude Code reaches Z.AI through Z.AI's Anthropic-compatible endpoint because the
# probe host has no valid Anthropic login (see calibration-auth-failures.jsonl).
MODELS = {
    'claude': ['--model', 'glm-5.2'],
    'codex': ['-c', 'model_reasoning_effort="low"'],
    'opencode': ['-m', 'zai-coding-plan/glm-5.2'],
    'pi': ['--provider', 'zai-coding-plan', '--model', 'glm-5.2'],
}
ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'

SECRET_PATTERNS = [
    re.compile(r'sk-[A-Za-z0-9_\-]{16,}'),
    re.compile(r'ghp_[A-Za-z0-9]{20,}'),
    re.compile(r'eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}'),
    re.compile(r'(?i)\bBearer\s+[A-Za-z0-9._~+/-]+'),
    re.compile(r'(?i)\b(?:ANTHROPIC_AUTH_TOKEN|[A-Za-z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY))\s*[:=]\s*["\']?[^\s"\',}]+'),
    re.compile(r'(?i)\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[^\s"\',}]+'),
]
SECRET_ENV_NAME = re.compile(r'(?i)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$')
ACTIVE_SECRETS = {value for name, value in os.environ.items()
                  if SECRET_ENV_NAME.search(name) and len(value) >= 4}


def redact(text):
    for secret in sorted(ACTIVE_SECRETS, key=len, reverse=True):
        text = text.replace(secret, '[REDACTED]')
    for pattern in SECRET_PATTERNS:
        text = pattern.sub('[REDACTED]', text)
    if any(secret in text for secret in ACTIVE_SECRETS):
        raise ValueError('credential remained after redaction')
    return text.replace(str(Path.home()), '~')


def redact_record(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_record(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_record(item) for key, item in value.items()}
    return value


def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(state):
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2) + '\n')


def workdir(harness, step):
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f'{harness}-{step}-', dir=WORK_ROOT))


def record(entry):
    entry = redact_record(entry)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    with RESULTS.open('a') as handle:
        handle.write(json.dumps(entry) + '\n')
    print(json.dumps(entry, indent=2))


def zai_key():
    for line in (Path.home() / '.pi' / 'agent' / '.env').read_text().splitlines():
        if line.startswith('ZAI_API_KEY='):
            key = line.split('=', 1)[1].strip().strip('"\'')
            ACTIVE_SECRETS.add(key)
            return key
    raise SystemExit('ZAI_API_KEY is not configured')


def harness_env(argv):
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith('CLAUDE_CODE_') or k in ('CLAUDECODE', 'CLAUDE_PID'))}
    if argv and (Path(argv[0]).name == 'opencode' or 'opencode' in argv[:2]):
        # This host wraps `opencode run` so each non-interactive call gets a disposable
        # data dir. Naming the series keeps one data dir across calls, which matches a
        # stock OpenCode install where sessions persist between runs.
        env['OPENCODE_RUNTIME_ID'] = 'braid-launch-probe'
        if os.environ.get('PROBE_OPENCODE_REAL') == '1':
            # The same wrapper starts OpenCode under GNU `timeout`, which moves it out of the
            # terminal's foreground process group. Terminal-close steps use the real binary.
            real_binary = Path.home() / '.opencode' / 'bin' / 'opencode'
            if not real_binary.is_file():
                raise SystemExit(f'OpenCode binary is missing at {real_binary}')
            env['PATH'] = str(real_binary.parent) + os.pathsep + env['PATH']
    if argv and argv[0] == 'claude' or 'claude' in argv[:4]:
        env['ANTHROPIC_BASE_URL'] = ZAI_ANTHROPIC_BASE_URL
        env['ANTHROPIC_AUTH_TOKEN'] = zai_key()
    return env


def run(argv, cwd, timeout=300):
    started = time.time()
    try:
        proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL, env=harness_env(argv))
        code, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as error:
        code, out, err = 'timeout', error.stdout or '', error.stderr or ''
        if isinstance(out, bytes):
            out = out.decode(errors='replace')
        if isinstance(err, bytes):
            err = err.decode(errors='replace')
    return code, out, err, round(time.time() - started, 1)


def save_raw(name, out, err):
    RAW.mkdir(parents=True, exist_ok=True)
    capture_id = secrets.token_hex(8)
    stdout = RAW / f'{name}-{capture_id}.stdout'
    with stdout.open('x') as handle:
        handle.write(redact(out))
    files = {'capture_id': capture_id, 'stdout': str(stdout.relative_to(OUTPUT_ROOT))}
    if err.strip():
        stderr = RAW / f'{name}-{capture_id}.stderr'
        with stderr.open('x') as handle:
            handle.write(redact(err))
        files['stderr'] = str(stderr.relative_to(OUTPUT_ROOT))
    return files


def jsonl(text):
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


def extract(harness, out):
    """Return (session_id, assistant_text, usage_fields) from structured output."""
    session, texts, usage = None, [], {}
    if harness == 'claude':
        try:
            doc = json.loads(out)
        except json.JSONDecodeError:
            return None, '', {}
        return doc.get('session_id'), doc.get('result') or '', {
            k: doc.get(k) for k in ('usage', 'total_cost_usd', 'duration_ms', 'num_turns') if k in doc}
    for event in jsonl(out):
        kind = event.get('type')
        if harness == 'codex':
            if kind == 'thread.started':
                session = event.get('thread_id')
            item = event.get('item') or {}
            if kind == 'item.completed' and item.get('type') == 'agent_message':
                texts.append(item.get('text') or '')
            if kind == 'turn.completed':
                usage['usage'] = event.get('usage')
        elif harness == 'opencode':
            session = session or event.get('sessionID')
            part = event.get('part') or {}
            if part.get('type') == 'text':
                texts.append(part.get('text') or '')
            if part.get('type') == 'step-finish':
                usage.setdefault('steps', []).append({k: part.get(k) for k in ('tokens', 'cost')})
        elif harness == 'pi':
            if kind == 'session':
                session = event.get('id')
            if kind == 'message_end':
                message = event.get('message') or {}
                if message.get('role') == 'assistant':
                    for block in message.get('content') or []:
                        if block.get('type') == 'text':
                            texts.append(block.get('text') or '')
                    if message.get('usage'):
                        usage.setdefault('messages', []).append(message.get('usage'))
    return session, '\n'.join(texts), usage


def turn_argv(harness, prompt, session=None):
    if harness == 'claude':
        argv = ['claude', '-p', '--output-format', 'json', *MODELS['claude']]
        if session:
            argv += ['--resume', session]
        return argv + [prompt]
    if harness == 'codex':
        base = ['codex', 'exec']
        if session:
            base += ['resume', session]
        return base + ['--json', '--skip-git-repo-check', *MODELS['codex'], prompt]
    if harness == 'opencode':
        argv = ['opencode', 'run', '--pure', '--format', 'json', *MODELS['opencode']]
        if session:
            argv += ['--session', session]
        return argv + [prompt]
    if harness == 'pi':
        argv = ['pi', '-p', '--mode', 'json', '-ne', *MODELS['pi']]
        if session:
            argv += ['--session', session]
        return argv + [prompt]
    raise SystemExit(f'unknown harness {harness}')


def step_turn1(harness):
    state = load_state()
    nonce = 'NONCE-' + secrets.token_hex(6).upper()
    cwd = workdir(harness, 'turn1')
    prompt = f'Remember this code for later: {nonce}. Reply with exactly: OK'
    argv = turn_argv(harness, prompt)
    code, out, err, seconds = run(argv, cwd)
    raw = save_raw(f'{harness}-turn1', out, err)
    session, text, usage = extract(harness, out)
    state[harness] = {'nonce': nonce, 'cwd': str(cwd), 'session': session}
    save_state(state)
    record({'step': 'turn1', 'harness': harness, 'argv': [redact(a) for a in argv], 'cwd': redact(str(cwd)),
            'exit': code, 'seconds': seconds, 'session_id_present': bool(session),
            'structured_events': len(jsonl(out)) or (1 if harness == 'claude' and session else 0),
            'usage_fields': usage, 'assistant_text': text[:200], 'raw': raw})


def recall(harness, resume):
    state = load_state()[harness]
    nonce = state['nonce']
    prompt = 'What code did I ask you to remember earlier in this conversation? Reply with only the code, or NONE if you do not know it.'
    cwd = state['cwd'] if resume else str(workdir(harness, 'control'))
    argv = turn_argv(harness, prompt, state['session'] if resume else None)
    code, out, err, seconds = run(argv, cwd)
    name = 'resume' if resume else 'control'
    raw = save_raw(f'{harness}-{name}', out, err)
    session, text, usage = extract(harness, out)
    record({'step': name, 'harness': harness, 'argv': [redact(a) for a in argv], 'cwd': redact(cwd),
            'exit': code, 'seconds': seconds, 'same_session_id': session == state['session'],
            'nonce_in_assistant_text': nonce in text, 'assistant_text': text[:200],
            'usage_fields': usage, 'raw': raw})


def pty_command(argv):
    # `script` gives the harness a real pseudo-terminal. Killing `script` closes the
    # pty master, so the kernel hangs up the harness exactly as a closed terminal would.
    return ['setsid', 'script', '-qfec', ' '.join(shell_quote(a) for a in argv), '/dev/null']


def shell_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


def descendant_pids(root_pid):
    children = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / 'status').read_text()
            parent = int(next(line.split()[1] for line in status.splitlines()
                              if line.startswith('PPid:')))
        except (OSError, StopIteration, ValueError):
            continue
        children.setdefault(parent, []).append(int(entry.name))
    found = set()
    pending = [root_pid]
    while pending:
        for child in children.get(pending.pop(), []):
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def actual_sleep_pids(seconds, root_pid=None, cwd=None):
    candidates = descendant_pids(root_pid) if root_pid is not None else (
        int(entry.name) for entry in Path('/proc').iterdir() if entry.name.isdigit())
    found = []
    for pid in candidates:
        try:
            base = Path(os.readlink(f'/proc/{pid}/exe')).name
            argv = (Path(f'/proc/{pid}/cmdline').read_bytes().rstrip(b'\0').split(b'\0'))
            process_cwd = Path(os.readlink(f'/proc/{pid}/cwd')) if cwd else None
        except OSError:
            continue
        if base == 'sleep' and argv[1:] == [seconds.encode()] and (
            cwd is None or process_cwd == Path(cwd)
        ):
            found.append(pid)
    return found


def wait_for_sleep(seconds, timeout, root_pid=None, cwd=None, process=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = actual_sleep_pids(seconds, root_pid=root_pid, cwd=cwd)
        if found:
            return found
        if process is not None and process.poll() is not None:
            break
        time.sleep(0.5)
    return []


def alive(pids):
    return [pid for pid in pids if Path(f'/proc/{pid}').exists()]


def hangup_task(harness, argv, cwd, marker_seconds, shell_runs_in_server=False):
    marker = Path(cwd) / 'marker.txt'
    proc = subprocess.Popen(pty_command(argv), cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env=harness_env(argv))
    sleepers = wait_for_sleep(marker_seconds, 150,
                              root_pid=None if shell_runs_in_server else proc.pid,
                              cwd=cwd if shell_runs_in_server else None, process=proc)
    marker_existed_at_close = marker.exists()
    if proc.poll() is None:
        os.kill(proc.pid, signal.SIGKILL)
    out, err = proc.communicate(timeout=10)
    time.sleep(2)
    sleepers_after_close = alive(sleepers)
    if sleepers:
        time.sleep(float(marker_seconds) + 10)
    return {
        'task_started_before_close': bool(sleepers),
        'marker_existed_at_close': marker_existed_at_close,
        'shell_children_alive_2s_after_close': len(sleepers_after_close),
        'marker_written_after_close': marker.exists() and not marker_existed_at_close,
        **({'invalid': 'No actual sleep child started before the PTY closed'} if not sleepers else {}),
    }, out, err


def step_hangup(harness):
    seconds = {'claude': '20.1', 'codex': '20.2', 'opencode': '20.3', 'pi': '20.4'}[harness]
    cwd = workdir(harness, 'hangup')
    prompt = (f'Use your shell tool to run exactly this command and wait for it: '
              f'sleep {seconds} && echo finished > marker.txt . Then reply DONE.')
    if harness == 'claude':
        argv = ['claude', '-p', '--permission-mode', 'bypassPermissions', *MODELS['claude'], prompt]
    elif harness == 'codex':
        argv = ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
                *MODELS['codex'], prompt]
    elif harness == 'opencode':
        argv = [opencode_binary(), 'run', '--pure', '--auto', *MODELS['opencode'], prompt]
    else:
        argv = ['pi', '-p', '-ne', *MODELS['pi'], prompt]
    observed, out, err = hangup_task(harness, argv, cwd, seconds)
    raw = save_raw(f'{harness}-hangup', out, err)
    record({'step': 'hangup', 'harness': harness, 'argv': [redact(a) for a in argv],
            'cwd': redact(str(cwd)), 'mode': 'foreground CLI under a pty; pty closed after the task started',
            'raw': raw, **observed})


def step_bg():
    cwd = workdir('claude', 'bg')
    marker = cwd / 'marker.txt'
    prompt = ('Use your shell tool to run exactly this command and wait for it: '
              'sleep 20.5 && echo finished > marker.txt . Then reply DONE.')
    argv = ['claude', '--bg', '--permission-mode', 'bypassPermissions', *MODELS['claude'], prompt]
    code, out, err, seconds = run(argv, cwd, timeout=120)
    launch_raw = save_raw('claude-bg-launch', out, err)
    match = re.search(r'backgrounded \S+ ([a-z0-9]{6,12})', re.sub(r'\x1b\[[0-9;]*m', '', out))
    sleepers = wait_for_sleep('20.5', 150, cwd=cwd)
    time.sleep(35)
    session_id = match.group(1) if match else None
    logs = run(['claude', 'logs', session_id], cwd, timeout=60) if session_id else ('n/a', '', '', 0)
    logs_raw = save_raw('claude-bg-logs', logs[1], logs[2])
    record({'step': 'bg', 'harness': 'claude', 'argv': [redact(a) for a in argv], 'cwd': redact(str(cwd)),
            'launcher_exit': code, 'launcher_seconds': seconds, 'launcher_output': redact(out.strip())[:300],
            'session_id': session_id, 'task_started_after_launcher_exit': bool(sleepers),
            'marker_written': marker.exists(), 'logs_exit': logs[0],
            'raw': {'launch': launch_raw, 'logs': logs_raw}})
    if session_id:
        stop = run(['claude', 'stop', session_id], cwd, timeout=60)
        remove = run(['claude', 'rm', session_id], cwd, timeout=60)
        record({'step': 'bg-cleanup', 'harness': 'claude', 'stop_exit': stop[0], 'rm_exit': remove[0],
                'stop_output': redact(stop[1] + stop[2]).strip()[:300],
                'rm_output': redact(remove[1] + remove[2]).strip()[:300],
                'raw': {'stop': save_raw('claude-bg-stop', stop[1], stop[2]),
                        'remove': save_raw('claude-bg-remove', remove[1], remove[2])}})


def opencode_binary():
    binary = Path.home() / '.opencode' / 'bin' / 'opencode'
    if not binary.is_file():
        raise SystemExit(f'OpenCode binary is missing at {binary}')
    return str(binary)


def free_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(('127.0.0.1', 0))
        return reservation.getsockname()[1]


def owns_listening_port(pid, port):
    """Check the server child owns the IPv4 listening socket before attaching."""
    try:
        listeners = set()
        for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '0A' and int(fields[1].split(':')[1], 16) == port:
                listeners.add(fields[9])
        return any(os.readlink(fd).removeprefix('socket:[').removesuffix(']') in listeners
                   for fd in Path(f'/proc/{pid}/fd').iterdir())
    except OSError:
        return False


def wait_for_own_server(server, port, timeout=30):
    output = bytearray()
    deadline = time.monotonic() + timeout
    expected = f'opencode server listening on http://127.0.0.1:{port}'.encode()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([server.stdout], [], [], 0.25)
        if ready:
            chunk = os.read(server.stdout.fileno(), 4096)
            if chunk:
                output.extend(chunk)
        if expected in output and server.poll() is None and owns_listening_port(server.pid, port):
            return True, output.decode(errors='replace')
        if server.poll() is not None:
            break
    return False, output.decode(errors='replace')


def step_serve():
    cwd = workdir('opencode', 'serve')
    port = free_loopback_port()
    serve_argv = [opencode_binary(), 'serve', '--pure', '--hostname', '127.0.0.1',
                  '--port', str(port)]
    server = subprocess.Popen(serve_argv, cwd=cwd, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              start_new_session=True, env=harness_env(['opencode', 'serve']))
    ready, startup_output = wait_for_own_server(server, port)
    prompt = ('Use your shell tool to run exactly this command and wait for it: '
              'sleep 20.6 && echo finished > marker.txt . Then reply DONE.')
    argv = [opencode_binary(), 'run', '--attach', f'http://127.0.0.1:{port}',
            '--dir', str(cwd), '--auto', *MODELS['opencode'], prompt]
    observed, out, err = {'invalid': 'The probe server did not own its requested listening port'}, '', ''
    try:
        if ready:
            observed, out, err = hangup_task('opencode', argv, cwd, '20.6',
                                             shell_runs_in_server=True)
        server_alive = server.poll() is None
    finally:
        if server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
        try:
            remaining_output, _ = server.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
            remaining_output, _ = server.communicate(timeout=10)
    raw = {'server': save_raw('opencode-serve-server',
                              startup_output + remaining_output.decode(errors='replace'), ''),
           'client': save_raw('opencode-serve-client', out, err)}
    record({'step': 'serve', 'harness': 'opencode', 'argv': [redact(a) for a in argv],
            'serve_argv': [redact(a) for a in serve_argv], 'cwd': redact(str(cwd)),
            'mode': 'opencode serve in its own session; client under a pty; client pty closed after the task started',
            'server_port': port, 'server_owned_listening_port_before_attach': ready,
            'server_alive_at_end': server_alive, 'raw': raw, **observed})


if __name__ == '__main__':
    step, *rest = sys.argv[1:]
    if step == 'turn1':
        step_turn1(rest[0])
    elif step == 'resume':
        recall(rest[0], True)
    elif step == 'control':
        recall(rest[0], False)
    elif step == 'hangup':
        step_hangup(rest[0])
    elif step == 'bg':
        step_bg()
    elif step == 'serve':
        step_serve()
    else:
        raise SystemExit(__doc__)
