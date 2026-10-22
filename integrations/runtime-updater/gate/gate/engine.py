"""Small fixed-operation Docker client. Never accepts Docker paths from HTTP."""
import http.client
import json
import re
import socket
import threading
import time
from urllib.parse import quote


class DockerError(RuntimeError):
    pass


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=180):
        super().__init__('localhost', timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


PROBE = r'''
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const cli='/opt/pi-web-ui/dist/hub/pi-web-hub.mjs';
fs.mkdirSync('/tmp/probe');
const init=spawnSync(process.execPath,[cli,'init','--config','/tmp/probe/config.json','--port','0'],{timeout:4000,stdio:'ignore'});
if(init.status!==0)process.exit(1);
const child=spawn(process.execPath,[cli,'serve','--config','/tmp/probe/config.json'],{stdio:['ignore','pipe','ignore']});
let data='',done=false;
const timer=setTimeout(()=>{child.kill('SIGKILL');process.exit(1)},12000);
child.on('error',()=>process.exit(1));
child.on('exit',code=>{clearTimeout(timer);process.exit(done&&code===0?0:1)});
child.stdout.on('data',async block=>{
 data+=block;if(data.length>16384){child.kill('SIGKILL');return}
 if(done||!data.includes('\n'))return;
 try{
  done=true;
  const url=new URL(JSON.parse(data.split('\n')[0]).localUrl);
  if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error();
  const a=await fetch(new URL('sessions/',url),{signal:AbortSignal.timeout(3000)});
  const b=await fetch(new URL('api/sessions',url),{signal:AbortSignal.timeout(3000)});
  if(!a.ok||!b.ok)throw Error();
  const result=await b.json();
  if(result===null||typeof result!=='object'||Array.isArray(result)||
     !Array.isArray(result.sessions)||result.sessions.length!==0)throw Error();
  child.kill('SIGTERM');
 }catch{done=false;child.kill('SIGKILL')}
});
'''


class Engine:
    def __init__(self, path='/var/run/docker.sock'):
        self.path = path

    def call(self, method, path, value=None, raw=None, missing=False, limit=4 * 1024 * 1024,
             timeout=None, response_raw=False):
        if timeout is not None and timeout <= 0:
            raise DockerError('Docker operation timed out')
        connection = UnixConnection(self.path, timeout=180 if timeout is None else timeout)
        body = raw if raw is not None else None if value is None else json.dumps(value).encode()
        transport = None
        expired = threading.Event()
        def expire():
            expired.set()
            sock = transport or connection.sock
            if sock:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        # Socket inactivity timeouts alone do not bound a slow header/body stream.
        timer = threading.Timer(timeout, expire) if timeout is not None else None
        if timer:
            timer.daemon = True
            timer.start()
        try:
            connection.request(method, '/v1.45' + path, body,
                               {'Content-Type': 'application/x-tar' if raw is not None else 'application/json'})
            transport = connection.sock
            response = connection.getresponse()
            data = response.read(limit + 1)
            if expired.is_set():
                raise DockerError('Docker operation timed out')
            if len(data) > limit:
                raise DockerError('daemon response exceeds limit')
            if response.status == 404 and missing:
                return None
            if response.status >= 300:
                # Engine errors can include file paths or container output. Do not relay.
                raise DockerError('Docker operation failed (HTTP %d)' % response.status)
            return data if response_raw else json.loads(data) if data else None
        except (OSError, http.client.HTTPException) as error:
            if isinstance(error, TimeoutError) or expired.is_set():
                raise DockerError('Docker operation timed out') from None
            raise
        finally:
            if timer:
                timer.cancel()
                timer.join()
            connection.close()

    def inspect(self, key, timeout=None):
        return self.call('GET', '/containers/' + quote(key, safe='') + '/json', missing=True, timeout=timeout)

    def list_lifecycle(self, run_id, timeout=3):
        from .lifecycle_contract import identifier
        identifier(run_id)
        filters = {'label': ['cn.swordfate.pi.run-id=' + run_id, 'cn.swordfate.pi.lifecycle=1'],
                   'status': ['running']}
        return self.call('GET', '/containers/json?all=0&filters=' + quote(json.dumps(filters), safe=''),
                         limit=1024 * 1024, timeout=timeout)

    def lifecycle_control(self, container_id, request, timeout=3):
        from .lifecycle_contract import CONTAINER, control_request
        control_request(request)
        if not isinstance(container_id, str) or not CONTAINER.fullmatch(container_id):
            raise ValueError('immutable container identity required')
        deadline = time.monotonic() + min(timeout, 3)
        remaining = lambda: deadline - time.monotonic()
        body = {'User': '1000:1000', 'Privileged': False, 'AttachStdin': False,
                'AttachStdout': True, 'AttachStderr': True, 'Tty': False,
                'Env': ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                        'PYTHONNOUSERSITE=1', 'PYTHONSAFEPATH=1'],
                'Cmd': ['/usr/local/bin/pi-session-control', '--request',
                        json.dumps(request, separators=(',', ':'), ensure_ascii=True)]}
        try:
            created = self.call('POST', '/containers/' + container_id + '/exec', body,
                                timeout=remaining(), limit=16384)
            key = created['Id']
            if not isinstance(key, str) or not CONTAINER.fullmatch(key):
                raise DockerError('invalid exec identity')
            raw = self.call('POST', '/exec/' + key + '/start', {'Detach': False, 'Tty': False},
                            timeout=remaining(), limit=16384 * 9, response_raw=True)
            # Docker's non-TTY stream uses an 8-byte header per stdout/stderr frame.
            position, output, total = 0, bytearray(), 0
            while position < len(raw):
                header = raw[position:position + 8]
                if len(header) != 8 or header[0] not in (1, 2) or header[1:4] != b'\0\0\0':
                    raise DockerError('invalid control stream')
                size = int.from_bytes(header[4:8], 'big')
                position += 8
                total += size
                if total > 16384 or position + size > len(raw):
                    raise DockerError('invalid control stream')
                if header[0] == 2 and size:
                    raise DockerError('control stderr refused')
                output.extend(raw[position:position + size])
                position += size
            info = self.call('GET', '/exec/' + key + '/json', timeout=remaining(), limit=16384)
            if info.get('Running') is not False or type(info.get('ExitCode')) is not int or info['ExitCode'] != 0:
                raise DockerError('control exec failed')
            value = json.loads(output.decode('utf-8'))
            if not isinstance(value, dict) or value.get('ok') is not True or not isinstance(value.get('result'), dict):
                raise DockerError('control response invalid')
            return value
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException):
            raise DockerError('control transport or response failed') from None

    def list_terminal(self, run_id, timeout=3):
        from .lifecycle_contract import identifier
        identifier(run_id)
        # All running matches, not only terminal-labelled ones: duplicates fail closed.
        filters = {'label': ['cn.swordfate.pi.run-id=' + run_id], 'status': ['running']}
        return self.call('GET', '/containers/json?all=0&filters=' + quote(json.dumps(filters), safe=''),
                         limit=1024 * 1024, timeout=timeout)

    def terminal_exec(self, container_id, before_start, timeout=3):
        """One fixed helper, duplex non-TTY stream. Never the buffered RPC path."""
        from .lifecycle_contract import CONTAINER
        if not isinstance(container_id, str) or not CONTAINER.fullmatch(container_id):
            raise ValueError('immutable container identity required')
        end = time.monotonic() + min(timeout, 3)
        def remaining():
            value = end - time.monotonic()
            if value <= 0:
                raise DockerError('terminal transport unavailable')
            return value
        body = {'User': '1000:1000', 'Privileged': False, 'AttachStdin': True,
                'AttachStdout': True, 'AttachStderr': True, 'Tty': False, 'WorkingDir': '/',
                'Env': ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                        'PYTHONNOUSERSITE=1', 'PYTHONSAFEPATH=1', 'PYTHONDONTWRITEBYTECODE=1'],
                'Cmd': ['/usr/bin/python3', '-I', '/usr/local/lib/pi-runtime/terminal/client.py']}
        created = self.call('POST', '/containers/' + container_id + '/exec', body,
                            timeout=remaining(), limit=16384)
        key = created.get('Id') if isinstance(created, dict) else None
        if not isinstance(key, str) or not CONTAINER.fullmatch(key):
            raise DockerError('terminal transport unavailable')
        before_start()
        sock = socket.socket(socket.AF_UNIX)
        try:
            sock.settimeout(remaining())
            sock.connect(self.path)
            data = b'{"Detach":false,"Tty":false}'
            request = ('POST /v1.45/exec/' + key + '/start HTTP/1.1\r\nHost: localhost\r\n'
                       'Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\n'
                       'Content-Length: ' + str(len(data)) + '\r\n\r\n').encode() + data
            sock.settimeout(remaining())
            sock.sendall(request)
            # Avoid buffered HTTP read-ahead stealing initial multiplex bytes.
            headers = bytearray()
            while not headers.endswith(b'\r\n\r\n'):
                sock.settimeout(remaining())
                byte = sock.recv(1)
                if not byte or len(headers) >= 8192:
                    raise DockerError('terminal transport unavailable')
                headers.extend(byte)
            lines = headers.decode('ascii', 'strict').lower().split('\r\n')
            if (lines[0].split()[:2] != ['http/1.1', '101'] or
                    'upgrade: tcp' not in lines or 'connection: upgrade' not in lines):
                raise DockerError('terminal transport unavailable')
            sock.setblocking(False)
            return sock
        except BaseException:
            sock.close()
            raise

    def lifecycle_volume(self, name, timeout=3):
        if name not in ('pi-user-home', 'pi-home', 'pi-runtime', 'pi-credentials',
                        'pi-huggingface-cache', 'pi-web-hub-runtime'):
            raise ValueError('untrusted lifecycle volume')
        return self.call('GET', '/volumes/' + name, missing=True, timeout=timeout, limit=16384)

    def build(self, context, tag, expected_labels):
        connection = UnixConnection(self.path, timeout=180)
        image = None
        try:
            connection.request('POST', '/v1.45/build?t=' + quote(tag, safe='') + '&networkmode=none&rm=1&forcerm=1&pull=0',
                               context, {'Content-Type': 'application/x-tar'})
            response = connection.getresponse()
            if response.status != 200:
                raise DockerError('candidate image build failed')
            total = 0
            while True:
                line = response.readline(65537)
                if not line:
                    break
                total += len(line)
                if len(line) > 65536 or total > 4 * 1024 * 1024:
                    raise DockerError('build output exceeds limit')
                event = json.loads(line)
                if 'error' in event or 'errorDetail' in event:
                    raise DockerError('candidate image build failed')
                result = event.get('aux', {}).get('ID')
                if result:
                    if not re.fullmatch(r'sha256:[0-9a-f]{64}', result) or (image and image != result):
                        raise DockerError('invalid build success image identity')
                    image = result
        finally:
            connection.close()
        if not image:
            raise DockerError('build ended without terminal success identity')
        info = self.call('GET', '/images/' + quote(image, safe='') + '/json')
        if info['Id'] != image or any(info['Config'].get('Labels', {}).get(k) != v
                                      for k, v in expected_labels.items()):
            raise DockerError('built image provenance mismatch')
        tagged = self.call('GET', '/images/' + quote(tag, safe='') + '/json')
        if tagged['Id'] != image:
            raise DockerError('build tag no longer resolves to success image')
        return image

    def image_env(self, image):
        return self.call('GET', '/images/' + quote(image, safe='') + '/json')['Config'].get('Env', [])

    def image_info(self, reference, timeout=None):
        return self.call('GET', '/images/' + quote(reference, safe='') + '/json',
                         missing=True, limit=1024 * 1024, timeout=timeout)

    @staticmethod
    def _digest_alias(reference):
        repository, separator, digest = reference.partition('@')
        if not separator:
            return reference
        parts = repository.split('/')
        if '.' not in parts[0] and ':' not in parts[0] and parts[0] != 'localhost':
            repository = 'docker.io/' + ('library/' if len(parts) == 1 else '') + repository
        elif repository.startswith('index.docker.io/'):
            repository = 'docker.io/' + repository[len('index.docker.io/'):]
        if repository.startswith('docker.io/') and repository.count('/') == 1:
            repository = 'docker.io/library/' + repository[len('docker.io/'):]
        return repository + '@' + digest

    def resolve_image(self, reference):
        from .registry import validate_image_reference
        if not isinstance(reference, str) or '@' not in reference:
            raise ValueError('image reference must contain a repository and digest')
        validate_image_reference(reference.split('@', 1)[0], reference)
        info = self.image_info(reference)
        if not info:
            self._pull_image(reference)
            info = self.image_info(reference)
        if (not info or not re.fullmatch(r'sha256:[0-9a-f]{64}', info.get('Id', '')) or
                self._digest_alias(reference) not in
                [self._digest_alias(value) for value in info.get('RepoDigests') or []]):
            raise DockerError('image digest or full identity mismatch')
        return info['Id']

    def _pull_image(self, reference):
        repository, digest = reference.split('@', 1)
        connection = UnixConnection(self.path, timeout=180)
        deadline = time.monotonic() + 180
        total, pending, terminal, seen_digest = 0, b'', False, False
        try:
            # No X-Registry-Auth, credential helpers, or request-controlled headers.
            connection.request('POST', '/v1.45/images/create?fromImage=' +
                               quote(repository, safe='') + '&tag=' + quote(digest, safe=''))
            response = connection.getresponse()
            if response.status != 200:
                raise DockerError('image pull failed; private registry authentication is unsupported')
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DockerError('image pull exceeded deadline')
                if connection.sock:
                    connection.sock.settimeout(remaining)
                block = response.read1(65536)
                if time.monotonic() >= deadline:
                    raise DockerError('image pull exceeded deadline')
                if not block:
                    break
                total += len(block)
                if total > 4 * 1024 * 1024:
                    raise DockerError('image pull output exceeds limit')
                pending += block
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    if len(line) > 65536:
                        raise DockerError('image pull event exceeds limit')
                    event = json.loads(line)
                    if not isinstance(event, dict) or 'error' in event or 'errorDetail' in event:
                        raise DockerError('image pull failed')
                    status = event.get('status', '')
                    if not isinstance(status, str):
                        raise DockerError('invalid image pull event')
                    if status.startswith('Digest: '):
                        if status != 'Digest: ' + digest:
                            raise DockerError('image pull digest mismatch')
                        seen_digest = True
                    for prefix in ('Status: Downloaded newer image for ', 'Status: Image is up to date for '):
                        if status.startswith(prefix):
                            if self._digest_alias(status[len(prefix):]) != self._digest_alias(reference):
                                raise DockerError('image pull terminal reference mismatch')
                            terminal = True
                if len(pending) > 65536:
                    raise DockerError('image pull event exceeds limit')
            if pending or not terminal or not seen_digest:
                raise DockerError('image pull ended without complete digest success')
        except (OSError, ValueError, http.client.HTTPException) as error:
            raise DockerError('image pull transport or stream failed') from None
        finally:
            connection.close()

    def ensure_base(self, image):
        alias = 'pi-web-hub:gate-base-' + image.removeprefix('sha256:')[:12]
        original = self.call('GET', '/images/' + quote(image, safe='') + '/json')
        if original['Id'] != image:
            raise DockerError('trusted base image mismatch')
        tagged = self.call('GET', '/images/' + quote(alias, safe='') + '/json', missing=True)
        if tagged and tagged['Id'] != image:
            raise DockerError('trusted base alias was changed')
        if not tagged:
            self.call('POST', '/images/' + quote(image, safe='') + '/tag?repo=pi-web-hub&tag=gate-base-' + image[7:19])

    def create(self, name, body, timeout=None):
        return self.call('POST', '/containers/create?name=' + quote(name, safe=''), body, timeout=timeout)['Id']

    def start(self, key, timeout=None):
        self.call('POST', '/containers/' + key + '/start', timeout=timeout)

    def stop(self, key):
        self.call('POST', '/containers/' + key + '/stop?t=20')

    def rename(self, key, name):
        self.call('POST', '/containers/' + key + '/rename?name=' + quote(name, safe=''))

    def remove(self, key, timeout=None):
        # Never request volume removal, never remove an object selected by a broad filter.
        self.call('DELETE', '/containers/' + key + '?force=1&v=0', timeout=timeout)

    def healthy(self, key, seconds):
        deadline = time.monotonic() + seconds
        while True:
            item = self.inspect(key)
            if not item or not item['State']['Running']:
                return False
            health = item['State'].get('Health', {}).get('Status')
            if health == 'healthy':
                return True
            if health == 'unhealthy' or time.monotonic() >= deadline:
                return False
            time.sleep(0.5)

    def probe(self, image, job):
        name = 'pi-gate-probe-' + job
        body = {'Image': image, 'User': '1000:1000', 'Entrypoint': ['node'], 'Cmd': ['-e', PROBE],
                'Labels': {'pi.deploy-gate.probe': job},
                'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                               'SecurityOpt': ['no-new-privileges:true'], 'Memory': 256 * 1024 * 1024,
                               'NanoCpus': 1000000000, 'PidsLimit': 64,
                               'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'},
                               'LogConfig': {'Type': 'none'}}}
        existing = self.inspect(name)
        if existing:
            self.cleanup_probe(job, image)
        identifier = self.create(name, body)
        try:
            self.start(identifier)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                item = self.inspect(identifier)
                if not item['State']['Running']:
                    if item['State']['ExitCode'] != 0:
                        raise DockerError('isolated candidate validation failed')
                    return
                time.sleep(0.25)
            raise DockerError('isolated candidate validation timed out')
        finally:
            self.remove(identifier)

    def cleanup_probe(self, job, image):
        item = self.inspect('pi-gate-probe-' + job)
        if not item:
            return
        if (item['Config'].get('Labels', {}).get('pi.deploy-gate.probe') != job or
                item['Image'] != image or item.get('Mounts')):
            raise DockerError('probe identity drift; manual cleanup required')
        self.remove(item['Id'])
