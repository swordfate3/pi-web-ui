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
    const control=await startRuntimeControl({PI_RUNTIME_RUN_ID:snapshot.run_id,PI_RUNTIME_CHILD_TOKEN:token,PI_RUNTIME_EXTENSION_SOCKET:socket},()=>snapshot);
    const request=message=>new Promise((resolve,reject)=>{const peer=net.createConnection(socket);let data='';
      peer.setTimeout(2000,()=>peer.destroy(Error('test deadline')));peer.on('error',reject);
      peer.on('connect',()=>peer.end(JSON.stringify({...message,token})+'\\n'));
      peer.on('data',chunk=>data+=chunk.toString());peer.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});});
    try{
      let dispatches=0,safeDuringDispatch=null;
      if(${JSON.stringify(dispatch)}) runtime.dispatchRuntimeUserMessage(()=>{dispatches++;safeDuringDispatch=guard.safe();});
      const before=await request({action:'snapshot'});
      const prepared=await request({action:'prepare',operation_id:operation,expected:{runtime_id:'runtime',session_id:'session',leaf_id:'leaf'}});
      const held=control.prepared;
      const commitCase=${JSON.stringify(commitCase)};
      if(commitCase){
        const expected=structuredClone(snapshot);
        if(commitCase==='no-lease') await request({action:'cancel',operation_id:operation});
        if(commitCase==='tainted') guard.taint();
        if(commitCase==='drift') snapshot.thinking='low';
        if(commitCase==='caller-drift') expected.model='other';
        if(commitCase==='clock-forward') Date.now=()=>9000000000000;
        const committed=await request({action:'commit',operation_id:commitCase==='wrong-operation'?'d'.repeat(32):operation,expected});
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
