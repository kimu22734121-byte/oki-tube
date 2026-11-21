// 共通ユーティリティ（DOM補助・トースト・ダイアログ・アイコン）

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const thumbUrl = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;

export const uid = () =>
  (globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)) ||
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  repeat1: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zM13 15V9h-1l-2 1v1h1.5v4H13z',
  trash: 'M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  drag: 'M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z',
  more: 'M6 10a2 2 0 100 4 2 2 0 000-4zm12 0a2 2 0 100 4 2 2 0 000-4zm-6 0a2 2 0 100 4 2 2 0 000-4z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;

/* ---------- トースト ---------- */
export function toast(msg, opts = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' err' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (opts.action) {
    const b = document.createElement('button');
    b.textContent = opts.action;
    b.onclick = () => { el.remove(); opts.onAction?.(); };
    el.appendChild(b);
  }
  box.appendChild(el);
  setTimeout(() => el.remove(), opts.action ? 6000 : 3500);
}

/* ---------- ダイアログ ---------- */
export function modal(html, setup) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<div class="dlg-body">${html}</div>`;
    document.body.appendChild(d);
    let value = null;
    d.addEventListener('close', () => { d.remove(); resolve(value); });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    setup(d, (v) => { value = v; d.close(); });
    d.showModal();
  });
}

export function promptText({ title, value = '', ok = 'OK', placeholder = '' }) {
  return modal(
    `<h3>${esc(title)}</h3>
     <form class="stack"><input class="inp" maxlength="100" autocomplete="off" value="${esc(value)}" placeholder="${esc(placeholder)}">
     <div class="dlg-actions"><button type="button" class="btn" data-a="cancel">キャンセル</button><button class="btn primary">${esc(ok)}</button></div></form>`,
    (d, done) => {
      const inp = $('input', d);
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
      $('form', d).addEventListener('submit', (e) => { e.preventDefault(); const v = inp.value.trim(); if (v) done(v); });
      $('[data-a=cancel]', d).onclick = () => done(null);
    });
}

export function confirmDialog(message, okLabel = '削除', danger = true) {
  return modal(
    `<p>${esc(message)}</p>
     <div class="dlg-actions"><button class="btn" data-a="cancel">キャンセル</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-a="ok">${esc(okLabel)}</button></div>`,
    (d, done) => {
      $('[data-a=cancel]', d).onclick = () => done(false);
      $('[data-a=ok]', d).onclick = () => done(true);
    }).then((v) => !!v);
}
