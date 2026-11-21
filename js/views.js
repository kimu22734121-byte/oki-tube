// 各画面の描画
import * as store from './store.js';
import * as player from './player.js';
import * as yt from './yt.js';
import { $, $$, esc, thumbUrl, toast, icon, modal, promptText, confirmDialog } from './util.js';

const root = () => document.getElementById('view');
const KEY = 'okitube.apiKey';
export const getApiKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setApiKey = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { toast('この環境ではブラウザに保存できません', { error: true }); } };

/* 再生中の行に印を付ける */
export function markPlaying() {
  const cur = player.state.cur;
  document.body.dataset.playing = player.state.playing ? '1' : '';
  $$('#view [data-uid]').forEach((el) => {
    const id = el.dataset.uid;
    el.classList.toggle('playing', !!cur && (id === cur.uid || id === 'v:' + cur.videoId));
  });
}

const cover = (videos, cls = '') =>
  `<span class="cover ${cls}">${videos.length ? `<img src="${thumbUrl(videos[0].videoId)}" alt="" loading="lazy">` : '<span class="ph">♪</span>'}</span>`;

// プレイリストのカバー: 1本=大きく / 2本=左右 / 3本=左1+右2 / 4本以上=2x2（4本以上ならランダムに4本）
const picks = new Map(); // プレイリストID -> {sig, list}（読み込み中は同じ顔ぶれを保つ）
function mosaic(pl, cls = '') {
  const vids = pl.videos;
  if (!vids.length) return cover([], cls);
  let list = vids.slice(0, 3);
  if (vids.length >= 4) {
    const sig = vids.map((v) => v.uid).join();
    let c = picks.get(pl.id);
    if (!c || c.sig !== sig) {
      const a = [...vids];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      c = { sig, list: a.slice(0, 4) }; picks.set(pl.id, c);
    }
    list = c.list;
  }
  const n = Math.min(list.length, 4);
  return `<span class="cover mosaic m${n} ${cls}">${list.map((v) => `<img src="${thumbUrl(v.videoId)}" alt="" loading="lazy">`).join('')}</span>`;
}

function rowHtml(v, o = {}) {
  return `<li class="row" data-uid="${esc(v.uid)}">
    ${o.edit ? `<span class="handle" title="ドラッグで並べ替え">${icon('drag')}</span>` : ''}
    <button class="row-main" data-act="play">
      <span class="thumb"><img src="${thumbUrl(v.videoId)}" alt="" loading="lazy"><i class="eq"><b></b><b></b><b></b></i></span>
      <span class="meta"><span class="t">${esc(v.title)}</span><span class="c">${esc(v.channelTitle)}</span></span>
    </button>
    ${o.edit ? `<button class="icon-btn danger" data-act="del" aria-label="削除">${icon('trash')}</button>` : ''}
    ${o.add ? `<button class="icon-btn ${o.added ? 'done' : ''}" data-act="add" aria-label="プレイリストに追加">${icon(o.added ? 'check' : 'plus')}</button>` : ''}
  </li>`;
}

/* ---------- 共通操作 ---------- */
async function renamePl(pl) {
  const name = await promptText({ title: 'プレイリスト名を変更', value: pl.name, ok: '変更' });
  if (name && name !== pl.name) store.renamePlaylist(pl.id, name);
}
async function deletePl(pl, goHome) {
  if (!(await confirmDialog(`「${pl.name}」を削除しますか？ 中の動画の登録も消えます。`))) return;
  store.deletePlaylist(pl.id);
  if (goHome) location.hash = '#/';
  toast('削除しました');
}
const playPl = (pl, shuffle) => {
  if (!pl.videos.length) return toast('動画がありません');
  const ctx = { type: 'playlist', id: pl.id };
  shuffle ? player.playShuffled(pl.videos, ctx) : (player.state.shuffle = false, player.play(pl.videos, 0, ctx));
};
const roleLabel = (r) => (r === 'edit' ? '編集もできる' : '見るだけ');
const isOwner = (pl) => pl.role === 'owner';

