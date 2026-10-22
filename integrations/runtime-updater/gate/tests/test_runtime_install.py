import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class RuntimeInstallTest(unittest.TestCase):
    def load(self):
        source = Path(__file__).parents[1] / 'gate/runtime_install.py'
        self.assertTrue(source.exists(), 'staged runtime installer is missing')
        spec = importlib.util.spec_from_file_location('runtime_install', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_candidate_is_verified_before_atomic_entrypoint_switch(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'lib/old-pi.js'
            old.parent.mkdir()
            old.write_text('old package remains available')
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../lib/old-pi.js')
            def run(argv, **kwargs):
                if 'install' in argv:
                    self.assertEqual((root / 'bin/pi').resolve(), old)
                    self.assertIn('--ignore-scripts', argv)
                    self.assertIn('@earendil-works/pi-coding-agent@1.3.0', argv)
                    prefix = Path(argv[argv.index('--prefix') + 1])
                    (prefix / 'bin').mkdir(parents=True)
                    (prefix / 'bin/pi').write_text('new pi')
                    return subprocess.CompletedProcess(argv, 0)
                return subprocess.CompletedProcess(argv, 0, stdout='1.3.0\n')
            with patch.object(install.subprocess, 'run', side_effect=run):
                result = install.install(root, '1.3.0', 'a' * 32)
                self.assertEqual((root / 'bin/pi').resolve(), old, 'preparation must not activate')
                result = install.install(root, '1.3.0', 'a' * 32, 'activate')
            self.assertTrue(result['ok'])
            self.assertEqual((root / 'bin/pi').read_text(), 'new pi')
            self.assertEqual(old.read_text(), 'old package remains available')
            self.assertEqual(result['version'], '1.3.0')

    def test_failed_version_verification_preserves_previous_entrypoint(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../old')
            with patch.object(install.subprocess, 'run', return_value=
                              subprocess.CompletedProcess([], 0, stdout='wrong-version\n')):
                result = install.install(root, '1.3.0', 'b' * 32)
            self.assertFalse(result['ok'])
            self.assertEqual((root / 'bin/pi').readlink(), Path('../old'))

    def test_repeated_task_is_unknown_not_a_clean_install_failure(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../old')
            (root / '.pi-releases' / ('c' * 32)).mkdir(parents=True)
            result = install.install(root, '1.3.0', 'c' * 32)
            self.assertEqual(result, {'ok': False, 'stage': 'activation_unknown'})

    def test_activation_requires_a_prepared_receipt(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/pi').symlink_to('../old')
            self.assertIn('action', __import__('inspect').signature(install.install).parameters)
            result = install.install(root, '1.3.0', 'c' * 32, 'activate')
            self.assertFalse(result['ok'])
            self.assertEqual((root / 'bin/pi').readlink(), Path('../old'))

    def test_unaudited_version_refused_before_filesystem_or_npm(self):
        install = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                install.install(root, '1.4.0', 'd' * 32)
            self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
