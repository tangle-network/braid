"""Regression checks for launch probe evidence capture."""

import os
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

import probe


class ProbeEvidenceTest(unittest.TestCase):
    def test_claude_credential_requires_explicit_environment_input(self):
        secret = 'synthetic-zai-key-1234567890'
        try:
            with mock.patch.dict(os.environ, {'ZAI_API_KEY': secret}):
                with mock.patch.object(Path, 'read_text', side_effect=AssertionError('private file read')):
                    self.assertEqual(secret, probe.zai_key())
                    self.assertEqual(secret, probe.harness_env(['claude', '-p'])['ANTHROPIC_AUTH_TOKEN'])
        finally:
            probe.ACTIVE_SECRETS.discard(secret)
        with mock.patch.dict(os.environ, {'ZAI_API_KEY': ''}):
            with self.assertRaisesRegex(SystemExit, 'Set ZAI_API_KEY'):
                probe.zai_key()

    def test_credential_forms_are_redacted_before_storage(self):
        secret = 'synthetic-key-value-1234567890'
        bearer = 'synthetic.bearer.value-1234567890'
        auth_token = 'synthetic-auth-token-value-1234567890'
        probe.ACTIVE_SECRETS.add(secret)
        try:
            captured = probe.redact_record({
                'stdout': f'Authorization: Bearer {bearer}\nANTHROPIC_AUTH_TOKEN={auth_token}',
                'nested': [f'Bearer {secret}', f'standalone {secret}'],
            })
        finally:
            probe.ACTIVE_SECRETS.remove(secret)
        for value in (secret, bearer, auth_token):
            self.assertNotIn(value, str(captured))
        self.assertIn('[REDACTED]', str(captured))

    def test_credentials_do_not_reach_saved_raw_or_results(self):
        secret = 'synthetic-key-value-1234567890'
        old_root, old_raw, old_results = probe.OUTPUT_ROOT, probe.RAW, probe.RESULTS
        with tempfile.TemporaryDirectory() as directory:
            probe.OUTPUT_ROOT = Path(directory)
            probe.RAW = probe.OUTPUT_ROOT / 'raw'
            probe.RESULTS = probe.OUTPUT_ROOT / 'results.jsonl'
            probe.ACTIVE_SECRETS.add(secret)
            try:
                raw = probe.save_raw('auth-failure', f'Authorization: Bearer {secret}',
                                     f'ANTHROPIC_AUTH_TOKEN={secret}')
                with redirect_stdout(StringIO()) as printed:
                    probe.record({'diagnostic': {'message': f'token was {secret}'}, 'raw': raw})
                saved = ''.join(path.read_text() for path in probe.OUTPUT_ROOT.rglob('*')
                                if path.is_file())
                self.assertNotIn(secret, saved + printed.getvalue())
                self.assertTrue((probe.OUTPUT_ROOT / raw['stdout']).is_file())
                self.assertTrue((probe.OUTPUT_ROOT / raw['stderr']).is_file())
            finally:
                probe.ACTIVE_SECRETS.remove(secret)
                probe.OUTPUT_ROOT, probe.RAW, probe.RESULTS = old_root, old_raw, old_results

    def test_repeated_captures_keep_distinct_raw_files(self):
        old_root, old_raw = probe.OUTPUT_ROOT, probe.RAW
        with tempfile.TemporaryDirectory() as directory:
            probe.OUTPUT_ROOT = Path(directory)
            probe.RAW = probe.OUTPUT_ROOT / 'raw'
            try:
                first = probe.save_raw('repeat', 'first output', '')
                second = probe.save_raw('repeat', 'second output', '')
                self.assertNotEqual(first['capture_id'], second['capture_id'])
                self.assertEqual('first output', (probe.OUTPUT_ROOT / first['stdout']).read_text())
                self.assertEqual('second output', (probe.OUTPUT_ROOT / second['stdout']).read_text())
            finally:
                probe.OUTPUT_ROOT, probe.RAW = old_root, old_raw

    def test_attach_requires_the_server_child_to_own_the_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertTrue(probe.owns_listening_port(os.getpid(), port))
            child = subprocess.Popen(
                [sys.executable, '-c',
                 f'print("opencode server listening on http://127.0.0.1:{port}", flush=True); '
                 'import time; time.sleep(2)'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                ready, output = probe.wait_for_own_server(child, port, timeout=0.5)
                self.assertFalse(ready)
                self.assertIn(str(port), output)
            finally:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()

    def test_prompt_text_cannot_count_as_started_shell_child(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt_only = subprocess.Popen(
                [sys.executable, '-c', 'import time; time.sleep(2)', 'sleep 3.7'],
                cwd=directory, start_new_session=True,
            )
            try:
                matched = subprocess.run(['pgrep', '-f', 'sleep 3.7'], capture_output=True,
                                         text=True, check=True).stdout.splitlines()
                self.assertIn(str(prompt_only.pid), matched)
                self.assertEqual([], probe.wait_for_sleep('3.7', 0.5,
                                                          root_pid=prompt_only.pid,
                                                          process=prompt_only))
            finally:
                os.killpg(prompt_only.pid, signal.SIGKILL)
                prompt_only.wait()

            shell = subprocess.Popen(['sh', '-c', 'sleep 3.7'], cwd=directory,
                                     start_new_session=True)
            try:
                self.assertTrue(probe.wait_for_sleep('3.7', 2,
                                                     root_pid=shell.pid, process=shell))
            finally:
                os.killpg(shell.pid, signal.SIGKILL)
                shell.wait()


if __name__ == '__main__':
    unittest.main()
