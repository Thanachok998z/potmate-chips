import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const DATA_FILE = join(DATA_DIR, 'rooms.json');
const PORT = Number(process.env.PORT || 3000);
const DENOMINATIONS = new Set([1000, 5000, 10000, 50000, 100000, 500000, 1000000]);
const START_MIN = 1000;
const START_MAX = 1000000000;
const MAX_PLAYERS = 4;
const rooms = new Map();
const requests = new Map();
let mutationQueue = Promise.resolve();

function secret() { return randomBytes(32).toString('base64url'); }
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(randomBytes(8), b => alphabet[b % alphabet.length]).join(''); } while (rooms.has(code));
  return code;
}
function cleanName(value) {
  const name = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!name || name.length > 18) throw new Error('ชื่อผู้เล่นต้องมี 1–18 ตัวอักษร');
  return name;
}
function money(value) { return Number.isSafeInteger(value) && value >= 0; }
function publicRoom(room, seat) {
  return {
    code: room.code, seat, initial: room.initial, pot: room.pot, fees: room.fees,
    hand: room.hand, bettingRound: room.bettingRound, contributions: room.contributions,
    responder: room.responder, aggressor: room.aggressor, turn: room.turn, waitingNext: room.waitingNext,
    checkedSeats: room.checkedSeats, folded: room.folded, foldedSeats: room.foldedSeats,
    allIn: room.allIn, pots: pots(room),
    pending: room.pending, revision: room.revision,
    processedIds: room.processed.filter(p => p.seat === seat).slice(-20).map(p => p.id),
    players: room.players.map(p => p ? { name: p.name, balance: p.balance } : null),
    history: room.history.slice(-100).reverse()
  };
}
function addHistory(room, kind, actor, text, extra = {}) {
  room.history.push({ id: secret().slice(0, 12), at: new Date().toISOString(), hand: room.hand,
    bettingRound: room.bettingRound, kind, actor, text, potAfter: room.pot,
    balancesAfter: room.players.map(p => p?.balance ?? null), ...extra });
}
function fee(pot) { return Math.floor(pot * 5 / 1000); }
function joined(room) { return room.players.map((player, seat) => player ? seat : -1).filter(seat => seat >= 0); }
function active(room) { return joined(room).filter(seat => !room.foldedSeats[seat]); }
function canAct(room, seat) { return !room.foldedSeats[seat] && !room.allIn[seat] && room.players[seat].balance > 0; }
function responders(room, seat) {
  return Array.from({ length: room.players.length - 1 }, (_, index) => (seat + index + 1) % room.players.length)
    .filter(other => room.players[other] && canAct(room, other));
}
function pots(room) {
  const levels = [...new Set(room.invested.filter(Boolean))].sort((a, b) => a - b);
  let previous = 0;
  return levels.map(level => {
    const contributors = joined(room).filter(seat => room.invested[seat] >= level);
    const pot = { amount: (level - previous) * contributors.length, eligible: contributors.filter(seat => !room.foldedSeats[seat]) };
    previous = level;
    return pot;
  });
}
function refundUncalled(room) {
  const ranked = [...room.invested].sort((a, b) => b - a);
  const unmatched = ranked[0] - (ranked[1] || 0);
  if (!unmatched) return;
  const owner = room.invested.indexOf(ranked[0]);
  room.players[owner].balance += unmatched;
  room.pot -= unmatched;
  room.invested[owner] -= unmatched;
  room.contributions[owner] = Math.max(0, room.contributions[owner] - unmatched);
  if (room.players[owner].balance > 0) room.allIn[owner] = false;
  addHistory(room, 'refund', owner, `คืน Bet ที่ยังไม่มีการ Call ${unmatched.toLocaleString('en-US')} ชิป ให้ ${room.players[owner].name}`, { amount: unmatched });
}
function closeBettingRound(room) {
  refundUncalled(room);
  room.bettingRound++;
  room.contributions = Array(room.players.length).fill(0);
  room.aggressor = null;
  room.responder = null;
  room.pendingSeats = [];
  room.turn = null;
  room.waitingNext = null;
  room.checkedSeats = Array(room.players.length).fill(false);
}
function authenticate(room, request) {
  const value = request.headers.authorization || '';
  if (!value.startsWith('Bearer ')) throw new Error('กรุณาเข้าห้องอีกครั้ง');
  const token = value.slice(7);
  const candidate = Buffer.from(token);
  for (let seat = 0; seat < room.players.length; seat++) {
    const actual = room.players[seat]?.token;
    if (actual) {
      const expected = Buffer.from(actual);
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return seat;
    }
  }
  throw new Error('สิทธิ์เข้าห้องไม่ถูกต้อง');
}
function assertRoom(code) {
  const room = rooms.get(code);
  if (!room) throw new Error('ไม่พบห้องนี้');
  return room;
}
function rateLimit(request, key, limit, windowMs) {
  const ip = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const id = `${ip}:${key}`;
  const recent = (requests.get(id) || []).filter(t => now - t < windowMs);
  if (recent.length >= limit) throw new Error('ลองใหม่อีกครั้งในภายหลัง');
  recent.push(now); requests.set(id, recent);
  if (requests.size > 10000) for (const [k, ts] of requests) if (ts.every(t => now - t >= windowMs)) requests.delete(k);
}
async function parseBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw new Error('ข้อมูลที่ส่งมีขนาดใหญ่เกินไป');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new Error('รูปแบบข้อมูลไม่ถูกต้อง'); }
}
async function save() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify([...rooms.values()]), { mode: 0o600 });
  await rename(tmp, DATA_FILE);
}
function transact(task) {
  const result = mutationQueue.then(task);
  mutationQueue = result.catch(() => {});
  return result;
}
function checkConservation(room) {
  const seats = joined(room);
  const total = seats.reduce((sum, seat) => sum + room.players[seat].balance, 0) + room.pot + room.fees;
  if (total !== room.initial * seats.length) throw new Error('ยอดชิปไม่สมดุล ระบบหยุดรายการนี้');
}
function applyAction(room, seat, action) {
  if (joined(room).length < 2) throw new Error('รอผู้เล่นอย่างน้อย 2 คนเข้าห้อง');
  if (room.pending && !['confirm', 'reject', 'cancel_claim'].includes(action.type)) throw new Error('รอการยืนยันผล');
  if (action.type === 'check') {
    if (room.responder !== null || room.waitingNext !== null || (room.turn !== null && room.turn !== seat) || room.checkedSeats[seat] || !canAct(room, seat) || responders(room, seat).length === 0) throw new Error('ยังไม่ถึงตา Check');
    room.checkedSeats[seat] = true;
    room.waitingNext = seat;
    room.turn = seat;
    room.handStarted = true;
    addHistory(room, 'check', seat, `${room.players[seat].name} Check · รอกด Next`);
  } else if (action.type === 'next') {
    if (room.waitingNext !== seat) throw new Error('รอผู้ที่ Check กด Next');
    const next = Array.from({ length: room.players.length - 1 }, (_, index) => (seat + index + 1) % room.players.length)
      .find(other => room.players[other] && canAct(room, other) && !room.checkedSeats[other]);
    addHistory(room, 'next', seat, next === undefined ? `${room.players[seat].name} กด Next · จบรอบ Check` : `${room.players[seat].name} กด Next · ถึงตา ${room.players[next].name}`);
    if (next === undefined) closeBettingRound(room);
    else { room.waitingNext = null; room.turn = next; }
  } else if (action.type === 'bet' || action.type === 'all_in') {
    const value = action.type === 'all_in' ? room.players[seat].balance : action.value;
    if (action.type === 'bet' && !DENOMINATIONS.has(value)) throw new Error('มูลค่าชิปไม่ถูกต้อง');
    if (!canAct(room, seat) || !value || room.players[seat].balance < value) throw new Error('ชิปคงเหลือไม่พอหรือผู้เล่นหมอบแล้ว');
    if (room.waitingNext !== null) throw new Error('รอผู้ที่ Check กด Next');
    if (room.responder === null && room.turn !== null && room.turn !== seat) throw new Error('ยังไม่ถึงตา Bet');
    if (room.responder !== null && room.responder !== seat) throw new Error('รอผู้เล่นที่ต้องตอบเบ็ต');
    if (room.responder === null && responders(room, seat).length === 0) throw new Error('ไม่มีผู้เล่นที่ตอบเบ็ตได้');
    const previousMaximum = Math.max(...room.contributions);
    room.players[seat].balance -= value;
    room.contributions[seat] += value;
    room.invested[seat] += value;
    room.pot += value;
    room.handStarted = true;
    room.turn = null;
    room.checkedSeats = Array(room.players.length).fill(false);
    if (room.players[seat].balance === 0) room.allIn[seat] = true;
    let label = 'เพิ่มชิปรอตอบ';
    if (room.contributions[seat] > previousMaximum || room.responder === null) {
      label = room.aggressor === null ? 'Bet' : 'Raise';
      room.aggressor = seat;
      room.pendingSeats = responders(room, seat);
    } else if (room.allIn[seat]) room.pendingSeats.shift();
    if (action.type === 'all_in') label = 'All-in';
    room.responder = room.pendingSeats[0] ?? null;
    addHistory(room, action.type, seat, `${room.players[seat].name} ${label} ${value.toLocaleString('en-US')} ชิป`, { amount: value });
    if (room.responder === null) closeBettingRound(room);
  } else if (action.type === 'call') {
    if (room.responder !== seat || !canAct(room, seat)) throw new Error('ยังไม่ใช่ตาที่ Call ได้');
    const due = Math.max(...room.contributions) - room.contributions[seat];
    const paid = Math.min(due, room.players[seat].balance);
    room.players[seat].balance -= paid;
    room.contributions[seat] += paid;
    room.invested[seat] += paid;
    room.pot += paid;
    if (room.players[seat].balance === 0) room.allIn[seat] = true;
    room.pendingSeats.shift();
    room.responder = room.pendingSeats[0] ?? null;
    addHistory(room, 'call', seat, `${room.players[seat].name} ${paid < due ? 'Call All-in' : 'Call'} ${paid.toLocaleString('en-US')} ชิป`, { amount: paid });
    if (room.responder === null) closeBettingRound(room);
  } else if (action.type === 'fold') {
    if (room.pot === 0 || room.foldedSeats[seat] || room.allIn[seat] || room.responder !== seat) throw new Error('ยังหมอบไม่ได้ในตอนนี้');
    room.foldedSeats[seat] = true;
    room.folded = seat;
    room.handStarted = true;
    if (room.responder === seat) room.pendingSeats.shift();
    room.responder = room.pendingSeats[0] ?? null;
    addHistory(room, 'fold', seat, `${room.players[seat].name} หมอบ`);
    if (room.responder === null || active(room).length === 1) closeBettingRound(room);
  } else if (action.type === 'claim' || action.type === 'claim_tie') {
    const tie = action.type === 'claim_tie';
    if (room.pending || room.responder !== null || room.waitingNext !== null || room.turn !== null || room.foldedSeats[seat] || (room.pot === 0 && active(room).length > 1)) throw new Error('ยังขอรับกองกลางไม่ได้');
    const layers = pots(room);
    const defaultWinners = tie && active(room).length === 2 ? layers.map(pot => [...pot.eligible]) : layers.map(() => [seat]);
    const winners = action.winners ?? defaultWinners;
    if (!Array.isArray(winners) || winners.length !== layers.length) throw new Error('ต้องระบุผู้ชนะของกองย่อยให้ครบ');
    if (tie && !winners.some(group => Array.isArray(group) && group.length > 1)) throw new Error('ผลเสมอต้องมีผู้รับชิปอย่างน้อยสองคน');
    const shares = Array(room.players.length).fill(0);
    let cumulative = 0;
    layers.forEach((layer, index) => {
      const group = winners[index];
      if (!Array.isArray(group) || !group.length || new Set(group).size !== group.length || group.some(winner => !Number.isInteger(winner) || !layer.eligible.includes(winner))) throw new Error('ผู้ชนะกองย่อยไม่ถูกต้อง');
      const charge = fee(cumulative + layer.amount) - fee(cumulative);
      cumulative += layer.amount;
      const net = layer.amount - charge;
      for (const winner of group) shares[winner] += Math.floor(net / group.length);
      const ordered = [...group].sort((a, b) => ((a - room.hand + 1 + room.players.length) % room.players.length) - ((b - room.hand + 1 + room.players.length) % room.players.length));
      for (let extra = 0; extra < net % group.length; extra++) shares[ordered[extra]]++;
    });
    room.pending = { outcome: tie ? 'tie' : 'win', claimant: seat, winners, pot: room.pot, fee: fee(room.pot), net: room.pot - fee(room.pot), shares, confirmed: [seat] };
    addHistory(room, action.type, seat, `${room.players[seat].name} เสนอผล ${tie ? 'เสมอ' : 'ผู้ชนะ'} และรอทุกคนยืนยัน`);
  } else if (action.type === 'reject') {
    if (!room.pending || room.pending.claimant === seat) throw new Error('ไม่มีผลให้ปฏิเสธ');
    room.pending = null;
    addHistory(room, 'reject', seat, `${room.players[seat].name} ไม่ยืนยันผล`);
  } else if (action.type === 'cancel_claim') {
    if (!room.pending || room.pending.claimant !== seat) throw new Error('ไม่มีคำขอให้ยกเลิก');
    room.pending = null;
    addHistory(room, 'cancel_claim', seat, `${room.players[seat].name} ถอนคำขอผล`);
  } else if (action.type === 'confirm') {
    if (!room.pending || room.pending.claimant === seat || room.pending.confirmed.includes(seat)) throw new Error('ไม่มีผลให้ยืนยัน');
    room.pending.confirmed.push(seat);
    addHistory(room, 'confirm', seat, `${room.players[seat].name} ยืนยันผล (${room.pending.confirmed.length}/${joined(room).length})`);
    if (room.pending.confirmed.length === joined(room).length) {
      const { shares, outcome } = room.pending;
      shares.forEach((amount, winner) => { if (amount) room.players[winner].balance += amount; });
      const charge = fee(room.pot);
      room.fees += charge;
      room.pot = 0;
      addHistory(room, outcome === 'tie' ? 'settle_tie' : 'settle', seat, `จบตาเล่น · แจกชิป ${shares.map((amount, winner) => amount ? `${room.players[winner].name} ${amount.toLocaleString('en-US')}` : '').filter(Boolean).join(' / ')} · ค่าธรรมเนียม ${charge.toLocaleString('en-US')}`, { shares, fee: charge });
      room.hand++;
      room.bettingRound = 1;
      room.contributions = Array(room.players.length).fill(0);
      room.invested = Array(room.players.length).fill(0);
      room.pendingSeats = [];
      room.turn = null;
      room.waitingNext = null;
      room.checkedSeats = Array(room.players.length).fill(false);
      room.aggressor = null;
      room.responder = null;
      room.folded = null;
      room.foldedSeats = Array(room.players.length).fill(false);
      room.allIn = Array(room.players.length).fill(false);
      room.handStarted = false;
      room.pending = null;
    }
  } else throw new Error('คำสั่งไม่ถูกต้อง');
  checkConservation(room);
  room.revision++;
}
function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(data));
}
async function staticFile(response, path) {
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const file = files[path];
  if (!file) return send(response, 404, { error: 'ไม่พบหน้านี้' });
  const content = await readFile(join(ROOT, 'public', file[0]));
  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
  response.end(content);
}
async function route(request, response) {
  try {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) return await staticFile(response, url.pathname);
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      rateLimit(request, 'create', 10, 60000);
      const body = await parseBody(request);
      const name = cleanName(body.name);
      const initial = body.initial;
      if (!money(initial) || initial < START_MIN || initial > START_MAX || initial % 1000 !== 0) throw new Error('ยอดเริ่มต้นต้องเป็นจำนวนเต็ม 1,000–1,000,000,000 และหารด้วย 1,000 ลงตัว');
      return send(response, 201, await transact(async () => {
        const code = roomCode(), token = secret();
        const room = { code, initial, players: [{ name, token, balance: initial }, null, null, null], pot: 0, fees: 0,
          hand: 1, bettingRound: 1, contributions: [0, 0, 0, 0], invested: [0, 0, 0, 0],
          responder: null, pendingSeats: [], turn: null, waitingNext: null, checkedSeats: [false, false, false, false],
          aggressor: null, folded: null, foldedSeats: [false, false, false, false],
          allIn: [false, false, false, false], handStarted: false, pending: null, revision: 1, history: [], processed: [] };
        addHistory(room, 'create', 0, `${name} สร้างห้อง · เริ่มต้นคนละ ${initial.toLocaleString('en-US')} ชิป`);
        rooms.set(code, room);
        try { await save(); } catch (error) { rooms.delete(code); throw error; }
        return { token, room: publicRoom(room, 0) };
      }));
    }
    if (parts[0] === 'api' && parts[1] === 'rooms' && /^[A-Z2-9]{8}$/.test(parts[2] || '')) {
      const code = parts[2];
      if (request.method === 'POST' && parts.length === 4 && parts[3] === 'join') {
        rateLimit(request, 'join', 20, 60000);
        const body = await parseBody(request);
        const name = cleanName(body.name);
        return send(response, 201, await transact(async () => {
          const room = assertRoom(code);
          const seat = room.players.findIndex(player => !player);
          if (seat < 0) throw new Error('ห้องนี้มีผู้เล่นครบแล้ว');
          if (room.handStarted || room.pot > 0 || room.pending) throw new Error('รอจบตาเล่นนี้ก่อนเข้าห้อง');
          const token = secret();
          room.players[seat] = { name, token, balance: room.initial };
          room.revision++;
          addHistory(room, 'join', seat, `${name} เข้าร่วมห้อง`);
          try { await save(); } catch (error) { room.players[seat] = null; room.revision--; room.history.pop(); throw error; }
          return { token, room: publicRoom(room, seat) };
        }));
      }
      if (request.method === 'GET' && parts.length === 3) {
        await mutationQueue;
        const room = assertRoom(code), seat = authenticate(room, request);
        return send(response, 200, { room: publicRoom(room, seat) });
      }
      if (request.method === 'POST' && parts.length === 4 && parts[3] === 'actions') {
        const body = await parseBody(request);
        if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(body.id)) throw new Error('รหัสรายการไม่ถูกต้อง');
        return send(response, 200, await transact(async () => {
          const room = assertRoom(code), seat = authenticate(room, request);
          const prior = room.processed.find(p => p.id === body.id && p.seat === seat);
          if (prior) return { room: publicRoom(room, seat), duplicate: true };
          const snapshot = structuredClone(room);
          try {
            applyAction(room, seat, body);
            room.processed.push({ id: body.id, seat });
            if (room.processed.length > 500) room.processed.shift();
            await save();
          } catch (error) { rooms.set(code, snapshot); throw error; }
          return { room: publicRoom(room, seat) };
        }));
      }
    }
    return send(response, 404, { error: 'ไม่พบรายการ' });
  } catch (error) {
    const userErrors = /ไม่พบ|ไม่ถูกต้อง|ไม่พอ|ไม่ได้|รอ|ต้อง|ครบ|ภายหลัง|ใหญ่|หมอบ|ไม่มี|สิทธิ์|คงเหลือ|สูงกว่า|ถึงตา/.test(error.message);
    if (!userErrors) console.error(error);
    return send(response, userErrors ? 400 : 500, { error: userErrors ? error.message : 'ระบบขัดข้อง กรุณาลองใหม่' });
  }
}
try {
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  for (const room of data) {
    room.players = [...room.players, ...Array(MAX_PLAYERS).fill(null)].slice(0, MAX_PLAYERS);
    room.contributions = [...room.contributions, ...Array(MAX_PLAYERS).fill(0)].slice(0, MAX_PLAYERS);
    room.invested = [...(room.invested ?? room.contributions), ...Array(MAX_PLAYERS).fill(0)].slice(0, MAX_PLAYERS);
    room.allIn = [...(room.allIn ?? []), ...Array(MAX_PLAYERS).fill(false)].slice(0, MAX_PLAYERS);
    room.foldedSeats = [...(room.foldedSeats ?? []), ...Array(MAX_PLAYERS).fill(false)].slice(0, MAX_PLAYERS);
    if (room.folded !== null) room.foldedSeats[room.folded] = true;
    room.pendingSeats ??= room.responder === null ? [] : [room.responder];
    room.turn ??= null;
    room.waitingNext ??= null;
    room.checkedSeats = [...(room.checkedSeats ?? []), ...Array(MAX_PLAYERS).fill(false)].slice(0, MAX_PLAYERS);
    room.handStarted ??= room.pot > 0 || room.folded !== null;
    if (room.pending) {
      room.pending.confirmed ??= [room.pending.claimant];
      room.pending.shares ??= room.players.map((_, seat) => seat === room.pending.claimant ? room.pending.net : 0);
      room.pending.shares = [...room.pending.shares, ...Array(MAX_PLAYERS).fill(0)].slice(0, MAX_PLAYERS);
    }
    rooms.set(room.code, room);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
http.createServer(route).listen(PORT, () => console.log(`PotMate listening on http://localhost:${PORT}`));
