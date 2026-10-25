"""Fixed launch operations over Engine.call; never a command API or Docker CLI."""
import json
import os
import stat
import time
from urllib.parse import quote

from .engine import DockerError
from .hub_management import HEX32, HEX64, checked_hex
from .pi_launches import VOLUMES, absolute, directory, identity, overlap

OWNER = 'cn.swordfate.pi.launch-id'
CREDENTIAL_TARGET = '/run/secrets/pi-web-session.json'

# Only these two fixed operations can execute. The args are generated exclusively
# by Gate. No shell, workspace program, environment-controlled CLI, or raw output.
HUB_OPERATION = r'''
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const action=process.argv[1],a=JSON.parse(process.argv[2]);
const cli='/opt/pi-web-ui/dist/hub/pi-web-hub.mjs';
function checkDir(p){
 if(!path.isAbsolute(p)||path.normalize(p)!==p||p==='/')throw Error();
 let cur='/';for(const part of p.slice(1).split('/')){
  cur=path.join(cur,part);const s=fs.lstatSync(cur);if(!s.isDirectory()||s.isSymbolicLink())throw Error();
 }
 const s=fs.lstatSync(p);if(s.uid!==process.getuid()||(s.mode&511)!==448)throw Error();
}
function call(args){
 const r=spawnSync(process.execPath,[cli,...args],{timeout:4000,maxBuffer:8192,encoding:'utf8',
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',NODE_OPTIONS:''}});
 if(r.status!==0||r.error||r.stderr)throw Error();return JSON.parse(r.stdout);
}
function read(){
 const fd=fs.openSync(a.output,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||
  (s.mode&63)!==0||s.size>8192)throw Error();const v=JSON.parse(fs.readFileSync(fd,'utf8'));
  if(!/^[a-f0-9]{32}$/.test(v.run_id)||!/^[a-f0-9]{64}$/.test(v.token))throw Error();return v;
 }finally{fs.closeSync(fd)}
}
try{
 checkDir(path.dirname(a.output));
 if(action==='issue'){
  const r=call(['issue','--config',a.config,'--label',a.label,'--output',a.output,'--backend-host','127.0.0.1']);
  const v=read();if(r.runId!==v.run_id||r.credentialFile!==a.output)throw Error();
  process.stdout.write(JSON.stringify(v));
 }else if(action==='revoke'){
  const v=read();if(v.run_id!==a.run_id)throw Error();
  const r=call(['revoke','--config',a.config,'--run-id',a.run_id]);if(r.revoked!==true)throw Error();
  fs.unlinkSync(a.output);process.stdout.write('{"revoked":true}');
 }else throw Error();
}catch{process.exit(1)}
'''


