"""Exercise the actual Engine HTTP transport against a disposable Unix daemon."""
import copy
import http.server
import json
from pathlib import Path
import socket
import socketserver
import tempfile
import threading
import unittest
from urllib.parse import unquote, urlsplit

from gate.engine import Engine
from gate.service import Gate
from test_pi_launches import launch_policy


class DockerServer(socketserver.UnixStreamServer):
    pass


class RecordingDocker:
    def __init__(self, base, policy):
        self.policy, self.calls, self.stages = policy, [], []
        self.containers, self.execs, self.grants = {}, {}, {}
        self.ambiguous, self.manager, self.hub_private_alias = None, None, False
        self.bad_image, self.foreign, self.fail_delete = False, False, False
        self.swap_credential = False
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def dispatch(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                value = json.loads(body) if body else None
                path = unquote(self.path.removeprefix('/v1.45'))
                owner.calls.append((self.command, path, value))
                if owner.manager and owner.manager.jobs()['jobs']:
                    owner.stages.append(owner.manager.jobs()['jobs'][0]['stage'])
                status, result, operation = owner.respond(self.command, path, value)
                if operation == owner.ambiguous and operation is not None:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                raw = result if isinstance(result, bytes) else json.dumps(result).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_DELETE = dispatch

        self.server = DockerServer(str(base / 'docker.sock'), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def respond(self, method, path, value):
        p = self.policy
        if path.startswith('/images/'):
            image = path.removeprefix('/images/').removesuffix('/json')
            return 200, {'Id': image if not self.bad_image else 'sha256:' + 'f' * 64,
                         'Config': {'Entrypoint': ['/usr/local/bin/pi-entrypoint'], 'Cmd': [],
                                    'Env': ['PATH=/usr/local/bin:/usr/bin:/bin'], 'Volumes': None}}, None
        if path.startswith('/volumes/'):
            name = path.rsplit('/', 1)[-1]
            return 200, {'Name': name, 'Driver': 'local', 'Options': None,
                         'Mountpoint': '/var/lib/docker/volumes/' + name + '/_data'}, None
        if path == '/containers/' + p['hub_container'] + '/json':
            return 200, {'Id': p['hub_container'], 'Image': p['hub_image'],
                         'Config': {'User': '1000:1000'}, 'State': {'Running': True},
                         'HostConfig': {'NetworkMode': 'host'},
                         'Mounts': [{'Type': 'volume', 'Name': p['volumes']['config'] if self.hub_private_alias else 'hub-private',
                                     'Source': '/var/lib/docker/volumes/hub-private/_data', 'Destination': '/private', 'RW': True},
                                    {'Type': 'volume', 'Name': p['volumes']['hub_runtime'],
                                     'Source': '/var/lib/docker/volumes/' + p['volumes']['hub_runtime'] + '/_data',
                                     'Destination': '/run/pi-web-hub', 'RW': True}]}, None
        if path == '/containers/' + p['hub_container'] + '/exec':
            key = f'{len(self.execs) + 1:064x}'
            self.execs[key] = value
            return 201, {'Id': key}, None
        if path.startswith('/exec/'):
            key = path.split('/')[2]
            if path.endswith('/json'):
                return 200, {'Running': False, 'ExitCode': 0}, None
            action, args = self.execs[key]['Cmd'][-2:]
            args = json.loads(args)
            if action == 'issue':
                run = f'{len(self.grants) + 1:032x}'
                self.grants[run] = {'run_id': run, 'token': 'e' * 64}
                result = self.grants[run]
            elif action == 'revoke':
                self.grants[args['run_id']]['revoked'] = True
                result = {'revoked': True}
            else:
                return 500, {}, None
            raw = json.dumps(result).encode()
            return 200, b'\x01\0\0\0' + len(raw).to_bytes(4, 'big') + raw, action
        if path.startswith('/containers/create?'):
            key = f'{100 + len(self.containers):064x}'
            name = path.split('name=', 1)[1]
            config = {k: copy.deepcopy(v) for k, v in value.items() if k != 'HostConfig'}
            mounts = []
            for m in value['HostConfig']['Mounts']:
                mounts.append({'Type': m['Type'], 'Source': m['Source'] if m['Type'] == 'bind' else
                               '/var/lib/docker/volumes/' + m['Source'] + '/_data',
                               **({'Name': m['Source']} if m['Type'] == 'volume' else {}),
                               'Destination': m['Target'], 'RW': not m['ReadOnly'], 'Propagation': 'rprivate'})
            self.containers[key] = dict(Id=key, Name='/' + name, Image=p['pi_image'], Config=config,
                                        HostConfig=copy.deepcopy(value['HostConfig']), Mounts=mounts,
                                        State={'Status': 'created', 'Running': False, 'ExitCode': 0,
                                               'FinishedAt': '0001-01-01T00:00:00Z'})
            if self.swap_credential:
                credential = Path(next(m['Source'] for m in value['HostConfig']['Mounts']
                                       if m['Target'] == '/run/secrets/pi-web-session.json'))
                credential.rename(credential.with_suffix('.old'))
                credential.write_text('{}')
            return 201, {'Id': key}, 'create'
        if path.startswith('/containers/'):
            key = urlsplit(path).path.split('/')[2]
            item = next((v for k, v in self.containers.items() if key in (k, v['Name'][1:])), None)
            if item is None:
                return 404, {}, None
            if path.endswith('/json'):
                result = copy.deepcopy(item)
                if self.foreign:
                    result['Config']['Labels']['cn.swordfate.pi.launch-id'] = 'f' * 32
                return 200, result, None
            if path.endswith('/start'):
                item['State'].update(Status='running', Running=True)
                return 204, b'', 'start'
            if method == 'DELETE':
                if self.fail_delete:
                    return 500, {}, 'delete'
                del self.containers[item['Id']]
                return 204, b'', 'delete'
        return 500, {}, None


class LaunchEngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='.launch-', dir=Path(__file__).parents[4])
        self.base = Path(self.tmp.name)
        self.policy = launch_policy(self.base)
        self.docker = RecordingDocker(self.base, self.policy)
        self.gate = Gate(self.base / 'state', launch_policy=self.policy,
                         launch_engine=Engine(str(self.base / 'docker.sock')))
        self.m = self.gate.pi_launches
        self.docker.manager = self.m
        self.addCleanup(self.stop)

    def stop(self):
        self.gate.close()
        self.docker.close()
        self.tmp.cleanup()

    def submit(self, key='a' * 32):
        return self.m.submit(dict(id=key, path='pi_projects/project-a', label='Project A',
                                 policy_revision=self.m.configuration()['revision'],
                                 workspace_revision=self.m.browse('pi_projects/project-a')['revision']))

    def tick(self):
        self.gate.tick()
        if self.gate.worker:
            self.gate.worker.join(6)
            self.assertFalse(self.gate.worker.is_alive(), 'worker did not finish its bounded step')

    def writes(self, operation):
        return [(m, p, v) for m, p, v in self.docker.calls if m == 'POST' and p.startswith('/containers/') and
                (p.endswith('/' + operation) or operation == 'create' and p.startswith('/containers/create?'))]

    def test_fixed_definition_independent_grants_and_owned_exit_cleanup(self):
        self.submit()
        self.assertEqual(self.docker.calls, [])
        self.tick()
        first = self.m.get('a' * 32)
        self.assertEqual(first['status'], 'running')
        definition = self.writes('create')[0][2]
        self.assertIn('PI_WEB_UI_AUTO_START=1', definition['Env'])
        self.assertEqual(definition['Image'], self.policy['pi_image'])
        self.assertEqual(definition['User'], '1000:1000')
        self.assertTrue(definition['Tty'])
        self.assertTrue(definition['OpenStdin'])
        self.assertFalse(definition['AttachStdin'])
        self.assertEqual(definition['Entrypoint'], ['/usr/local/bin/pi-entrypoint'])
        self.assertEqual(definition['Cmd'], [])
        host = definition['HostConfig']
        self.assertEqual(host['CapDrop'], ['ALL'])
        self.assertEqual(host['SecurityOpt'], ['no-new-privileges:true'])
        self.assertEqual(host['NetworkMode'], 'host')
        self.assertFalse(host['Privileged'])
        self.assertFalse(host['AutoRemove'])
        self.assertEqual(len(host['Mounts']), 8)
        binds = [m for m in host['Mounts'] if m['Type'] == 'bind']
        self.assertEqual(binds[0], {'Type': 'bind', 'Source': str(self.base / 'projects/pi_projects/project-a'),
                                   'Target': '/workspace', 'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}})
        self.assertEqual(binds[1]['Target'], '/run/secrets/pi-web-session.json')
        self.assertTrue(binds[1]['ReadOnly'])
        credential = Path(binds[1]['Source'])
        self.assertEqual(credential.stat().st_mode & 0o777, 0o400)
        self.assertEqual(json.loads(credential.read_text())['run_id'], first['run_id'])
        self.assertNotIn('token', json.dumps(self.m.jobs()))
        self.submit('b' * 32)
        self.tick()
        second = self.m.get('b' * 32)
        self.assertEqual(second['status'], 'running')
        self.assertNotEqual(first['run_id'], second['run_id'])
        item = next(v for v in self.docker.containers.values() if v['Config']['Labels']['cn.swordfate.pi.launch-id'] == first['id'])
        item['State'].update(Status='exited', Running=False, FinishedAt='2026-10-25T00:00:00Z')
        for _ in range(3):
            self.tick()
        self.assertEqual(self.m.get(first['id'])['status'], 'exited')
        self.assertTrue(self.docker.grants[first['run_id']]['revoked'])
        self.assertNotIn('revoked', self.docker.grants[second['run_id']])
        self.assertFalse(credential.exists())
        deletes = [(p, v) for method, p, v in self.docker.calls if method == 'DELETE']
        self.assertEqual(deletes, [('/containers/' + item['Id'] + '?v=false&force=false', None)])

    def test_ambiguous_issue_never_replays_and_stage_precedes_exec(self):
        self.docker.ambiguous = 'issue'
        self.submit()
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'recovery_required')
        self.assertEqual(self.m.get('a' * 32)['stage'], 'grant_intent')
        self.assertEqual(len(self.docker.grants), 1)
        before = len([c for c in self.docker.calls if c[0] != 'GET'])
        self.m.recover()
        self.tick()
        self.assertEqual(before, len([c for c in self.docker.calls if c[0] != 'GET']))
        self.assertIn('grant_intent', self.docker.stages)

    def test_ambiguous_create_is_inspected_not_restarted(self):
        self.docker.ambiguous = 'create'
        self.submit()
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'recovery_required')
        for _ in range(2):
            self.tick()
        self.assertEqual(len(self.writes('create')), 1)
        self.assertEqual(self.writes('start'), [])
        self.assertIn('create_intent', self.docker.stages)

    def test_ambiguous_start_reconciles_running_without_replay(self):
        self.docker.ambiguous = 'start'
        self.submit()
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'recovery_required')
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'running')
        self.assertEqual(len(self.writes('start')), 1)
        self.assertIn('start_intent', self.docker.stages)

    def test_restart_marks_intents_uncertain_without_writes(self):
        self.docker.ambiguous = 'start'
        self.submit()
        self.tick()
        self.gate.close()
        self.gate = Gate(self.base / 'state', launch_policy=self.policy,
                         launch_engine=Engine(str(self.base / 'docker.sock')))
        self.m = self.gate.pi_launches
        self.docker.manager = self.m
        before = len(self.docker.calls)
        self.m.recover()
        self.assertEqual(before, len(self.docker.calls))
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'running')
        self.assertEqual(len(self.writes('start')), 1)

    def test_changed_inode_before_dispatch_has_no_grant(self):
        self.submit()
        path = self.base / 'projects/pi_projects/project-a'
        path.rename(path.with_name('old'))
        path.symlink_to(path.with_name('old'))
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'failed')
        self.assertEqual(self.docker.grants, {})

    def test_foreign_container_cannot_be_cleaned(self):
        self.submit()
        self.tick()
        self.docker.foreign = True
        for item in self.docker.containers.values():
            item['State'].update(Status='exited', Running=False, FinishedAt='2026-10-25T00:00:00Z')
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'recovery_required')
        self.assertFalse(any(c[0] == 'DELETE' for c in self.docker.calls))
        self.assertFalse(any(g.get('revoked') for g in self.docker.grants.values()))

    def test_pinned_image_and_private_hub_volume_refused_before_grant(self):
        for attribute in ('bad_image', 'hub_private_alias'):
            with self.subTest(attribute=attribute):
                setattr(self.docker, attribute, True)
                key = ('c' if attribute == 'bad_image' else 'd') * 32
                self.submit(key)
                self.tick()
                self.assertEqual(self.m.get(key)['status'], 'failed')
                self.assertEqual(self.docker.grants, {})
                setattr(self.docker, attribute, False)

    def test_existing_admission_and_upgrade_fences(self):
        policy = {'mode': 'auto', 'images': [self.policy['pi_image']]}
        self.gate.lifecycle.set_policy(policy)
        self.gate.runtime_updates.set_policy(policy)
        self.submit()
        with self.assertRaises(RuntimeError):
            self.gate.submit({'commit': '1' * 40})
        with self.assertRaises(RuntimeError):
            self.gate.reserve_upgrade('sha256:' + 'f' * 64)
        with self.assertRaises(RuntimeError):
            self.gate.store.require_admission()
        with self.assertRaisesRegex(RuntimeError, 'Pi launches reserve admission'):
            self.gate.runtime_updates.submit({'version': '1.0.0', 'idempotency_key': 'f' * 32})
        with self.assertRaisesRegex(RuntimeError, 'Pi launches reserve admission'):
            self.gate.lifecycle.submit({'run_id': 'e' * 32, 'runtime_id': 'runtime-old',
                                        'session_id': 'session', 'leaf_id': None, 'idempotency_key': 'f' * 32})

    def test_changed_credential_before_start_is_not_dispatched(self):
        self.docker.swap_credential = True
        self.submit()
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'recovery_required')
        self.assertEqual(self.writes('start'), [])

    def test_cleanup_failure_remains_visible_and_is_not_replayed(self):
        self.submit()
        self.tick()
        self.docker.fail_delete = True
        for item in self.docker.containers.values():
            item['State'].update(Status='exited', Running=False, FinishedAt='2026-10-25T00:00:00Z')
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'recovery_required')
        before = len([c for c in self.docker.calls if c[0] != 'GET'])
        self.m.recover()
        self.tick()
        self.assertEqual(before, len([c for c in self.docker.calls if c[0] != 'GET']))

    def test_private_optional_models_bind_is_readonly_and_fixed(self):
        source = self.base / 'models'
        source.mkdir()
        self.policy['auxiliary_binds'] = [{'source': str(source), 'target': '/run/cc-switch-pi-models', 'read_only': True}]
        self.policy['environment']['PI_CC_SWITCH_MODELS_DIR'] = '/run/cc-switch-pi-models'
        self.gate.close()
        self.gate = Gate(self.base / 'state', launch_policy=self.policy,
                         launch_engine=Engine(str(self.base / 'docker.sock')))
        self.m = self.gate.pi_launches
        self.docker.manager = self.m
        self.submit()
        self.tick()
        self.assertEqual(self.m.get('a' * 32)['status'], 'running')
        mounts = self.writes('create')[0][2]['HostConfig']['Mounts']
        self.assertIn('PI_CC_SWITCH_MODELS_DIR=/run/cc-switch-pi-models', self.writes('create')[0][2]['Env'])
        self.assertEqual([m for m in mounts if m['Target'] == '/run/cc-switch-pi-models'],
                         [{'Type': 'bind', 'Source': str(source), 'Target': '/run/cc-switch-pi-models',
                           'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}}])

    def test_stable_running_launch_allows_deployment_and_upgrade_admission(self):
        self.submit()
        self.tick()
        job = self.gate.submit({'commit': '1' * 40})
        self.assertEqual(job['status'], 'pending')
        self.gate.store.update(job['id'], status='rejected')
        reservation = self.gate.reserve_upgrade('sha256:' + 'f' * 64)
        self.assertRegex(reservation['id'], '^[a-f0-9]{32}$')
        self.assertEqual(len(self.m.active()), 1)  # still counts against live quota

    def test_stable_running_launch_allows_runtime_and_does_not_starve_it(self):
        from gate.runtime_catalog import RuntimeCatalog
        from test_runtime_catalog import release
        self.submit()
        self.tick()
        m = self.gate.runtime_updates
        m.set_policy({'mode': 'manual', 'images': [self.policy['pi_image']]})
        m.catalog = RuntimeCatalog(fetch=lambda _: release('1.3.0'))
        job = m.submit({'version': '1.3.0', 'idempotency_key': 'd' * 32})
        self.assertEqual(job['status'], 'pending')
        before = len(self.docker.calls)
        self.tick()
        self.assertEqual(len(self.docker.calls), before)
        self.assertEqual(self.m.get('a' * 32)['status'], 'running')

    def test_stable_running_launch_allows_lifecycle_dispatch(self):
        from test_lifecycle import Gate as LifecycleGate, FakeEngine, BODY, IMAGE
        self.gate.close()
        self.gate = LifecycleGate(self.base / 'state', launch_policy=self.policy,
                                 launch_engine=Engine(str(self.base / 'docker.sock')))
        self.m = self.gate.pi_launches
        self.docker.manager = self.m
        self.submit()
        self.tick()
        life = self.gate.lifecycle
        life.engine = FakeEngine()
        life.set_policy({'mode': 'auto', 'images': [IMAGE]})
        job = life.submit(BODY)
        self.assertEqual(job['status'], 'queued')
        before = len(self.docker.calls)
        self.tick()
        self.assertNotEqual(life.get(job['id'])['status'], 'queued')
        self.assertEqual(len(self.docker.calls), before)

    def test_launch_admitted_during_lifecycle_inspection_fences_final_commit(self):
        from test_lifecycle import Gate as LifecycleGate, FakeEngine, BODY, IMAGE
        self.gate.close()
        self.gate = LifecycleGate(self.base / 'state', launch_policy=self.policy,
                                 launch_engine=Engine(str(self.base / 'docker.sock')))
        self.m = self.gate.pi_launches
        self.docker.manager = self.m
        life = self.gate.lifecycle
        life.engine = FakeEngine()
        life.set_policy({'mode': 'auto', 'images': [IMAGE]})
        life.engine.on_status = lambda: self.submit()
        with self.assertRaisesRegex(RuntimeError, 'Pi launches reserve admission'):
            life.submit(BODY)
        self.assertEqual(life.jobs(), [])


if __name__ == '__main__':
    unittest.main()
