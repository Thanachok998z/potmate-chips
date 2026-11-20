const $ = id => document.getElementById(id);
const DENOMS = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];
const format = value => new Intl.NumberFormat('en-US').format(value);
const short = value => value >= 1000000 ? `${value / 1000000}m` : `${value / 1000}k`;
let session = null;
let room = null;
let busy = false;
let lastRevision = -1;
let noticeTimer;

function notify(text, error = false) {
  const el = $('message');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.style.display = 'block';
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error('อ่านผลจากเซิร์ฟเวอร์ไม่ได้'); }
  if (!response.ok) { const error = new Error(data.error || 'ทำรายการไม่สำเร็จ'); error.httpStatus = response.status; throw error; }
  return data;
}
function saveSession() { localStorage.setItem('potmate-session', JSON.stringify(session)); }
function clearSession() {
  localStorage.removeItem('potmate-session');
  session = null; room = null; lastRevision = -1;
  $('room').hidden = true; $('entry').hidden = false;
}
function button(label, type, disabled = false, extraClass = '') {
  const el = document.createElement('button');
  el.type = 'button'; el.className = `button ${extraClass}`; el.textContent = label; el.disabled = disabled;
  el.addEventListener('click', () => action(type));
  return el;
}
function drawPlayer(seat) {
  const target = $(`player${seat}`);
  target.replaceChildren();
  const p = room.players[seat];
  const isMe = seat === room.seat;
  target.classList.toggle('me', isMe);
  const head = document.createElement('div'); head.className = 'player-head';
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = String(seat + 1);
  const info = document.createElement('div');
  const name = document.createElement('div'); name.className = 'player-name'; name.textContent = p?.name || 'รอผู้เล่น 2';
  const role = document.createElement('div'); role.className = 'player-role'; role.textContent = `${isMe ? 'คุณ' : 'อีกฝ่าย'}${room.folded === seat ? ' · หมอบ' : room.allIn?.[seat] ? ' · ALL-IN' : p?.balance === 0 ? ' · ชิปหมด' : ''}`;
  info.append(name, role); head.append(avatar, info); target.append(head);
  const balance = document.createElement('div'); balance.className = 'balance'; balance.textContent = p ? format(p.balance) : '—'; target.append(balance);
  const caption = document.createElement('div'); caption.className = 'caption'; caption.textContent = `ชิปคงเหลือ · รอบเบ็ตนี้วาง ${format(room.contributions[seat])}`; target.append(caption);
  const tray = document.createElement('div'); tray.className = 'chips';
  DENOMS.forEach((value, index) => {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = `chip c${index}`; chip.textContent = short(value);
    chip.setAttribute('aria-label', `วางชิป ${format(value)}`);
    chip.disabled = !isMe || !room.players[1] || !!room.pending || room.folded !== null || room.allIn?.some(Boolean) || room.players[1 - seat]?.balance === 0 || p.balance < value || busy || !!session?.pending;
    chip.draggable = !chip.disabled;
    let dragging = false;
    chip.addEventListener('click', () => { if (!dragging) action('bet', value); });
    chip.addEventListener('dragstart', event => {
      if (chip.disabled) return event.preventDefault();
      dragging = true;
      event.dataTransfer.setData('text/plain', String(value));
      event.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => setTimeout(() => { dragging = false; }, 50));
    tray.append(chip);
  });
  target.append(tray);
  if (!isMe) return;
  const controls = document.createElement('div'); controls.className = 'player-buttons';
  const other = 1 - seat;
  if (room.responder === seat && room.folded === null && !room.pending) {
    const due = room.contributions[other] - room.contributions[seat];
    controls.append(button(`${due > p.balance ? 'Call All-in' : 'Call'} ${format(Math.min(Math.max(0, due), p.balance))}`, 'call', due < 0 || busy || !!session?.pending, 'primary'));
  }
  controls.append(button(`All-in ${format(p.balance)}`, 'all_in', !room.players[1] || p.balance === 0 || room.players[other].balance === 0 || room.allIn?.some(Boolean) || room.folded !== null || !!room.pending || busy || !!session?.pending));
  controls.append(button('หมอบ', 'fold', !room.players[1] || room.pot === 0 || room.folded !== null || !!room.pending || busy || !!session?.pending, 'danger'));
  controls.append(button("I'm Win", 'claim', !room.players[1] || (room.pot === 0 && room.folded === null) || room.folded === seat || (room.responder !== null && room.folded === null) || !!room.pending || busy || !!session?.pending));
  controls.append(button('ฉันเสมอ', 'claim_tie', !room.players[1] || room.pot === 0 || room.folded !== null || room.responder !== null || !!room.pending || busy || !!session?.pending));
  target.append(controls);
}
function drawDecision() {
  const target = $('decision'); target.replaceChildren();
  if (!room.pending) { target.hidden = true; return; }
  target.hidden = false;
  const title = document.createElement('h2'); title.textContent = room.pending.outcome === 'tie' ? 'ยืนยันผลเสมอ' : 'ยืนยันผู้ชนะ';
  const copy = document.createElement('p');
  const claimant = room.players[room.pending.claimant]?.name || 'ผู้เล่น';
  copy.textContent = room.pending.outcome === 'tie' ? `${claimant} ขอให้แบ่ง pot ${format(room.pending.pot)} ชิป · ค่าธรรมเนียม 0.5% = ${format(room.pending.fee)} · ${room.players[0].name} ได้ ${format(room.pending.shares[0])} และ ${room.players[1].name} ได้ ${format(room.pending.shares[1])} ชิป` : `${claimant} ขอรับ pot ${format(room.pending.pot)} ชิป · ค่าธรรมเนียม 0.5% = ${format(room.pending.fee)} · ได้รับสุทธิ ${format(room.pending.net)} ชิป`;
  const controls = document.createElement('div'); controls.className = 'buttons';
  if (room.pending.claimant === room.seat) controls.append(button('ถอนคำขอ', 'cancel_claim', busy || !!session?.pending));
  else controls.append(button(room.pending.outcome === 'tie' ? 'ยืนยันเสมอ' : 'ยืนยันผู้ชนะ', 'confirm', busy || !!session?.pending, 'primary'), button('ไม่ยืนยัน', 'reject', busy || !!session?.pending, 'danger'));
  target.append(title, copy, controls);
}
function drawHistory() {
  const target = $('history'); target.replaceChildren();
  if (!room.history.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'ยังไม่มีรายการ'; target.append(empty); return; }
  for (const event of room.history) {
    const row = document.createElement('div'); row.className = 'entry';
    const main = document.createElement('div'); main.textContent = event.text;
    const meta = document.createElement('small'); meta.textContent = `ตาเล่น ${event.hand} · รอบเบ็ต ${event.bettingRound} · pot หลังรายการ ${format(event.potAfter)}`;
    main.append(meta);
    const time = document.createElement('time'); time.dateTime = event.at; time.textContent = new Date(event.at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
    row.append(main, time); target.append(row);
  }
}
function render() {
  if (!room) return;
  $('entry').hidden = true; $('room').hidden = false;
  $('roomCode').textContent = room.code;
  $('round').textContent = `ตาเล่น ${room.hand} · รอบเบ็ต ${room.bettingRound}`;
  $('potAmount').textContent = format(room.pot);
  $('feePreview').textContent = `ค่าธรรมเนียมเมื่อจบตาเล่น ${format(Math.floor(room.pot * 0.005))}`;
  $('feesTotal').textContent = `ค่าธรรมเนียมสะสม ${format(room.fees)} ชิป`;
  const other = 1 - room.seat;
  $('turnStatus').textContent = !room.players[1] ? 'รออีกฝ่ายเข้าห้อง' : room.pending ? 'รออีกฝ่ายยืนยันผล' : room.folded !== null ? `${room.players[room.folded].name} หมอบ` : room.allIn?.some(Boolean) && room.responder === null ? "All-in แล้ว · เลือก I'm Win หรือ เสมอ" : room.responder === null && room.players.some(p => p.balance === 0) ? 'มีผู้เล่นชิปหมด · เริ่ม Bet ใหม่ไม่ได้' : room.responder === null ? 'เปิด Bet ได้ทั้งสองฝ่าย' : room.responder === room.seat ? `คุณต้อง Call ${format(Math.min(Math.max(0, room.contributions[other] - room.contributions[room.seat]), room.players[room.seat].balance))}${room.allIn?.[other] ? ' หรือหมอบ' : ' หรือวางชิปเพื่อ Raise'}` : `รอ ${room.players[other].name} Call ${room.allIn?.[room.seat] ? 'หรือหมอบ' : 'หรือ Raise'}`;
  drawPlayer(0); drawPlayer(1); drawDecision(); drawHistory();
}
function setRoom(data) {
  if (data.room.revision <= lastRevision && room) return;
  room = data.room; lastRevision = room.revision; render();
}
async function refresh() {
  if (!session) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(session.code)}`);
    $('connection').textContent = 'เชื่อมต่อแล้ว';
    setRoom(data);
    if (session.pending && data.room.processedIds.includes(session.pending.id)) {
      session.pending = null; saveSession(); render();
    }
  } catch (error) {
    $('connection').textContent = 'ขาดการเชื่อมต่อ';
    if (/สิทธิ์|ไม่พบห้อง/.test(error.message)) { clearSession(); notify(error.message, true); }
  }
}
async function transmitPending() {
  if (!session?.pending || busy) return;
  busy = true; render();
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(session.code)}/actions`, { method: 'POST', body: JSON.stringify(session.pending) });
    setRoom(data);
    session.pending = null; saveSession();
  } catch (error) {
    if (error.httpStatus) { session.pending = null; saveSession(); notify(error.message, true); }
    else notify('การเชื่อมต่อสะดุด กำลังตรวจรายการเดิมก่อนส่งซ้ำ', true);
    await refresh();
  }
  finally { busy = false; render(); }
}
function action(type, value) {
  if (!session || busy || session.pending) return;
  session.pending = { id: crypto.randomUUID(), type, value };
  saveSession();
  transmitPending();
}
async function enter(path, body) {
  if (busy) return;
  busy = true;
  try {
    const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
    session = { code: data.room.code, token: data.token };
    saveSession(); setRoom(data); $('connection').textContent = 'เชื่อมต่อแล้ว';
  } catch (error) { notify(error.message, true); }
  finally { busy = false; }
}
$('createForm').addEventListener('submit', event => {
  event.preventDefault();
  const initial = Number($('initial').value);
  enter('/api/rooms', { name: $('createName').value.trim(), initial });
});
$('joinForm').addEventListener('submit', event => {
  event.preventDefault();
  const code = $('joinCode').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) return notify('รหัสห้องต้องมี 8 ตัว', true);
  enter(`/api/rooms/${code}/join`, { name: $('joinName').value.trim() });
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(room.code); notify('คัดลอกรหัสห้องแล้ว'); }
  catch { notify(`รหัสห้อง: ${room.code}`); }
});
$('leave').addEventListener('click', () => { if (confirm('ลบสิทธิ์ผู้เล่นจากเครื่องนี้? คุณจะกลับเข้าที่นั่งเดิมไม่ได้ แต่ห้องและชิปยังอยู่บนเซิร์ฟเวอร์')) clearSession(); });
$('potDrop').addEventListener('dragover', event => { event.preventDefault(); $('potDrop').classList.add('over'); });
$('potDrop').addEventListener('dragleave', () => $('potDrop').classList.remove('over'));
$('potDrop').addEventListener('drop', event => {
  event.preventDefault(); $('potDrop').classList.remove('over');
  const value = Number(event.dataTransfer.getData('text/plain'));
  if (DENOMS.includes(value)) action('bet', value);
});
try { session = JSON.parse(localStorage.getItem('potmate-session') || 'null'); }
catch { session = null; }
if (session?.code && session?.token) refresh(); else clearSession();
setInterval(async () => { await refresh(); if (session?.pending && !busy) transmitPending(); }, 1500);
