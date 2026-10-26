import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const entry = new URL("../extensions/runtime-control.ts", import.meta.url).href;
const loader = new URL("./register-ts.mjs", import.meta.url).href;

// A separate process gives each test an immutable guard descriptor, as a real
// preload would. The fake input source is the only double; control IPC is real.
async function probe(transport, dispatch = false, commitCase = null) {
  const source = `
    import {mkdtemp,writeFile,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';import path from 'node:path';import net from 'node:net';
    import * as runtime from ${JSON.stringify(entry)};
    const {startRuntimeControl}=runtime;
    const root=await mkdtemp(path.join(tmpdir(),'web-rpc-control-'));
    let safe=true,barrier=null,stopping=false;
    const guard=Object.freeze({version:1,transport:${JSON.stringify(transport)},intact:()=>true,safe:()=>safe,
      taint:()=>{safe=false;},freeze:(owner,operation)=>{if(!safe)return false;barrier={owner,operation};return true;},
      release:(owner,operation)=>{if(stopping||barrier?.owner!==owner||barrier.operation!==operation)return false;barrier=null;return true;},shutdown:()=>{safe=false;stopping=true;}});
    if(${JSON.stringify(transport !== null)}) Object.defineProperty(globalThis,Symbol.for('pi.runtime.stdin-guard.v1'),{value:guard,configurable:false,writable:false});
    const session=path.join(root,'session.jsonl');await writeFile(session,'{}\\n',{mode:0o600});
    const socket=path.join(root,'rpc.sock'),token='a'.repeat(64),operation='b'.repeat(32);
    const snapshot={run_id:'c'.repeat(32),runtime_id:'runtime',session_id:'session',leaf_id:'leaf',
      session_file:session,cwd:root,version:'1.4.0',idle:true,pending:false,busy:false,provider:'test',model:'fixture',thinking:'off'};
    let commitFresh=false,now=1000;
    if(['deadline-boundary','bootstrap-expired','bootstrap-deadline-boundary'].includes(${JSON.stringify(commitCase)})) globalThis.performance={now:()=>now};
    const bootstrap=!!${JSON.stringify(commitCase)}?.startsWith('bootstrap-');
    const env={PI_RUNTIME_RUN_ID:snapshot.run_id,PI_RUNTIME_CHILD_TOKEN:token,PI_RUNTIME_EXTENSION_SOCKET:socket,
      ...(bootstrap?{PI_RUNTIME_PENDING_ACTIVATION:operation}:{})};
    const getSnapshot=()=>{
      if(commitFresh) now+=150001;
      return snapshot;
    };
    let control=await startRuntimeControl(env,getSnapshot);
    const request=message=>new Promise((resolve,reject)=>{const peer=net.createConnection(socket);let data='';
      peer.setTimeout(2000,()=>peer.destroy(Error('test deadline')));peer.on('error',reject);
      peer.on('connect',()=>peer.end(JSON.stringify({...message,token})+'\\n'));
      peer.on('data',chunk=>data+=chunk.toString());peer.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});});
    try{
      let dispatches=0,safeDuringDispatch=null;
      if(${JSON.stringify(dispatch)}) runtime.dispatchRuntimeUserMessage(()=>{dispatches++;safeDuringDispatch=guard.safe();});
      const initiallyHeld=control.prepared;
      const before=await request({action:'snapshot'});
      const prepared=await request({action:'prepare',operation_id:operation,expected:{runtime_id:'runtime',session_id:'session',leaf_id:'leaf'}});
      const held=control.prepared;
      const commitCase=${JSON.stringify(commitCase)};
      if(bootstrap){
        if(commitCase!=='bootstrap-admit'){
          const expected=structuredClone(snapshot);
          if(commitCase==='bootstrap-drift') snapshot.thinking='low';
          if(commitCase==='bootstrap-expired') now+=150001;
          if(commitCase==='bootstrap-deadline-boundary') commitFresh=true;
          const admitted=await request({action:'admit',operation_id:operation,expected});
          await control.close();control=await startRuntimeControl(env,getSnapshot);
          console.log(JSON.stringify({admitted,held:control.prepared,marker:env.PI_RUNTIME_PENDING_ACTIVATION}));
        }else{
        const wrong=await request({action:'admit',operation_id:'d'.repeat(32),expected:structuredClone(snapshot)});
        const cancelled=await request({action:'cancel',operation_id:operation});
        const heldAfterCancel=control.prepared;
        const markerAfterCancel=env.PI_RUNTIME_PENDING_ACTIVATION;
        await control.close();control=await startRuntimeControl(env,getSnapshot);
        const recreatedAfterCancel=control.prepared;
        const noLease=await request({action:'admit',operation_id:operation,expected:structuredClone(snapshot)});
        await request({action:'prepare',operation_id:operation,expected:{runtime_id:'runtime',session_id:'session',leaf_id:'leaf'}});
        const admitted=await request({action:'admit',operation_id:operation,expected:structuredClone(snapshot)});
        const replay=await request({action:'admit',operation_id:operation,expected:structuredClone(snapshot)});
        const heldAfterAdmit=control.prepared;
        await control.close();control=await startRuntimeControl(env,getSnapshot);
        const recreatedReplay=await request({action:'admit',operation_id:operation,expected:structuredClone(snapshot)});
        console.log(JSON.stringify({initiallyHeld,wrong,cancelled,heldAfterCancel,markerAfterCancel,recreatedAfterCancel,noLease,admitted,replay,heldAfterAdmit,
          recreatedHeld:control.prepared,recreatedReplay,markerAfterAdmit:env.PI_RUNTIME_PENDING_ACTIVATION??null}));
        }
      }else
      if(commitCase){
        const expected=structuredClone(snapshot);
        if(commitCase==='no-lease') await request({action:'cancel',operation_id:operation});
        if(commitCase==='tainted') guard.taint();
        if(commitCase==='drift') snapshot.thinking='low';
        if(commitCase==='caller-drift') expected.model='other';
        if(commitCase==='clock-forward') Date.now=()=>9000000000000;
        if(commitCase==='deadline-boundary') commitFresh=true;
        const committed=await request({action:commitCase==='default-admit'?'admit':'commit',operation_id:commitCase==='wrong-operation'?'d'.repeat(32):operation,expected});
        const replay=commitCase==='commit'?await request({action:'commit',operation_id:operation,expected}):null;
        const cancelled=await request({action:'cancel',operation_id:operation});
        console.log(JSON.stringify({committed,replay,cancelled,held:control.prepared,stopping}));
      }else{
        const cancelled=held?await request({action:'cancel',operation_id:operation}):null;
        console.log(JSON.stringify({before,prepared,held,cancelled,released:!control.prepared,dispatches,safeDuringDispatch}));
      }
    }finally{await control.close();await rm(root,{recursive:true,force:true});}
  `;
  const { stdout, stderr } = await run(process.execPath, ["--experimental-default-type=module", "--import", loader, "--input-type=module", "-e", source], {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, timeout: 8000, maxBuffer: 32 * 1024,
  });
  assert.equal(stderr, ""); return JSON.parse(stdout);
}

