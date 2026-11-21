// Firebase（Authentication + Cloud Firestore）とのやり取り
// データ構造:
//   users/{uid}/playlists/{playlistId} = { name, videos:[{uid,videoId,title,channelTitle,channelId?}], createdAt, updatedAt,
//                                          viewerEmails:[…], editorEmails:[…] }   ← 共有相手（見るだけ／編集もできる）
//   shares/{相手のメール}/items/{playlistId} = { ownerUid, ownerEmail, playlistId, role, name }  ← 「共有された」一覧用の目印

import { toast, uid } from './util.js';
import { isVideoId } from './yt.js';

const FIREBASE_VERSION = '10.14.1';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
export const MAX_VIDEOS = 2000;

let F = null, app, db, auth, unsub = null, unsubShares = null;
const docUnsubs = new Map(); // 共有されたプレイリストごとの購読
const sharedMap = new Map();
let ownList = [];
const listeners = new Set();

export const state = { user: null, playlists: [], ready: false, fromCache: false, pending: false, error: null, access: 'ok', isAdmin: false };

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

export async function init(config) {
  const [a, b, c] = await Promise.all([
    import(CDN + 'firebase-app.js'),
    import(CDN + 'firebase-auth.js'),
    import(CDN + 'firebase-firestore.js'),
  ]);
  F = { ...a, ...b, ...c };
  app = F.initializeApp(config);
  auth = F.getAuth(app);
  try {
    // オフラインでも動くよう、端末にキャッシュ（複数タブ対応）
    db = F.initializeFirestore(app, {
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn('Firestoreのオフラインキャッシュを使えません', e);
    db = F.getFirestore(app);
  }
}

// 許可制: 管理者（admins/{uid}）か、許可リスト（allowed/{メール}）に入っている人だけが使える。
// 確認できないとき（オフライン・ルール未更新など）は通し、実際の保存・読み取りはルール側で守られる。
async function checkAccess(u) {
  const email = (u.email || '').toLowerCase();
  state.isAdmin = false;
  try {
    const [a, m] = await Promise.all([
      F.getDoc(F.doc(db, 'admins', u.uid)),
      email ? F.getDoc(F.doc(db, 'allowed', email)) : Promise.resolve(null),
    ]);
    state.isAdmin = a.exists();
    return a.exists() || (m && m.exists()) ? 'ok' : 'denied';
  } catch (e) {
    console.warn('利用許可を確認できませんでした', e.code || e);
    return 'ok';
  }
}

export function onAuth(cb) {
  return F.onAuthStateChanged(auth, async (u) => {
    stopSync();
    state.user = u ? { uid: u.uid, email: u.email, name: u.displayName, photo: u.photoURL } : null;
    state.playlists = []; ownList = []; sharedMap.clear(); state.ready = false; state.error = null;
    state.access = 'ok'; state.isAdmin = false;
    if (u) {
      state.access = await checkAccess(u);
      if (!auth.currentUser || auth.currentUser.uid !== u.uid) return; // 確認中に別のアカウントへ切り替わった
      if (state.access === 'ok') startSync(u.uid, (u.email || '').toLowerCase(), !!u.emailVerified);
    }
    cb(state.user);
    emit();
  });
}

/* ---------- メンバー管理（管理者のみ） ---------- */
export function watchAllowed(cb, onError) {
  return F.onSnapshot(F.collection(db, 'allowed'),
    (snap) => cb(snap.docs.map((d) => d.id).sort()),
    (e) => onError?.(e));
}
export function allowEmail(raw) {
  const email = normEmail(raw);
  if (!validEmail(email)) throw new Error('メールアドレスの形式が正しくありません');
  return F.setDoc(F.doc(db, 'allowed', email), { addedAt: Date.now(), addedBy: state.user.uid }).catch(fail);
}
export const disallowEmail = (raw) => F.deleteDoc(F.doc(db, 'allowed', normEmail(raw))).catch(fail);

export async function signIn() {
  const provider = new F.GoogleAuthProvider();
  try {
    await F.signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      return F.signInWithRedirect(auth, provider);
    }
    throw e;
  }
}

export const signOut = () => F.signOut(auth);


function rebuild() {
  const shared = [...sharedMap.values()].sort((x, y) => x.name.localeCompare(y.name, 'ja'));
  state.playlists = ownList.concat(shared);
  emit();
}

function mapDoc(id, x, ownerUid, role) {
  return {
    id, ownerUid, role, name: x.name || '(無題)', videos: Array.isArray(x.videos) ? x.videos : [], createdAt: x.createdAt || 0,
    viewerEmails: Array.isArray(x.viewerEmails) ? x.viewerEmails : [], editorEmails: Array.isArray(x.editorEmails) ? x.editorEmails : [],
  };
}

function startSync(userId, email, verified) {
  unsub = F.onSnapshot(
    F.collection(db, 'users', userId, 'playlists'),
    { includeMetadataChanges: true },
    (snap) => {
      ownList = snap.docs.map((d) => mapDoc(d.id, d.data(), userId, 'owner')).sort((a, b) => a.createdAt - b.createdAt);
      state.ready = true;
      state.fromCache = snap.metadata.fromCache;
      state.pending = snap.metadata.hasPendingWrites;
      state.error = null;
      rebuild();
    },
    (err) => {
      console.error(err);
      state.error = err.code === 'permission-denied' ? 'permission-denied' : err.message;
      state.ready = true; // 表示は壊さずエラーだけ伝える
      emit();
    });

  // 自分宛てに共有されたプレイリスト（ルール未更新などで失敗しても、自分のデータの表示は続ける）
  if (!email || !verified) return;
  unsubShares = F.onSnapshot(F.collection(db, 'shares', email, 'items'), (snap) => {
    const ptrs = snap.docs.map((d) => d.data()).filter((p) => p.ownerUid && p.playlistId && p.ownerUid !== userId);
    const want = new Set(ptrs.map((p) => p.playlistId));
    for (const [pid, u] of docUnsubs) if (!want.has(pid)) { u(); docUnsubs.delete(pid); sharedMap.delete(pid); }
    for (const p of ptrs) {
      if (docUnsubs.has(p.playlistId)) continue;
      docUnsubs.set(p.playlistId, F.onSnapshot(
        F.doc(db, 'users', p.ownerUid, 'playlists', p.playlistId),
        (s) => {
          if (!s.exists()) sharedMap.delete(p.playlistId);
          else {
            const x = s.data();
            const role = (x.editorEmails || []).includes(email) ? 'edit' : (x.viewerEmails || []).includes(email) ? 'view' : null;
            if (role) sharedMap.set(p.playlistId, { ...mapDoc(s.id, x, p.ownerUid, role), ownerEmail: p.ownerEmail || '' });
            else sharedMap.delete(p.playlistId); // 共有が解除された
          }
          rebuild();
        },
        () => { sharedMap.delete(p.playlistId); rebuild(); }));
    }
    rebuild();
  }, (err) => console.warn('共有一覧を読み込めません（ルール未更新の可能性）', err.code));
}
function stopSync() {
  if (unsub) { unsub(); unsub = null; }
  if (unsubShares) { unsubShares(); unsubShares = null; }
  docUnsubs.forEach((u) => u()); docUnsubs.clear();
}

const fail = (e) => {
  console.error(e);
  toast(e.code === 'permission-denied' ? '保存できませんでした（権限エラー。セキュリティルールを確認してください）' : '保存に失敗しました。通信状況を確認してください。', { error: true });
};

function clean(v) {
  const o = {
    uid: v.uid || uid(),
    videoId: v.videoId,
    title: String(v.title || v.videoId).slice(0, 200),
    channelTitle: String(v.channelTitle || '').slice(0, 100),
  };
  if (v.channelId) o.channelId = v.channelId;
  return o;
}

const col = () => F.collection(db, 'users', state.user.uid, 'playlists');
const find = (id) => state.playlists.find((p) => p.id === id);
// 共有されたプレイリストは持ち主の場所にあるので、持ち主のUIDで参照する
const ref = (id) => F.doc(db, 'users', find(id)?.ownerUid || state.user.uid, 'playlists', id);
const pointer = (email, id) => F.doc(db, 'shares', email, 'items', id);
const members = (pl) => [...pl.viewerEmails, ...pl.editorEmails];
const canEdit = (pl) => pl && (pl.role === 'owner' || pl.role === 'edit');
export { canEdit };

/* ---------- プレイリスト操作（オフラインでも即座に画面へ反映され、復帰後に同期） ---------- */
export function createPlaylist(name, videos = []) {
  const r = F.doc(col());
  const now = Date.now();
  F.setDoc(r, { name: name.slice(0, 100), videos: videos.map(clean), createdAt: now, updatedAt: now, viewerEmails: [], editorEmails: [] }).catch(fail);
  return r.id;
}
export function renamePlaylist(id, name) {
  const pl = find(id);
  const b = F.writeBatch(db);
  b.update(ref(id), { name: name.slice(0, 100), updatedAt: Date.now() });
  if (pl) for (const e of members(pl)) b.set(pointer(e, id), pointerData(pl, e, name.slice(0, 100)));
  return b.commit().catch(fail);
}
export function deletePlaylist(id) {
  const pl = find(id);
  const b = F.writeBatch(db);
  b.delete(ref(id));
  if (pl) for (const e of members(pl)) b.delete(pointer(e, id));
  return b.commit().catch(fail);
}
export const setVideos = (id, videos) =>
  F.updateDoc(ref(id), { videos: videos.map(clean), updatedAt: Date.now() }).catch(fail);

export function addVideos(id, videos) {
  const pl = find(id);
  if (pl && pl.videos.length + videos.length > MAX_VIDEOS) {
    toast(`1つのプレイリストには${MAX_VIDEOS}本まで入れられます`, { error: true });
    return [];
  }
  const items = videos.map(clean);
  F.updateDoc(ref(id), { videos: F.arrayUnion(...items), updatedAt: Date.now() }).catch(fail);
  return items;
}

/* ---------- 共有（プレイリストごと・メールアドレスで指定） ---------- */
const pointerData = (pl, email, name = pl.name) => ({
  ownerUid: state.user.uid, ownerEmail: (state.user.email || '').toLowerCase(), playlistId: pl.id,
  role: pl.editorEmails.includes(email) ? 'edit' : 'view', name,
});

export const normEmail = (s) => String(s || '').trim().toLowerCase();
export const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// role: 'view'（見るだけ） | 'edit'（編集もできる）
export function shareWith(id, rawEmail, role) {
  const pl = find(id);
  const email = normEmail(rawEmail);
  if (!pl || pl.role !== 'owner') throw new Error('共有できるのは自分のプレイリストだけです');
  if (!validEmail(email)) throw new Error('メールアドレスの形式が正しくありません');
  if (email === normEmail(state.user.email)) throw new Error('自分自身には共有できません');
  if (!members(pl).includes(email) && members(pl).length >= 20) throw new Error('共有できるのは1つのプレイリストにつき20人までです');
  const viewer = pl.viewerEmails.filter((e) => e !== email), editor = pl.editorEmails.filter((e) => e !== email);
  (role === 'edit' ? editor : viewer).push(email);
  const next = { ...pl, viewerEmails: viewer, editorEmails: editor };
  const b = F.writeBatch(db);
  b.update(ref(id), { viewerEmails: viewer, editorEmails: editor });
  b.set(pointer(email, id), pointerData(next, email));
  return b.commit().catch(fail);
}

export function unshare(id, rawEmail) {
  const pl = find(id);
  const email = normEmail(rawEmail);
  if (!pl || pl.role !== 'owner') return;
  const b = F.writeBatch(db);
  b.update(ref(id), { viewerEmails: pl.viewerEmails.filter((e) => e !== email), editorEmails: pl.editorEmails.filter((e) => e !== email) });
  b.delete(pointer(email, id));
  return b.commit().catch(fail);
}

// 共有されたプレイリストを自分の一覧から外す
export function leaveShared(id) {
  const pl = find(id);
  if (!pl || pl.role === 'owner') return;
  sharedMap.delete(id); docUnsubs.get(id)?.(); docUnsubs.delete(id); rebuild();
  return F.deleteDoc(pointer(normEmail(state.user.email), id)).catch(fail);
}

/* ---------- チャンネル別まとめ（共有されたものも含む） ---------- */
export function channelGroups() {
  const map = new Map();
  const seen = new Set();
  for (const pl of state.playlists) {
    for (const v of pl.videos) {
      if (seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      const name = v.channelTitle || '（チャンネル不明）';
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(v);
    }
  }
  return [...map].map(([name, videos]) => ({ name, videos })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

// 再生中のリストの最新内容を取得（編集に追従させるため）
export function videosForCtx(ctx) {
  if (!ctx) return null;
  if (ctx.type === 'playlist') return state.playlists.find((p) => p.id === ctx.id)?.videos ?? null;
  if (ctx.type === 'channel') return channelGroups().find((g) => g.name === ctx.key)?.videos ?? null;
  return null;
}

/* ---------- バックアップ（JSON） ---------- */
export function exportData() {
  return {
    app: 'oki-tube',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: state.playlists.filter((p) => p.role === 'owner').map((p) => ({
      name: p.name,
      videos: p.videos.map((v) => ({ videoId: v.videoId, title: v.title, channelTitle: v.channelTitle, ...(v.channelId ? { channelId: v.channelId } : {}) })),
    })),
  };
}

export function importData(obj) {
  if (!obj || obj.app !== 'oki-tube' || !Array.isArray(obj.playlists)) throw new Error('oki-tubeのバックアップファイルではありません');
  let count = 0, vids = 0;
  for (const p of obj.playlists.slice(0, 200)) {
    if (!p || typeof p.name !== 'string') continue;
    const videos = (Array.isArray(p.videos) ? p.videos : [])
      .filter((v) => v && isVideoId(v.videoId))
      .slice(0, MAX_VIDEOS)
      .map((v) => ({ videoId: v.videoId, title: String(v.title || v.videoId), channelTitle: String(v.channelTitle || ''), channelId: typeof v.channelId === 'string' ? v.channelId : '' }));
    createPlaylist(p.name.trim() || '(無題)', videos);
    count++; vids += videos.length;
  }
  if (!count) throw new Error('読み込めるプレイリストがありませんでした');
  return { count, vids };
}
