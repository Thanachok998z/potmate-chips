import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function openPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function start(port, dataDir) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`);
    try { const response = await fetch(origin); if (response.ok) return { child, origin }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('Server did not start');
}
async function request(origin, path, token, body) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
  return data;
}
test('Bet and Raise happen on chip placement; Call closes only betting round; win settles once', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'potmate-test-'));
  const port = await openPort();
  let service;
  try {
    service = await start(port, dataDir);
    const { origin } = service;
    const created = await request(origin, '/api/rooms', null, { name: 'A', initial: 100000 });
    const code = created.room.code;
    const joined = await request(origin, `/api/rooms/${code}/join`, null, { name: 'B' });
    const a = created.token, b = joined.token;
    let seq = 0;
    const act = (token, type, value) => request(origin, `/api/rooms/${code}/actions`, token, { id: `test-action-${++seq}`, type, value });
    await act(a, 'bet', 10000);
    let result = await act(b, 'call');
    assert.equal(result.room.pot, 20000);
    assert.equal(result.room.bettingRound, 2);
    assert.equal(result.room.fees, 0);
    await act(b, 'bet', 5000);
    result = await act(a, 'bet', 10000);
    assert.equal(result.room.responder, 1);
    result = await act(b, 'call');
    assert.equal(result.room.pot, 40000);
    assert.equal(result.room.bettingRound, 3);
    await act(a, 'claim');
    const confirmId = `test-action-${++seq}`;
    result = await request(origin, `/api/rooms/${code}/actions`, b, { id: confirmId, type: 'confirm' });
    assert.equal(result.room.pot, 0);
    assert.equal(result.room.fees, 200);
    assert.deepEqual(result.room.players.map(p => p.balance), [119800, 80000]);
    assert.equal(result.room.hand, 2);
    const again = await request(origin, `/api/rooms/${code}/actions`, b, { id: confirmId, type: 'confirm' });
    assert.equal(again.duplicate, true);
    assert.equal(again.room.players[0].balance, 119800);
    service.child.kill();
    await new Promise(resolve => service.child.once('exit', resolve));
    service = await start(await openPort(), dataDir);
    const restored = await request(service.origin, `/api/rooms/${code}`, a);
    assert.equal(restored.room.players[0].balance, 119800);
    assert.equal(restored.room.fees, 200);
    await request(service.origin, `/api/rooms/${code}/actions`, b, { id: `test-action-${++seq}`, type: 'bet', value: 1000 });
    await request(service.origin, `/api/rooms/${code}/actions`, a, { id: `test-action-${++seq}`, type: 'call' });
    await request(service.origin, `/api/rooms/${code}/actions`, a, { id: `test-action-${++seq}`, type: 'bet', value: 1000 });
    const folded = await request(service.origin, `/api/rooms/${code}/actions`, b, { id: `test-action-${++seq}`, type: 'fold' });
    assert.equal(folded.room.pot, 2000);
    assert.equal(folded.room.players[0].balance, 118800);
    await request(service.origin, `/api/rooms/${code}/actions`, a, { id: `test-action-${++seq}`, type: 'claim' });
    const foldedResult = await request(service.origin, `/api/rooms/${code}/actions`, b, { id: `test-action-${++seq}`, type: 'confirm' });
    assert.equal(foldedResult.room.pot, 0);
    assert.equal(foldedResult.room.fees, 210);
    assert.deepEqual(foldedResult.room.players.map(p => p.balance), [120790, 79000]);
  } finally {
    if (service && service.child.exitCode === null && service.child.signalCode === null) {
      service.child.kill();
      await new Promise(resolve => service.child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('All-in and tie split the net pot; a short All-in returns the uncalled excess', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'potmate-allin-'));
  const service = await start(await openPort(), dataDir);
  try {
    const { origin } = service;
    const created = await request(origin, '/api/rooms', null, { name: 'A', initial: 100000 });
    const code = created.room.code;
    const joined = await request(origin, `/api/rooms/${code}/join`, null, { name: 'B' });
    const a = created.token, b = joined.token;
    let seq = 0;
    const act = (token, type, value) => request(origin, `/api/rooms/${code}/actions`, token, { id: `allin-action-${++seq}`, type, value });
    let result = await act(a, 'all_in');
    assert.equal(result.room.players[0].balance, 0);
    assert.equal(result.room.responder, 1);
    result = await act(b, 'call');
    assert.equal(result.room.pot, 200000);
    assert.deepEqual(result.room.allIn, [true, true]);
    await act(a, 'claim_tie');
    result = await act(b, 'confirm');
    assert.equal(result.room.fees, 1000);
    assert.deepEqual(result.room.players.map(p => p.balance), [99500, 99500]);
    await act(a, 'bet', 50000);
    await act(b, 'call');
    await act(a, 'claim');
    await act(b, 'confirm');
    await act(a, 'bet', 100000);
    result = await act(b, 'all_in');
    assert.equal(result.room.pot, 99000);
    assert.equal(result.room.players[0].balance, 99500);
    assert.equal(result.room.players[1].balance, 0);
    assert.equal(result.room.responder, null);
    await assert.rejects(act(a, 'bet', 1000));
    await act(a, 'claim');
    result = await act(b, 'confirm');
    assert.equal(result.room.fees, 1995);
    assert.deepEqual(result.room.players.map(p => p.balance), [198005, 0]);
  } finally {
    if (service.child.exitCode === null && service.child.signalCode === null) {
      service.child.kill();
      await new Promise(resolve => service.child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('an odd chip after a tie goes to the alternating seat', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'potmate-tie-'));
  const service = await start(await openPort(), dataDir);
  try {
    const { origin } = service;
    const created = await request(origin, '/api/rooms', null, { name: 'A', initial: 2000 });
    const code = created.room.code;
    const joined = await request(origin, `/api/rooms/${code}/join`, null, { name: 'B' });
    const a = created.token, b = joined.token;
    let seq = 0;
    const act = (token, type, value) => request(origin, `/api/rooms/${code}/actions`, token, { id: `tie-action-${++seq}`, type, value });
    await act(a, 'bet', 1000);
    await act(b, 'call');
    await act(a, 'claim_tie');
    let result = await act(b, 'confirm');
    assert.deepEqual(result.room.players.map(p => p.balance), [1995, 1995]);
    await act(a, 'all_in');
    await act(b, 'call');
    result = await act(a, 'claim_tie');
    assert.deepEqual(result.room.pending.shares, [1985, 1986]);
    result = await act(b, 'confirm');
    assert.deepEqual(result.room.players.map(p => p.balance), [1985, 1986]);
    assert.equal(result.room.fees, 29);
  } finally {
    if (service.child.exitCode === null && service.child.signalCode === null) {
      service.child.kill();
      await new Promise(resolve => service.child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('folding to an uncalled All-in returns it and can close a zero-pot hand', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'potmate-fold-'));
  const service = await start(await openPort(), dataDir);
  try {
    const { origin } = service;
    const created = await request(origin, '/api/rooms', null, { name: 'A', initial: 1000 });
    const code = created.room.code;
    const joined = await request(origin, `/api/rooms/${code}/join`, null, { name: 'B' });
    const a = created.token, b = joined.token;
    let seq = 0;
    const act = (token, type) => request(origin, `/api/rooms/${code}/actions`, token, { id: `fold-action-${++seq}`, type });
    await act(a, 'all_in');
    const folded = await act(b, 'fold');
    assert.equal(folded.room.pot, 0);
    assert.deepEqual(folded.room.players.map(p => p.balance), [1000, 1000]);
    await act(a, 'claim');
    const settled = await act(b, 'confirm');
    assert.equal(settled.room.hand, 2);
    assert.equal(settled.room.fees, 0);
    assert.deepEqual(settled.room.allIn, [false, false]);
  } finally {
    if (service.child.exitCode === null && service.child.signalCode === null) {
      service.child.kill();
      await new Promise(resolve => service.child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
