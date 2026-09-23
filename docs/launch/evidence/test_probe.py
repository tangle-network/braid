"""Regression checks for launch probe evidence capture."""

import os
import signal
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import probe


class ProbeEvidenceTest(unittest.TestCase):
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
                probe.save_raw('auth-failure', f'Authorization: Bearer {secret}',
                               f'ANTHROPIC_AUTH_TOKEN={secret}')
                with redirect_stdout(StringIO()) as printed:
                    probe.record({'diagnostic': {'message': f'token was {secret}'}})
                saved = ''.join(path.read_text() for path in probe.OUTPUT_ROOT.rglob('*')
                                if path.is_file())
                self.assertNotIn(secret, saved + printed.getvalue())
            finally:
                probe.ACTIVE_SECRETS.remove(secret)
                probe.OUTPUT_ROOT, probe.RAW, probe.RESULTS = old_root, old_raw, old_results

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
