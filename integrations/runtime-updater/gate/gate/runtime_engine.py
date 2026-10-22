"""Fixed-operation runtime installer; its only persistent mount is pi-runtime."""
import json
from pathlib import Path
import time
import re
from urllib.parse import quote

from .lifecycle_contract import CONTAINER


def runtime_volume(value):
    if value != 'pi-runtime' and (not isinstance(value, str) or
            re.fullmatch(r'pi-runtime-update-test-[0-9a-f]{12,32}', value) is None):
        raise ValueError('invalid trusted runtime volume')
    return value


class RuntimeEngine:
    def __init__(self, engine, *, volume='pi-runtime'):
        self.engine = engine
        self.volume = runtime_volume(volume)

    def consumers(self, *, timeout=3):
        filters = {'volume': [self.volume], 'status': ['running']}
        return self.engine.call('GET', '/containers/json?all=0&filters=' +
                                quote(json.dumps(filters), safe=''), timeout=timeout, limit=1024 * 1024)

    @staticmethod
    def name(job, phase):
        if phase not in ('prepare', 'activate'):
            raise ValueError('invalid helper phase')
        return 'pi-runtime-updater-' + job['id'] + '-' + phase

    def definition(self, job, phase):
        self.name(job, phase)
        script = Path(__file__).with_name('runtime_install.py').read_text()
        return {
            'Image': job['policy']['images'][0], 'User': '1000:1000',
            'Entrypoint': ['/usr/bin/python3', '-I', '-c'],
            'Cmd': [script, job['version'], job['id'], phase], 'WorkingDir': '/tmp',
            'Env': ['HOME=/tmp', 'PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_OPTIONS=',
                    'NPM_CONFIG_USERCONFIG=/dev/null', 'NPM_CONFIG_GLOBALCONFIG=/tmp/npm-globalrc',
                    'NPM_CONFIG_CACHE=/tmp/npm-cache', 'NPM_CONFIG_PREFIX=/home/node/.local'],
            'Labels': {'cn.swordfate.pi.runtime-update': job['id'],
                       'cn.swordfate.pi.runtime-phase': phase},
            'HostConfig': {
                'NetworkMode': 'host' if phase == 'prepare' else 'none',
                'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                'SecurityOpt': ['no-new-privileges:true'], 'Memory': 1073741824,
                'NanoCpus': 2000000000, 'PidsLimit': 96, 'RestartPolicy': {'Name': 'no'},
                'Tmpfs': {'/tmp': 'rw,nosuid,nodev,size=512m,mode=1777'},
                'Mounts': [{'Type': 'volume', 'Source': self.volume,
                            'Target': '/home/node/.local', 'ReadOnly': False,
                            'VolumeOptions': {'NoCopy': True}}],
                'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '1m', 'max-file': '1'}},
            },
        }

    def inspect(self, job, phase):
        saved = job.get('helpers', {}).get(phase, {})
        item = self.engine.inspect(saved.get('id') or self.name(job, phase), timeout=3)
        if item is None:
            return None
        definition = self.definition(job, phase)
        config, host = item.get('Config', {}), item.get('HostConfig', {})
        mounts = item.get('Mounts') or []
        if (not CONTAINER.fullmatch(item.get('Id', '')) or item['Image'] != definition['Image'] or
                any(config.get(k) != definition[k] for k in ('User', 'Entrypoint', 'Cmd', 'WorkingDir')) or
                config.get('Labels', {}).get('cn.swordfate.pi.runtime-update') != job['id'] or
                config.get('Labels', {}).get('cn.swordfate.pi.runtime-phase') != phase or
                (saved.get('id') is not None and item['Id'] != saved['id']) or
                any(host.get(k) != definition['HostConfig'][k] for k in
                    ('NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt')) or
                host.get('Privileged') or host.get('CapAdd') or host.get('Devices') or
                host.get('Binds') or host.get('VolumesFrom') or
                len(mounts) != 1 or mounts[0].get('Type') != 'volume' or
                mounts[0].get('Name') != self.volume or
                mounts[0].get('Destination') != '/home/node/.local' or mounts[0].get('RW') is not True):
            raise RuntimeError('runtime helper identity changed')
        volume = self.engine.lifecycle_volume(self.volume)
        if (not volume or volume.get('Driver') != 'local' or volume.get('Options') or
                mounts[0].get('Source') != volume.get('Mountpoint')):
            raise RuntimeError('untrusted runtime volume')
        return item

    def create(self, job, phase):
        """Creation is inert. The caller commits this ID before dispatching start."""
        item = self.inspect(job, phase)
        if item is None:
            if phase in job.get('helpers', {}):
                raise RuntimeError('persisted helper disappeared')
            image = self.engine.image_info(job['policy']['images'][0], timeout=3)
            if not image or image.get('Config', {}).get('Volumes'):
                raise RuntimeError('invalid runtime helper image')
            created = self.engine.call('POST', '/containers/create?name=' + self.name(job, phase),
                                       self.definition(job, phase), timeout=3, limit=16384)
            if not CONTAINER.fullmatch(created.get('Id', '')):
                raise RuntimeError('invalid helper container')
            item = self.inspect({**job, 'helpers': {phase: {'id': created['Id']}}}, phase)
        if not item or item.get('State', {}).get('Status') != 'created':
            raise RuntimeError('unrecorded helper may have run')
        return item['Id']

    def start(self, job, phase):
        saved = job.get('helpers', {}).get(phase, {})
        if not saved.get('id') or not saved.get('intent_at'):
            raise RuntimeError('durable helper identity and intent required')
        item = self.inspect(job, phase)
        if not item or item.get('State', {}).get('Status') != 'created':
            raise RuntimeError('helper start outcome ambiguous')
        self.engine.call('POST', '/containers/' + item['Id'] + '/start', timeout=3)
        return item['Id']

    def poll(self, job, phase):
        item = self.inspect(job, phase)
        if not item:
            return {'state': 'unknown'}
        state = item.get('State', {})
        if state.get('Running'):
            if time.time() - job['helpers'][phase]['intent_at'] / 1000 > 900:
                # Stop only the fixed helper, never an Agent; do not infer activation.
                self.engine.call('POST', '/containers/' + item['Id'] + '/stop?t=2', timeout=3)
                return {'state': 'unknown'}
            return {'state': 'running'}
        if state.get('Status') != 'exited':
            return {'state': 'unknown'}
        raw = self.engine.call('GET', '/containers/' + item['Id'] + '/logs?stdout=1&stderr=1',
                               response_raw=True, limit=8192, timeout=3)
        output, position = bytearray(), 0
        while position < len(raw):
            header = raw[position:position + 8]
            if len(header) != 8 or header[0] != 1 or header[1:4] != b'\0\0\0':
                return {'state': 'unknown'}
            size = int.from_bytes(header[4:8], 'big')
            position += 8
            if position + size > len(raw):
                return {'state': 'unknown'}
            output.extend(raw[position:position + size])
            position += size
        try:
            value = json.loads(output)
        except (ValueError, UnicodeError):
            return {'state': 'unknown'}
        changed = phase == 'activate'
        if (state.get('ExitCode') == 0 and value == {'ok': True, 'version': job['version'], 'changed': changed}):
            return {'state': 'succeeded', 'version': job['version'], 'changed': changed}
        if value == {'ok': False, 'stage': 'install_failed'} and state.get('ExitCode') == 1:
            return {'state': 'failed', 'stage': 'install_failed'}
        return {'state': 'unknown'}

    def quiescent(self, job):
        """Inspect all labeled helpers, including creation-before-ID-commit orphans."""
        filters = {'label': ['cn.swordfate.pi.runtime-update=' + job['id']]}
        items = self.engine.call('GET', '/containers/json?all=1&filters=' +
                                 quote(json.dumps(filters), safe=''), timeout=3, limit=1024 * 1024)
        if not isinstance(items, list) or len(items) > 8:
            raise RuntimeError('ambiguous runtime helpers')
        keys = {item['Id'] for item in items}
        keys.update(value['id'] for value in job.get('helpers', {}).values())
        if job.get('helper_id'):  # Pre-two-phase ledger: absence can be inspected; live legacy helper cannot.
            keys.add(job['helper_id'])
        for key in keys:
            item = self.engine.inspect(key, timeout=3)
            if item is None:
                continue  # Host acknowledgment plus confirmed absence, not installation success.
            phase = item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.runtime-phase')
            if phase not in ('prepare', 'activate'):
                raise RuntimeError('legacy or unrecognized helper requires host removal')
            checked = self.inspect({**job, 'helpers': {phase: {'id': key}}}, phase)
            state = (checked or {}).get('State', {})
            if state.get('Running') is not False or state.get('Status') not in ('created', 'exited', 'dead'):
                raise RuntimeError('runtime helper still active')