function plMenu(pl, goHome) {
  const owner = isOwner(pl), edit = store.canEdit(pl);
  return modal(
    `<h3>${esc(pl.name)}</h3>
     <button class="menu-btn" data-a="play">▶ 再生</button>
     <button class="menu-btn" data-a="shuffle">🔀 シャッフル再生</button>
     ${edit ? '<button class="menu-btn" data-a="add">＋ 動画を追加</button>' : ''}
     ${owner ? '<button class="menu-btn" data-a="share">👥 共有…</button><button class="menu-btn" data-a="rename">✎ 名前を変更</button><button class="menu-btn danger" data-a="delete">🗑 削除</button>'
       : '<button class="menu-btn danger" data-a="leave">共有を解除（自分の一覧から外す）</button>'}`,
    (d, done) => $$('[data-a]', d).forEach((b) => (b.onclick = () => done(b.dataset.a))))
    .then((a) => {
      if (a === 'play') playPl(pl, false);
      else if (a === 'shuffle') playPl(pl, true);
      else if (a === 'add') location.hash = `#/add?pl=${pl.id}`;
      else if (a === 'share') sharePl(pl.id);
      else if (a === 'rename') renamePl(pl);
      else if (a === 'delete') deletePl(pl, goHome);
      else if (a === 'leave') leavePl(pl, goHome);
    });
}

async function leavePl(pl, goHome) {
  if (!(await confirmDialog(`「${pl.name}」の共有を解除しますか？（自分の一覧から消えます。持ち主のデータは消えません）`, '解除'))) return;
  store.leaveShared(pl.id);
  if (goHome) location.hash = '#/';
}

// 共有の設定ダイアログ（持ち主だけ）。開いている間は最新の状態に更新される。
function sharePl(id) {
  const get = () => store.state.playlists.find((p) => p.id === id);
  if (!get()) return;
  const d = document.createElement('dialog');
  d.className = 'dlg';
  document.body.appendChild(d);
  const draw = () => {
    const pl = get();
    if (!pl) { d.close(); return; }
    const rows = [...pl.editorEmails.map((e) => [e, 'edit']), ...pl.viewerEmails.map((e) => [e, 'view'])];
    d.innerHTML = `<div class="dlg-body"><h3>「${esc(pl.name)}」を共有</h3>
      <p class="muted small">共有した相手だけがこのプレイリストを見られます。相手はこのアプリに、そのメールアドレスのGoogleアカウントでログインしてください。共有していないプレイリストは相手に一切見えません。</p>
      <div class="members">${rows.length ? rows.map(([e, r]) => `<div class="member"><div><div class="m-email">${esc(e)}</div><div class="muted small">${roleLabel(r)}</div></div><button class="btn danger" data-unshare="${esc(e)}">解除</button></div>`).join('') : '<p class="muted small">まだ誰にも共有していません。</p>'}</div>
      <form class="stack"><label class="lbl">共有する相手のGoogleメールアドレス</label>
        <input class="inp" type="email" inputmode="email" autocapitalize="off" autocomplete="off" placeholder="example@gmail.com" required>
        <select class="inp"><option value="view">見るだけ（再生のみ）</option><option value="edit">編集もできる（追加・削除・並べ替え）</option></select>
        <div class="dlg-actions"><button type="button" class="btn" data-close>閉じる</button><button class="btn primary">共有する</button></div></form></div>`;
  };
  d.addEventListener('click', async (e) => {
    if (e.target === d || e.target.closest('[data-close]')) return d.close();
    const u = e.target.closest('[data-unshare]');
    if (u) { await store.unshare(id, u.dataset.unshare); toast('共有を解除しました'); }
  });
  d.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await store.shareWith(id, f.querySelector('input').value, f.querySelector('select').value);
      toast('共有しました'); f.querySelector('input').value = '';
    } catch (err) { toast(err.message, { error: true }); }
  });
  const stop = store.subscribe(() => {
    if (!d.open) return;
    const keep = d.querySelector('input')?.value;
    draw();
    if (keep) d.querySelector('input').value = keep;
  });
  d.addEventListener('close', () => { stop(); d.remove(); });
  draw();
  d.showModal();
}

