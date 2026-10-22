"""Self-contained script executed in a restricted, disposable update container."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

# Match the SDK/TUI versions audited by the image-owned stdin guard and Web
# runtime-control extension. Extending this list requires a new manual protocol
# and session/draft-preservation audit, not merely a successful npm installation.
AUDITED_VERSIONS = frozenset(('1.1.0', '1.3.0'))


def install(prefix, version, task, action='prepare'):
    if (not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version)
            or version not in AUDITED_VERSIONS or not re.fullmatch('[0-9a-f]{32}', task)
            or action not in ('prepare', 'activate')):
        raise ValueError('invalid exact runtime version or task')
    prefix = Path(prefix)
    activated = False
    try:
        if prefix.is_symlink() or not prefix.is_dir():
            raise ValueError('invalid runtime prefix')
        with open(prefix / '.pi-runtime-update.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            entry = prefix / 'bin/pi'
            if entry.parent.is_symlink() or not entry.is_symlink():
                raise ValueError('runtime entrypoint must be a package symlink')
            previous = os.readlink(entry)
            releases = prefix / '.pi-releases'
            releases.mkdir(mode=0o755, exist_ok=True)
            if releases.is_symlink():
                raise ValueError('invalid releases directory')
            release = releases / task
            candidate = release / 'bin/pi'
            receipt = release / 'receipt.json'
            if action == 'prepare':
                # Existing artifacts may be evidence of an earlier activation.
                # Never classify a replay as a fresh, clean installation failure.
                if release.exists() or release.is_symlink():
                    return {'ok': False, 'stage': 'activation_unknown'}
                release.mkdir(mode=0o755)
                command = ['/usr/local/bin/npm', '--prefix', str(release), 'install', '-g',
                           '--ignore-scripts', '--min-release-age=0', '--no-audit', '--no-fund',
                           '--registry=https://registry.npmjs.org/',
                           '@earendil-works/pi-coding-agent@' + version]
                subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=840, check=True)
                value = {'version': version, 'task': task, 'previous_target': previous,
                         'target': str(candidate), 'phase': 'prepared'}
            else:
                if release.is_symlink() or receipt.is_symlink():
                    raise ValueError('invalid prepared release')
                value = json.loads(receipt.read_text())
                if (set(value) != {'version', 'task', 'previous_target', 'target', 'phase'} or
                        value['version'] != version or value['task'] != task or
                        value['target'] != str(candidate) or value['phase'] != 'prepared' or
                        value['previous_target'] != previous):
                    return {'ok': False, 'stage': 'activation_unknown'}
            if not candidate.resolve(strict=True).is_relative_to(release.resolve(strict=True)):
                raise ValueError('candidate escapes release')
            checked = subprocess.run([str(candidate), '--version'], stdin=subprocess.DEVNULL,
                                     capture_output=True, text=True, timeout=15, check=True)
            if checked.stdout.strip() != version or len(checked.stdout) > 512:
                raise ValueError('installed version mismatch')
            # Direct npm updates do not share our lock: refuse a changed entrypoint.
            if not entry.is_symlink() or os.readlink(entry) != previous:
                raise ValueError('runtime entrypoint changed during installation')
            if action == 'prepare':
                with open(receipt, 'x') as stream:
                    json.dump(value, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                return {'ok': True, 'version': version, 'changed': False}
            link = entry.parent / ('.pi-update-' + task)
            link.symlink_to(candidate)
            # Any interruption from this point is ambiguous, including a failed
            # filesystem operation whose completion was not observed by Python.
            activated = True
            os.replace(link, entry)
            descriptor = os.open(entry.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            value['phase'] = 'activated'
            with open(receipt, 'w') as stream:
                json.dump(value, stream)
                stream.flush()
                os.fsync(stream.fileno())
            return {'ok': True, 'version': version, 'changed': True}
    except Exception:
        return {'ok': False, 'stage': 'activation_unknown' if activated else 'install_failed'}


if __name__ == '__main__':
    outcome = install(Path('/home/node/.local'), sys.argv[1], sys.argv[2], sys.argv[3])
    print(json.dumps(outcome, separators=(',', ':')), flush=True)
    sys.exit(0 if outcome['ok'] else 1)