test("private runtime control admits the intact RPC fence and holds/cancels the same identity", async () => {
  const result = await probe("pi-rpc-v1:stdin-stdout-jsonl");
  assert.equal(result.before.ok, true);
  assert.equal(result.before.result.busy, false);
  assert.equal(result.prepared.ok, true); assert.equal(result.held, true);
  assert.equal(result.prepared.result.version, "1.4.0");
  assert.equal(result.cancelled.result.cancelled, true); assert.equal(result.released, true);
});

test('private final commit latches admission before acknowledgement and cannot be cancelled or replayed', async () => {
  const result = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, 'commit');
  assert.equal(result.committed.ok, true, 'Final live commit handshake must exist');
  assert.equal(result.committed.result.committed, true);
  assert.equal(result.committed.result.operation_id, 'b'.repeat(32));
  assert.equal(result.committed.result.snapshot.thinking, 'off');
  assert.equal(result.stopping, true); assert.equal(result.held, true);
  assert.equal(result.replay.ok, false); assert.equal(result.cancelled.ok, false);
});

test('private final commit refuses missing lease, wrong operation, complete state drift and tainted input', async () => {
  for (const mode of ['no-lease', 'wrong-operation', 'drift', 'caller-drift', 'tainted']) {
    const result = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, mode);
    assert.equal(result.committed.ok, false, mode);
    assert.equal(result.stopping, false, mode);
  }
});

test('wall clock jumps cannot expire an otherwise valid original monotonic runtime lease', async () => {
  const result = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, 'clock-forward');
  assert.equal(result.committed.ok, true);
  assert.equal(result.stopping, true); assert.equal(result.held, true);
  assert.equal(result.cancelled.ok, false);
});