class PiLaunchEngine:
    def __init__(self, engine, policy):
        self.engine, self.policy = engine, policy
        self.deadline = time.monotonic() + 30

    def _call(self, method, path, value=None, **kwargs):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DockerError('launch deadline exceeded')
        return self.engine.call(method, path, value, timeout=min(6, remaining), limit=65536, **kwargs)

    def _hub(self):
        p = self.policy
        hub = self._call('GET', '/containers/' + p['hub_container'] + '/json')
        if (not isinstance(hub, dict) or hub.get('Id') != p['hub_container'] or hub.get('Image') != p['hub_image'] or
                hub.get('State', {}).get('Running') is not True or hub.get('Config', {}).get('User') != '1000:1000' or
                hub.get('HostConfig', {}).get('NetworkMode') != 'host'):
            raise DockerError('Hub identity unavailable')
        # No Pi writable volume may alias *any* Hub mount. Only registry socket
        # volume is shared, at its fixed read-only Pi destination.
        for m in hub.get('Mounts') or []:
            dest, source = m.get('Destination', ''), m.get('Source', '')
            if not dest or not source:
                raise DockerError('Hub mount unavailable')
            if any(overlap(dest, protected) for protected in ('/opt/pi-web-ui', '/usr/local/bin')):
                raise DockerError('Hub executable overridden')
            if m.get('Name') in p['volumes'].values() and not (
                    m.get('Name') == p['volumes']['hub_runtime'] and dest == '/run/pi-web-hub'):
                raise DockerError('private Hub volume shared')
            if m.get('Type') == 'bind' and any(overlap(source, p[k]) for k in ('root', 'credential_root')):
                raise DockerError('Hub bind overlaps launch data')
            if any(overlap(source, bind['source']) for bind in p['auxiliary_binds']):
                raise DockerError('auxiliary bind overlaps Hub private data')
        return hub

    def preflight(self, job):
        p = self.policy
        images = {}
        for name in ('pi_image', 'hub_image'):
            item = self._call('GET', '/images/' + quote(p[name], safe='') + '/json')
            if not isinstance(item, dict) or item.get('Id') != p[name]:
                raise DockerError('launch image changed')
            images[name] = item
        config = images['pi_image'].get('Config') or {}
        if config.get('Entrypoint') != ['/usr/local/bin/pi-entrypoint'] or config.get('Volumes'):
            raise DockerError('launch image contract mismatch')
        env = config.get('Env') or []
        if (not isinstance(env, list) or any(not isinstance(e, str) or '=' not in e or len(e) > 8192 for e in env) or
                len(env) > 128 or len({e.split('=', 1)[0] for e in env}) != len(env)):
            raise DockerError('launch image environment invalid')
        hub = self._hub()
        for name in p['volumes'].values():
            volume = self._call('GET', '/volumes/' + name)
            if (not isinstance(volume, dict) or volume.get('Name') != name or
                    volume.get('Driver') != 'local' or volume.get('Options') or not volume.get('Mountpoint')):
                raise DockerError('existing local volume required')
            source = absolute(volume['Mountpoint'])
            if any(overlap(source, p[k]) for k in ('root', 'profile_root', 'credential_root')):
                raise DockerError('volume overlaps private authority')
            for mount in hub.get('Mounts') or []:
                if overlap(source, mount['Source']) and not (
                        name == p['volumes']['hub_runtime'] and mount['Destination'] == '/run/pi-web-hub'):
                    raise DockerError('volume aliases Hub private data')
        return env

    def _hub_operation(self, action, job):
        self._hub()
        args = dict(config=self.policy['hub_config'], output=self.policy['hub_export_root'] + '/' + job['id'] + '.json')
        if action == 'issue':
            # Use a server-generated label: arbitrary browser strings never
            # become CLI options (including labels beginning with --).
            args['label'] = 'Gate Pi ' + job['id']
        elif action == 'revoke':
            args['run_id'] = checked_hex(job['run_id'], HEX32)
        else:
            raise ValueError('invalid fixed Hub operation')
        body = {'User': '1000:1000', 'Privileged': False, 'AttachStdin': False,
                'AttachStdout': True, 'AttachStderr': True, 'Tty': False, 'WorkingDir': '/',
                'Env': ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'NODE_OPTIONS='],
                'Cmd': ['/usr/local/bin/node', '-e', HUB_OPERATION, action, json.dumps(args)]}
        created = self._call('POST', '/containers/' + self.policy['hub_container'] + '/exec', body)
        key = checked_hex(created['Id'], HEX64)
        raw = self._call('POST', '/exec/' + key + '/start', {'Detach': False, 'Tty': False}, response_raw=True)
        output = bytearray()
        while raw:
            if len(raw) < 8 or raw[:4] != b'\x01\0\0\0':
                raise DockerError('invalid Hub operation stream')
            size = int.from_bytes(raw[4:8], 'big')
            if size > len(raw) - 8 or len(output) + size > 8192:
                raise DockerError('invalid Hub operation output')
            output.extend(raw[8:8 + size])
            raw = raw[8 + size:]
        info = self._call('GET', '/exec/' + key + '/json')
        if info.get('Running') is not False or type(info.get('ExitCode')) is not int or info['ExitCode'] != 0:
            raise DockerError('Hub operation failed')
        return json.loads(output)

    def grant(self, job):
        credential = self._hub_operation('issue', job)
        if not isinstance(credential, dict) or set(credential) - {'run_id', 'token', 'interactions'}:
            raise DockerError('invalid launch credential')
        checked_hex(credential.get('run_id'), HEX32)
        checked_hex(credential.get('token'), HEX64)
        return credential

    def credential_path(self, job):
        return self.policy['credential_root'] + '/' + checked_hex(job['id'], HEX32) + '.json'

    def write_credential(self, job, credential):
        with directory(self.policy['credential_root']) as parent:
            fd = os.open(job['id'] + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=parent)
            with os.fdopen(fd, 'w') as stream:
                stream.write(json.dumps(credential))
                if os.geteuid() == 0:
                    os.fchown(stream.fileno(), 1000, 1000)
                if os.fstat(stream.fileno()).st_uid != 1000:
                    raise DockerError('credential owner must be UID1000')
                stream.flush()
                os.fsync(stream.fileno())
                result = identity(stream.fileno())
            os.fsync(parent)
            return result

    def definition(self, job):
        p = self.policy
        env = dict(e.split('=', 1) for e in job['image_env'])
        env.update(p['environment'])
        env.update(PI_WEB_UI_AUTO_START='1', PI_RUNTIME_RUN_ID=job['run_id'], PI_RUNTIME_DIR='/run/pi-runtime',
                   PI_WEB_UI_REGISTRY_SOCKET='/run/pi-web-hub/registry.sock',
                   PI_WEB_UI_REGISTRY_CREDENTIAL_FILE=CREDENTIAL_TARGET)
        if p['auxiliary_binds']:
            env['PI_CC_SWITCH_MODELS_DIR'] = '/run/cc-switch-pi-models'
        mounts = [{'Type': 'volume', 'Source': p['volumes'][key], 'Target': target,
                   'ReadOnly': key == 'hub_runtime', 'VolumeOptions': {'NoCopy': True}} for key, target in VOLUMES.items()]
        mounts.extend([{'Type': 'bind', 'Source': p['root'] + ('/' + job['path'] if job['path'] else ''),
                        'Target': '/workspace', 'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}},
                       {'Type': 'bind', 'Source': self.credential_path(job), 'Target': CREDENTIAL_TARGET,
                        'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}}])
        mounts.extend({'Type': 'bind', 'Source': bind['source'], 'Target': bind['target'],
                       'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}} for bind in p['auxiliary_binds'])
        return {'Image': p['pi_image'], 'User': '1000:1000', 'WorkingDir': '/workspace',
                'Entrypoint': ['/usr/local/bin/pi-entrypoint'], 'Cmd': [],
                'OpenStdin': True, 'StdinOnce': False, 'Tty': True,
                'AttachStdin': False, 'AttachStdout': False, 'AttachStderr': False,
                'Env': [k + '=' + v for k, v in sorted(env.items())],
                'Labels': {OWNER: job['id'], 'cn.swordfate.pi.run-id': job['run_id'],
                           'cn.swordfate.pi.lifecycle': '1', 'cn.swordfate.pi.launch-policy': job['request']['policy_revision']},
                'HostConfig': {'Mounts': mounts, 'NetworkMode': 'host', 'Privileged': False,
                               'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                               'AutoRemove': False, 'RestartPolicy': {'Name': 'no'},
                               'Memory': 4 * 1024**3, 'PidsLimit': 512,
                               'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '2m', 'max-file': '3'}}}}

    def create(self, job):
        self.check_credential(job)
        result = self._call('POST', '/containers/create?name=pi-gate-launch-' + job['id'], self.definition(job))
        return checked_hex(result['Id'], HEX64)

    def observe(self, job):
        target = job.get('container_id') or 'pi-gate-launch-' + job['id']
        item = self._call('GET', '/containers/' + target + '/json', missing=True)
        if item is None:
            return None
        expected = self.definition(job)
        checked_hex(item.get('Id'), HEX64)
        if (job.get('container_id', item['Id']) != item['Id'] or item.get('Name') != '/pi-gate-launch-' + job['id'] or
                item.get('Image') != self.policy['pi_image']):
            raise DockerError('launch container identity changed')
        config, host = item.get('Config') or {}, item.get('HostConfig') or {}
        for key in ('User', 'WorkingDir', 'Entrypoint', 'Cmd', 'OpenStdin', 'Tty', 'Labels'):
            if config.get(key) != expected[key]:
                raise DockerError('launch container definition changed')
        if sorted(config.get('Env') or []) != sorted(expected['Env']):
            raise DockerError('launch environment changed')
        for key, value in expected['HostConfig'].items():
            if key != 'Mounts' and host.get(key) != value:
                raise DockerError('launch security changed')
        if any(host.get(k) for k in ('CapAdd', 'Devices', 'DeviceRequests', 'Binds', 'VolumesFrom', 'GroupAdd',
                                     'PidMode', 'UTSMode', 'UsernsMode', 'Tmpfs')) or host.get('IpcMode') in ('host',):
            raise DockerError('launch authority changed')
        actual = item.get('Mounts') or []
        if len(actual) != len(expected['HostConfig']['Mounts']):
            raise DockerError('launch mounts changed')
        for mount in expected['HostConfig']['Mounts']:
            matches = [m for m in actual if m.get('Destination') == mount['Target']]
            if len(matches) != 1:
                raise DockerError('launch mount absent')
            m = matches[0]
            if (m.get('Type') != mount['Type'] or m.get('RW') is not (not mount['ReadOnly']) or
                    m.get('Name' if mount['Type'] == 'volume' else 'Source') != mount['Source'] or
                    m.get('Propagation', '') not in ('', 'rprivate') or m.get('SubPath') or m.get('Subpath')):
                raise DockerError('launch mount authority changed')
        return item

    def start(self, job):
        self.check_credential(job)
        item = self.observe(job)
        if item is None or item.get('State', {}).get('Status') != 'created':
            raise DockerError('launch container not newly created')
        self._call('POST', '/containers/' + job['container_id'] + '/start')

    @staticmethod
    def exited(item):
        state = item.get('State') or {}
        return (state.get('Status') == 'exited' and state.get('Running') is False and
                type(state.get('ExitCode')) is int and isinstance(state.get('FinishedAt'), str) and
                not state['FinishedAt'].startswith('0001-') and bool(state['FinishedAt']))

    def revoke(self, job):
        item = self.observe(job)
        if item is None or not self.exited(item):
            raise DockerError('owned launch not exited')
        if self._hub_operation('revoke', job) != {'revoked': True}:
            raise DockerError('revocation uncertain')

    def remove_container(self, job):
        item = self.observe(job)
        if item is None or not self.exited(item):
            raise DockerError('owned launch not exited')
        self._call('DELETE', '/containers/' + item['Id'] + '?v=false&force=false')

    def check_credential(self, job):
        with directory(self.policy['credential_root']) as parent:
            fd = os.open(job['id'] + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                s = os.fstat(fd)
                if (identity(fd) != job['credential_identity'] or not stat.S_ISREG(s.st_mode) or
                        s.st_nlink != 1 or s.st_uid != 1000 or stat.S_IMODE(s.st_mode) != 0o400):
                    raise DockerError('credential identity changed')
            finally:
                os.close(fd)

    def remove_credential(self, job):
        with directory(self.policy['credential_root']) as parent:
            name = job['id'] + '.json'
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                s = os.fstat(fd)
                if identity(fd) != job['credential_identity'] or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                    raise DockerError('credential identity changed')
                os.unlink(name, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(fd)
