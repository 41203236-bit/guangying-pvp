import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import { getDatabase, ref, set, update, onValue, get } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const bridge = window.__gameBridge;
if (!bridge) throw new Error("找不到 __gameBridge，請確認 game.html 已加入橋接物件。");

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let onlineMode = false;
let suppressSync = false;
let myPlayer = null;
let roomId = null;
let hostTimer = null;
let roomUnsubStarted = false;
let currentRoom = null;
let matchStarted = false;

function normalizePlayers(players = {}) {
  const norm = {};
  for (const role of ["O", "X"]) {
    const raw = players[role];
    if (typeof raw === 'boolean') {
      norm[role] = { joined: raw, ready: false };
    } else {
      norm[role] = { joined: !!raw?.joined, ready: !!raw?.ready };
    }
  }
  return norm;
}

function syncPerspective() {
  if (bridge?.setPerspective) bridge.setPerspective(myPlayer, onlineMode && matchStarted);
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
    <button id="btn-ready" disabled>準備</button>
    <button id="btn-copy-room">複製房號</button>
    <span id="online-room-status">Firebase 已載入，尚未加入房間。請選擇身分後建立房間，或輸入房號加入房間。</span>
  `;
  document.body.appendChild(wrap);

  const overlay = document.createElement('div');
  overlay.id = 'ready-overlay';
  overlay.innerHTML = `
    <div class="ready-panel">
      <div class="ready-title">房間等待區</div>
      <div class="ready-room">房號：<span id="ready-room-id">-</span></div>
      <div class="ready-role">你的身份：<span id="ready-role">-</span></div>
      <div class="ready-status-grid">
        <div>光 / O：<span id="ready-status-O">未加入</span></div>
        <div>影 / X：<span id="ready-status-X">未加入</span></div>
      </div>
      <div class="ready-help" id="ready-help">等待雙方加入並按下準備</div>
      <div class="ready-actions">
        <button id="btn-ready-overlay" disabled>準備</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('btn-create-room').onclick = createRoom;
  document.getElementById('btn-join-room').onclick = joinRoom;
  document.getElementById('btn-ready').onclick = toggleReady;
  document.getElementById('btn-ready-overlay').onclick = toggleReady;
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

function setReadyOverlay(show) {
  const overlay = document.getElementById('ready-overlay');
  if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

function setReadyButtons(enabled, text='準備') {
  for (const id of ['btn-ready','btn-ready-overlay']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = !enabled;
    btn.textContent = text;
  }
}

function updateWaitingUI(room) {
  const players = normalizePlayers(room?.players);
  const readyO = players.O.joined ? (players.O.ready ? '已準備' : '未準備') : '未加入';
  const readyX = players.X.joined ? (players.X.ready ? '已準備' : '未準備') : '未加入';
  document.getElementById('ready-room-id').textContent = roomId || '-';
  document.getElementById('ready-role').textContent = myPlayer ? (myPlayer === 'O' ? '光 / O' : '影 / X') : '-';
  document.getElementById('ready-status-O').textContent = readyO;
  document.getElementById('ready-status-X').textContent = readyX;

  const meReady = myPlayer ? players[myPlayer]?.ready : false;
  const bothJoined = players.O.joined && players.X.joined;
  const bothReady = players.O.ready && players.X.ready;
  let help = '等待雙方加入並按下準備';
  if (!bothJoined) help = '等待另一位玩家加入房間';
  else if (!meReady) help = '雙方已入房，請按下準備';
  else if (!bothReady) help = '你已準備，等待對手準備';
  else help = '雙方已準備，正在開始對戰…';
  document.getElementById('ready-help').textContent = help;
  setReadyButtons(!!myPlayer && room?.status !== 'playing', meReady ? '取消準備' : '準備');
  setReadyOverlay(room?.status !== 'playing');
}

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function freshInitialState(role) {
  const state = bridge.getState();
  state.turn = role;
  state.timeLeft = 30;
  state.grid = Array(9).fill(null);
  state.queues = { O: [], X: [] };
  state.data.O.skillUsed = 0;
  state.data.X.skillUsed = 0;
  state.data.O.defending = false;
  state.data.X.defending = false;
  state.data.O.stunned = false;
  state.data.X.stunned = false;
  return state;
}

async function createRoom() {
  myPlayer = document.getElementById('player-select').value;
  roomId = document.getElementById('room-input').value.trim().toUpperCase() || randomRoomId();
  document.getElementById('room-input').value = roomId;
  const payload = {
    status: 'waiting',
    createdAt: Date.now(),
    host: myPlayer,
    players: {
      O: { joined: myPlayer === 'O', ready: false },
      X: { joined: myPlayer === 'X', ready: false }
    },
    state: freshInitialState(myPlayer),
    lastActionBy: null
  };
  await set(ref(db, `rooms/${roomId}`), payload);
  onlineMode = true;
  matchStarted = false;
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
  const players = normalizePlayers(room.players);
  if (players[myPlayer]?.joined) { setStatus(`這個身分 ${myPlayer} 已有人使用。請換另一邊。`); return; }
  await update(roomRef, {
    [`players/${myPlayer}`]: { joined: true, ready: false },
    status: room.status === 'playing' ? 'playing' : 'waiting'
  });
  onlineMode = true;
  matchStarted = room.status === 'playing';
  syncPerspective();
  bindRoomListener();
  setStatus(`已加入房間 ${roomId}，你是 ${myPlayer}。請按準備。`);
}

async function toggleReady() {
  if (!onlineMode || !roomId || !myPlayer || !currentRoom) return;
  const players = normalizePlayers(currentRoom.players);
  const me = players[myPlayer];
  const nextReady = !me.ready;
  const roomRef = ref(db, `rooms/${roomId}`);
  const patch = {
    [`players/${myPlayer}/ready`]: nextReady,
    status: 'waiting'
  };
  await update(roomRef, patch);
}

async function maybeStartMatch(room) {
  const players = normalizePlayers(room.players);
  if (!(players.O.joined && players.X.joined && players.O.ready && players.X.ready)) return;
  if (room.status === 'playing') return;
  const initialState = freshInitialState(room.host || 'O');
  await update(ref(db, `rooms/${roomId}`), {
    status: 'playing',
    state: initialState,
    startedAt: Date.now(),
    lastActionBy: 'system:start'
  });
}

function bindRoomListener() {
  if (roomUnsubStarted) return;
  roomUnsubStarted = true;
  onValue(ref(db, `rooms/${roomId}`), async (snapshot) => {
    const room = snapshot.val();
    currentRoom = room;
    if (!room) {
      setStatus('房間不存在或已被刪除。');
      setReadyOverlay(false);
      return;
    }
    if (room.state) {
      suppressSync = true;
      bridge.stopTimer();
      bridge.applyState(room.state, { skipTimer: true });
      suppressSync = false;
    }

    updateWaitingUI(room);

    if (room.status === 'waiting') {
      matchStarted = false;
      syncPerspective();
      const players = normalizePlayers(room.players);
      if (players.O.joined && players.X.joined && room.host === myPlayer) {
        await maybeStartMatch(room);
      }
      if (!(players.O.joined && players.X.joined)) {
        setStatus(`房間 ${roomId} 等待另一位玩家加入。你是 ${myPlayer}。`);
      } else {
        setStatus(`房間 ${roomId} 已集結，請雙方按準備。你是 ${myPlayer}。`);
      }
      clearInterval(hostTimer);
      return;
    }

    matchStarted = true;
    syncPerspective();
    setStatus(`房間 ${roomId} 已開始。你是 ${myPlayer}，目前輪到 ${room.state?.turn || '-'}。`);
    runHostTimer(room);
  });
}

function runHostTimer(room) {
  const amHost = room.host === myPlayer;
  if (!amHost) return;
  clearInterval(hostTimer);
  hostTimer = setInterval(async () => {
    if (!onlineMode || suppressSync || !matchStarted) return;
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
  if (!matchStarted) { setStatus('雙方都準備好後才會開始。'); return; }
  const state = bridge.getState();
  if (state.turn !== myPlayer) { setStatus('還沒輪到你。'); return; }
  originalTap(index);
  await updateRoomState(bridge.getState(), 'tap');
};

window.useSkill = async function patchedUseSkill(type) {
  if (!onlineMode) return originalUseSkill(type);
  if (!matchStarted) { setStatus('雙方都準備好後才會開始。'); return; }
  const state = bridge.getState();
  if (state.turn !== myPlayer) { setStatus('還沒輪到你。'); return; }
  originalUseSkill(type);
  await updateRoomState(bridge.getState(), `skill:${type}`);
};

ensureRoomBar();
bridge.stopTimer();
syncPerspective();
setReadyOverlay(false);
setStatus('Firebase 已載入，尚未加入房間。請選擇身分後建立房間，或輸入房號加入房間。');
