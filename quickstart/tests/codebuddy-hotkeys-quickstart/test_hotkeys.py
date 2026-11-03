import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / "codebuddy-hotkeys-quickstart"
sys.path.insert(0, str(ROOT))
import hotkeys as h

RULE = {"key": "cmd+i", "command": "runCommands", "args": {"commands": ["app-hook-studio.codebuddy.focusInput"]}}

class UnitTests(unittest.TestCase):
    def test_jsonc_preserves_unrelated_strings_comments_and_trailing_commas(self):
        source = '// keep\n[\n {"key":"cmd+k", "command":"user.keep", "args":{"text":"literal // /* quoted \\\" x",},}, // tail\n]\n'
        previous = h.jsonc_document(source)[0]
        added = h.edit_binding(source, RULE, RULE["args"]["commands"][0])
        self.assertEqual(h.jsonc_document(added)[0], previous + [RULE])
        self.assertIn('// tail', added)
        self.assertEqual(h.edit_binding(added, RULE, RULE["args"]["commands"][0]), added)
        removed = h.edit_binding(added, None, RULE["args"]["commands"][0])
        self.assertEqual(h.jsonc_document(removed)[0], previous)
        self.assertIn('// keep', removed)
        self.assertIn('// tail', removed)

    def test_legacy_owned_keybinding_migrates_and_conflicts_are_rejected(self):
        source = '[\n // app-hook-studio:focus-input\n {"key":"cmd+i","command":"coding-copilot.webviews.chat.focus"}\n]'
        changed = h.edit_binding(source, RULE, RULE["args"]["commands"][0])
        self.assertEqual(h.jsonc_document(changed)[0], [RULE])
        with self.assertRaises(ValueError):
            h.edit_binding(changed.replace('runCommands', 'user.changed'), RULE, RULE["args"]["commands"][0])
        with self.assertRaises(ValueError):
            h.edit_binding(json.dumps([RULE]), None, RULE["args"]["commands"][0])
        with self.assertRaises(ValueError):
            h.jsonc_document('[{"key":')

    def test_shortcuts_are_exact_and_plain_focus_or_collisions_fail(self):
        self.assertEqual(h.ide_key('Control+Command+Shift+F5'), 'ctrl+cmd+shift+f5')
        self.assertEqual(h.shortcut('ctrl+cmd+n')["code"], 'KeyN')
        with self.assertRaises(ValueError): h.ide_key('i')
        with self.assertRaises(ValueError): h.shortcut('cmd+cmd+i')
        with self.assertRaises(ValueError): h.shortcut('cmd+esc+esc')
        with self.assertRaises(ValueError): h.settings({"newChatEnabled": True})

    def test_templates_and_reference_vectors_are_self_contained(self):
        manifest, runtime = h.runtime_files()
        self.assertEqual(manifest["host"]["originalSha256"], 'f99b6e1e25e62b442bc7335b67e859f80c3b6d6a1c51d31cfb52591c578aa42e')
        self.assertIn('__webpack_require__(637830).ChatViewService', runtime['focus-host-v2.js'])
        self.assertEqual(len(manifest['referenceVectors']), 3)
        for vector in manifest['referenceVectors']:
            for version, expected in vector['versions'].items():
                self.assertEqual(h.digest(h.render_webview(vector['settings'], int(version), runtime).encode()), expected)

    def test_running_app_blocks_mutation(self):
        result = subprocess.CompletedProcess([], 0, '/Applications/CodeBuddy CN.app/Contents/MacOS/Electron\n', '')
        with patch.object(h.subprocess, 'run', return_value=result), self.assertRaises(ValueError):
            h.require_closed(Path('/Applications/CodeBuddy CN.app'))


