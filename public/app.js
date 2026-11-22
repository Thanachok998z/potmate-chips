const $ = id => document.getElementById(id);
const DENOMS = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];
const format = value => new Intl.NumberFormat('en-US').format(value);
const short = value => value >= 1000000 ? `${value / 1000000}m` : `${value / 1000}k`;
let session = null;
let room = null;
let busy = false;
let lastRevision = -1;
let noticeTimer;
let resultMode = null;
let resultSelection = [];
let resultHand = null;
const playerCount = () => room.players.filter(Boolean).length;
const activeSeats = () => room.players.map((player, seat) => player && !room.foldedSeats[seat] ? seat : -1).filter(seat => seat >= 0);
const maxBet = () => Math.max(...room.contributions);
const canBet = seat => playerCount() >= 2 && !room.pending && !room.foldedSeats[seat] && !room.allIn[seat] && room.players[seat].balance > 0 && (room.responder === null || room.responder === seat) && room.players.some((player, other) => other !== seat && player && !room.foldedSeats[other] && !room.allIn[other] && player.balance > 0);

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
  session = null; room = null; lastRevision = -1; resultMode = null;
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
  const name = document.createElement('div'); name.className = 'player-name'; name.textContent = p?.name || `รอผู้เล่น ${seat + 1}`;
  const role = document.createElement('div'); role.className = 'player-role'; role.textContent = p ? `${isMe ? 'คุณ' : `ผู้เล่น ${seat + 1}`}${room.foldedSeats[seat] ? ' · หมอบ' : room.allIn[seat] ? ' · ALL-IN' : p.balance === 0 ? ' · ชิปหมด' : ''}${room.responder === seat ? ' · ถึงตาตอบ' : ''}` : 'ยังไม่มีผู้เล่น';
  info.append(name, role); head.append(avatar, info); target.append(head);
  const balance = document.createElement('div'); balance.className = 'balance'; balance.textContent = p ? format(p.balance) : '—'; target.append(balance);
  const caption = document.createElement('div'); caption.className = 'caption'; caption.textContent = `ชิปคงเหลือ · รอบเบ็ตนี้วาง ${format(room.contributions[seat])}`; target.append(caption);
  if (!isMe) return;
  const tray = document.createElement('div'); tray.className = 'chips';
  DENOMS.forEach((value, index) => {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = `chip c${index}`; chip.textContent = short(value);
    chip.setAttribute('aria-label', `วางชิป ${format(value)}`);
    chip.disabled = !canBet(seat) || p.balance < value || busy || !!session?.pending;
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
  const controls = document.createElement('div'); controls.className = 'player-buttons';
  if (room.responder === seat && !room.pending) {
    const due = maxBet() - room.contributions[seat];
    controls.append(button(`${due > p.balance ? 'Call All-in' : 'Call'} ${format(Math.min(due, p.balance))}`, 'call', busy || !!session?.pending, 'primary'));
  }
  controls.append(button(`All-in ${format(p.balance)}`, 'all_in', !canBet(seat) || busy || !!session?.pending));
  controls.append(button('หมอบ', 'fold', room.pot === 0 || room.foldedSeats[seat] || room.allIn[seat] || room.responder !== seat || !!room.pending || busy || !!session?.pending, 'danger'));
  const canClaim = playerCount() >= 2 && (room.pot > 0 || activeSeats().length === 1) && !room.foldedSeats[seat] && room.responder === null && !room.pending && !busy && !session?.pending;
  controls.append(button("I'm Win", 'open_win', !canClaim));
  controls.append(button('ฉันเสมอ', 'open_tie', !canClaim || activeSeats().length < 2 || room.pot === 0));
  target.append(controls);
}
function drawDecision() {
  const target = $('decision'); target.replaceChildren();
  if (!room.pending) { target.hidden = true; return; }
  target.hidden = false;
  const title = document.createElement('h2'); title.textContent = room.pending.outcome === 'tie' ? 'ยืนยันผลเสมอ' : 'ยืนยันผู้ชนะ';
  const copy = document.createElement('p');
  const claimant = room.players[room.pending.claimant]?.name || 'ผู้เล่น';
  const payouts = room.pending.shares.map((amount, seat) => amount ? `${room.players[seat].name} ${format(amount)}` : '').filter(Boolean).join(' · ');
  copy.textContent = `${claimant} เสนอผล · กองกลาง ${format(room.pending.pot)} ชิป · ค่าธรรมเนียม ${format(room.pending.fee)} ชิป · รับสุทธิ: ${payouts || 'ไม่มีชิปในกอง'} · ยืนยันแล้ว ${(room.pending.confirmed || [room.pending.claimant]).length}/${playerCount()} คน`;
  const controls = document.createElement('div'); controls.className = 'buttons';
  if (room.pending.claimant === room.seat) controls.append(button('ถอนคำขอ', 'cancel_claim', busy || !!session?.pending));
  else if (!(room.pending.confirmed || []).includes(room.seat)) controls.append(button('ยืนยันผล', 'confirm', busy || !!session?.pending, 'primary'), button('ไม่ยืนยัน', 'reject', busy || !!session?.pending, 'danger'));
  target.append(title, copy, controls);
}
function openResult(mode) {
  if (!room || room.pending || room.responder !== null) return;
  resultMode = mode; resultHand = room.hand;
  resultSelection = room.pots.map(pot => {
    const preferred = pot.eligible.includes(room.seat) ? room.seat : pot.eligible[0];
    if (mode === 'tie' && pot.eligible.length > 1 && pot.eligible.includes(room.seat)) return [room.seat, pot.eligible.find(seat => seat !== room.seat)];
    return preferred === undefined ? [] : [preferred];
  });
  drawResultEditor();
  $('resultEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function drawResultEditor() {
  const target = $('resultEditor'); target.replaceChildren();
  if (!resultMode || !room || room.pending || room.hand !== resultHand) { target.hidden = true; return; }
  target.hidden = false;
  const heading = document.createElement('h2'); heading.textContent = resultMode === 'tie' ? 'เลือกคนที่เสมอ' : 'เลือกผู้ชนะ';
  const help = document.createElement('p'); help.textContent = 'เลือกผู้รับชิปในแต่ละกอง หากมีหลายคนเสมอกันให้เลือกหลายชื่อ ทุกคนในห้องต้องยืนยันก่อนแจกชิป';
  target.append(heading, help);
  for (const [index, pot] of room.pots.entries()) {
    const box = document.createElement('fieldset'); box.className = 'pot-choice';
    const legend = document.createElement('legend'); legend.textContent = `${index === 0 ? 'กองหลัก' : `กองย่อย ${index}`} · ${format(pot.amount)} ชิป`;
    box.append(legend);
    for (const seat of pot.eligible) {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = resultSelection[index].includes(seat);
      input.addEventListener('change', () => {
        resultSelection[index] = input.checked ? [...resultSelection[index], seat] : resultSelection[index].filter(selected => selected !== seat);
      });
      label.append(input, document.createTextNode(room.players[seat].name)); box.append(label);
    }
    target.append(box);
  }
  if (!room.pots.length) { const empty = document.createElement('p'); empty.textContent = 'กองกลางไม่มีชิป สามารถจบตาเล่นได้'; target.append(empty); }
  const controls = document.createElement('div'); controls.className = 'buttons';
  const submit = button('เสนอผลให้ทุกคนยืนยัน', 'submit_result', false, 'primary');
  controls.append(submit, button('ยกเลิก', 'cancel_result'));
  target.append(controls);
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
  $('turnStatus').textContent = playerCount() < 2 ? 'รอผู้เล่นคนที่ 2 เข้าห้อง' : room.pending ? `รอการยืนยันผล ${(room.pending.confirmed || []).length}/${playerCount()}` : room.responder === room.seat ? `ถึงตาคุณ · Call ${format(Math.min(maxBet() - room.contributions[room.seat], room.players[room.seat].balance))} หรือ Raise/หมอบ` : room.responder !== null ? `รอ ${room.players[room.responder].name} ตอบเบ็ต` : activeSeats().length === 1 ? 'เหลือผู้เล่นคนเดียว · เสนอผลเพื่อจบตาเล่น' : 'เปิด Bet หรือเสนอผลได้';
  for (let seat = 0; seat < 4; seat++) drawPlayer(seat);
  drawDecision(); drawResultEditor(); drawHistory();
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
  if (type === 'open_win' || type === 'open_tie') return openResult(type === 'open_tie' ? 'tie' : 'win');
  if (type === 'cancel_result') { resultMode = null; drawResultEditor(); return; }
  if (type === 'submit_result') {
    if (resultSelection.some(group => !group.length)) return notify('เลือกผู้รับชิปของทุกกองก่อน', true);
    if (resultMode === 'tie' && !resultSelection.some(group => group.length > 1)) return notify('เลือกผู้เล่นที่เสมออย่างน้อย 2 คน', true);
    type = resultMode === 'tie' ? 'claim_tie' : 'claim';
    value = undefined;
  }
  if (!session || busy || session.pending) return;
  session.pending = { id: crypto.randomUUID(), type, value, ...(type === 'claim' || type === 'claim_tie' ? { winners: resultSelection.map(group => [...group]) } : {}) };
  resultMode = null;
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
