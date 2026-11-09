import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2] / 'codebuddy-hotkeys-quickstart'
sys.path.insert(0, str(ROOT))
import hotkeys as h
import remote_hotkeys as remote


class RemoteConfigTests(unittest.TestCase):
    def test_expected_commit_cli_is_validated_and_sent_in_stdin(self):
        commit = '22e67e2a976382fdb01b02588226f2cfd9e24dc3'
        with mock.patch.object(sys, 'argv', ['remote_hotkeys.py', 'apply', '--host', 'test-alias', '--expected-commit', commit]), mock.patch.object(remote.subprocess, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(remote.main(), 0)
            payload = json.loads(run.call_args.kwargs['input'])
            self.assertEqual(payload['expectedCommit'], commit)
            self.assertEqual(payload['commit'], 'auto')
        for invalid in ('abc', 'g' * 40, commit + '\n'):
            with mock.patch.object(sys, 'argv', ['remote_hotkeys.py', 'apply', '--host', 'test-alias', '--expected-commit', invalid]), mock.patch.object(remote.subprocess, 'run') as run, mock.patch('sys.stderr'):
                with self.assertRaises(SystemExit):
                    remote.main()
                run.assert_not_called()

    def test_shared_config_and_legacy_runtime_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({**h.DEFAULTS, 'new_chat_enabled': False, 'stop_enabled': False, 'focus_enabled': False}))
            config, focus = remote.load_config(path)
            self.assertFalse(config['newChatEnabled'])
            self.assertEqual(config['stopMode'], 'disabled')
            self.assertFalse(focus)
            path.write_text(json.dumps(config))
            self.assertEqual(remote.load_config(path), (config, True))


