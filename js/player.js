// YouTube公式 IFrame Player API による連続再生（キュー・シャッフル・リピート）

import { toast, thumbUrl } from './util.js';

export const state = {
  queue: [],      // 再生リスト（動画の配列）
  order: [],      // 再生順（queueのインデックス）
  pos: -1,        // order上の現在位置
  ctx: null,      // どのリストから再生しているか {type, id|key}
  cur: null,      // 現在の動画
  shuffle: false,
  repeat: 'off',  // 'off' | 'all' | 'one'
  playing: false,
  ready: false,
  error: null,
};

const subs = new Set(), tsubs = new Set();
export const onChange = (f) => subs.add(f);
export const onTime = (f) => tsubs.add(f);
const emit = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

let yt = null, elId = null, loading = false, errStreak = 0;

/* ---------- API読み込み ---------- */
function loadApi() {
  return new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { s.remove(); reject(new Error('load')); };
    document.head.appendChild(s);
  });
}

export function init(id) {
  elId = id;
  create();
  window.addEventListener('online', () => { if (!yt && !loading) create(); });
  setInterval(tick, 500);
}

function create() {
  loading = true;
  loadApi().then(() => {
    const vars = { playsinline: 1, rel: 0, modestbranding: 1 };
    if (/^https?:$/.test(location.protocol)) vars.origin = location.origin;
    yt = new window.YT.Player(elId, {
      width: '100%', height: '100%', playerVars: vars,
      events: { onReady, onStateChange, onError },
    });
  }).catch(() => {
    state.error = 'プレーヤーを読み込めません（オフラインの可能性があります）';
    emit();
  }).finally(() => { loading = false; });
}

function onReady() {
  state.ready = true; state.error = null;
  if (state.cur) load();
  emit();
}

function onStateChange(e) {
  const S = window.YT.PlayerState;
  if (e.data === S.ENDED) return ended();
  if (e.data === S.PLAYING) { errStreak = 0; state.playing = true; }
  else if (e.data === S.PAUSED) state.playing = false;
  emit();
}

function onError(e) {
  const code = e.data;
  const msg = code === 101 || code === 150 ? '埋め込み再生が許可されていない動画です'
    : code === 100 ? '動画が見つかりません（削除・非公開の可能性）' : '再生できない動画です';
  toast(`${msg}。次の曲へ進みます`, { error: true });
  errStreak++;
  if (errStreak >= Math.max(1, state.queue.length)) { // 全部だめなら止める
    errStreak = 0; state.playing = false; emit(); return;
  }
  setTimeout(() => next(true), 800);
}

function ended() {
  state.playing = false;
  if (state.repeat === 'one') { yt.seekTo(0, true); yt.playVideo(); return; }
  next(true);
}

function load() {
  if (!state.cur) return;
  if (!yt || !state.ready) return; // onReadyで読み込む
  try { yt.loadVideoById(state.cur.videoId); } catch (e) { console.error(e); }
}

/* ---------- 並び順 ---------- */
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function buildOrder(startIndex) {
  const n = state.queue.length;
  const all = [...Array(n).keys()];
  if (state.shuffle) { state.order = [startIndex, ...shuffled(all.filter((i) => i !== startIndex))]; state.pos = 0; }
  else { state.order = all; state.pos = startIndex; }
}
function setCur() { state.cur = state.queue[state.order[state.pos]] || null; }

/* ---------- 公開API ---------- */
export function play(list, index, ctx) {
  if (!list.length) return;
  state.queue = [...list]; state.ctx = ctx; errStreak = 0;
  buildOrder(Math.min(Math.max(index, 0), list.length - 1));
  setCur(); load(); mediaSession(); emit();
}

export function playShuffled(list, ctx) {
  if (!list.length) return;
  state.shuffle = true;
  play(list, Math.floor(Math.random() * list.length), ctx);
}

export function toggle() {
  if (!state.cur || !yt || !state.ready) return;
  const S = window.YT.PlayerState;
  if (yt.getPlayerState() === S.PLAYING) yt.pauseVideo(); else yt.playVideo();
}

export function next(auto = false) {
  const n = state.order.length;
  if (!n) return;
  let p = state.pos + 1;
  if (p >= n) {
    if (auto && state.repeat === 'off') { state.playing = false; emit(); return; } // 最後まで再生したら停止
    const cur = state.order[state.pos];
    if (state.shuffle) {
      let o = shuffled([...Array(n).keys()]);
      if (n > 1 && o[0] === cur) [o[0], o[1]] = [o[1], o[0]];
      state.order = o;
    }
    p = 0;
  }
  state.pos = p; setCur(); load(); mediaSession(); emit();
}

export function prev() {
  if (!state.order.length) return;
  if (yt && state.ready && yt.getCurrentTime() > 3) { yt.seekTo(0, true); return; }
  let p = state.pos - 1;
  if (p < 0) p = state.repeat === 'off' ? 0 : state.order.length - 1;
  state.pos = p; setCur(); load(); mediaSession(); emit();
}

export function seek(sec) { if (yt && state.ready && state.cur) yt.seekTo(sec, true); }

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.queue.length && state.pos >= 0) buildOrder(state.order[state.pos]);
  emit();
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  emit();
}

// 再生元のリストが編集されたとき、再生中の曲を保ったままキューを更新する
export function syncQueue(list) {
  if (!state.cur || !state.ctx) return;
  if (list.length === state.queue.length && list.every((v, i) => v.uid === state.queue[i].uid)) return;
  const idxOf = new Map(list.map((v, i) => [v.uid, i]));
  const oldUids = state.order.map((i) => state.queue[i]?.uid);
  const curIdx = idxOf.get(state.cur.uid);
  const oldIdx = state.order[state.pos] ?? 0;
  const oldPos = state.pos;
  state.queue = list;
  if (!list.length) { state.order = []; state.pos = -1; emit(); return; }
  if (!state.shuffle) {
    state.order = [...list.keys()];
    state.pos = curIdx !== undefined ? curIdx : Math.min(oldIdx, list.length) - 1;
  } else {
    const kept = oldUids.filter((u) => idxOf.has(u)).map((u) => idxOf.get(u));
    const seen = new Set(kept);
    const added = shuffled([...list.keys()].filter((i) => !seen.has(i)));
    state.order = kept.concat(added);
    state.pos = curIdx !== undefined
      ? state.order.indexOf(curIdx)
      : oldUids.slice(0, oldPos).filter((u) => idxOf.has(u)).length - 1;
  }
  emit();
}

/* ---------- 時間表示 ---------- */
function tick() {
  if (!yt || !state.ready || !state.cur || typeof yt.getCurrentTime !== 'function') return;
  const cur = yt.getCurrentTime(), dur = yt.getDuration();
  tsubs.forEach((f) => f(cur || 0, dur || 0));
}

/* ---------- メディアセッション（ロック画面等の標準の操作表示。再生の仕組み自体は変えません） ---------- */
let msInit = false;
function mediaSession() {
  if (!('mediaSession' in navigator) || !state.cur) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: state.cur.title, artist: state.cur.channelTitle,
      artwork: [{ src: thumbUrl(state.cur.videoId), sizes: '320x180', type: 'image/jpeg' }],
    });
    if (!msInit) {
      msInit = true;
      const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* 未対応 */ } };
      set('play', () => toggle()); set('pause', () => toggle());
      set('previoustrack', () => prev()); set('nexttrack', () => next());
    }
  } catch { /* ignore */ }
}