REAL = bool(os.environ.get('CODEBUDDY_TEST_ORIGINAL') and os.environ.get('CODEBUDDY_TEST_HOST'))
@unittest.skipUnless(REAL, 'Set original Webview and host paths for real-source integration tests')
class RealSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='codebuddy-python-quickstart-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / 'Example.app'
        self.directory = self.root / 'data'
        self.keybindings = self.root / 'keybindings.json'
        self.manifest, self.runtime = h.runtime_files()
        self.webview = self.app / self.manifest['webview']['path']
        self.host = self.app / self.manifest['host']['artifactRelativePath']
        self.webview.parent.mkdir(parents=True)
        self.host.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(os.environ['CODEBUDDY_TEST_ORIGINAL'], self.webview)
        shutil.copyfile(os.environ['CODEBUDDY_TEST_HOST'], self.host)
        base = self.app / 'Contents/Resources/app'
        (base / 'package.json').write_text(json.dumps({'version': self.manifest['appVersion']}))
        (base / 'extensions/genie/package.json').write_text(json.dumps({'version': self.manifest['extensionVersion']}))
        self.keybindings.write_text('// keep\n[{"key":"cmd+k","command":"user.keep"},]\n')
        self.options = {**h.DEFAULTS, 'app': str(self.app), 'keybindings': str(self.keybindings)}

    def test_preflight_apply_reconfigure_restore_exactly_without_node_or_raycast(self):
        before = [p.read_bytes() for p in (self.webview, self.host, self.keybindings)]
        _, config, targets = h.plan(self.options, self.manifest, self.runtime, None, self.directory)
        self.assertFalse(self.directory.exists())
        self.assertTrue(all(item['current'] != item['candidate'] for item in targets.values()))
        self.assertTrue(h.apply(self.options, self.manifest, self.runtime, self.directory)['changed'])
        self.assertFalse(h.apply(self.options, self.manifest, self.runtime, self.directory)['changed'])
        changed = {**self.options, 'new_chat': 'ctrl+alt+f5', 'stop': 'cmd+alt+.', 'focus': 'cmd+shift+i', 'scope': 'input'}
        h.apply(changed, self.manifest, self.runtime, self.directory)
        state = h.read_state(self.directory)
        self.assertEqual(state['config']['focus'], 'cmd+shift+i')
        self.assertEqual(h.jsonc_document(self.keybindings.read_text())[0][-1]['key'], 'cmd+shift+i')
        h.restore(changed, self.manifest, self.directory)
        self.assertEqual([p.read_bytes() for p in (self.webview, self.host, self.keybindings)], before)
        h.restore(changed, self.manifest, self.directory)

    def test_unknown_target_backup_damage_and_later_user_edits_are_preserved(self):
        self.host.write_bytes(b'unknown')
        with self.assertRaises(ValueError): h.apply(self.options, self.manifest, self.runtime, self.directory)
        shutil.copyfile(os.environ['CODEBUDDY_TEST_HOST'], self.host)
        h.apply(self.options, self.manifest, self.runtime, self.directory)
        edited = self.keybindings.read_bytes() + b'// later user edit\n'
        self.keybindings.write_bytes(edited)
        with self.assertRaises(ValueError): h.restore(self.options, self.manifest, self.directory)
        self.assertEqual(self.keybindings.read_bytes(), edited)
        state = h.read_state(self.directory)
        self.keybindings.write_bytes(h.edit_binding('// keep\n[{"key":"cmd+k","command":"user.keep"},]\n', RULE, self.manifest['focusCommand']).encode())
        self.assertIn(h.digest(self.keybindings.read_bytes()), state['targets']['keybindings']['accepted'])
        (self.directory / 'host.before').write_bytes(b'broken backup')
        with self.assertRaises(ValueError): h.restore(self.options, self.manifest, self.directory)

    def test_all_features_can_be_disabled_and_new_keybindings_file_is_removed_on_restore(self):
        self.keybindings.unlink()
        disabled = {**self.options, 'new_chat': 'off', 'stop': 'off', 'focus': 'off'}
        h.apply(disabled, self.manifest, self.runtime, self.directory)
        self.assertFalse(self.keybindings.exists())
        h.restore(disabled, self.manifest, self.directory)
        self.assertFalse(self.keybindings.exists())
        h.apply(self.options, self.manifest, self.runtime, self.directory)
        self.assertTrue(self.keybindings.exists())
        h.restore(self.options, self.manifest, self.directory)
        self.assertFalse(self.keybindings.exists())

    def test_default_cli_keeps_backups_inside_the_app_and_restores_from_them(self):
        before = [p.read_bytes() for p in (self.webview, self.host, self.keybindings)]
        command = [sys.executable, str(ROOT / 'hotkeys.py'), 'apply', '--app', str(self.app), '--keybindings', str(self.keybindings)]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        directory = self.app / h.BACKUP_RELATIVE
        self.assertEqual(json.loads(result.stdout)['backupDirectory'], str(directory))
        for name, data in zip(('webview', 'host', 'keybindings'), before):
            self.assertEqual((directory / (name + '.before')).read_bytes(), data)
        h.apply({**self.options, 'focus': 'cmd+shift+i'}, self.manifest, self.runtime, directory)
        self.assertEqual((directory / 'keybindings.before').read_bytes(), before[2])
        subprocess.run([sys.executable, str(ROOT / 'hotkeys.py'), 'restore', '--app', str(self.app)], capture_output=True, text=True, check=True)
        self.assertEqual([p.read_bytes() for p in (self.webview, self.host, self.keybindings)], before)
        self.assertTrue((directory / 'state.json').exists())

    def test_running_app_does_not_create_an_in_app_backup_directory(self):
        directory = self.app / h.BACKUP_RELATIVE
        result = subprocess.CompletedProcess([], 0, str(self.app / 'Contents/MacOS/Electron') + '\n', '')
        with patch.object(h.subprocess, 'run', return_value=result), self.assertRaises(ValueError):
            h.apply(self.options, self.manifest, self.runtime, directory)
        self.assertFalse(directory.exists())

    def test_active_legacy_external_backup_is_used_until_restored_then_new_install_is_internal(self):
        home = self.root / 'home'
        legacy = home / 'Library/Application Support/CodeBuddy Hotkeys Quickstart' / hashlib.sha256(str(self.app).encode()).hexdigest()[:16]
        h.apply(self.options, self.manifest, self.runtime, legacy)
        environment = {**os.environ, 'HOME': str(home)}
        base = [sys.executable, str(ROOT / 'hotkeys.py')]
        checked = subprocess.run(base + ['status', '--app', str(self.app)], env=environment, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(checked.stdout)['backupDirectory'], str(legacy))
        subprocess.run(base + ['restore', '--app', str(self.app)], env=environment, capture_output=True, text=True, check=True)
        result = subprocess.run(base + ['apply', '--app', str(self.app), '--keybindings', str(self.keybindings)], env=environment, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['backupDirectory'], str(self.app / h.BACKUP_RELATIVE))
        self.assertTrue((legacy / 'state.json').exists())

    def test_copied_module_runs_with_no_node_or_original_repository_on_path(self):
        copied = self.root / 'portable'
        shutil.copytree(ROOT, copied, ignore=shutil.ignore_patterns('__pycache__', '.git'))
        environment = {**os.environ, 'PATH': '/usr/bin:/bin'}
        command = [sys.executable, str(copied / 'hotkeys.py'), 'apply', '--app', str(self.app), '--keybindings', str(self.keybindings), '--data-dir', str(self.directory)]
        result = subprocess.run(command, cwd=str(self.root), env=environment, capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(result.stdout)['ok'])
        restored = subprocess.run([sys.executable, str(copied / 'hotkeys.py'), 'restore', '--data-dir', str(self.directory)], cwd=str(self.root), env=environment, capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(restored.stdout)['ok'])

    def test_cli_preserves_saved_hotkeys_and_explicit_backup_directory_selects_restore_target(self):
        arguments = [sys.executable, str(ROOT / 'hotkeys.py'), 'apply', '--app', str(self.app), '--keybindings', str(self.keybindings), '--data-dir', str(self.directory), '--new-chat', 'cmd+alt+n', '--focus', 'cmd+shift+i']
        installed = subprocess.run(arguments, capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(installed.stdout)['ok'])
        result = subprocess.run([sys.executable, str(ROOT / 'hotkeys.py'), 'status', '--data-dir', str(self.directory)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['config']['new_chat'], 'cmd+alt+n')
        restored = subprocess.run([sys.executable, str(ROOT / 'hotkeys.py'), 'restore', '--data-dir', str(self.directory)], capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(restored.stdout)['ok'])


if __name__ == '__main__':
    unittest.main()