@unittest.skipUnless(os.environ.get('CODEBUDDY_TEST_REMOTE_HOST') and os.environ.get('CODEBUDDY_TEST_ORIGINAL') and shutil.which('node'), 'Set remote host and original Webview paths; Node required')
class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.commit = os.environ.get('CODEBUDDY_TEST_REMOTE_COMMIT', remote.COMMIT)
        self.profile = remote.BUILDS[self.commit]
        self.base = self.home / '.codebuddy-server-cn/bin' / ('stable-' + self.commit)
        self.base.mkdir(parents=True)
        (self.base / 'product.json').write_text(json.dumps({'commit': self.commit}))
        (self.base / 'package.json').write_text(json.dumps({'version': '1.106.1'}))
        ext = self.base / 'extensions/genie'
        (ext / 'out/extension').mkdir(parents=True)
        (ext / 'out/webviews').mkdir()
        (ext / 'package.json').write_text(json.dumps({'version': '3.10.0'}))
        self.host = ext / 'out/extension/index.js'
        self.webview = ext / 'out/webviews' / self.profile['webview']
        shutil.copyfile(os.environ['CODEBUDDY_TEST_REMOTE_HOST'], self.host)
        shutil.copyfile(os.environ['CODEBUDDY_TEST_ORIGINAL'], self.webview)
        (self.base / 'node').symlink_to(shutil.which('node'))
        manifest, runtime = h.runtime_files()
        self.payload = {'commit': self.commit, 'builds': remote.BUILDS, 'manifest': manifest,
            'config': {'newChatEnabled': True, 'newChatShortcut': 'ctrl+cmd+n', 'stopMode': 'double-escape', 'stopShortcut': 'cmd+alt+.', 'doubleEscapeMs': 500, 'scope': 'panel'},
            'library': base64.b64encode((ROOT / 'hotkeys.py').read_bytes()).decode(),
            'runtime': {name: base64.b64encode(value.encode()).decode() for name, value in runtime.items()}}

    def run_worker(self, command, ok=True, worker=None):
        result = subprocess.run([sys.executable, '-c', worker or remote.WORKER], input=json.dumps({**self.payload, 'command': command}), text=True, capture_output=True, env={**os.environ, 'HOME': str(self.home)})
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def test_preflight_install_repeat_restore_and_refuse_external_changes(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        checked = self.run_worker('preflight')
        self.assertIs(checked['checksPassed'], True)
        self.assertEqual(checked['target'], {'commit': self.commit, 'appVersion': '1.106.1', 'extensionVersion': '3.10.0', 'base': str(self.base.resolve())})
        backup = self.base / 'app-hook-studio-remote-backup'
        self.assertFalse(backup.exists())
        self.assertEqual(self.run_worker('apply')['phase'], 'applied')
        installed = [self.host.read_bytes(), self.webview.read_bytes()]
        result = self.run_worker('apply', ok=False)
        self.assertIn('restore', result.stderr)
        self.assertEqual([self.host.read_bytes(), self.webview.read_bytes()], installed)
        self.host.write_bytes(installed[0] + b'// external change\n')
        self.run_worker('restore', ok=False)
        self.assertEqual(self.webview.read_bytes(), installed[1])
        self.host.write_bytes(installed[0])
        self.assertEqual(self.run_worker('restore')['phase'], 'restored')
        self.assertEqual([self.host.read_bytes(), self.webview.read_bytes()], before)
        self.run_worker('apply')
        self.assertEqual((backup / 'host.before').read_bytes(), before[0])
        (backup / 'webview.before').write_bytes(b'damaged')
        self.run_worker('apply', ok=False)

    def test_focus_switch_omits_remote_command_registration(self):
        before = self.host.read_bytes()
        self.payload['focusEnabled'] = False
        self.run_worker('apply')
        self.assertEqual(self.host.read_bytes(), before)
        self.run_worker('restore')
        self.payload['focusEnabled'] = True
        self.run_worker('apply')
        self.assertIn(b'app-hook-studio.codebuddy.focusInput', self.host.read_bytes())
        self.run_worker('restore')
        self.payload['focusEnabled'] = False
        self.run_worker('apply')
        self.assertEqual(self.host.read_bytes(), before)

    def test_auto_never_falls_back_to_an_installed_but_inactive_directory(self):
        self.payload['commit'] = 'auto'
        result = self.run_worker('apply', ok=False)
        self.assertIn('Cannot select active server build unambiguously', result.stderr)
        self.assertFalse((self.base / 'app-hook-studio-remote-backup').exists())

    def assert_no_writes(self, before):
        self.assertEqual([self.host.read_bytes(), self.webview.read_bytes()], before)
        self.assertFalse((self.base / 'app-hook-studio-remote-backup').exists())

    def test_unknown_commit_refused_before_backup_creation(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        (self.base / 'product.json').write_text('{"commit":"unknown"}')
        result = self.run_worker('apply', ok=False)
        self.assertIn('unknown', result.stderr)
        self.assertIn('appVersion', result.stderr)
        self.assertIn('extensionVersion', result.stderr)
        self.assertIn('no writes', result.stderr)
        self.assert_no_writes(before)

    def test_missing_and_unsupported_versions_refuse_without_backups(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        for relative in ('package.json', 'extensions/genie/package.json'):
            path = self.base / relative
            saved = path.read_bytes()
            for content in ('{}', '{"version":""}', '{"version":"999.0"}', None):
                if content is None:
                    path.unlink()
                else:
                    path.write_text(content)
                result = self.run_worker('apply', ok=False)
                self.assertEqual(result.stdout, '')
                self.assertIn('appVersion', result.stderr)
                self.assertIn('extensionVersion', result.stderr)
                self.assertIn('<missing>' if content != '{"version":"999.0"}' else '999.0', result.stderr)
                self.assertIn('no writes', result.stderr)
                self.assert_no_writes(before)
                path.write_bytes(saved)

    def test_expected_commit_mismatch_refuses_even_with_explicit_commit(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        self.payload['expectedCommit'] = '0' * 40
        # Simulate actual active build without depending on host /proc processes.
        worker = remote.WORKER.replace("    active = set()", "    active = {payload['commit']}", 1)
        result = self.run_worker('apply', ok=False, worker=worker)
        self.assertIn('expected commit mismatch', result.stderr)
        self.assertIn(self.commit, result.stderr)
        self.assertIn('no writes', result.stderr)
        self.assert_no_writes(before)

    def test_expected_commit_matches_actual_active_build(self):
        self.payload['expectedCommit'] = self.commit
        worker = remote.WORKER.replace("    active = set()", "    active = {payload['expectedCommit']}", 1)
        self.payload['commit'] = 'auto'
        result = self.run_worker('preflight', worker=worker)
        self.assertEqual(result['target']['commit'], self.commit)
        self.assertIs(result['checksPassed'], True)
        self.assertFalse((self.base / 'app-hook-studio-remote-backup').exists())
        self.assertEqual(self.run_worker('apply', worker=worker)['phase'], 'applied')

    def test_build_switch_before_lock_leaves_no_backup_directory(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        worker = remote.WORKER.replace('def select_build():', 'selection_calls = 0\ndef select_build():\n    global selection_calls\n    selection_calls += 1', 1)
        worker = worker.replace('    return requested\n', "    return requested if selection_calls < 4 else '0' * 40\n", 1)
        result = self.run_worker('apply', ok=False, worker=worker)
        self.assertIn('Unsupported active remote commit', result.stderr)
        self.assert_no_writes(before)

    def test_unknown_active_build_reports_versions_without_backups(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        self.payload['builds'] = {}
        result = self.run_worker('apply', ok=False)
        self.assertIn('Unsupported active remote commit', result.stderr)
        self.assertIn('1.106.1', result.stderr)
        self.assertIn('3.10.0', result.stderr)
        self.assert_no_writes(before)

    def test_failed_digest_or_syntax_never_emits_verified_target(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        self.host.write_bytes(before[0] + b'// changed\n')
        result = self.run_worker('preflight', ok=False)
        self.assertEqual(result.stdout, '')
        self.host.write_bytes(before[0])
        worker = remote.WORKER.replace('if syntax.returncode:', 'if True:')
        result = self.run_worker('preflight', ok=False, worker=worker)
        self.assertIn('syntax invalid', result.stderr)
        self.assertEqual(result.stdout, '')
        self.assert_no_writes(before)

    def test_active_build_rechecked_during_locked_plan(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        # The fifth selection happens in plan() after entering the lock.
        worker = remote.WORKER.replace('def select_build():', 'selection_calls = 0\ndef select_build():\n    global selection_calls\n    selection_calls += 1', 1)
        worker = worker.replace('    return requested\n', "    return requested if selection_calls < 5 else '0' * 40\n", 1)
        result = self.run_worker('apply', ok=False, worker=worker)
        self.assertIn('Unsupported active remote commit', result.stderr)
        self.assertEqual([self.host.read_bytes(), self.webview.read_bytes()], before)
        backup = self.base / 'app-hook-studio-remote-backup'
        self.assertFalse((backup / 'state.json').exists())
        self.assertEqual(list(backup.iterdir()), [])
