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
    responder: room.responder, aggressor: room.aggressor, folded: room.folded, allIn: room.allIn,
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
function refundUncalled(room) {
  const unmatched = Math.abs(room.contributions[0] - room.contributions[1]);
  if (!unmatched) return;
  const owner = room.contributions[0] > room.contributions[1] ? 0 : 1;
  room.players[owner].balance += unmatched;
  room.pot -= unmatched;
  room.contributions[owner] -= unmatched;
  addHistory(room, 'refund', owner, `คืน Bet ที่ยังไม่มีการ Call ${unmatched.toLocaleString('en-US')} ชิป ให้ ${room.players[owner].name}`, { amount: unmatched });
}
function closeBettingRound(room) {
  refundUncalled(room);
  room.bettingRound++;
  room.contributions = [0, 0];
  room.aggressor = null;
  room.responder = null;
}
function authenticate(room, request) {
  const value = request.headers.authorization || '';
  if (!value.startsWith('Bearer ')) throw new Error('กรุณาเข้าห้องอีกครั้ง');
  const token = value.slice(7);
  const candidate = Buffer.from(token);
  for (let seat = 0; seat < 2; seat++) {
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
  if (room.players[1]) {
    const total = room.players[0].balance + room.players[1].balance + room.pot + room.fees;
    if (total !== room.initial * 2) throw new Error('ยอดชิปไม่สมดุล ระบบหยุดรายการนี้');
  }
}
function applyAction(room, seat, action) {
  const other = 1 - seat;
  if (!room.players[1]) throw new Error('รอผู้เล่นคนที่ 2 เข้าห้อง');
  if (room.pending && !['confirm', 'reject', 'cancel_claim'].includes(action.type)) throw new Error('รอการยืนยันผู้ชนะ');
  if (action.type === 'bet' || action.type === 'all_in') {
    const value = action.type === 'all_in' ? room.players[seat].balance : action.value;
    if (action.type === 'bet' && !DENOMINATIONS.has(value)) throw new Error('มูลค่าชิปไม่ถูกต้อง');
    if (room.folded !== null) throw new Error('มีผู้เล่นหมอบแล้ว');
    if (room.allIn.some(Boolean) || room.players[other].balance === 0) throw new Error('มีผู้เล่น All-in หรือชิปหมดแล้ว ให้ Call หรือขอจบตาเล่น');
    if (!value) throw new Error('ชิปคงเหลือไม่พอ');
    if (room.players[seat].balance < value) throw new Error('ชิปคงเหลือไม่พอ');
    const before = room.contributions[seat];
    room.players[seat].balance -= value;
    if (room.players[seat].balance === 0) room.allIn[seat] = true;
    room.contributions[seat] += value;
    room.pot += value;
    let label = 'Bet';
    if (room.aggressor === null) {
      room.aggressor = seat;
      room.responder = other;
    } else if (room.contributions[seat] > room.contributions[other] && seat !== room.aggressor) {
      room.aggressor = seat;
      room.responder = other;
      label = 'Raise';
    } else if (room.contributions[seat] > before && seat === room.aggressor) {
      label = 'เพิ่ม Bet';
    } else {
      label = 'เพิ่มชิปรอตอบ';
    }
    if (action.type === 'all_in') label = 'All-in';
    addHistory(room, action.type, seat, `${room.players[seat].name} ${label} ${value.toLocaleString('en-US')} ชิป`, { amount: value });
    if (room.allIn[seat] && room.responder === seat) closeBettingRound(room);
  } else if (action.type === 'call') {
    if (room.folded !== null || room.responder !== seat) throw new Error('ยังไม่ใช่ตาที่ Call ได้');
    const due = room.contributions[other] - room.contributions[seat];
    if (due < 0) throw new Error('ยอดที่วางสูงกว่าอีกฝ่ายแล้ว');
    const paid = Math.min(due, room.players[seat].balance);
    room.players[seat].balance -= paid;
    if (room.players[seat].balance === 0) room.allIn[seat] = true;
    room.contributions[seat] += paid;
    room.pot += paid;
    addHistory(room, 'call', seat, `${room.players[seat].name} ${paid < due ? 'Call All-in' : 'Call'} ${paid.toLocaleString('en-US')} ชิป · จบรอบเบ็ต ${room.bettingRound}`, { amount: paid });
    closeBettingRound(room);
  } else if (action.type === 'fold') {
    if (room.folded !== null || room.pot === 0) throw new Error('ยังหมอบไม่ได้ในตอนนี้');
    refundUncalled(room);
    room.folded = seat;
    addHistory(room, 'fold', seat, `${room.players[seat].name} หมอบ`);
  } else if (action.type === 'claim' || action.type === 'claim_tie') {
    const tie = action.type === 'claim_tie';
    if (room.pending || (room.pot === 0 && room.folded === null) || room.responder !== null && room.folded === null || (tie && room.folded !== null) || (!tie && room.folded === seat)) throw new Error('ยังขอรับกองกลางไม่ได้');
    const net = room.pot - fee(room.pot);
    const shares = [Math.floor(net / 2), Math.floor(net / 2)];
    shares[(room.hand - 1) % 2] += net % 2;
    room.pending = { outcome: tie ? 'tie' : 'win', claimant: seat, pot: room.pot, fee: fee(room.pot), net, ...(tie ? { shares } : {}) };
    addHistory(room, action.type, seat, `${room.players[seat].name} กด ${tie ? 'เสมอ' : "I'm Win"} และรอการยืนยัน`);
  } else if (action.type === 'reject') {
    if (!room.pending || room.pending.claimant === seat) throw new Error('ไม่มีผลให้ปฏิเสธ');
    room.pending = null;
    addHistory(room, 'reject', seat, `${room.players[seat].name} ไม่ยืนยันผู้ชนะ`);
  } else if (action.type === 'cancel_claim') {
    if (!room.pending || room.pending.claimant !== seat) throw new Error('ไม่มีคำขอให้ยกเลิก');
    room.pending = null;
    addHistory(room, 'cancel_claim', seat, `${room.players[seat].name} ถอนคำขอรับกองกลาง`);
  } else if (action.type === 'confirm') {
    if (!room.pending || room.pending.claimant === seat) throw new Error('ไม่มีผลให้ยืนยัน');
    const charge = fee(room.pot);
    const net = room.pot - charge;
    if (room.pending.outcome === 'tie') {
      room.players[0].balance += room.pending.shares[0];
      room.players[1].balance += room.pending.shares[1];
    } else room.players[room.pending.claimant].balance += net;
    room.fees += charge;
    room.pot = 0;
    if (room.pending.outcome === 'tie') addHistory(room, 'settle_tie', seat, `${room.players[seat].name} ยืนยันเสมอ · แบ่ง ${room.pending.shares[0].toLocaleString('en-US')} / ${room.pending.shares[1].toLocaleString('en-US')} ชิป (ค่าธรรมเนียม ${charge.toLocaleString('en-US')})`, { shares: room.pending.shares, fee: charge });
    else addHistory(room, 'settle', seat, `${room.players[seat].name} ยืนยัน · ${room.players[room.pending.claimant].name} รับ ${net.toLocaleString('en-US')} ชิป (ค่าธรรมเนียม ${charge.toLocaleString('en-US')})`, { winner: room.pending.claimant, fee: charge, amount: net });
    room.hand++;
    room.bettingRound = 1;
    room.contributions = [0, 0];
    room.aggressor = null;
    room.responder = null;
    room.folded = null;
    room.allIn = [false, false];
    room.pending = null;
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
        const room = { code, initial, players: [{ name, token, balance: initial }, null], pot: 0, fees: 0,
          hand: 1, bettingRound: 1, contributions: [0, 0], responder: null, aggressor: null,
          folded: null, allIn: [false, false], pending: null, revision: 1, history: [], processed: [] };
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
          if (room.players[1]) throw new Error('ห้องนี้มีผู้เล่นครบแล้ว');
          const token = secret();
          room.players[1] = { name, token, balance: room.initial };
          room.revision++;
          addHistory(room, 'join', 1, `${name} เข้าร่วมห้อง`);
          try { await save(); } catch (error) { room.players[1] = null; room.revision--; room.history.pop(); throw error; }
          return { token, room: publicRoom(room, 1) };
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
    const userErrors = /ไม่พบ|ไม่ถูกต้อง|ไม่พอ|ไม่ได้|รอ|ต้อง|ครบ|ภายหลัง|ใหญ่|หมอบ|ไม่มี|สิทธิ์|คงเหลือ|สูงกว่า/.test(error.message);
    if (!userErrors) console.error(error);
    return send(response, userErrors ? 400 : 500, { error: userErrors ? error.message : 'ระบบขัดข้อง กรุณาลองใหม่' });
  }
}
try {
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  for (const room of data) { room.allIn ??= [false, false]; rooms.set(room.code, room); }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
http.createServer(route).listen(PORT, () => console.log(`PotMate listening on http://localhost:${PORT}`));