// 既存のプレイリストを選ぶ／その場で新規作成して選ぶ
function choosePlaylist() {
  const pls = store.state.playlists.filter(store.canEdit);
  return modal(
    `<h3>プレイリストに追加</h3>
     <div class="pick">${pls.map((p) => `<button class="menu-btn" data-id="${p.id}">${esc(p.name)} <small class="muted">${p.videos.length}本</small></button>`).join('')}</div>
     <form class="stack"><label class="lbl">＋ 新しいプレイリストを作って追加</label>
     <div class="inline"><input class="inp" maxlength="100" placeholder="新しいプレイリスト名"><button class="btn primary">作成</button></div></form>
     <div class="dlg-actions"><button class="btn" data-a="cancel">キャンセル</button></div>`,
    (d, done) => {
      $$('[data-id]', d).forEach((b) => (b.onclick = () => done({ id: b.dataset.id })));
      $('form', d).addEventListener('submit', (e) => { e.preventDefault(); const v = $('input', d).value.trim(); if (v) done({ newName: v }); });
      $('[data-a=cancel]', d).onclick = () => done(null);
    });
}
async function addToPlaylist(v) {
  const r = await choosePlaylist();
  if (!r) return;
  if (r.newName) { store.createPlaylist(r.newName, [v]); return toast(`「${r.newName}」を作成して追加しました`); }
  const pl = store.state.playlists.find((p) => p.id === r.id);
  if (!pl || !store.canEdit(pl)) return;
  if (pl.videos.some((x) => x.videoId === v.videoId)) return toast('すでに入っています');
  if (store.addVideos(pl.id, [v]).length) toast(`「${pl.name}」に追加しました`);
}

