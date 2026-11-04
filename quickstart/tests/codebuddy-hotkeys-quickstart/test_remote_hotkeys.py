import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2] / 'codebuddy-hotkeys-quickstart'
sys.path.insert(0, str(ROOT))
import hotkeys as h
import remote_hotkeys as remote


@unittest.skipUnless(os.environ.get('CODEBUDDY_TEST_REMOTE_HOST') and os.environ.get('CODEBUDDY_TEST_ORIGINAL') and shutil.which('node'), 'Set remote host and original Webview paths; Node required')
class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.base = self.home / '.codebuddy-server-cn/bin' / ('stable-' + remote.COMMIT)
        self.base.mkdir(parents=True)
        (self.base / 'product.json').write_text(json.dumps({'commit': remote.COMMIT}))
        (self.base / 'package.json').write_text(json.dumps({'version': '1.106.1'}))
        ext = self.base / 'extensions/genie'
        (ext / 'out/extension').mkdir(parents=True)
        (ext / 'out/webviews').mkdir()
        (ext / 'package.json').write_text(json.dumps({'version': '3.10.0'}))
        self.host = ext / 'out/extension/index.js'
        self.webview = ext / 'out/webviews/main.942dbf9a.chunk.js'
        shutil.copyfile(os.environ['CODEBUDDY_TEST_REMOTE_HOST'], self.host)
        shutil.copyfile(os.environ['CODEBUDDY_TEST_ORIGINAL'], self.webview)
        (self.base / 'node').symlink_to(shutil.which('node'))
        manifest, runtime = h.runtime_files()
        self.payload = {'commit': remote.COMMIT, 'hostHash': remote.HOST_SHA256, 'manifest': manifest,
            'config': {'newChatEnabled': True, 'newChatShortcut': 'ctrl+cmd+n', 'stopMode': 'double-escape', 'stopShortcut': 'cmd+alt+.', 'doubleEscapeMs': 500, 'scope': 'panel'},
            'library': base64.b64encode((ROOT / 'hotkeys.py').read_bytes()).decode(),
            'runtime': {name: base64.b64encode(value.encode()).decode() for name, value in runtime.items()}}

    def run_worker(self, command, ok=True):
        result = subprocess.run([sys.executable, '-c', remote.WORKER], input=json.dumps({**self.payload, 'command': command}), text=True, capture_output=True, env={**os.environ, 'HOME': str(self.home)})
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def test_preflight_install_repeat_restore_and_refuse_external_changes(self):
        before = [self.host.read_bytes(), self.webview.read_bytes()]
        self.run_worker('preflight')
        backup = self.base / 'app-hook-studio-remote-backup'
        self.assertFalse(backup.exists())
        self.assertEqual(self.run_worker('apply')['phase'], 'applied')
        installed = [self.host.read_bytes(), self.webview.read_bytes()]
        result = self.run_worker('apply')
        self.assertTrue(all(not target['changed'] for target in result['targets'].values()))
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

    def test_unknown_commit_refused_before_backup_creation(self):
        (self.base / 'product.json').write_text('{"commit":"unknown"}')
        self.run_worker('apply', ok=False)
        self.assertFalse((self.base / 'app-hook-studio-remote-backup').exists())
