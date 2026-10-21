"""Task5 ONLY: real Gate/Engine/provider + bundled runtime + synthetic PTY child.

No live objects, source writes, image pulls, package installs or model credentials.
The Hub runs outside Docker and has no Docker socket. Exact labelled cleanup only.
"""
import io
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import sys
import tarfile
import threading
import time
from urllib.parse import quote

SOURCE = Path(os.environ['PI_TASK5_GATE_SOURCE']).resolve()
sys.path.insert(0, str(SOURCE))
from gate.engine import Engine
from gate.service import Gate
from gate.terminal_provider import TerminalProvider
from gate.terminal_contract import encode

BASE = 'sha256:1a23ab4104c1d806a9cd2370f508ed04d83ea79c48ebdf9da8d99ae904cebae8'
REPO = Path(__file__).resolve().parents[2]
CHILD = r'''
import json, os, socket, threading
identity = dict(runId=os.environ['PI_RUNTIME_RUN_ID'], runtimeId='task5-runtime', sessionId='task5-session', terminalEpoch=os.environ['PI_RUNTIME_TERMINAL_EPOCH'])
latched = False
server = socket.socket(socket.AF_UNIX)
server.bind(os.environ['PI_RUNTIME_EXTENSION_SOCKET'])
os.chmod(os.environ['PI_RUNTIME_EXTENSION_SOCKET'], 0o600)
server.listen(4)
def adapter():
    global latched
    while True:
        peer, _ = server.accept()
        with peer:
            try:
                peer.settimeout(1)
                data = b''
                while not data.endswith(b'\n') and len(data) < 65536:
                    part = peer.recv(4096)
                    if not part: break
                    data += part
                request = json.loads(data)
                if request['token'] != os.environ['PI_RUNTIME_CHILD_TOKEN'] or any(identity[k] != v for k,v in request['expected'].items()):
                    continue
                if request['action'] == 'terminal-prepare': latched = True
                peer.sendall((json.dumps({'ok':True,'result':dict(identity,adapterInstanceId='a'*32,latched=latched)})+'\n').encode())
            except Exception: pass
threading.Thread(target=adapter, daemon=True).start()
print('TASK5 NATIVE SCREEN READY', flush=True)
print('原生终端：中文输入与显式按键', flush=True)
while True:
    text = input()
    if text == 'SWITCH_SESSION': identity['sessionId'] = 'task5-session-replaced'
    print('RECEIVED:' + text, flush=True)
'''
TOKEN = r'''
import os, secrets
with os.fdopen(os.open('/run/pi-terminal-credentials/provider.token', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o640),'w') as stream:
    os.fchmod(stream.fileno(),0o640)
    stream.write(secrets.token_hex(32))
'''

def context(label):
    dockerfile = '''FROM %s
USER root
COPY runtime/ /usr/local/lib/pi-runtime/terminal/
COPY child.py token.py secret-probe.mjs /opt/task5/
COPY pi-entrypoint /usr/local/bin/pi-entrypoint
RUN chmod 755 /usr/local/bin/pi-entrypoint && install -d -o 1000 -g 1000 -m 700 /run/pi-runtime && install -d -o 0 -g 1000 -m 2770 /run/pi-terminal-credentials
LABEL pi.task5.test="%s"
USER 1000:1000
''' % (BASE, label)
    files = {'Dockerfile': dockerfile.encode(), 'child.py': CHILD.encode(), 'token.py': TOKEN.encode(),
             'secret-probe.mjs': Path(os.environ['PI_TASK5_SECRET_PROBE']).read_bytes(),
             'pi-entrypoint': b'#!/bin/sh\nexec /usr/bin/python3 -I /usr/local/lib/pi-runtime/terminal/supervisor.py /usr/bin/python3 -I /opt/task5/child.py\n'}
    for name in ('broker.cjs', 'supervisor.py', 'client.py'):
        files['runtime/' + name] = (REPO / 'dist/runtime' / name).read_bytes()
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return result.getvalue()