test('fresh snapshot crossing the original monotonic deadline cannot enter permanent commit', async () => {
  const result = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, 'deadline-boundary');
  assert.equal(result.committed.ok, false, 'Lease must remain valid at the irreversible latch, not merely on request entry');
  assert.equal(result.stopping, false);
});

test('successor input remains bootstrap-held across cancellation until exact prepared admission', async () => {
  const result = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, 'bootstrap-admit');
  assert.equal(result.initiallyHeld, true, 'New successor Web mutations must be gated before readiness');
  assert.equal(result.wrong.ok, false); assert.equal(result.cancelled.ok, true);
  assert.equal(result.heldAfterCancel, true); assert.equal(result.noLease.ok, false);
  assert.equal(result.admitted.ok, true); assert.equal(result.admitted.result.admitted, true);
  assert.equal(result.heldAfterAdmit, false); assert.equal(result.replay.ok, false);
  assert.equal(result.markerAfterCancel, 'b'.repeat(32));
  assert.equal(result.recreatedAfterCancel, true);
  assert.equal(result.markerAfterAdmit, null, 'Only successful admission consumes the process bootstrap marker');
  assert.equal(result.recreatedHeld, false, 'Ordinary controller recreation must not re-lock an admitted process');
  assert.equal(result.recreatedReplay.ok, false);
});

test('successor admission refuses fresh-state drift and original-deadline expiry without releasing bootstrap input', async () => {
  for (const mode of ['bootstrap-drift', 'bootstrap-expired', 'bootstrap-deadline-boundary']) {
    const result = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, mode);
    assert.equal(result.admitted.ok, false, mode);
    assert.equal(result.held, true, mode);
    assert.equal(result.marker, 'b'.repeat(32), mode);
  }
  const standalone = await probe('pi-rpc-v1:stdin-stdout-jsonl', false, 'default-admit');
  assert.equal(standalone.committed.ok, false, 'A normal process cannot use successor admission');
  assert.equal(standalone.cancelled.ok, true);
});

test('malformed or incomplete successor bootstrap never creates an ordinary unheld controller', async () => {
  const { startRuntimeControl } = await import(entry);
  for (const marker of ['', 'bad', 'b'.repeat(31), 'B'.repeat(32)]) {
    await assert.rejects(startRuntimeControl({ PI_RUNTIME_PENDING_ACTIVATION: marker }, () => null), /activation/);
  }
  await assert.rejects(startRuntimeControl({ PI_RUNTIME_PENDING_ACTIVATION: 'b'.repeat(32) }, () => null), /configuration/);
  assert.equal(await startRuntimeControl({}, () => null), undefined);
});

test("private runtime control preserves audited TUI admission and refuses unknown transports", async () => {
  const tui = await probe("pi-tui-1.1.0:stdin-data");
  assert.equal(tui.before.result.busy, false); assert.equal(tui.prepared.ok, true);
  const unknown = await probe("pi-rpc-v0:unverified");
  assert.equal(unknown.before.result.busy, true); assert.equal(unknown.prepared.ok, false);
  assert.equal(unknown.held, false);
});

test("RPC void dispatch fails closed before calling Pi and cannot acquire a lease", async () => {
  const result = await probe("pi-rpc-v1:stdin-stdout-jsonl", true);
  assert.equal(result.dispatches, 1);
  assert.equal(result.safeDuringDispatch, false);
  assert.equal(result.before.result.busy, true);
  assert.equal(result.prepared.ok, false);
  assert.equal(result.held, false);
});

test("RPC void dispatch fencing preserves legacy TUI dispatch admission", async () => {
  const result = await probe("pi-tui-1.1.0:stdin-data", true);
  assert.equal(result.dispatches, 1);
  assert.equal(result.safeDuringDispatch, true);
  assert.equal(result.before.result.busy, false);
  assert.equal(result.prepared.ok, true);
});

test("RPC void dispatch preserves standalone input without admitting an absent or unknown guard", async () => {
  for (const transport of [null, "pi-rpc-v0:unverified"]) {
    const result = await probe(transport, true);
    assert.equal(result.dispatches, 1);
    assert.equal(result.safeDuringDispatch, true);
    assert.equal(result.before.result.busy, true);
    assert.equal(result.prepared.ok, false);
    assert.equal(result.held, false);
  }
});