/* ---------- ドラッグで並べ替え ---------- */
function enableDrag(ul, commit) {
  ul.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle) return;
    e.preventDefault();
    const row = handle.closest('li');
    const scroller = root();
    const startY = e.clientY, startScroll = scroller.scrollTop;
    const rows = [...ul.children];
    const mids = rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 + scroller.scrollTop; });
    const from = rows.indexOf(row);
    let to = from;
    row.classList.add('dragging');
    const move = (ev) => {
      const sr = scroller.getBoundingClientRect();
      if (ev.clientY < sr.top + 50) scroller.scrollTop -= 12;
      else if (ev.clientY > sr.bottom - 50) scroller.scrollTop += 12;
      const dy = ev.clientY - startY + (scroller.scrollTop - startScroll);
      row.style.transform = `translateY(${dy}px)`;
      const y = ev.clientY + scroller.scrollTop;
      // 「ポインタより上にある（自分以外の）行の数」が挿入位置
      const above = rows.filter((r, i) => i !== from && y > mids[i]).length;
      to = above;
      rows.forEach((r) => r.classList.remove('drop-before', 'drop-end'));
      const others = rows.filter((r) => r !== row);
      if (to >= others.length) others[others.length - 1]?.classList.add('drop-end');
      else others[to].classList.add('drop-before');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      row.classList.remove('dragging'); row.style.transform = '';
      rows.forEach((r) => r.classList.remove('drop-before', 'drop-end'));
      if (to !== from) {
        const uids = rows.map((r) => r.dataset.uid);
        const [m] = uids.splice(from, 1);
        uids.splice(to, 0, m);
        commit(uids);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/* ---------- ライブラリ（プレイリスト一覧） ---------- */
let libView = (() => { try { return localStorage.getItem('okitube.libView') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
export function library() {
  const el = root();
  function draw() {
    const own = store.state.playlists.filter(isOwner), shared = store.state.playlists.filter((p) => !isOwner(p));
    const nShared = (p) => p.viewerEmails.length + p.editorEmails.length;
    const card = (p) => `<div class="card" data-id="${p.id}">
          <button class="card-open" data-act="open">${mosaic(p)}<span class="cn">${esc(p.name)}</span><span class="cs">${p.videos.length}本の動画${isOwner(p) ? (nShared(p) ? ` · 👥${nShared(p)}人に共有中` : '') : ` · 共有（${roleLabel(p.role)}）`}</span></button>
          <button class="card-more" data-act="more" aria-label="メニュー">${icon('more')}</button></div>`;
    el.innerHTML = `<div class="page"><div class="lib-head"><h1>ライブラリ</h1>
        <div class="seg view-toggle" role="group" aria-label="表示形式">
          <button data-act="view-grid" aria-pressed="${libView === 'grid'}" title="タイル表示">▦</button>
          <button data-act="view-list" aria-pressed="${libView === 'list'}" title="リスト表示">☰</button>
        </div></div>
      <div class="grid ${libView === 'list' ? 'as-list' : ''}">
        ${own.map(card).join('')}
        <button class="card" data-act="new"><span class="cover newc"><span class="plus">＋</span></span><span class="cn">新規作成</span><span class="cs">&nbsp;</span></button>
      </div>
      ${shared.length ? `<h2 class="sec">共有されたプレイリスト</h2><div class="grid ${libView === 'list' ? 'as-list' : ''}">${shared.map(card).join('')}</div>` : ''}
      ${!store.state.ready ? '<p class="muted center">読み込み中…</p>' : ''}
      ${store.state.error ? `<p class="notice err">${store.state.error === 'permission-denied' ? 'データを読み込めません（権限エラー）。FirestoreのセキュリティルールをREADMEの通りに設定してください。' : '同期エラー: ' + esc(store.state.error)}</p>` : ''}
    </div>`;
    markPlaying();
  }
  el.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('[data-id]');
    const pl = card && store.state.playlists.find((p) => p.id === card.dataset.id);
    if (b.dataset.act === 'view-grid' || b.dataset.act === 'view-list') {
      libView = b.dataset.act === 'view-list' ? 'list' : 'grid';
      try { localStorage.setItem('okitube.libView', libView); } catch { /* */ }
      draw();
    } else if (b.dataset.act === 'new') {
      const name = await promptText({ title: '新規プレイリスト', placeholder: 'プレイリスト名', ok: '作成' });
      if (name) location.hash = `#/pl/${store.createPlaylist(name)}`;
    } else if (b.dataset.act === 'open' && pl) location.hash = `#/pl/${pl.id}`;
    else if (b.dataset.act === 'more' && pl) plMenu(pl, false);
  };
  draw();
  return { onData: draw };
}

/* ---------- プレイリスト詳細 ---------- */
export function playlist(id) {
  const el = root();
  let editing = false;
  const get = () => store.state.playlists.find((p) => p.id === id);
  function draw() {
    const pl = get();
    if (!pl) {
      el.innerHTML = `<div class="page"><a class="back" href="#/">‹ ライブラリ</a><p class="muted">${store.state.ready ? 'このプレイリストは見つかりません。' : '読み込み中…'}</p></div>`;
      return;
    }
    el.innerHTML = `<div class="page"><a class="back" href="#/">‹ ライブラリ</a>
      <div class="pl-head">${mosaic(pl, 'big')}<div class="pl-info"><h1>${esc(pl.name)}</h1><p class="muted">${pl.videos.length}本の動画${isOwner(pl) ? (pl.viewerEmails.length + pl.editorEmails.length ? ` · 👥${pl.viewerEmails.length + pl.editorEmails.length}人に共有中` : '') : ` · 共有（${roleLabel(pl.role)}）${pl.ownerEmail ? ' · 持ち主: ' + esc(pl.ownerEmail) : ''}`}</p></div></div>
      <div class="actions">
        <button class="btn primary" data-act="playall">▶ 再生</button>
        <button class="btn" data-act="shuffle">🔀 シャッフル</button>
        ${store.canEdit(pl) ? `<button class="btn" data-act="addvid">＋ 動画を追加</button>
        <button class="btn ${editing ? 'on' : ''}" data-act="edit">${editing ? '✓ 完了' : '並べ替え・削除'}</button>` : ''}
        ${isOwner(pl) ? '<button class="btn" data-act="share">👥 共有</button>' : ''}
        <button class="icon-btn" data-act="menu" aria-label="その他">${icon('more')}</button>
      </div>
      ${pl.videos.length
        ? `<ul class="list ${editing ? 'editing' : ''}" id="vlist">${pl.videos.map((v) => rowHtml(v, { edit: editing && store.canEdit(pl) })).join('')}</ul>`
        : `<div class="empty">まだ動画がありません。${store.canEdit(pl) ? '<br>「＋ 動画を追加」から、YouTube検索またはURLで追加できます。' : ''}</div>`}
    </div>`;
    if (editing && store.canEdit(pl)) {
      const ul = $('#vlist', el);
      if (ul) enableDrag(ul, (uids) => {
        const by = new Map(pl.videos.map((v) => [v.uid, v]));
        store.setVideos(pl.id, uids.map((u) => by.get(u)).filter(Boolean));
      });
    }
    markPlaying();
  }
  el.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    const pl = get();
    if (!b || !pl) return;
    const act = b.dataset.act;
    if (act === 'playall') playPl(pl, false);
    else if (act === 'shuffle') playPl(pl, true);
    else if (act === 'addvid' && store.canEdit(pl)) location.hash = `#/add?pl=${pl.id}`;
    else if (act === 'edit' && store.canEdit(pl)) { editing = !editing; draw(); }
    else if (act === 'share' && isOwner(pl)) sharePl(pl.id);
    else if (act === 'menu') plMenu(pl, true);
    else if (act === 'play') {
      const li = b.closest('li');
      const idx = pl.videos.findIndex((v) => v.uid === li.dataset.uid);
      if (idx >= 0) player.play(pl.videos, idx, { type: 'playlist', id: pl.id });
    } else if (act === 'del' && store.canEdit(pl)) {
      const li = b.closest('li');
      const before = pl.videos;
      const v = before.find((x) => x.uid === li.dataset.uid);
      store.setVideos(pl.id, before.filter((x) => x.uid !== li.dataset.uid));
      toast(`「${v?.title ?? '動画'}」を削除しました`, { action: '元に戻す', onAction: () => store.setVideos(pl.id, before) });
    }
  };
  draw();
  return { onData: draw };
}

/* ---------- 動画の追加（検索 / URL） ---------- */
export function add(params) {
  const el = root();
  let target = params.get('pl') || '';
  let created = null; // 直前にこの画面で作った（まだ一覧に反映されていない）プレイリスト
  let tab = 'search', results = [], next = '', lastQ = '', busy = false;
  const added = new Set();

  el.innerHTML = `<div class="page"><h1>動画を追加</h1>
    <div class="target"><label class="lbl" for="tgt">追加先のプレイリスト</label>
      <select id="tgt" class="inp"></select>
      <input id="newName" class="inp" maxlength="100" placeholder="新しいプレイリスト名" hidden></div>
    <div class="tabs2"><button data-tab="search">YouTubeで検索</button><button data-tab="url">URLを貼り付け</button></div>
    <section id="pSearch">
      <form id="sf" class="inline"><input id="q" class="inp" type="search" placeholder="曲名・アーティスト名・キーワード" enterkeyhint="search"><button class="btn primary">検索</button></form>
      <div id="hint"></div><ul id="res" class="list"></ul><div class="center"><button id="more" class="btn" hidden>もっと見る</button></div>
    </section>
    <section id="pUrl" hidden>
      <textarea id="urls" class="inp" rows="4" placeholder="https://www.youtube.com/watch?v=…&#10;https://youtu.be/…（複数の場合は改行で区切る）"></textarea>
      <div class="actions"><button id="urlAdd" class="btn primary">追加する</button></div>
      <p id="urlMsg" class="muted"></p>
    </section></div>`;
  const tgt = $('#tgt', el), newName = $('#newName', el), res = $('#res', el);

  const inTarget = (videoId) => added.has(`${target}:${videoId}`) || !!store.state.playlists.find((p) => p.id === target)?.videos.some((v) => v.videoId === videoId);

  function fillTarget() {
    const pls = store.state.playlists.filter(store.canEdit);
    const extra = created && !pls.some((p) => p.id === created.id) ? `<option value="${created.id}">${esc(created.name)}</option>` : '';
    tgt.innerHTML = `<option value="">選んでください…</option>${pls.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}${extra}<option value="__new">＋ 新しいプレイリストを作成…</option>`;
    if (!target && !pls.length && store.state.ready) target = '__new';
    tgt.value = [...tgt.options].some((o) => o.value === target) ? target : '';
    target = tgt.value;
    newName.hidden = target !== '__new';
  }
  function drawResults() {
    res.innerHTML = results.map((v) => rowHtml({ ...v, uid: 'v:' + v.videoId }, { add: true, added: inTarget(v.videoId) })).join('');
    $('#more', el).hidden = !next;
    markPlaying();
  }
  function drawHint() {
    $('#hint', el).innerHTML = getApiKey() ? '' : '<p class="notice">YouTube検索にはAPIキーが必要です。<a href="#/settings">設定画面</a>で入力してください（URLでの追加はキーなしでも使えます）。</p>';
  }
  async function ensureTarget() {
    if (!target) { toast('追加先のプレイリストを選んでください'); tgt.focus(); return null; }
    if (target === '__new') {
      const name = newName.value.trim();
      if (!name) { toast('新しいプレイリスト名を入力してください'); newName.focus(); return null; }
      const id = store.createPlaylist(name);
      created = { id, name }; target = id;
      fillTarget();
    }
    return target;
  }
  const targetName = () => store.state.playlists.find((p) => p.id === target)?.name || created?.name || '';

  async function doSearch(more) {
    const key = getApiKey();
    if (!key) { drawHint(); return toast('設定画面でAPIキーを入力してください', { error: true }); }
    const q = more ? lastQ : $('#q', el).value.trim();
    if (!q || busy) return;
    busy = true;
    if (!more) { lastQ = q; results = []; res.innerHTML = '<li class="muted center">検索中…</li>'; }
    try {
      const r = await yt.search(q, key, more ? next : '');
      results = more ? results.concat(r.items) : r.items; next = r.next;
      if (!results.length) res.innerHTML = '<li class="muted center">見つかりませんでした</li>'; else drawResults();
    } catch (e) {
      res.innerHTML = `<li class="notice err">${esc(e.message)}</li>`; next = '';
    } finally { busy = false; }
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; $$('.tabs2 button', el).forEach((b) => b.classList.toggle('active', b.dataset.tab === tab)); $('#pSearch', el).hidden = tab !== 'search'; $('#pUrl', el).hidden = tab !== 'url'; return; }
    const b = e.target.closest('#res [data-act]');
    if (!b) return;
    const li = b.closest('li');
    const v = results.find((x) => 'v:' + x.videoId === li.dataset.uid);
    if (!v) return;
    if (b.dataset.act === 'play') {
      player.play([{ ...v, uid: 'v:' + v.videoId }], 0, { type: 'preview' });
    } else if (b.dataset.act === 'add') {
      if (inTarget(v.videoId) && target && target !== '__new') return toast('すでに入っています');
      const id = await ensureTarget();
      if (!id) return;
      if (inTarget(v.videoId)) return toast('すでに入っています');
      if (!store.addVideos(id, [v]).length) return;
      added.add(`${id}:${v.videoId}`);
      toast(`「${targetName()}」に追加しました`);
      drawResults();
    }
  });
  tgt.onchange = () => { target = tgt.value; newName.hidden = target !== '__new'; if (!newName.hidden) newName.focus(); drawResults(); };
  $('#sf', el).onsubmit = (e) => { e.preventDefault(); doSearch(false); };
  $('#more', el).onclick = () => doSearch(true);
  $('#urlAdd', el).onclick = async () => {
    const msg = $('#urlMsg', el);
    const tokens = $('#urls', el).value.split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return toast('URLを貼り付けてください');
    const ids = [], bad = [];
    tokens.forEach((s) => { const id = yt.parseVideoId(s); id ? (!ids.includes(id) && ids.push(id)) : bad.push(s); });
    if (!ids.length) { msg.textContent = 'YouTubeの動画URLとして読み取れませんでした。'; return; }
    const id = await ensureTarget();
    if (!id) return;
    const btn = $('#urlAdd', el); btn.disabled = true; msg.textContent = '取得中…';
    try {
      const { found, missing } = await yt.resolveVideos(ids, getApiKey());
      const fresh = found.filter((v) => !inTarget(v.videoId));
      const items = fresh.length ? store.addVideos(id, fresh) : [];
      items.forEach((v) => added.add(`${id}:${v.videoId}`));
      const parts = [];
      if (items.length) parts.push(`${items.length}本を「${targetName()}」に追加しました`);
      if (found.length - fresh.length) parts.push(`${found.length - fresh.length}本はすでに入っています`);
      if (missing.length) parts.push(`${missing.length}本は取得できませんでした（非公開・削除・埋め込み不可など）`);
      if (bad.length) parts.push(`${bad.length}件はURLとして読み取れませんでした`);
      msg.textContent = parts.join(' / ');
      if (items.length) $('#urls', el).value = '';
    } catch (err) { msg.textContent = err.message; }
    finally { btn.disabled = false; }
  };

  $$('.tabs2 button', el).forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  fillTarget(); drawHint();
  return { onData() { fillTarget(); if (results.length) drawResults(); } };
}

/* ---------- チャンネル別 ---------- */
export function channels() {
  const el = root();
  function draw() {
    const groups = store.channelGroups();
    el.innerHTML = `<div class="page"><h1>チャンネル</h1>
      ${groups.length ? `<div class="grid">${groups.map((g) => `<a class="card" href="#/ch/${encodeURIComponent(g.name)}">${cover(g.videos)}<span class="cn">${esc(g.name)}</span><span class="cs">${g.videos.length}本の動画</span></a>`).join('')}</div>`
        : `<div class="empty">${store.state.ready ? 'まだ動画がありません。プレイリストに動画を追加すると、チャンネルごとにまとめて表示されます。' : '読み込み中…'}</div>`}</div>`;
  }
  el.onclick = null;
  draw();
  return { onData: draw };
}

export function channel(name) {
  const el = root();
  const get = () => store.channelGroups().find((g) => g.name === name);
  function draw() {
    const g = get();
    if (!g) { el.innerHTML = `<div class="page"><a class="back" href="#/ch">‹ チャンネル</a><p class="muted">${store.state.ready ? 'このチャンネルの動画はありません。' : '読み込み中…'}</p></div>`; return; }
    el.innerHTML = `<div class="page"><a class="back" href="#/ch">‹ チャンネル</a>
      <div class="pl-head">${cover(g.videos, 'big')}<div class="pl-info"><h1>${esc(g.name)}</h1><p class="muted">${g.videos.length}本の動画（すべてのプレイリストから重複なしで集計）</p></div></div>
      <div class="actions"><button class="btn primary" data-act="playall">▶ 再生</button><button class="btn" data-act="shuffle">🔀 シャッフル</button></div>
      <ul class="list">${g.videos.map((v) => rowHtml(v, { add: true })).join('')}</ul></div>`;
    markPlaying();
  }
  el.onclick = (e) => {
    const b = e.target.closest('[data-act]'); const g = get();
    if (!b || !g) return;
    const ctx = { type: 'channel', key: g.name };
    if (b.dataset.act === 'playall') { player.state.shuffle = false; player.play(g.videos, 0, ctx); }
    else if (b.dataset.act === 'shuffle') player.playShuffled(g.videos, ctx);
    else {
      const v = g.videos.find((x) => x.uid === b.closest('li')?.dataset.uid);
      if (!v) return;
      if (b.dataset.act === 'play') player.play(g.videos, g.videos.indexOf(v), ctx);
      else if (b.dataset.act === 'add') addToPlaylist(v);
    }
  };
  draw();
  return { onData: draw };
}

/* ---------- 設定 ---------- */
export function settings(fbSource) {
  const el = root();
  const u = store.state.user;
  el.innerHTML = `<div class="page narrow"><h1>設定</h1>
    <section class="panel"><h2>アカウント</h2>
      <p>${u ? `${esc(u.name || '')} <span class="muted">${esc(u.email || '')}</span>` : ''}</p>
      <button class="btn" id="signout">ログアウト</button></section>
    <section class="panel"><h2>YouTube APIキー</h2>
      <p class="muted small">動画の検索に使います。キーは<b>この端末のブラウザにだけ</b>保存され、サーバーやGitHubには送られません。端末ごとに入力が必要です。取得方法はREADMEを見てください。</p>
      <input id="apikey" class="inp" type="password" autocomplete="off" spellcheck="false" placeholder="AIza…" value="${esc(getApiKey())}">
      <div class="actions"><button class="btn primary" id="keySave">保存</button><button class="btn" id="keyTest">接続テスト</button><button class="btn" id="keyClear">削除</button></div>
      <p id="keyMsg" class="muted small"></p></section>
    <section class="panel"><h2>バックアップ</h2>
      <p class="muted small">プレイリストをJSONファイルに書き出し／読み込みできます。読み込みは「新しいプレイリストとして追加」されるので、既存のデータは消えません。</p>
      <div class="actions"><button class="btn" id="exp">書き出す</button><button class="btn" id="imp">読み込む</button></div>
      <input type="file" id="file" accept="application/json,.json" hidden></section>
    <section class="panel"><h2>Firebase</h2>
      <p class="muted small">接続先: ${esc(fbSource.projectId || '')}（${fbSource.local ? 'この端末に保存した設定' : 'js/firebase-config.js'}）</p>
      ${fbSource.local ? '<button class="btn" id="fbReset">この端末のFirebase設定を消す</button>' : ''}</section>
    <section class="panel"><h2>このアプリについて</h2>
      <p class="muted small">動画の再生にはYouTube公式の埋め込みプレーヤーを使用しています。動画のダウンロードや、YouTubeの利用規約に反する再生方法は行いません。<a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube利用規約</a></p></section>
  </div>`;
  const msg = $('#keyMsg', el);
  $('#signout', el).onclick = () => store.signOut();
  $('#keySave', el).onclick = () => { setApiKey($('#apikey', el).value.trim()); msg.textContent = '保存しました。'; };
  $('#keyClear', el).onclick = () => { setApiKey(''); $('#apikey', el).value = ''; msg.textContent = '削除しました。'; };
  $('#keyTest', el).onclick = async () => {
    const k = $('#apikey', el).value.trim();
    if (!k) { msg.textContent = 'キーを入力してください。'; return; }
    msg.textContent = 'テスト中…';
    try { await yt.fetchVideos(['jNQXAC9IVRw'], k); setApiKey(k); msg.textContent = '✓ 接続できました（保存しました）。'; }
    catch (e) { msg.textContent = '✗ ' + e.message; }
  };
  $('#exp', el).onclick = () => {
    const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `oki-tube-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#imp', el).onclick = () => $('#file', el).click();
  $('#file', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const r = store.importData(JSON.parse(await f.text()));
      toast(`${r.count}個のプレイリスト（${r.vids}本）を読み込みました`);
    } catch (err) { toast(err.message || '読み込みに失敗しました', { error: true }); }
  };
  $('#fbReset', el)?.addEventListener('click', () => { try { localStorage.removeItem('okitube.fbconfig'); } catch { /* */ } location.reload(); });
  el.onclick = null;
  return {};
}

/* ---------- ログイン / 初期設定 / エラー ---------- */
export function login() {
  const el = root();
  el.onclick = null;
  el.innerHTML = `<div class="page narrow center hero"><div class="logo-big">▶</div><h1>oki-tube</h1>
    <p class="muted">お気に入りのYouTube動画をプレイリストで管理。<br>パソコンでもスマホでも同じ内容が表示されます。</p>
    <button class="btn primary lg" id="gl">Googleでログイン</button><p id="loginMsg" class="notice err" hidden></p></div>`;
  $('#gl', el).onclick = async () => {
    const m = $('#loginMsg', el); m.hidden = true;
    try { await store.signIn(); } catch (e) {
      m.hidden = false;
      m.textContent = e.code === 'auth/unauthorized-domain' ? 'このサイトのドメインがFirebaseの「承認済みドメイン」に登録されていません（READMEを確認）。' : `ログインに失敗しました（${e.code || e.message}）`;
    }
  };
}

export function setup(onSaved) {
  const el = root();
  el.onclick = null;
  el.innerHTML = `<div class="page narrow"><h1>Firebaseの設定</h1>
    <p class="muted">まだFirebaseの設定がありません。READMEの手順で作成した「ウェブアプリの設定」（firebaseConfig）を貼り付けてください。<br>
    ※ 全端末で使うには、<code>js/firebase-config.js</code> に書いて公開するのがおすすめです（この値は秘密情報ではありません）。</p>
    <textarea id="cfg" class="inp" rows="9" spellcheck="false" placeholder='const firebaseConfig = {&#10;  apiKey: "…",&#10;  authDomain: "…firebaseapp.com",&#10;  projectId: "…",&#10;  appId: "…"&#10;};'></textarea>
    <div class="actions"><button class="btn primary" id="cfgSave">この端末に保存して開始</button></div><p id="cfgMsg" class="notice err" hidden></p></div>`;
  $('#cfgSave', el).onclick = () => {
    const text = $('#cfg', el).value;
    const cfg = {};
    for (const m of text.matchAll(/["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g)) cfg[m[1]] = m[2];
    if (!cfg.apiKey || !cfg.projectId || !cfg.appId) { const m = $('#cfgMsg', el); m.hidden = false; m.textContent = 'apiKey / projectId / appId が見つかりません。firebaseConfigをそのまま貼り付けてください。'; return; }
    if (!cfg.authDomain) cfg.authDomain = `${cfg.projectId}.firebaseapp.com`;
    try { localStorage.setItem('okitube.fbconfig', JSON.stringify(cfg)); } catch { /* */ }
    onSaved();
  };
}

export function message(html, retry) {
  const el = root();
  el.onclick = null;
  el.innerHTML = `<div class="page narrow center hero"><p>${html}</p>${retry ? '<button class="btn primary" id="retry">再読み込み</button>' : ''}</div>`;
  $('#retry', el)?.addEventListener('click', retry);
}
