"""Opt-in disposable Gate→Docker→real Pi→Hub launch acceptance.

Uses explicitly selected immutable images and fresh test volumes only. No API
keys, SSH, production state, project mounts or model requests are used.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'integrations/runtime-updater/gate'))
from gate.service import Gate


def command(*args, timeout=40):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True).stdout.strip()


def wait_for(callback, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = callback()
        if result:
            return result
        time.sleep(.15)
    raise AssertionError('Disposable launch condition timed out')


def main():
    if os.environ.get('PI_REAL_DOCKER_TEST') != '1':
        raise ValueError('explicit test opt-in required')
    images = {key: os.environ.get(key, '') for key in ('PI_LAUNCH_TEST_IMAGE', 'PI_LAUNCH_TEST_HUB_IMAGE')}
    if any(not re.fullmatch(r'sha256:[a-f0-9]{64}', image) for image in images.values()):
        raise ValueError('explicit immutable test images required')
    namespace = uuid.uuid4().hex
    prefix = 'pi-launch-test-' + namespace
    volumes = {key: prefix + '-' + key for key in ('home', 'runtime', 'config', 'credentials', 'cache', 'hub_runtime')}
    destinations = {'home': '/home/node', 'runtime': '/home/node/.local', 'config': '/home/node/.pi',
                    'credentials': '/home/node/.credentials', 'cache': '/home/node/.cache/huggingface',
                    'hub_runtime': '/run/pi-web-hub'}
    output = ROOT / '.tmp/launch-acceptance' / namespace
    output.mkdir(parents=True)
    evidence = {'namespace': namespace, 'images': images, 'volumes': list(volumes.values()),
                'production_touched': False, 'registered': False, 'cleanup': False}
    hub = gate = None
    created_volumes, created_containers, launch_ids = [], [], []
    with tempfile.TemporaryDirectory(prefix='pi-launch-acceptance-') as temporary:
        base = Path(temporary)
        for relative in ('projects/pi_projects/project-a', 'profile', 'credentials', 'hub-private', 'exports'):
            (base / relative).mkdir(parents=True, mode=0o700)
        config = base / 'hub-private/config.json'
        config.write_text(json.dumps({'port': 0, 'runtimeDir': '/run/pi-web-hub'}))
        config.chmod(0o600)
        try:
            for volume in volumes.values():
                command('docker', 'volume', 'create', '--label', 'pi.launch.acceptance=' + namespace, volume)
                created_volumes.append(volume)
            # Every mount is newly created in this invocation. Docker seeds the
            # image-owned runtime; the helper initializes synthetic settings.
            mounts = []
            for key, destination in destinations.items():
                mounts.extend(['--mount', f'type=volume,source={volumes[key]},target={destination}' +
                               ('' if key == 'runtime' else ',volume-nocopy')])
            seed = '''
import json,os
from pathlib import Path
agent=Path('/home/node/.pi/agent');agent.mkdir(parents=True,exist_ok=True)
(agent/'settings.json').write_text(json.dumps({'defaultProvider':'faux','defaultModel':'faux-1',
 'extensions':['/opt/pi-web-ui/e2e/fixtures/runtime-update-provider.ts','/opt/pi-web-ui/extensions/mirror-server.ts']}))
for root in ('/home/node','/run/pi-web-hub'):
 for directory,dirs,files in os.walk(root):
  os.chown(directory,1000,1000)
  for name in files:
   os.chown(os.path.join(directory,name),1000,1000,follow_symlinks=False)
os.chmod('/run/pi-web-hub',0o700)
'''
            # Record deterministic names before create: a timed-out daemon
            # response can still have created the exact disposable container.
            helper = prefix + '-seed'
            created_containers.append(helper)
            command('docker', 'create', '--name', helper, '--network', 'none', '--user', '0:0',
                    '--entrypoint', '/usr/bin/python3', *mounts, images['PI_LAUNCH_TEST_IMAGE'], '-c', seed, timeout=180)
            command('docker', 'start', '-a', helper, timeout=60)
            hub = command('docker', 'create', '--name', prefix + '-hub', '--network', 'host', '--user', '1000:1000',
                          '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory', '512m', '--pids-limit', '128',
                          '--mount', f'type=bind,source={base}/hub-private,target=/hub/private',
                          '--mount', f'type=bind,source={base}/exports,target=/hub/exports',
                          '--mount', f'type=volume,source={volumes["hub_runtime"]},target=/run/pi-web-hub',
                          images['PI_LAUNCH_TEST_HUB_IMAGE'])
            created_containers.append(hub)
            command('docker', 'start', hub)
            def hub_url():
                for line in command('docker', 'logs', hub).splitlines():
                    try:
                        value = json.loads(line)
                        if value.get('localUrl'):
                            return value['localUrl']
                    except ValueError:
                        pass
            url = wait_for(hub_url)
            policy = dict(version=1, enabled=True, root=str(base / 'projects'), root_label='gitproject',
                          default_path='pi_projects', profile_root=str(base / 'profile'),
                          credential_root=str(base / 'credentials'), pi_image=images['PI_LAUNCH_TEST_IMAGE'],
                          hub_image=images['PI_LAUNCH_TEST_HUB_IMAGE'], hub_container=hub,
                          hub_config='/hub/private/config.json', hub_export_root='/hub/exports',
                          volumes=volumes, environment={}, auxiliary_binds=[], gate_provenance={'mode': 'host'})
            gate = Gate(base / 'gate', launch_policy=policy)
            manager = gate.pi_launches
            body = dict(id=uuid.uuid4().hex, path='pi_projects/project-a', label='Disposable real Pi',
                        policy_revision=manager.configuration()['revision'],
                        workspace_revision=manager.browse('pi_projects/project-a')['revision'])
            launch_ids.append(body['id'])
            manager.submit(body)
            manager.submit(body)
            def running():
                gate.tick()
                if gate.worker:
                    gate.worker.join(1)
                job = manager.get(body['id'])
                if job['status'] in ('failed', 'recovery_required'):
                    private = manager._get(body['id'])
                    expected = manager._engine().definition(private) if private.get('run_id') else {}
                    result = subprocess.run(['docker', 'inspect', 'pi-gate-launch-' + body['id']], capture_output=True, text=True)
                    if result.returncode == 0:
                        item = json.loads(result.stdout)[0]
                        evidence['diagnostic_state'] = item['State']['Status']
                        evidence['diagnostic_config_mismatches'] = [key for key in ('User', 'WorkingDir', 'Entrypoint', 'Cmd', 'OpenStdin', 'Tty', 'Labels') if item['Config'].get(key) != expected.get(key)]
                        evidence['diagnostic_host_mismatches'] = [key for key, value in expected.get('HostConfig', {}).items() if key != 'Mounts' and item['HostConfig'].get(key) != value]
                        (output / 'synthetic-pi.log').write_text(command('docker', 'logs', item['Id'])[-8000:])
                    raise AssertionError('Disposable launch failed: ' + job['stage'])
                return job if job['status'] == 'running' else None
            job = wait_for(running)
            evidence['job'] = job
            def registered():
                with urllib.request.urlopen(url + 'api/sessions', timeout=3) as response:
                    sessions = json.load(response)['sessions']
                return sessions[0] if len(sessions) == 1 else None
            session = wait_for(registered)
            evidence['registered'] = True
            evidence['generation'] = session['generation']
            # A new client after the original management request ended still
            # reaches this independent process. No browser lifetime owns it.
            with urllib.request.urlopen(url.rstrip('/') + session['path'], timeout=5) as response:
                assert response.status == 200
            item = manager._get(body['id'])
            container = item['container_id']
            created_containers.append(container)
            evidence['pi_container'] = container
            inspect = json.loads(command('docker', 'inspect', container))[0]
            assert inspect['State']['Running'] and inspect['Config']['User'] == '1000:1000'
            assert inspect['HostConfig']['CapDrop'] == ['ALL']
            assert len(manager.jobs()['jobs']) == 1
            # Explicitly stop this one test Pi, then exercise owned cleanup.
            command('docker', 'stop', '--time', '5', container)
            def cleaned():
                gate.tick()
                if gate.worker:
                    gate.worker.join(1)
                return manager.get(body['id'])['status'] == 'exited'
            wait_for(cleaned)
            evidence['owned_exit_cleanup'] = True
        finally:
            if gate:
                gate.close()
            for launch_id in launch_ids:
                name = 'pi-gate-launch-' + launch_id
                result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
                if result.returncode == 0:
                    item = json.loads(result.stdout)[0]
                    assert item['Config']['Labels'].get('cn.swordfate.pi.launch-id') == launch_id
                    command('docker', 'rm', '-f', item['Id'])
            for container in reversed(created_containers):
                result = subprocess.run(['docker', 'inspect', container], capture_output=True)
                if result.returncode == 0:
                    command('docker', 'rm', '-f', container)
            for volume in reversed(created_volumes):
                assert volume.startswith(prefix + '-')
                command('docker', 'volume', 'rm', volume)
            evidence['cleanup'] = True
            (output / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
