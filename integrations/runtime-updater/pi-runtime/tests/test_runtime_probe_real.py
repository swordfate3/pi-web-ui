"""Controller-run black-box tests INSIDE an isolated offline helper image.

No resource creation here. Controller supplies Gate's bound request as JSON in
PI_RUNTIME_PROBE_REAL_REQUEST (and optionally PI_RUNTIME_PROBE_RESTORE_REQUEST).
Absent inputs are explicitly skipped, never counted as compatibility evidence.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest

RUNTIME = Path(__file__).resolve().parents[1]


def load_probe():
    spec = importlib.util.spec_from_file_location('fixed_real_probe', RUNTIME / 'runtime_probe.py')
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    return probe


class RealProbeTests(unittest.TestCase):
    def invoke(self, request, *arguments):
        result = subprocess.run(['/usr/bin/python3', '-I', str(RUNTIME / 'runtime_probe.py'), *arguments],
                                input=json.dumps(request), text=True, capture_output=True,
                                env={'HOME': '/tmp', 'PATH': '/usr/local/bin:/usr/bin:/bin'}, timeout=255)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stderr, '')
        value = json.loads(result.stdout)
        self.assertIs(value['ok'], True)
        return value

    @unittest.skipUnless(os.environ.get('PI_RUNTIME_PROBE_REAL_REQUEST'), 'controller offline helper required')
    def test_real_pty_web_generation_taint_negative_contract_and_supervisor_refresh(self):
        request = json.loads(os.environ['PI_RUNTIME_PROBE_REAL_REQUEST'])
        probe = load_probe()
        value = self.invoke(request)
        self.assertEqual(set(value), {'ok', 'version', 'changed', 'evidence'})
        self.assertIs(value['changed'], False)
        self.assertEqual(value['version'], request['release']['version'])
        evidence = value['evidence']
        self.assertEqual(evidence['candidate_hash'], probe.digest(request['candidate']))
        self.assertEqual(evidence['release_hash'], probe.digest(request['release']))
        self.assertEqual(evidence['profile_hash'], probe.digest(request['profile']))
        self.assertEqual(set(evidence['checks']), {
            'exact_version', 'node_engine', 'web_extension', 'pty_guard', 'input_barrier',
            'async_taint', 'generation_idle', 'session_restore', 'no_replay'})
        self.assertTrue(all(check is True for check in evidence['checks'].values()))
        original = probe.PREFIX / '.pi-releases' / request['task']
        self.assertEqual(probe.tree_digest(original), request['candidate']['tree_sha256'])

    @unittest.skipUnless(os.environ.get('PI_RUNTIME_PROBE_RESTORE_REQUEST'), 'controller frozen capture required')
    def test_real_restore_preserves_frozen_capture_and_binds_observation(self):
        request = json.loads(os.environ['PI_RUNTIME_PROBE_RESTORE_REQUEST'])
        probe = load_probe()
        original = Path(request['session_path']).read_bytes()
        value = self.invoke(request, '--restore')
        self.assertEqual(value['contract'], 'pi-runtime-restore-v1')
        self.assertEqual(value['session_sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(value['expected_hash'], probe.digest(request['expected']))
        self.assertEqual(value['candidate_tree_sha256'], probe.tree_digest(Path(request['candidate_prefix'])))
        self.assertEqual(value['cwd_mode'], 'surrogate')
        self.assertIs(value['no_replay'], True)
        self.assertEqual(value['restored'], {key: request['expected'][key] for key in (
            'session_id', 'leaf_id', 'cwd', 'provider', 'model', 'thinking')})
        self.assertEqual(Path(request['session_path']).read_bytes(), original)

    @unittest.skipUnless(os.environ.get('PI_RUNTIME_PROBE_SOURCE_REQUEST'), 'controller measured source required')
    def test_real_source_uses_measured_package_and_observes_all_nine_checks(self):
        request = json.loads(os.environ['PI_RUNTIME_PROBE_SOURCE_REQUEST'])
        probe = load_probe()
        value = self.invoke(request, '--source')
        self.assertEqual(set(value), {'ok', 'source_hash', 'profile_hash', 'node', 'checks'})
        self.assertEqual(value['source_hash'], probe.digest(request['source']))
        self.assertEqual(value['profile_hash'], probe.digest(request['profile']))
        self.assertEqual(set(value['checks']), {
            'exact_version', 'node_engine', 'web_extension', 'pty_guard', 'input_barrier',
            'async_taint', 'generation_idle', 'session_restore', 'no_replay'})
        self.assertTrue(all(check is True for check in value['checks'].values()))
        self.assertEqual(probe.tree_digest(Path(request['source']['package'])), request['source']['tree_sha256'])


if __name__ == '__main__':
    unittest.main()
