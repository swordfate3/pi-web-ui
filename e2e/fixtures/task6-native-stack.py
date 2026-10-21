"""Isolated actual Docker/Pi/Gate/Hub orchestration, not a synthetic PTY child.

Only owned, labelled resources. No user home/token/env/policy/production volume.
The staged host gatectl changes only its fixed test Gate container name.
"""
import base64
import json
import os
from pathlib import Path
import pty
import secrets
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import ProxyHandler, build_opener

REPO = Path(__file__).resolve().parents[2]
GATE = Path(os.environ['PI_TASK6_GATE_SOURCE']).resolve()
PI = Path(os.environ['PI_TASK6_DOCKER_SOURCE']).resolve()
BASE = 'sha256:1a23ab4104c1d806a9cd2370f508ed04d83ea79c48ebdf9da8d99ae904cebae8'
CANONICAL = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'


def command(*args, data=None, timeout=15):
    result = subprocess.run(list(args), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        # Never echo private exports, tokens, terminal output or arbitrary errors.
        raise RuntimeError('isolated operation failed: ' + args[0] + ' ' + args[1])
    return result.stdout


def docker(*args, **kwargs):
    return command('docker', *args, **kwargs)


def port():
    with socket.socket() as peer:
        peer.bind(('127.0.0.1', 0))
        return peer.getsockname()[1]


def wait_for(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if result:
            return result
        if time.monotonic() >= deadline:
            raise RuntimeError('isolated readiness deadline')
        time.sleep(.05)


class Stack:
    def __init__(self):
        self.prefix = 'pi-task6-' + secrets.token_hex(6)
        self.temporary = tempfile.TemporaryDirectory(prefix=self.prefix + '-')
        self.root = Path(self.temporary.name)
        self.containers, self.volumes, self.images = [], [], []
        self.master = self.launcher = None
        self.stop_drain = threading.Event()
        self.drain = None
        self.closed = False
        self.base_alias = None
        self.evidence = {'prefix': self.prefix, 'base': BASE}

    def inspect(self, name):
        return json.loads(docker('inspect', '--format', '{{json .}}', name))

    def common(self, memory='512m', network='none'):
        return ['--label', 'pi.task6.test=' + self.prefix, '--network', network,
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--memory', memory, '--cpus', '2', '--pids-limit', '128', '--log-driver', 'none']

    def create(self, suffix, image, args, mounts=(), user='1000:1000', network='none', entrypoint='/usr/local/bin/node', readonly=True):
        name = self.prefix + '-' + suffix
        options = self.common(network=network)
        if readonly:
            options += ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777']
        for mount in mounts:
            options += ['--mount', mount]
        docker('create', '--name', name, *options, '--user', user, '--entrypoint', entrypoint, image, *args)
        self.containers.append(name)
        docker('start', name)
        return name

    def build(self, context, tag, *args):
        self.images.append(tag)
        print(json.dumps(dict(type='progress',prefix=self.prefix,stage='build',resource=tag)),flush=True)
        result = subprocess.run(['docker', 'build', '--pull=false', '--network', 'none', '--label',
                                 'pi.task6.test=' + self.prefix, '-t', tag, *args, str(context)],
                                capture_output=True,timeout=90)
        if result.returncode:
            sys.stderr.buffer.write(result.stderr[-8000:]) # sanitized build context, no credentials/TUI
            raise RuntimeError('isolated image build failed')
        log=result.stdout
        # Docker output contains build metadata only; retain bounded counts, not TUI.
        self.evidence.setdefault('buildOutputBytes', []).append(len(log))
        return json.loads(docker('image', 'inspect', '--format', '{{json .Id}}', tag))

    def hub_cli(self, *args):
        return json.loads(docker('exec', '--user', '1000:1000', self.hub, '/usr/local/bin/node',
                                '/opt/pi-web-ui/dist/hub/pi-web-hub.mjs', *args, '--config', '/hub/private/config.json'))

    def events(self):
        file = self.workspace / 'native-events.jsonl'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def native(self):
        # Native extension's actual process.pid plus kernel PPID/start time/exe,
        # not Docker State.Pid (the Python supervisor).
        pid = self.events()[0]['pid']
        script = 'import json,os,pathlib; p=pathlib.Path("/proc/' + str(pid) + '"); s=(p/"stat").read_text().rsplit(") ",1)[1].split(); print(json.dumps(dict(pid=' + str(pid) + ',ppid=int(s[1]),start=s[19],exe=os.readlink(p/"exe"))))'
        result = json.loads(docker('exec', '--user', '1000:1000', self.pi, '/usr/bin/python3', '-I', '-c', script))
        assert result['pid'] != 1 and result['ppid'] == 1 and result['exe'] == '/usr/local/bin/node'
        assert self.events()[0]['entry'] == '/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
        if hasattr(self, 'original_native'):
            assert result == self.original_native, 'native Pi child changed'
        return result

    def start(self):
        self.workspace = self.root / 'workspace'
        private, registry, fixture = [self.root / name for name in ('private', 'registry', 'fixture')]
        for directory in (self.workspace, private, registry, fixture):
            directory.mkdir(mode=0o700)
        # Synthetic, token-free model and SSH inputs exercise normal entry setup.
        (registry/'models.json').write_text('{"providers":{}}\n')
        ssh=fixture/'ssh'; ssh.mkdir(mode=0o700)
        (ssh/'config').write_text('# Task6 synthetic SSH preparation marker\n')
        command('git', 'init', '-q', str(self.workspace))
        # BuildKit interprets a bare image ID in FROM as a registry repository.
        # An isolated local alias preserves the exact cached ID without touching
        # the user's existing tags or resolving a registry image.
        self.base_alias = self.prefix + ':cached-base'
        docker('tag', BASE, self.base_alias)
        assert json.loads(docker('image','inspect','--format','{{json .Id}}',self.base_alias)) == BASE
        stage = self.root / 'release-context'
        command('node', str(REPO/'scripts/stage-terminal-image.mjs'), '--output', str(stage), timeout=20)
        context = self.root / 'runtime-build'
        context.mkdir()
        shutil.copy2(PI/'pi-entrypoint', context/'pi-entrypoint')
        text = (PI/'Dockerfile.terminal').read_text()
        # Root-owned test fixture extension and faux provider only; production
        # runtime/entrypoint remain the actual installed artifacts.
        text = text.replace('USER 1000:1000\nENTRYPOINT', 'COPY fixtures/ /opt/task6/fixtures/\nUSER 1000:1000\nENTRYPOINT')
        (context/'Dockerfile').write_text(text)
        shutil.copytree(REPO/'e2e/fixtures', context/'fixtures', ignore=shutil.ignore_patterns('__pycache__'))
        self.runtime_image = self.build(context, self.prefix+':runtime', '--build-arg', 'PI_TERMINAL_BASE='+self.base_alias,
                                        '--build-context', 'pi_terminal='+str(stage))
        self.evidence['runtimeImage'] = self.runtime_image
        gate_context = self.root/'gate-build'
        gate_context.mkdir()
        shutil.copytree(GATE/'gate', gate_context/'gate', ignore=shutil.ignore_patterns('__pycache__'))
        gatefile = (GATE/'Dockerfile').read_text()
        lines = gatefile.splitlines()
        assert lines[1].startswith('FROM ')
        lines[1] = 'FROM ' + self.base_alias
        (gate_context/'Dockerfile').write_text('\n'.join(lines)+'\n')
        self.chat_port, self.terminal_port, self.management_port = port(), port(), port()
        assert len({self.chat_port,self.terminal_port,self.management_port}) == 3
        policy = dict(target=self.prefix+'-hub', base_image=BASE, private_volume=self.prefix+'-unused-private',
                      runtime_volume=self.prefix+'-unused-runtime', health_port=self.chat_port, health_timeout=1)
        (gate_context/'policy.json').write_text(json.dumps(policy))
        (gate_context/'terminal-policy.json').write_text(json.dumps(dict(enabled=True,images=[self.runtime_image])))
        gate_image = self.build(gate_context, self.prefix+':gate')
        self.evidence['gateImage'] = gate_image
        for suffix in ('state', 'ipc', 'credentials'):
            name = self.prefix+'-'+suffix
            docker('volume','create','--label','pi.task6.test='+self.prefix,name)
            self.volumes.append(name)
        print(json.dumps(dict(type='progress',prefix=self.prefix,stage='gate',volumes=self.volumes)),flush=True)
        gate_mounts = ['type=volume,src='+self.volumes[0]+',dst=/state',
                       'type=volume,src='+self.volumes[1]+',dst=/run/pi-terminal-provider',
                       'type=volume,src='+self.volumes[2]+',dst=/run/pi-terminal-credentials',
                       'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock']
        self.gate = self.create('gate',gate_image,['-m','gate.service','--port','0'],gate_mounts,user='0:0',entrypoint='/usr/bin/python3')
        # Actual production host CLI; only the test container name is staged.
        gatectl = (GATE/'gatectl').read_text()
        assert gatectl.count("GATE = 'pi-deploy-gate'") == 1
        self.host_cli = self.root/'gatectl'
        self.host_cli.write_text(gatectl.replace("GATE = 'pi-deploy-gate'", 'GATE = '+repr(self.gate)))
        self.host_env = dict(os.environ, PYTHONPATH=str(GATE), PI_PIRUN_DOCKER_BIN='docker')
        def preflight():
            result = subprocess.run(['/usr/bin/python3',str(self.host_cli),'terminal-preflight','--image',self.runtime_image],
                                    env=self.host_env,capture_output=True,timeout=2.5)
            return json.loads(result.stdout) if result.returncode == 0 else None
        self.evidence['preflight'] = wait_for(preflight, timeout=10)
        self.evidence['preflightBeforePiCreation'] = True
        print(json.dumps(dict(type='progress',prefix=self.prefix,stage='preflight-passed',resource=self.gate)),flush=True)
        config = dict(port=self.chat_port,management={'port':self.management_port},runtimeDir='/run/pi-web-hub',
                      terminal={'port':self.terminal_port,'provider':{'socketPath':'/run/pi-terminal-provider/provider.sock',
                                                                   'credentialFile':'/run/pi-terminal-credentials/provider.token'}})
        file = private/'config.json'; file.write_text(json.dumps(config)); file.chmod(0o600)
        self.hub = self.create('hub',self.runtime_image,['/opt/pi-web-ui/dist/hub/pi-web-hub.mjs','serve','--config','/hub/private/config.json'],
            ['type=bind,src='+str(private)+',dst=/hub/private', 'type=bind,src='+str(registry)+',dst=/run/pi-web-hub',
             'type=volume,src='+self.volumes[1]+',dst=/run/pi-terminal-provider,readonly',
             'type=volume,src='+self.volumes[2]+',dst=/run/pi-terminal-credentials,readonly'],network='host')
        opener = build_opener(ProxyHandler({}))
        def sessions():
            try:
                with opener.open('http://127.0.0.1:'+str(self.chat_port)+'/api/sessions',timeout=1) as response:
                    return json.loads(response.read())
            except OSError:
                return None
        wait_for(lambda: registry.joinpath('registry.sock').exists() and sessions() is not None)
        issued = self.hub_cli('issue','--output','/hub/private/run.json','--label','Task6 native real Pi')
        credential = private/'run.json'
        assert json.loads(credential.read_text())['run_id'] == issued['runId']
        self.run = issued['runId']
        env = dict(HOME='/home/node',PATH=CANONICAL,PI_RUNTIME_PROFILE='web-terminal-v1',PI_RUNTIME_RUN_ID=self.run,
                   PI_PIRUN_WEB_TERMINAL_CONTROL='local', PI_CODING_AGENT_DIR='/home/node/.pi/agent',
                   PI_WEB_UI_HOST='127.0.0.1', PI_WEB_UI_PORT=str(port()),PI_WEB_UI_DISABLED='false',PI_OFFLINE='1',
                   PI_WEB_UI_REGISTRY_SOCKET='/run/cc-switch-pi-models/registry.sock',
                   PI_CC_SWITCH_MODELS_DIR='/run/cc-switch-pi-models',
                   PI_WEB_UI_REGISTRY_CREDENTIAL_FILE='/run/secrets/pi-web-session.json',PI_TASK6_NATIVE_TEST='1')
        self.pi = self.prefix+'-pi'
        spec = {'services':{'pi':dict(image=self.runtime_image,user='1000:1000',working_dir='/workspace',
            network_mode='host',entrypoint=['/usr/local/bin/pi-entrypoint'],stdin_open=True,tty=True,
            cap_drop=['ALL'],security_opt=['no-new-privileges'],environment=env,
            labels={'pi.task6.test':self.prefix,'cn.swordfate.pi.run-id':self.run,'cn.swordfate.pi.runtime-profile':'web-terminal-v1'},
            volumes=[str(self.workspace)+':/workspace',str(registry)+':/run/cc-switch-pi-models:ro',str(credential)+':/run/secrets/pi-web-session.json:ro',str(ssh)+':/run/host-ssh:ro'])}}
        compose = self.root/'compose.json'; compose.write_text(json.dumps(spec))
        options = ['compose','--project-name',self.prefix,'--project-directory',str(self.root),'--env-file','/dev/null',
                   '-f',str(compose),'-f',str(PI/'compose.terminal.yaml')]
        rendered=json.loads(docker(*options,'config','--format','json'))
        assert rendered['services']['pi']['logging']['driver'] == 'none'
        self.evidence['actualComposeConfigLogging'] = 'none'
        master, slave = pty.openpty(); self.master=master
        import fcntl, struct, termios
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
        self.containers.append(self.pi)
        print(json.dumps(dict(type='progress',prefix=self.prefix,stage='native-launch',containers=self.containers)),flush=True)
        self.launcher=subprocess.Popen(['docker',*options,'run','--name',self.pi,'--no-deps','--pull','never','--interactive','pi',
            '--offline','--model','faux/faux-1','--api-key','faux-key','--session-dir','/home/node/.pi/agent/sessions',
            '--name','Task6 native Pi','--approve','--no-skills','--no-prompt-templates','--no-context-files',
            '--extension','/opt/task6/fixtures/faux-provider-extension.ts','--extension','/opt/task6/fixtures/native-terminal-extension.ts'],
            stdin=slave,stdout=slave,stderr=subprocess.PIPE,env=dict(os.environ,COMPOSE_DISABLE_ENV_FILE='1'))
        os.close(slave)
        self.local_tail=bytearray()
        def drain():
            while not self.stop_drain.is_set():
                if not select.select([master],[],[],.1)[0]:continue
                try: data=os.read(master,32768)
                except OSError:break
                if not data:break
                self.local_tail.extend(data)
                if len(self.local_tail)>65536: del self.local_tail[:-65536]
        self.drain=threading.Thread(target=drain,daemon=True);self.drain.start()
        wait_for(lambda:self.events() and sessions().get('sessions'),timeout=25)
        self.original_native=self.native()
        self.evidence['nativeChild']=self.original_native
        self.evidence['nativeVersionSource']=self.events()[0]['entry']
        self.evidence['nativeVersion']=self.events()[0]['version']
        prep='import json,pathlib,stat; p=pathlib.Path("/home/node"); assert json.loads((p/".pi/agent/models.json").read_text())=={"providers":{}}; s=p/".ssh/config"; assert s.read_text()=="# Task6 synthetic SSH preparation marker\\n"; assert stat.S_IMODE(s.stat().st_mode)==0o600; print("preparation-ok")'
        assert docker('exec','--user','1000:1000',self.pi,'/usr/bin/python3','-I','-c',prep).strip()==b'preparation-ok'
        self.evidence['actualSshAndModelsPreparation']=True
        item=self.inspect(self.pi)
        assert item['Config']['User']=='1000:1000' and item['HostConfig']['LogConfig']['Type']=='none'
        assert not item.get('LogPath') and item['Image']==self.runtime_image
        assert all(m['Destination'] not in ('/var/run/docker.sock','/run/pi-terminal-provider','/run/pi-terminal-credentials') for m in item['Mounts'])
        self.evidence['inspectLogging']='none'
        # Actual UID1000/cap-dropALL Hub reads strict root:GID1000/0640 token on
        # dedicated read-only mounts and calls the real provider, not a host mock.
        probe='import fs from "node:fs"; const c=JSON.parse(fs.readFileSync("/hub/private/config.json"));'
        probe+='const s=fs.statSync(c.terminal.provider.credentialFile); if(process.getuid()!==1000||s.uid!==0||s.gid!==1000||(s.mode&511)!==416)process.exit(2);'
        probe+='const p=fs.readFileSync("/proc/self/status","utf8");if(!/CapEff:\\s+0+\\n/.test(p))process.exit(3);console.log("permission-ok");'
        assert docker('exec','--user','1000:1000',self.hub,'/usr/local/bin/node','--input-type=module','-e',probe).strip()==b'permission-ok'
        info=self.inspect(self.hub)
        assert all(not m['RW'] for m in info['Mounts'] if m['Destination'] in ('/run/pi-terminal-provider','/run/pi-terminal-credentials'))
        self.evidence['hubUidGidReadonlyPermission']=True
        status_script='const fs=require("fs"),net=require("net");const p=JSON.parse(fs.readFileSync("/hub/private/config.json")).terminal.provider; const s=net.createConnection(p.socketPath);s.setTimeout(2000,()=>process.exit(2));let d="";s.on("connect",()=>s.write(JSON.stringify({v:1,op:"status",token:fs.readFileSync(p.credentialFile,"utf8"),runId:process.argv[1]})+"\\n"));s.on("data",b=>{d+=b;if(d.includes("\\n")){console.log(d.split("\\n")[0]);s.destroy()}});'
        def target():
            try:
                raw=docker('exec','--user','1000:1000',self.hub,'/usr/local/bin/node','-e',status_script,self.run,timeout=4)
                return json.loads(raw)['target'] if raw else None
            except (RuntimeError,KeyError):return None
        self.target=wait_for(target,timeout=15)
        code=self.hub_cli('pair-terminal','--run-id',self.run,'--runtime-id',self.target['runtimeId'],
                          '--session-id',self.target['sessionId'],'--terminal-epoch',self.target['terminalEpoch'],'--access','write')['code']
        self.evidence['permissionReadyThroughRealProvider']=True
        return dict(terminalUrl='http://127.0.0.1:'+str(self.terminal_port)+'/',chatUrl='http://127.0.0.1:'+str(self.chat_port)+'/',
                    chatPath=sessions()['sessions'][0]['path'],code=code,target=self.target,prefix=self.prefix)

    def request(self, value):
        op=value['op']
        if op=='local':
            os.write(self.master,base64.b64decode(value['data']))
            return {'written':True}
        if op=='events':return {'events':self.events(),'effects':(self.workspace/'native-effects.txt').read_text().splitlines() if (self.workspace/'native-effects.txt').exists() else [],'native':self.native()}
        if op=='assert-helpers-closed':
            top=json.loads(docker('inspect','--format','{{json .State}}',self.pi))
            assert top['Running']
            # Fixed Python helper must disappear after all browser connections close.
            script='import pathlib,json; a=[]\nfor p in pathlib.Path("/proc").iterdir():\n if p.name.isdigit():\n  try:\n   c=(p/"cmdline").read_bytes().split(b"\\0")\n   if b"/usr/local/lib/pi-runtime/terminal/client.py" in c:a.append(int(p.name))\n  except OSError:pass\nprint(json.dumps(a))'
            wait_for(lambda:json.loads(docker('exec',self.pi,'/usr/bin/python3','-I','-c',script))==[],timeout=5)
            self.evidence['noHelperAfterDisconnect']=True
            return {'closed':True}
        if op=='exit':
            self.native()
            os.write(self.master,b'\x1dl/quit\r')
            wait_for(lambda:self.launcher.poll() is not None,timeout=15)
            assert self.launcher.returncode==0,'native exit did not return zero'
            assert not self.inspect(self.pi)['State']['Running']
            assert any(e['event']=='shutdown' for e in self.events())
            logs=subprocess.run(['docker','logs',self.pi],capture_output=True,timeout=3)
            assert b'TASK6_NATIVE_PI_READY' not in logs.stdout+logs.stderr
            self.evidence.update(nativeExitCode=0,noRetrievableTuiMarker=True,sameNativeChildVerified=True)
            return {'exited':True}
        raise ValueError('unknown fixture operation')

    def close(self):
        if self.closed:return
        self.closed=True
        if hasattr(self,'workspace'):
            self.evidence['nativeEvents']=self.events()
            effects=self.workspace/'native-effects.txt'
            self.evidence['effects']=effects.read_text().splitlines() if effects.exists() else []
        if self.master is not None and self.launcher and self.launcher.poll() is None:
            try:os.write(self.master,b'\x1dl/quit\r')
            except OSError:pass
        for name in reversed(self.containers):
            result=subprocess.run(['docker','inspect','--format','{{json .Config.Labels}}',name],capture_output=True,timeout=5)
            if result.returncode:continue
            assert json.loads(result.stdout).get('pi.task6.test')==self.prefix
            if self.inspect(name)['State']['Running']:
                docker('stop','--time','5',name,timeout=8)
            docker('rm','-f',name,timeout=12)
        if self.launcher:
            if self.launcher.poll() is None:self.launcher.terminate()
            self.launcher.communicate(timeout=5)
        self.stop_drain.set()
        if self.drain:self.drain.join(1)
        if self.master is not None:os.close(self.master)
        registry=self.root/'registry/registry.sock'
        assert not registry.exists(),'Hub registry socket left after graceful close'
        if self.volumes:
            probe=self.prefix+'-cleanup-probe'
            docker('run','--rm','--name',probe,*self.common(), '--read-only','--user','1000:1000',
                   '--mount','type=volume,src='+self.volumes[1]+',dst=/run/pi-terminal-provider,readonly',
                   '--entrypoint','/usr/bin/python3',self.runtime_image,'-I','-c',
                   'from pathlib import Path; assert not Path("/run/pi-terminal-provider/provider.sock").exists()')
            self.evidence['gateAndHubSocketsRemoved']=True
        for name in self.volumes:
            assert json.loads(docker('volume','inspect','--format','{{json .Labels}}',name))['pi.task6.test']==self.prefix
            docker('volume','rm',name)
        for tag in reversed(self.images):
            result=subprocess.run(['docker','image','inspect','--format','{{json .Config.Labels}}',tag],capture_output=True,timeout=5)
            if result.returncode:continue
            assert json.loads(result.stdout).get('pi.task6.test')==self.prefix
            docker('image','rm',tag,timeout=15)
        if self.base_alias:
            assert json.loads(docker('image','inspect','--format','{{json .Id}}',self.base_alias)) == BASE
            docker('image','rm',self.base_alias,timeout=15)
        remaining=docker('ps','-aq','--filter','label=pi.task6.test='+self.prefix).strip()
        assert not remaining
        assert not docker('volume','ls','-q','--filter','label=pi.task6.test='+self.prefix).strip()
        assert not docker('image','ls','-q','--filter','label=pi.task6.test='+self.prefix).strip()
        self.evidence['ownedResourcesRemoved']=True
        artifacts=Path(os.environ.get('PI_E2E_ARTIFACT_DIR','/tmp/pi-task6-browser'))
        artifacts.mkdir(parents=True,exist_ok=True)
        (artifacts/(self.prefix+'-evidence.json')).write_text(json.dumps(self.evidence,indent=2)+'\n')
        self.temporary.cleanup()


def main():
    stack=Stack()
    def stopping(*_):raise SystemExit(1)
    signal.signal(signal.SIGTERM,stopping)
    try:
        print(json.dumps({'type':'ready',**stack.start()}),flush=True)
        for line in sys.stdin:
            value=json.loads(line)
            if value['op']=='stop':break
            print(json.dumps({'type':'result',**stack.request(value)}),flush=True)
    finally:
        stack.close()
        print('{"type":"cleanup","ownedResourcesRemoved":true}',flush=True)


if __name__=='__main__':main()
