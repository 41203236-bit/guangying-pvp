import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getDatabase, ref, set, update, onValue, get } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const bridge = window.__gameBridge;
if (!bridge) throw new Error('找不到 __gameBridge，請確認 game.html 已加入橋接物件。');

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let onlineMode = false;
let suppressSync = false;
let myPlayer = null;
let roomId = null;
let hostTimer = null;
let roomUnsubStarted = false;

function syncPerspective() {
  if (bridge?.setPerspective) bridge.setPerspective(myPlayer, onlineMode);
}

function ensureRoomBar() {
  if (document.getElementById('online-room-bar')) return;
  const wrap = document.createElement('div');
  wrap.id = 'online-room-bar';
  wrap.innerHTML = `
    <strong>連線</strong>
    <input id="room-input" placeholder="房號" maxlength="20" />
    <select id="player-select">
      <option value="O">光 / O</option>
      <option value="X">影 / X</option>
    </select>
    <button id="btn-create-room">建立房間</button>
    <button id="btn-join-room">加入房間</button>
    <button id="btn-copy-room">複製房號</button>
    <span id="online-room-status">未連線，照常是本地模式。</span>
  `;
  document.body.appendChild(wrap);
  document.getElementById('btn-create-room').onclick = createRoom;
  document.getElementById('btn-join-room').onclick = joinRoom;
  document.getElementById('btn-copy-room').onclick = async () => {
    const input = document.getElementById('room-input');
    if (!input.value) return;
    try { await navigator.clipboard.writeText(input.value); setStatus('房號已複製。'); }
    catch { setStatus('無法複製房號，請手動複製。'); }
  };
}

function setStatus(msg) {
  const el = document.getElementById('online-room-status');
  if (el) el.textContent = msg;
}

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function createRoom() {
  myPlayer = document.getElementById('player-select').value;
  roomId = document.getElementById('room-input').value.trim().toUpperCase() || randomRoomId();
  document.getElementById('room-input').value = roomId;
  const initialState = bridge.getState();
  const payload = {
    status: 'waiting',
    createdAt: Date.now(),
    host: myPlayer,
    players: { O: myPlayer === 'O', X: myPlayer === 'X' },
    state: initialState,
    lastActionBy: null
  };
  await set(ref(db, `rooms/${roomId}`), payload);
  onlineMode = true;
  syncPerspective();
  bindRoomListener();
  setStatus(`房間 ${roomId} 已建立，等待另一位玩家加入。你是 ${myPlayer}。`);
}

async function joinRoom() {
  roomId = document.getElementById('room-input').value.trim().toUpperCase();
  myPlayer = document.getElementById('player-select').value;
  if (!roomId) { setStatus('請先輸入房號。'); return; }
  const roomRef = ref(db, `rooms/${roomId}`);
  const snap = await get(roomRef);
  if (!snap.exists()) { setStatus('找不到這個房間。'); return; }
  const room = snap.val();
  if (room.players?.[myPlayer]) { setStatus(`這個身分 ${myPlayer} 已有人使用。請換另一邊。`); return; }
  await update(roomRef, {
    [`players/${myPlayer}`]: true,
    status: 'playing'
  });
  onlineMode = true;
  syncPerspective();
  bindRoomListener();
  setStatus(`已加入房間 ${roomId}，你是 ${myPlayer}。`);
}

function bindRoomListener() {
  if (roomUnsubStarted) return;
  roomUnsubStarted = true;
  onValue(ref(db, `rooms/${roomId}`), (snapshot) => {
    const room = snapshot.val();
    if (!room) {
      setStatus('房間不存在或已被刪除。');
      return;
    }
    if (room.state) {
      suppressSync = true;
      bridge.stopTimer();
      bridge.applyState(room.state, { skipTimer: true });
      suppressSync = false;
      syncPerspective();
    }
    if (room.status === 'waiting') {
      setStatus(`房間 ${roomId} 等待第二位玩家加入。你是 ${myPlayer}。`);
    } else {
      setStatus(`房間 ${roomId} 已連線。你是 ${myPlayer}，目前輪到 ${room.state?.turn || '-'}。`);
      runHostTimer(room);
    }
  });
}

function runHostTimer(room) {
  const amHost = room.host === myPlayer;
  if (!amHost) return;
  clearInterval(hostTimer);
  hostTimer = setInterval(async () => {
    if (!onlineMode || suppressSync) return;
    const state = bridge.getState();
    if (state.gameOver) return;
    state.timeLeft = Math.max(0, (state.timeLeft ?? 0) - 1);
    if (state.timeLeft <= 0) {
      state.timeLeft = 30;
      state.data[state.turn].skillUsed = 0;
      state.data[state.turn].defending = false;
      state.turn = state.turn === 'O' ? 'X' : 'O';
      if (state.data[state.turn].stunned) {
        state.data[state.turn].stunned = false;
        state.data[state.turn].skillUsed = 0;
        state.data[state.turn].defending = false;
        state.turn = state.turn === 'O' ? 'X' : 'O';
      }
    }
    await updateRoomState(state, 'timer');
  }, 1000);
}

async function updateRoomState(state, by = 'action') {
  if (!onlineMode || !roomId) return;
  await update(ref(db, `rooms/${roomId}`), {
    state,
    lastActionBy: by,
    updatedAt: Date.now()
  });
}

const originalTap = bridge.tap.bind(bridge);
const originalUseSkill = bridge.useSkill.bind(bridge);

window.tap = async function patchedTap(index) {
  if (!onlineMode) return originalTap(index);
  const state = bridge.getState();
  if (state.turn !== myPlayer) { setStatus('還沒輪到你。'); return; }
  originalTap(index);
  await updateRoomState(bridge.getState(), 'tap');
};

window.useSkill = async function patchedUseSkill(type) {
  if (!onlineMode) return originalUseSkill(type);
  const state = bridge.getState();
  if (state.turn !== myPlayer) { setStatus('還沒輪到你。'); return; }
  originalUseSkill(type);
  await updateRoomState(bridge.getState(), `skill:${type}`);
};

ensureRoomBar();
bridge.stopTimer();
syncPerspective();
setStatus('Firebase 已載入，尚未加入房間。請選擇身分後建立房間，或輸入房號加入房間。');