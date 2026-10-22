"""Global shared-runtime upgrades with durable, idle-only session refresh."""
import json
import re
import secrets
import threading
import time

from .lifecycle import Deadline
from .lifecycle_contract import IMAGE, identifier, snapshot, terminal_profile
from .registry import fingerprint
from .runtime_catalog import RegistryUnavailable, RuntimeCatalog, stable_version
from .runtime_install import checked_candidate, checked_evidence, digest, pinned_release
from .runtime_engine import MAX_SOURCES, checked_source, checked_source_evidence
from .store import ACTIVE, REQUEST_OPEN, _json

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
OPEN = ('pending', 'queued', 'running', 'recovery_required')
SUBMIT_SINGLE_FLIGHT_WAIT = 10
MAX_SUBMIT_FLIGHTS = 128


class RuntimeUpdates:
    def __init__(self, gate):
        self.gate, self.store = gate, gate.store
        self.runtime_engine = None
        self.catalog = RuntimeCatalog()
        self._submit_flights_lock = threading.Lock()
        self._submit_flights = {}

    def _engine(self):
        if self.runtime_engine is not None:
            return self.runtime_engine
        from .runtime_engine import RuntimeEngine
        return RuntimeEngine(self.gate.lifecycle._engine(), volume=self.gate.runtime_volume)

    def _profile(self, job):
        # Admission binds local source and policy image identities; it neither
        # contacts Docker nor executes a candidate before manual approval.
        if self.runtime_engine is not None:
            return self.runtime_engine.profile(job)
        from .runtime_engine import RuntimeEngine
        return RuntimeEngine.profile(job)

    def policy(self):
        with self.store.lock:
            return json.loads(self.store.db.execute('SELECT data FROM runtime_policy WHERE id=1').fetchone()[0])

    def set_policy(self, value):
        if (not isinstance(value, dict) or set(value) != {'mode', 'images'} or
                value['mode'] not in ('disabled', 'manual', 'auto') or
                not isinstance(value['images'], list) or len(value['images']) > 64 or
                any(not isinstance(i, str) or not IMAGE.fullmatch(i) for i in value['images']) or
                (value['mode'] != 'disabled' and not value['images'])):
            raise ValueError('invalid runtime update policy')
        with self.store.lock, self.store._write_transaction():
            self.store.require_admission()
            if any(j['status'] == 'running' for j in self._jobs()):
                raise RuntimeError('runtime rollout in progress')
            old = self.policy()
            definition = {'mode': value['mode'], 'images': sorted(set(value['images']))}
            if all(old[k] == v for k, v in definition.items()):
                return old
            policy = {**definition, 'generation': old['generation'] + 1}
            policy['policy_hash'] = fingerprint(policy)
            self.store.db.execute('UPDATE runtime_policy SET data=? WHERE id=1', (_json(policy),))
            self.store._append_event('runtime_policy', 'pi-runtime', mode=policy['mode'])
            return policy

    def _get(self, key):
        identifier(key)
        with self.store.lock:
            row = self.store.db.execute('SELECT data FROM runtime_jobs WHERE id=?', (key,)).fetchone()
            if not row:
                raise KeyError('runtime update not found')
            return json.loads(row[0])

    @staticmethod
    def public(job):
        keys = ('id', 'version', 'status', 'stage', 'created_at', 'install_started_at',
                'resolved_at', 'resolution')
        result = {k: job[k] for k in keys if k in job}
        result['targets'] = [
            {k: t[k] for k in ('run_id', 'status', 'old_version', 'version', 'restart_id', 'wait_reason', 'profile') if k in t}
            for t in job.get('targets', [])]
        if job.get('resolved_at'):
            result['resolved'] = True
        return result

    def get(self, key):
        return self.public(self._get(key))

    def _jobs(self):
        with self.store.lock:
            return [json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM runtime_jobs ORDER BY rowid DESC')]

    def jobs(self):
        return [self.public(j) for j in self._jobs()[:100]]

    def active(self):
        return [self.public(j) for j in self._jobs() if j['status'] in OPEN and not j.get('resolved_at')]

    def _update(self, key, **fields):
        with self.store.lock, self.store._write_transaction():
            job = self._get(key)
            job.update(fields)
            self.store.db.execute('UPDATE runtime_jobs SET data=? WHERE id=?', (_json(job), key))
            return job

    def _other_work(self):
        return (self.gate.closing or self.gate.lifecycle.active() or
                (self.gate.worker and self.gate.worker.is_alive()) or
                any(j['status'] in (*ACTIVE, *REQUEST_OPEN) for j in self.store.list()))

    def _join_submit_flight(self, key, version):
        with self._submit_flights_lock:
            flight = self._submit_flights.get(key)
            if flight is not None:
                if flight['version'] != version:
                    raise RuntimeError('idempotency conflict')
                return flight, False
            if len(self._submit_flights) >= MAX_SUBMIT_FLIGHTS:
                raise RuntimeError('too many runtime submissions')
            flight = {'version': version, 'event': threading.Event()}
            self._submit_flights[key] = flight
            return flight, True

    def _finish_submit_flight(self, key, flight):
        with self._submit_flights_lock:
            flight['event'].set()
            if self._submit_flights.get(key) is flight:
                del self._submit_flights[key]

    @staticmethod
    def _raise_submit_failure():
        raise RegistryUnavailable() from None

    def _wait_for_submit_flight(self, key, version, flight):
        flight['event'].wait(SUBMIT_SINGLE_FLIGHT_WAIT)
        try:
            previous = self._get(key)
        except KeyError:
            previous = None
        if previous is not None:
            if previous['version'] != version:
                raise RuntimeError('idempotency conflict')
            return self.public(previous)
        self._raise_submit_failure()

    def submit(self, value):
        if (not isinstance(value, dict) or set(value) != {'version', 'idempotency_key'} or
                not isinstance(value['version'], str) or len(value['version']) > 64 or
                not VERSION.fullmatch(value['version'])):
            raise ValueError('an exact stable Pi version is required')
        key = identifier(value['idempotency_key'])
        # Join under the ledger lock, then resolve outside it without replaying a key.
        with self.store.lock:
            try:
                previous = self._get(key)
            except KeyError:
                previous = None
            if previous:
                if previous['version'] != value['version']:
                    raise RuntimeError('idempotency conflict')
                return self.public(previous)
            self.store.require_admission()
            initial_policy = self.policy()
            if initial_policy['mode'] == 'disabled' or self.active() or self._other_work():
                raise RuntimeError('runtime update disabled or busy')
            # Fixed lock order: store -> flight. Waiting and resolution happen
            # only after both locks are released.
            flight, leader = self._join_submit_flight(key, value['version'])
        if not leader:
            return self._wait_for_submit_flight(key, value['version'], flight)
        try:
            try:
                release = self.catalog.resolve(value['version'])
            except Exception:
                self._raise_submit_failure()
            with self.store.lock, self.store._write_transaction():
                self.store.require_admission()
                try:
                    previous = self._get(key)
                except KeyError:
                    previous = None
                if previous:
                    if previous['version'] != value['version']:
                        raise RuntimeError('idempotency conflict')
                    result = self.public(previous)
                else:
                    policy = self.policy()
                    if policy != initial_policy:
                        raise RuntimeError('runtime policy changed during resolution')
                    if policy['mode'] == 'disabled' or self.active() or self._other_work():
                        raise RuntimeError('runtime update disabled or busy')
                    if len(self._jobs()) >= 1000:
                        raise RuntimeError('runtime update quota')
                    job = dict(id=key, version=value['version'], policy=policy,
                               release=release, release_hash=fingerprint(release),
                               status='queued' if policy['mode'] == 'auto' else 'pending',
                               stage='queued_by_policy' if policy['mode'] == 'auto' else 'awaiting_approval',
                               targets=[], created_at=int(time.time() * 1000))
                    job['profile'] = self._profile(job)
                    self.store.db.execute('INSERT INTO runtime_jobs (id,data) VALUES (?,?)', (key, _json(job)))
                    self.store._append_event('runtime_requested', 'pi-runtime', request=key,
                                             version=value['version'])
                    result = self.public(job)
            return result
        finally:
            self._finish_submit_flight(key, flight)

    def _fence(self, job):
        self.store.require_admission()
        release = job.get('release')
        if (not isinstance(release, dict) or set(release) != {'version', 'integrity', 'tarball', 'node'} or
                not stable_version(job['version']) or release['version'] != job['version'] or
                fingerprint(release) != job.get('release_hash')):
            raise RuntimeError('pinned runtime release changed or missing')
        pinned_release(release, job['version'])
        if job.get('profile') != self._profile(job):
            raise RuntimeError('runtime execution profile changed')
        if self.policy()['policy_hash'] != job['policy']['policy_hash'] or self.policy()['mode'] == 'disabled':
            raise RuntimeError('runtime policy changed')

    def approve(self, key):
        with self.store.lock:
            job = self._get(key)
            self._fence(job)
            if job['status'] != 'pending' or self._other_work():
                raise RuntimeError('runtime task not eligible')
            return self.public(self._update(key, status='queued', stage='approved_by_host'))

    def readiness(self):
        """Read-only trust/readiness projection. Busy generation can wait after submit."""
        consumers = []
        installed_versions = set()
        life = self.gate.lifecycle
        deadline = Deadline(time, 4)
        try:
            policy = self.policy()
            jobs, current_profile = self._jobs(), None
            candidates = life._transport(deadline, self._engine().consumers)
            if not isinstance(candidates, list) or len(candidates) > 128:
                raise RuntimeError('runtime inventory unavailable')
            for candidate in candidates:
                deadline.remaining()
                cid = candidate.get('Id')
                row = {'run_id': fingerprint({'consumer': cid})[:32], 'ready': False,
                       'reason': 'unmanaged_consumer'}
                try:
                    item = life._transport(deadline, life._engine().inspect, cid)
                    if item is None or item.get('State', {}).get('Running') is False:
                        continue
                    run = identifier(item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.run-id'))
                    row['run_id'] = run
                    checked = life._resolve(run, policy, expected=cid, role='inventory', deadline=deadline)
                    if not any(m.get('Name') == self.gate.runtime_volume and m.get('Destination') == '/home/node/.local'
                               for m in checked.get('Mounts') or []):
                        raise RuntimeError('runtime mount mismatch')
                    row['reason'] = 'consumer_not_ready'
                    observation = life._status(checked, deadline)
                    state = snapshot(observation, run)
                    installed = observation.get('installed_version')
                    if installed is not None:
                        if not stable_version(installed):
                            raise RuntimeError('invalid installed version')
                        installed_versions.add(installed)
                    if not stable_version(state['version']):
                        raise RuntimeError('invalid runtime version')
                    row.update(version=state['version'])
                    blocker = self._engine().consumer_blocker(checked, state)
                    if blocker:
                        row.update(ready=False, reason=blocker)
                    else:
                        checked_source(state.get('source_identity'), state['version'])
                        row.update(ready=True, source_status='evaluable')
                        # Pure ledger lookup only: HTTP readiness never creates,
                        # starts, polls or synchronously waits for a probe.
                        for job in jobs:
                            try:
                                if job['policy'] != policy:
                                    continue
                                if current_profile is None:
                                    current_profile = self._profile(job)
                                if job['profile'] != current_profile:
                                    continue
                                self.source_proof(job, checked, state)
                                row['source_status'] = 'verified'
                                break
                            except (ValueError, KeyError, TypeError, RuntimeError):
                                continue
                        if state['busy'] or state['pending'] or not state['idle']:
                            row['reason'] = 'busy_waits_for_idle'
                        else:
                            row.pop('reason', None)
                except Exception:
                    pass
                deadline.remaining()
                consumers.append(row)
            if self.policy() != policy or len(installed_versions) > 1:
                raise RuntimeError('runtime policy changed during readiness')
            return {'status': 'ready' if all(row['ready'] for row in consumers) else 'blocked',
                    'consumers': consumers,
                    **({'installed_version': next(iter(installed_versions))} if installed_versions else {})}
        except Exception:
            return {'status': 'unavailable', 'consumers': []}

    def reject(self, key):
        with self.store.lock:
            job = self._get(key)
            if job['status'] not in ('pending', 'queued'):
                raise RuntimeError('cannot reject an activated runtime update')
            return self.public(self._update(key, status='rejected', stage='host_rejected'))

    def authorize_child(self, child):
        parent = self._get(child['runtime_update_id'])
        self._fence(parent)
        checked_evidence(parent.get('evidence'), parent.get('candidate'), parent['release'], parent['profile'])
        if (parent['status'] != 'running' or parent['stage'] not in ('refreshing', 'waiting_for_idle') or
                parent['policy'] != child['policy'] or child.get('requested_version') != parent['version'] or
                not any(t.get('restart_id') == child['id'] and t['container_id'] == child['container_id']
                        for t in parent['targets'])):
            raise RuntimeError('runtime refresh authorization changed')
        # Re-resolve the actual immutable container and measured launch at the
        # last Gate authorization boundary, not the enqueue-time version label.
        life = self.gate.lifecycle
        item = life._resolve(child['run_id'], parent['policy'], expected=child['container_id'],
                             expected_hash=child['target_hash'])
        state = snapshot(life._status(item), child['run_id'])
        self.source_proof(parent, item, state)
        if child.get('source_hash') != digest(state['source_identity']):
            raise RuntimeError('runtime refresh source changed')

    def tick(self):
        active = [j for j in self._jobs() if j['status'] in OPEN and not j.get('resolved_at')]
        if not active:
            return False
        job = active[-1]
        if job['status'] in ('pending', 'recovery_required'):
            return True
        if job['status'] == 'queued':
            try:
                self._fence(job)
            except RuntimeError:
                self._update(job['id'], status='stale', stage='policy_changed')
                return True
        # Let the existing lifecycle dispatcher execute an authorized child.
        if any(j.get('runtime_update_id') == job['id'] and j['status'] in ('queued', 'running')
               for j in self.gate.lifecycle._jobs()):
            return False
        target = self._install if job['stage'] not in ('refreshing', 'waiting_for_idle') else self._refresh
        self.gate.worker = threading.Thread(target=target, args=(job,), daemon=False)
        self.gate.worker.start()
        return True

    def _inventory(self, job):
        engine, life, inventory = self._engine(), self.gate.lifecycle, []
        candidates = engine.consumers()
        if not isinstance(candidates, list) or len(candidates) > 128:
            raise RuntimeError('too many runtime consumers')
        for candidate in candidates:
            if candidate.get('Id') == job.get('helper_id'):
                continue
            item = life._engine().inspect(candidate['Id'], timeout=3)
            if item is None or item.get('State', {}).get('Running') is False:
                continue  # Listed while running, now confirmed exited by immutable ID.
            # A helper retained across Gate restart is reconciled separately.
            if item and item.get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.runtime-update') == job['id']:
                continue
            run = identifier((item or {}).get('Config', {}).get('Labels', {}).get('cn.swordfate.pi.run-id'))
            deadline = Deadline(time, 4)
            try:
                item = life._resolve(run, job['policy'], expected=candidate['Id'], deadline=deadline,
                                     role='terminal' if terminal_profile(item) else 'inventory')
            except Exception:
                latest = life._engine().inspect(candidate['Id'], timeout=3)
                if latest is None or latest.get('State', {}).get('Running') is False:
                    continue
                raise
            if not any(m.get('Name') == self.gate.runtime_volume and m.get('Destination') == '/home/node/.local'
                       for m in item.get('Mounts') or []):
                raise RuntimeError('runtime consumer mount mismatch')
            if terminal_profile(item):
                # Explicit inventory-only marker: never a lifecycle snapshot/version.
                inventory.append((item, {'profile': 'web-terminal-v1'}))
                continue
            try:
                state = snapshot(life._status(item, deadline), run)
            except Exception:
                latest = life._engine().inspect(candidate['Id'], timeout=3)
                if latest is None or latest.get('State', {}).get('Running') is False:
                    continue
                # Trust was established before status. A fresh identity check
                # distinguishes startup/transport gaps from a changed container.
                life._resolve(run, job['policy'], expected=item['Id'], expected_hash=life._target_hash(item))
                state = None
            inventory.append((item, state))
        return inventory

    def source_proof(self, job, item, state):
        """Pure lookup of exact, durable Gate-owned source/profile evidence.

        Callers independently resolve trusted container/status and retain their
        final barrier/restoration checks. No version or package receipt grants
        compatibility, and this does not grant source origin/integrity.
        """
        if (item.get('Image') not in job['policy']['images'] or terminal_profile(item) or
                not isinstance(state, dict)):
            raise RuntimeError('source evidence unavailable')
        identity = checked_source(state.get('source_identity'), state.get('version'))
        record = job.get('sources', {}).get(digest(identity), {})
        if record.get('identity') != identity:
            raise RuntimeError('source evidence unavailable')
        return checked_source_evidence(record.get('evidence'), identity, job['profile'])

    def _ensure_sources(self, job, inventory):
        """Drive one bounded offline source job; resume from durable helper intent."""
        identities = {}
        for item, state in inventory:
            if state is None:
                return job, False
            identity = checked_source(state.get('source_identity'), state.get('version'))
            if item.get('Image') not in job['policy']['images'] or terminal_profile(item):
                raise RuntimeError('source consumer not evaluable')
            identities[digest(identity)] = identity
        # An exited consumer does not revoke an already durable helper intent.
        # Reconcile retained source jobs as well, so no source helper is left
        # running concurrently with a later writable installation phase.
        records = job.get('sources', {})
        if len(records) > MAX_SOURCES:
            raise RuntimeError('source validation quota')
        for key, record in records.items():
            identity = record.get('identity')
            checked_source(identity, identity.get('version') if isinstance(identity, dict) else None)
            if digest(identity) != key:
                raise RuntimeError('source record identity changed')
            identities.setdefault(key, identity)
        for key, identity in identities.items():
            record = job.get('sources', {}).get(key)
            if record is not None and record.get('identity') != identity:
                raise RuntimeError('source record identity changed')
            if record and 'evidence' in record:
                checked_source_evidence(record['evidence'], identity, job['profile'])
        for key, identity in identities.items():
            record = job.get('sources', {}).get(key)
            if record and 'evidence' in record:
                continue
            if record is None:
                with self.store.lock:
                    latest = self._get(job['id'])
                    if latest != job or latest['status'] != 'running':
                        raise RuntimeError('source authorization changed')
                    self._fence(latest)
                    sources = latest.get('sources', {})
                    if len(sources) >= MAX_SOURCES:
                        raise RuntimeError('source validation quota')
                    job = self._update(job['id'], sources={**sources, key: {'identity': identity}})
            result = self._drive_helper(job, 'source-' + key)
            job = self._get(job['id'])
            if result.get('state') == 'running':
                return job, False
            if result.get('state') != 'succeeded':
                raise RuntimeError('source helper outcome unverified')
            evidence = checked_source_evidence(result.get('evidence'), identity, job['profile'])
            with self.store.lock:
                latest = self._get(job['id'])
                if latest != job or latest['status'] != 'running':
                    raise RuntimeError('source validation authorization changed')
                self._fence(latest)
                sources = latest['sources']
                job = self._update(job['id'], sources={**sources, key: {
                    'identity': identity, 'evidence': evidence}})
            # Bound each worker pass to one source probe. All current identities
            # must be verified before returning eligibility, even on recovery.
            return job, all('evidence' in job.get('sources', {}).get(k, {}) for k in identities)
        return job, True

    def _drive_helper(self, job, phase):
        self._fence(job)
        engine, key = self._engine(), job['id']
        helper = job.get('helpers', {}).get(phase)
        if phase == 'activate':
            checked_evidence(job.get('evidence'), job.get('candidate'), job['release'], job['profile'])
            # Once start intent is durable, reconcile the helper outcome. New
            # consumer blockers cannot relabel a possible activation as a clean
            # pre-activation failure or strand it in a readiness wait.
            if not helper or not helper.get('intent_at'):
                job, verified = self._ensure_sources(job, self._inventory(job))
                if not verified:
                    return {'state': 'waiting'}
        if helper is None:
            identity = engine.create(job, phase)
            job = self._update(key, helpers={**job.get('helpers', {}), phase: {'id': identity}})
            helper = job['helpers'][phase]
        if not helper.get('intent_at'):
            # Only this invocation may send start after committing the intent.
            # A recovered intent always goes straight to polling, even if the
            # helper still says created: the previous start result is unknown.
            if phase == 'activate':
                job, verified = self._ensure_sources(job, self._inventory(job))
                if not verified:
                    return {'state': 'waiting'}
                helper = job['helpers'][phase]
            with self.store.lock:
                latest = self._get(key)
                if latest != job or latest['status'] != 'running':
                    raise RuntimeError('helper authorization changed')
                self._fence(latest)
                helper = {**helper, 'intent_at': int(time.time() * 1000)}
                job = self._update(key, helpers={**job.get('helpers', {}), phase: helper})
            engine.start(job, phase)
        return engine.poll(job, phase)

    def _install(self, job):
        key = job['id']
        try:
            if job['status'] == 'queued':
                inventory = self._inventory(job)
                with self.store.lock:
                    latest = self._get(key)
                    if latest != job or latest['status'] != 'queued':
                        return  # A host rejection won the race; never resurrect it.
                    self._fence(job)
                    if any(state is None for _, state in inventory):
                        self._update(key, stage='waiting_for_consumer_readiness')
                        return
                    for item, state in inventory:
                        checked_source(state.get('source_identity'), state.get('version'))
                        blocker = self._engine().consumer_blocker(item, state)
                        if blocker:
                            raise RuntimeError(blocker)
                    job = self._update(key, status='running', stage='preparing', helpers={},
                                       install_started_at=int(time.time() * 1000))
            if job['stage'] not in ('preparing', 'prepared', 'validating', 'validated', 'activating'):
                # Never replay a legacy installing job using the new protocol.
                self._update(key, status='recovery_required', stage='installation_outcome_unknown')
                return
            if job['stage'] == 'preparing':
                job, verified = self._ensure_sources(job, self._inventory(job))
                if not verified:
                    return
            if job['stage'] == 'prepared':
                checked_candidate(job.get('candidate'), job['release'])
                job = self._update(key, stage='validating')
            if job['stage'] == 'validated':
                checked_evidence(job.get('evidence'), job.get('candidate'), job['release'], job['profile'])
                job = self._update(key, stage='activating')
            phase = {'preparing': 'prepare', 'validating': 'validate', 'activating': 'activate'}[job['stage']]
            result = self._drive_helper(job, phase)
            if result.get('state') in ('running', 'waiting'):
                return
            if result.get('state') == 'failed':
                self._update(key, status='failed', stage=result.get('stage', 'install_failed'))
            elif result.get('state') == 'succeeded' and result.get('version') == job['version']:
                # The result is observed after a side effect; recheck the
                # policy/profile before accepting it as durable authority.
                self._fence(self._get(key))
                if phase == 'prepare':
                    checked_candidate(result.get('candidate'), job['release'])
                    self._update(key, stage='prepared', candidate=result['candidate'])
                elif phase == 'validate':
                    checked_evidence(result.get('evidence'), job['candidate'], job['release'], job['profile'])
                    self._update(key, stage='validated', evidence=result['evidence'])
                else:
                    self._update(key, stage='refreshing', installed_version=job['version'])
            else:
                self._update(key, status='recovery_required', stage='installation_outcome_unknown')
        except Exception:
            with self.store.lock:
                latest = self._get(key)
                if latest['status'] not in ('queued', 'running'):
                    return
                self._update(key, status='failed' if latest['status'] == 'queued' else 'recovery_required',
                             stage='unmanaged_or_unavailable_consumer' if latest['status'] == 'queued'
                             else 'installation_outcome_unknown')

    def _state_key(self, item, state):
        return fingerprint({'state': state, 'target': self.gate.lifecycle._target_hash(item)})

    def _enqueue(self, parent, item, state, targets, target):
        if terminal_profile(item):
            raise RuntimeError('terminal_profile_unaudited')
        life, key = self.gate.lifecycle, secrets.token_hex(16)
        child = {**{k: state[k] for k in ('run_id', 'runtime_id', 'session_id', 'leaf_id')},
                 'id': key, 'status': 'queued', 'stage': 'runtime_update_refresh',
                 'policy': parent['policy'], 'container_id': item['Id'], 'old_version': state['version'],
                 'target_hash': life._target_hash(item), 'created_at': int(time.time() * 1000),
                 'runtime_update_id': parent['id'], 'requested_version': parent['version']}
        child['source_hash'] = self.source_proof(parent, item, state)['source_hash']
        with self.store.lock, self.store._write_transaction():
            self.store.require_admission()
            if len(life._jobs()) >= 1000:
                raise RuntimeError('lifecycle quota')
            target.update(status='refreshing', restart_id=key,
                          attempt_state=self._state_key(item, state), attempts=target.get('attempts', 0) + 1)
            target.pop('wait_reason', None)
            target.pop('retry_after_state', None)
            parent = self._get(parent['id'])
            parent.update(targets=targets, stage='refreshing')
            self.store.db.execute('UPDATE runtime_jobs SET data=? WHERE id=?', (_json(parent), parent['id']))
            self.store.db.execute('INSERT INTO lifecycle_jobs (id,data) VALUES (?,?)', (key, _json(child)))

    def _refresh(self, job):
        key, targets = job['id'], job['targets']
        try:
            self._fence(job)
            checked_evidence(job.get('evidence'), job.get('candidate'), job['release'], job['profile'])
            current = self._inventory(job)
            for item, state in current:
                if state is not None:
                    self.source_proof(job, item, state)
            visible = {item['Id'] for item, _ in current}
            by_container = {item['Id']: (item, state) for item, state in current}
            # Reconcile lifecycle evidence before considering another restart.
            for target in targets:
                restart = target.get('restart_id')
                if restart and target['status'] == 'refreshing':
                    child = self.gate.lifecycle._get(restart)
                    if child['status'] == 'succeeded':
                        if child.get('new_version') != job['version']:
                            raise RuntimeError('runtime version proof mismatch')
                        target.update(status='succeeded', version=job['version'])
                    elif child['status'] == 'stale':
                        if child['stage'] == 'restore_pre_stop_failed':
                            target.update(status='blocked', wait_reason='restore_pre_stop_failed')
                            self._update(key, targets=targets, status='recovery_required',
                                         stage='restore_pre_stop_failed')
                            return
                        target.update(status='waiting_for_idle', wait_reason='awaiting_state_change',
                                      retry_after_state=target.get('attempt_state'))
                        target.pop('restart_id', None)
                    elif child['status'] in ('failed', 'recovery_required'):
                        pair = by_container.get(target['container_id'])
                        if (child['status'] == 'failed' and child['stage'] in ('checking_rejected', 'checking_timeout')
                                and pair and pair[1] is not None):
                            item, state = pair
                            observed = self.gate.lifecycle._status(item)
                            state = snapshot(observed, child['run_id'])
                            self.source_proof(job, item, state)
                            by_container[item['Id']] = (item, state)
                            operation = observed.get('operation') or {}
                            if (state['runtime_id'] == child['runtime_id'] and
                                    (not state['idle'] or state['pending'] or state['busy']) and
                                    operation.get('operation_id') == child['id'] and
                                    operation.get('status') == 'failed' and operation.get('stage') == child['stage'] and
                                    not operation.get('new_runtime_id') and not operation.get('old_version')):
                                self.gate.lifecycle._update(child['id'], resolved_at=int(time.time() * 1000),
                                                            resolution='runtime_pre_stop_retry')
                                target.update(status='waiting_for_idle', wait_reason='busy_race',
                                              retry_after_state=self._state_key(item, state))
                                target.pop('restart_id', None)
                                continue
                        # Never repeat a restart with unknown or post-stop outcome.
                        self._update(key, targets=targets, status='recovery_required', stage='refresh_requires_inspection')
                        return
                if target['container_id'] not in visible and target['status'] != 'succeeded':
                    target.update(status='exited')
            current = list(by_container.values())  # Include the latest retry-proof snapshot.
            attempts = {t['container_id']: t.get('attempts', 0) for t in targets}
            for item, state in sorted(current, key=lambda pair: attempts.get(pair[0]['Id'], 0)):
                target = next((t for t in targets if t['container_id'] == item['Id']), None)
                if target is None:
                    target = {'run_id': item['Config']['Labels']['cn.swordfate.pi.run-id'],
                              'container_id': item['Id'], 'status': 'waiting_for_idle'}
                    targets.append(target)
                if state is None:
                    target.update(status='waiting_for_idle', wait_reason='consumer_not_ready')
                    continue
                if terminal_profile(item):
                    target.update(status='manual_restart_required', profile='web-terminal-v1',
                                  wait_reason='terminal_profile_unaudited')
                    for field in ('old_version', 'version', 'restart_id'):
                        target.pop(field, None)
                    continue
                target.setdefault('old_version', state['version'])
                if (target.get('retry_after_state') is not None and
                        target['retry_after_state'] != self._state_key(item, state)):
                    target.pop('retry_after_state', None)
                if state['version'] == job['version']:
                    target.update(status='succeeded', version=job['version'])
                    continue
                if target['status'] == 'succeeded':
                    target.update(status='waiting_for_idle')
                if state['idle'] and not state['pending'] and not state['busy']:
                    if target.get('retry_after_state') == self._state_key(item, state):
                        target.update(status='waiting_for_idle', wait_reason='awaiting_state_change')
                        continue
                    self._enqueue(job, item, state, targets, target)
                    return
                target.update(status='waiting_for_idle')
            complete = all(t['status'] in ('succeeded', 'exited', 'manual_restart_required') for t in targets)
            manual = any(t['status'] == 'manual_restart_required' for t in targets)
            self._update(key, targets=targets,
                         status=('manual_restart_required' if manual else 'succeeded') if complete else 'running',
                         stage=('installed_manual_restart_required' if manual else 'complete') if complete else 'waiting_for_idle')
        except Exception:
            self._update(key, targets=targets, status='recovery_required', stage='refresh_requires_inspection')

    def _resolution_ready(self, job):
        self.store.require_admission()
        if (job['status'] != 'recovery_required' or job.get('resolved_at') or
                self.gate.closing or (self.gate.worker and self.gate.worker.is_alive()) or
                any(j['status'] in (*ACTIVE, *REQUEST_OPEN) for j in self.store.list()) or
                any(j['id'] != job['id'] for j in self.active())):
            raise RuntimeError('runtime inspection not eligible')
        if self.gate.lifecycle.active():
            # Even this parent's failed children must be individually inspected.
            raise RuntimeError('unresolved lifecycle work')

    def resolve(self, key, acknowledge):
        if acknowledge != 'inspected_no_mutation':
            raise ValueError('explicit inspection acknowledgment required')
        with self.store.lock:
            job = self._get(key)
            self._resolution_ready(job)
            children = self.gate.lifecycle._jobs()
        self._engine().quiescent(job)
        for item, state in self._inventory(job):
            if terminal_profile(item):
                continue  # No legacy operation endpoint exists for this role.
            if state is None:
                raise RuntimeError('consumer inspection unavailable')
            value = self.gate.lifecycle._status(item)
            if (value.get('operation') or {}).get('status') == 'running':
                raise RuntimeError('supervisor operation still running')
        with self.store.lock, self.store._write_transaction():
            if self._get(key) != job or self.gate.lifecycle._jobs() != children:
                raise RuntimeError('inspection state changed')
            self._resolution_ready(job)
            job.update(resolved_at=int(time.time() * 1000), resolution=acknowledge)
            self.store.db.execute('UPDATE runtime_jobs SET data=? WHERE id=?', (_json(job), key))
            self.store._append_event('runtime_resolved', 'pi-runtime', request=key, outcome=job['status'])
            return self.public(job)