def main():
    def terminate(*_): raise SystemExit(1)
    signal.signal(signal.SIGTERM, terminate)
    directory, run = Path(sys.argv[1]), sys.argv[2]
    engine = Engine()
    assert engine.image_info(BASE)['Id'] == BASE
    prefix = 'pi-task5-' + secrets.token_hex(6)
    labels = {'pi.task5.test': prefix}
    tag, containers, volumes = prefix + ':test', [], []
    image = gate = provider = listener = None
    threads = []
    stop = threading.Event()
    def host():
        return dict(NetworkMode='none', ReadonlyRootfs=False, CapDrop=['ALL'], SecurityOpt=['no-new-privileges:true'], Memory=268435456, NanoCpus=1000000000, PidsLimit=64, LogConfig={'Type':'none','Config':{}}, Tmpfs={'/tmp':'rw,nosuid,nodev,noexec,size=32m,mode=1777'})
    def create(suffix, body):
        body['Labels'] = {**body.get('Labels',{}), **labels}
        cid = engine.create(prefix + '-' + suffix, body, timeout=5)
        containers.append(cid); engine.start(cid,timeout=5)
        return cid
    def wait(cid):
        assert engine.call('POST','/containers/' + cid + '/wait?condition=not-running',timeout=10)['StatusCode'] == 0, 'owned credential-reader probe failed'
    try:
        image = engine.build(context(prefix), tag, labels)
        volume = prefix + '-credentials'
        engine.call('POST','/volumes/create',{'Name':volume,'Labels':labels},timeout=5); volumes.append(volume)
        mount = {'Type':'volume','Source':volume,'Target':'/run/pi-terminal-credentials'}
        h = host(); h['Mounts'] = [mount]
        wait(create('token-owner',dict(Image=image,User='0:0',Entrypoint=['/usr/bin/python3'],Cmd=['-I','/opt/task5/token.py'],HostConfig=h)))
        for readonly, mode in ((True,'accept'),(False,'reject')):
            h = host(); h['ReadonlyRootfs'] = True; h['Mounts'] = [dict(mount,ReadOnly=readonly)]
            wait(create('reader-' + mode,dict(Image=image,User='1000:1000',Entrypoint=['/usr/local/bin/node'],Cmd=['/opt/task5/secret-probe.mjs',mode],HostConfig=h)))
        cid = create('runtime',dict(Image=image,User='1000:1000',Entrypoint=['/usr/local/bin/pi-entrypoint'],Cmd=[],Tty=True,OpenStdin=True,StdinOnce=False,HostConfig=host(),Env=['PI_RUNTIME_PROFILE=web-terminal-v1','PI_RUNTIME_RUN_ID=' + run,'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','PI_PIRUN_WEB_TERMINAL_CONTROL=remote','HOME=/tmp/task5-home'],Labels={'cn.swordfate.pi.run-id':run,'cn.swordfate.pi.runtime-profile':'web-terminal-v1'}))
        original = engine.inspect(cid)
        assert original['Config']['User'] == '1000:1000' and not original['Mounts'] and not original.get('LogPath')
        gate = Gate(directory / 'gate-state'); gate.lifecycle.engine = engine
        provider = TerminalProvider(gate,{'enabled':True,'images':[image]},secrets.token_hex(32))
        token_file = directory / 'provider.token'
        fd = os.open(token_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as out: out.write(provider.token)
        address = directory / 'provider.sock'
        listener = socket.socket(socket.AF_UNIX); listener.bind(str(address)); listener.listen(8); listener.settimeout(.1)
        def accept():
            while not stop.is_set():
                try: peer, _ = listener.accept()
                except socket.timeout: continue
                except OSError: break
                thread = threading.Thread(target=provider.handle,args=(peer,),daemon=True); threads.append(thread); thread.start()
        accept_thread = threading.Thread(target=accept,daemon=True); accept_thread.start()
        deadline = time.monotonic() + 15
        target = None
        while target is None:
            with socket.socket(socket.AF_UNIX) as peer:
                peer.settimeout(3); peer.connect(str(address)); peer.sendall(encode(dict(v=1,op='status',token=provider.token,runId=run)))
                data = b''
                while not data.endswith(b'\n'):
                    block = peer.recv(32768)
                    if not block: break
                    data += block
                if data:
                    ready = json.loads(data)
                    if ready.get('type') == 'ready': target = ready['target']
            assert time.monotonic() < deadline, 'owned synthetic runtime not ready'
            if target is None: time.sleep(.1)
        print(json.dumps(dict(type='ready',target=target,provider=dict(socketPath=str(address),credentialFile=str(token_file)),permissionProbe=True)),flush=True)
        for line in sys.stdin:
            if line.strip() == 'stop': break
            if line.strip() == 'assert-live':
                current = engine.inspect(cid)
                assert current['State']['Running'] and current['State']['Pid'] == original['State']['Pid']
                print('{"type":"live","sameChild":true}',flush=True)
    finally:
        stop.set()
        if listener: listener.close()
        if provider: provider.close()
        for thread in threads: thread.join(8)
        assert not any(thread.is_alive() for thread in threads), 'owned provider thread remains'
        if gate: gate.close()
        for cid in reversed(containers):
            item = engine.inspect(cid,timeout=5)
            assert item['Config']['Labels'].get('pi.task5.test') == prefix
            engine.remove(cid,timeout=10)
        for name in volumes:
            info = engine.call('GET','/volumes/' + name,timeout=5)
            assert info['Labels'].get('pi.task5.test') == prefix
            engine.call('DELETE','/volumes/' + name,timeout=10)
        if image: engine.call('DELETE','/images/' + quote(tag,safe=''),timeout=10)
        print('{"type":"cleanup","ownedResourcesRemoved":true}',flush=True)

if __name__ == '__main__': main()
