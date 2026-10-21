"""Failure injection for the real native fixture's cleanup; never invokes Docker."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
with patch.dict(os.environ, PI_TASK6_GATE_SOURCE='/unused/gate',
                PI_TASK6_DOCKER_SOURCE='/unused/pi'):
    spec = importlib.util.spec_from_file_location(
        'task6_native_stack', REPO / 'e2e/fixtures/task6-native-stack.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)


class DockerBoundary:
    """Model resource existence/labels and fail only the requested Engine action."""

    def __init__(self, stack):
        self.prefix = stack.prefix
        self.resources = {'container': {}, 'volume': {}, 'image': {}}
        self.failures = {}
        self.calls = []

    def add(self, kind, name, *, owner=None):
        self.resources[kind][name] = {
            'Id': native.BASE if name.endswith(':cached-base') else 'sha256:test',
            'Config': {'Labels': {'pi.task6.test': owner or self.prefix}},
            'Labels': {'pi.task6.test': owner or self.prefix},
            'State': {'Running': True},
        }

    def docker(self, *args, **_kwargs):
        self.calls.append(args)
        for head, count in list(self.failures.items()):
            if args[:len(head)] == head and count:
                self.failures[head] -= 1
                if args[0] == 'run':
                    # Model a probe that was created before its client timed out.
                    self.add('container', args[args.index('--name') + 1])
                raise RuntimeError('injected Engine failure')
        kind, action = args[:2]
        if kind == 'inspect':
            kind, action = 'container', 'inspect'
        if action == 'inspect':
            item = self.resources[kind].get(args[-1])
            if item is None:
                raise RuntimeError('absent resource')
            template = args[args.index('--format') + 1]
            value = item
            for field in template.removeprefix('{{json .').removesuffix('}}').split('.'):
                if field:
                    value = value[field]
            return json.dumps(value).encode()
        if action == 'ls' or kind == 'ps':
            kind = 'container' if kind == 'ps' else kind
            return '\n'.join(self.resources[kind]).encode()
        if kind == 'stop':
            self.resources['container'][args[-1]]['State']['Running'] = False
            return b''
        if action == 'rm' or kind == 'rm':
            self.resources['container' if kind == 'rm' else kind].pop(args[-1], None)
            return b''
        if kind == 'run':
            probe = args[args.index('--name') + 1]
            self.add('container', probe)
            self.resources['container'].pop(probe)
            return b''
        raise AssertionError('unexpected Docker command: ' + repr(args))

    def run(self, args, **kwargs):
        # Also cover the pre-fix implementation's direct inspect calls.
        try:
            return subprocess.CompletedProcess(args, 0, self.docker(*args[1:]), b'')
        except RuntimeError:
            return subprocess.CompletedProcess(args, 1, b'', b'not available')


class NativeCleanupTests(unittest.TestCase):
    def setUp(self):
        self.artifacts = tempfile.TemporaryDirectory(prefix='task6-cleanup-test-')
        self.addCleanup(self.artifacts.cleanup)
        self.environment = patch.dict(os.environ, PI_E2E_ARTIFACT_DIR=self.artifacts.name)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.stack = native.Stack()
        self.addCleanup(self.stack.temporary.cleanup)
        self.engine = DockerBoundary(self.stack)
        self.docker = patch.object(native, 'docker', self.engine.docker)
        self.docker.start()
        self.addCleanup(self.docker.stop)
        self.run = patch.object(native.subprocess, 'run', self.engine.run)
        self.run.start()
        self.addCleanup(self.run.stop)

    def record(self, kind, suffix):
        name = self.stack.prefix + (':' if kind == 'image' else '-') + suffix
        getattr(self.stack, {'container': 'containers', 'volume': 'volumes', 'image': 'images'}[kind]).append(name)
        self.engine.add(kind, name)
        return name

    def full_stack(self):
        for suffix in ('gate', 'hub', 'pi'):
            self.record('container', suffix)
        for suffix in ('state', 'ipc', 'credentials'):
            self.record('volume', suffix)
        for suffix in ('runtime', 'gate'):
            self.record('image', suffix)
        self.stack.runtime_image = 'sha256:test'
        self.stack.base_alias = self.stack.prefix + ':cached-base'
        self.engine.add('image', self.stack.base_alias)

    def assert_empty(self):
        self.assertEqual(self.engine.resources, {'container': {}, 'volume': {}, 'image': {}})
        self.assertFalse(self.stack.root.exists(), 'temporary directory must also be cleaned')

    def evidence(self):
        return json.loads((Path(self.artifacts.name) / (self.stack.prefix + '-evidence.json')).read_text())

    def test_second_volume_creation_failure_cleans_first_volume_and_images(self):
        # The exact startup state after state creation succeeds and IPC creation fails.
        self.record('volume', 'state')
        self.record('image', 'runtime')
        self.record('image', 'gate')
        self.stack.close()
        self.assert_empty()
        self.assertTrue(self.stack.closed)
        self.assertFalse(any(call[0] == 'run' for call in self.engine.calls))

    def test_complete_cleanup_is_idempotent_and_preserves_socket_proof(self):
        self.full_stack()
        self.stack.close()
        self.assert_empty()
        self.assertTrue(self.evidence()['gateAndHubSocketsRemoved'])
        self.assertTrue(self.stack.closed)
        calls = len(self.engine.calls)
        self.stack.close()
        self.assertEqual(len(self.engine.calls), calls)

    def test_probe_failure_does_not_gate_resource_removal_and_can_retry(self):
        self.full_stack()
        self.engine.failures[('run',)] = 1
        with self.assertRaises(RuntimeError):
            self.stack.close()
        self.assert_empty()
        self.assertFalse(self.stack.closed, 'failed postcondition cannot mark close complete')
        self.assertFalse(self.evidence()['ownedResourcesRemoved'])
        self.assertTrue(self.evidence()['cleanupFailures'])
        self.stack.close()
        self.assertTrue(self.stack.closed)
        self.assertTrue(self.evidence()['ownedResourcesRemoved'])
        self.assertTrue(self.evidence()['cleanupAttempts'][0]['failures'])
        self.assertNotEqual(self.evidence().get('gateAndHubSocketsRemoved'), True,
                            'retry cannot invent the failed socket proof')

    def test_early_container_removal_failure_attempts_all_resources_then_retries(self):
        self.full_stack()
        pi = self.stack.prefix + '-pi'
        self.engine.failures[('rm', '-f', pi)] = 1
        with self.assertRaises(RuntimeError):
            self.stack.close()
        self.assertEqual(set(self.engine.resources['container']), {pi})
        self.assertEqual(self.engine.resources['volume'], {})
        self.assertEqual(self.engine.resources['image'], {})
        self.assertFalse(self.stack.root.exists())
        self.assertFalse(self.stack.closed)
        self.assertFalse(self.evidence()['ownedResourcesRemoved'])
        self.stack.close()
        self.assert_empty()
        self.assertTrue(self.stack.closed)
        removed = len(self.engine.calls)
        self.stack.close()
        self.assertEqual(len(self.engine.calls), removed, 'complete close must be idempotent')

    def test_retry_preserves_captured_native_events_and_effects_after_source_removal(self):
        self.full_stack()
        self.stack.workspace = self.stack.root / 'workspace'
        self.stack.workspace.mkdir()
        events = [{'event': 'shutdown', 'pid': 18}]
        (self.stack.workspace / 'native-events.jsonl').write_text(json.dumps(events[0]) + '\n')
        (self.stack.workspace / 'native-effects.txt').write_text('APPROVED_ONCE\n')
        self.engine.failures[('run',)] = 1
        with self.assertRaises(RuntimeError):
            self.stack.close()
        self.assert_empty()
        self.assertEqual(self.evidence()['nativeEvents'], events)
        self.assertEqual(self.evidence()['effects'], ['APPROVED_ONCE'])
        self.assertFalse(self.stack.closed)
        self.stack.close()
        self.assertTrue(self.stack.closed)
        self.assertEqual(self.evidence()['nativeEvents'], events)
        self.assertEqual(self.evidence()['effects'], ['APPROVED_ONCE'])
        self.assertTrue(self.evidence()['cleanupAttempts'][0]['failures'])
        self.assertNotEqual(self.evidence().get('gateAndHubSocketsRemoved'), True,
                            'retaining native evidence cannot invent a missing socket proof')

    def test_volume_image_and_alias_failures_are_aggregated_and_retried(self):
        self.full_stack()
        state = self.stack.prefix + '-state'
        image = self.stack.prefix + ':gate'
        alias = self.stack.base_alias
        for head in [('volume', 'rm', state), ('image', 'rm', image), ('image', 'rm', alias)]:
            self.engine.failures[head] = 1
        with self.assertRaises(RuntimeError):
            self.stack.close()
        self.assertEqual(set(self.engine.resources['volume']), {state})
        self.assertEqual(set(self.engine.resources['image']), {image, alias})
        self.assertEqual(self.engine.resources['container'], {})
        self.assertFalse(self.stack.closed)
        failures = self.evidence()['cleanupFailures']
        for operation in ('remove volume ' + state, 'remove image ' + image, 'remove cached base alias'):
            self.assertTrue(any(value.startswith(operation + ':') for value in failures))
        self.stack.close()
        self.assert_empty()
        self.assertTrue(self.stack.closed)

    def test_missing_recorded_resources_are_verified_absent_before_completion(self):
        self.full_stack()
        self.engine.resources = {'container': {}, 'volume': {}, 'image': {}}
        self.stack.close()
        self.assert_empty()
        self.assertTrue(self.stack.closed)

    def test_native_evidence_error_does_not_block_cleanup_or_retry(self):
        self.full_stack()
        self.stack.workspace = self.stack.root / 'workspace'
        self.stack.workspace.mkdir()
        with patch.object(self.stack, 'events', side_effect=ValueError('private-content-must-not-echo')):
            with self.assertRaises(RuntimeError) as error:
                self.stack.close()
        self.assertNotIn('private-content-must-not-echo', str(error.exception))
        self.assert_empty()
        self.assertFalse(self.stack.closed)
        self.stack.close()
        self.assertTrue(self.stack.closed)

    def test_stop_failure_still_attempts_force_remove_and_later_resources(self):
        self.full_stack()
        self.engine.failures[('stop',)] = 1
        with self.assertRaises(RuntimeError):
            self.stack.close()
        self.assert_empty()
        self.assertFalse(self.stack.closed)
        self.stack.close()
        self.assertTrue(self.stack.closed)

    def test_label_mismatch_preserves_foreign_resource_but_cleans_owned_peers(self):
        self.full_stack()
        pi = self.stack.prefix + '-pi'
        self.engine.resources['container'][pi]['Config']['Labels']['pi.task6.test'] = 'foreign'
        with self.assertRaises((RuntimeError, AssertionError)):
            self.stack.close()
        self.assertEqual(set(self.engine.resources['container']), {pi})
        self.assertEqual(self.engine.resources['volume'], {})
        self.assertEqual(self.engine.resources['image'], {})
        self.assertFalse(self.stack.closed)
        self.assertFalse(self.stack.root.exists())


if __name__ == '__main__':
    unittest.main()
