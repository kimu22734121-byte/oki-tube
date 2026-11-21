// アプリ全体の起動・ルーティング・プレーヤー操作UI・表示モード
import * as store from './store.js';
import * as player from './player.js';
import * as views from './views.js';
import { $, $$, fmtTime, icon, thumbUrl } from './util.js';

const MODE_KEY = 'okitube.mode';
const FB_KEY = 'okitube.fbconfig';
const MODES = ['normal', 'watch', 'bgm', 'drive'];

/* ---------- 表示モード ---------- */
function setMode(m) {
  if (!MODES.includes(m)) m = 'normal';
  document.body.dataset.mode = m;
  $$('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  try { localStorage.setItem(MODE_KEY, m); } catch { /* */ }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b && b.tagName === 'BUTTON') setMode(b.dataset.mode);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.dataset.mode !== 'normal' && !document.querySelector('dialog[open]')) setMode('normal');
});

/* ---------- プレーヤー操作ボタン ---------- */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctl]');
  if (!b) return;
  ({ prev: () => player.prev(), next: () => player.next(), toggle: player.toggle, shuffle: player.toggleShuffle, repeat: player.cycleRepeat })[b.dataset.ctl]?.();
});

function renderControls() {
  const s = player.state;
  const cur = s.cur;
  $$('[data-ctl=prev]').forEach((b) => (b.innerHTML = icon('prev')));
  $$('[data-ctl=next]').forEach((b) => (b.innerHTML = icon('next')));
  $$('[data-ctl=toggle]').forEach((b) => { b.innerHTML = icon(s.playing ? 'pause' : 'play'); b.disabled = !cur; });
  $$('[data-ctl=shuffle]').forEach((b) => { b.innerHTML = icon('shuffle'); b.classList.toggle('on', s.shuffle); b.setAttribute('aria-pressed', String(s.shuffle)); b.title = 'シャッフル: ' + (s.shuffle ? 'オン' : 'オフ'); });
  $$('[data-ctl=repeat]').forEach((b) => {
    b.innerHTML = icon(s.repeat === 'one' ? 'repeat1' : 'repeat');
    b.classList.toggle('on', s.repeat !== 'off');
    b.title = 'リピート: ' + { off: 'オフ', all: 'プレイリスト全体', one: '1曲' }[s.repeat];
  });
  const th = $('#dkThumb');
  th.hidden = !cur;
  if (cur) th.src = thumbUrl(cur.videoId);
  $('#dkTitle').textContent = cur ? cur.title : (s.error || '停止中');
  $('#dkChannel').textContent = cur ? cur.channelTitle : '';
  $('#drTitle').textContent = cur ? `${cur.title}${cur.channelTitle ? ' — ' + cur.channelTitle : ''}` : '停止中';
  $('#idle').hidden = !!cur && !s.error;
  $('#idle').textContent = s.error || '再生する動画を選んでください';
  document.title = cur ? `${s.playing ? '▶ ' : ''}${cur.title} - oki-tube` : 'oki-tube';
  views.markPlaying();
}
player.onChange(renderControls);

const seek = $('#seek');
let seeking = false;
seek.addEventListener('input', () => { seeking = true; $('#tCur').textContent = fmtTime(seek.value); });
seek.addEventListener('change', () => { player.seek(Number(seek.value)); seeking = false; });
player.onTime((cur, dur) => {
  if (seeking) return;
  seek.max = Math.floor(dur) || 0; seek.value = Math.floor(cur);
  $('#tCur').textContent = fmtTime(cur); $('#tDur').textContent = fmtTime(dur);
});

/* ---------- 同期状態の表示 ---------- */
function renderSync() {
  const el = $('#sync');
  const s = store.state;
  if (!s.user) { el.textContent = ''; return; }
  let t = '✓ 同期済み', c = '';
  if (!navigator.onLine) { t = 'オフライン'; c = 'warn'; }
  else if (s.error) { t = '同期エラー'; c = 'warn'; }
  else if (s.pending) t = '同期中…';
  else if (!s.ready) t = '読み込み中…';
  else if (s.fromCache) t = '接続中…';
  el.textContent = t; el.className = 'sync ' + c;
}
window.addEventListener('online', renderSync);
window.addEventListener('offline', renderSync);

/* ---------- ルーティング ---------- */
let current = null;
function route() {
  if (!store.state.user || store.state.access === 'denied') return;
  try { current?.destroy?.(); } catch { /* */ }
  // 画面ごとにイベントリスナーを初期化するため、#viewを作り直す
  const old = $('#view');
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(qs || '');
  let tab = 'library';
  try {
    if (parts[0] === 'pl' && parts[1]) current = views.playlist(parts[1]);
    else if (parts[0] === 'add') { tab = 'add'; current = views.add(params); }
    else if (parts[0] === 'ch') { tab = 'ch'; current = parts[1] ? views.channel(parts[1]) : views.channels(); }
    else if (parts[0] === 'settings') { tab = 'settings'; current = views.settings(fbInfo); }
    else current = views.library();
  } catch (e) {
    console.error(e);
    views.message('画面の表示中にエラーが発生しました。', () => location.reload());
    current = null;
  }
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  views.markPlaying();
}
window.addEventListener('hashchange', route);

function onStoreChange() {
  renderSync();
  if (!store.state.user) return;
  try { current?.onData?.(); } catch (e) { console.error(e); }
  const ctx = player.state.ctx;
  if (ctx && ctx.type !== 'preview') {
    const list = store.videosForCtx(ctx);
    if (list) player.syncQueue(list);
  }
}

/* ---------- 起動 ---------- */
let fbInfo = {};
async function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(FB_KEY) || 'null');
    if (stored?.apiKey && stored?.projectId) { fbInfo = { projectId: stored.projectId, local: true }; return stored; }
  } catch { /* */ }
  try {
    const mod = await import('./firebase-config.js');
    const c = mod.default || {};
    if (c.apiKey && c.projectId) { fbInfo = { projectId: c.projectId, local: false }; return c; }
  } catch { /* */ }
  return null;
}

async function boot() {
  setMode((() => { try { return localStorage.getItem(MODE_KEY); } catch { return null; } })());
  renderControls();
  player.init('yt');
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  // 画像が読み込めないときは枠だけ残す
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);

  const cfg = await loadConfig();
  if (!cfg) return views.setup(() => location.reload());
  views.message('読み込み中…');
  try { await store.init(cfg); }
  catch (e) {
    console.error(e);
    return views.message('Firebaseに接続できません。<br>ネットワークを確認して、もう一度お試しください。', () => location.reload());
  }
  store.subscribe(onStoreChange);
  store.onAuth((user) => {
    const denied = user && store.state.access === 'denied';
    document.body.dataset.anon = user && !denied ? '' : '1';
    if (!user) { player.state.cur = null; current = null; views.login(); renderControls(); }
    else if (denied) { current = null; views.denied(user); }
    else route();
    renderSync();
  });
}
boot();
