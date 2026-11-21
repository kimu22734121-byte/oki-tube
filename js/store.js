// Firebase（Authentication + Cloud Firestore）とのやり取り
// データ構造:  users/{uid}/playlists/{playlistId} = { name, videos:[{uid,videoId,title,channelTitle,channelId?}], createdAt, updatedAt }

import { toast, uid } from './util.js';
import { isVideoId } from './yt.js';

const FIREBASE_VERSION = '10.14.1';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
export const MAX_VIDEOS = 2000;

let F = null, app, db, auth, unsub = null;
const listeners = new Set();

export const state = { user: null, playlists: [], ready: false, fromCache: false, pending: false, error: null };

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

export function onAuth(cb) {
  return F.onAuthStateChanged(auth, (u) => {
    stopSync();
    state.user = u ? { uid: u.uid, email: u.email, name: u.displayName, photo: u.photoURL } : null;
    state.playlists = []; state.ready = false; state.error = null;
    if (u) startSync(u.uid);
    cb(state.user);
    emit();
  });
}

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

const col = () => F.collection(db, 'users', state.user.uid, 'playlists');
const ref = (id) => F.doc(db, 'users', state.user.uid, 'playlists', id);

function startSync(userId) {
  unsub = F.onSnapshot(
    F.collection(db, 'users', userId, 'playlists'),
    { includeMetadataChanges: true },
    (snap) => {
      state.playlists = snap.docs
        .map((d) => {
          const x = d.data();
          return { id: d.id, name: x.name || '(無題)', videos: Array.isArray(x.videos) ? x.videos : [], createdAt: x.createdAt || 0 };
        })
        .sort((a, b) => a.createdAt - b.createdAt);
      state.ready = true;
      state.fromCache = snap.metadata.fromCache;
      state.pending = snap.metadata.hasPendingWrites;
      state.error = null;
      emit();
    },
    (err) => {
      console.error(err);
      state.error = err.code === 'permission-denied' ? 'permission-denied' : err.message;
      state.ready = true; // 表示は壊さずエラーだけ伝える
      emit();
    });
}
function stopSync() { if (unsub) { unsub(); unsub = null; } }

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

/* ---------- プレイリスト操作（オフラインでも即座に画面へ反映され、復帰後に同期） ---------- */
export function createPlaylist(name, videos = []) {
  const r = F.doc(col());
  const now = Date.now();
  F.setDoc(r, { name: name.slice(0, 100), videos: videos.map(clean), createdAt: now, updatedAt: now }).catch(fail);
  return r.id;
}
export const renamePlaylist = (id, name) =>
  F.updateDoc(ref(id), { name: name.slice(0, 100), updatedAt: Date.now() }).catch(fail);
export const deletePlaylist = (id) => F.deleteDoc(ref(id)).catch(fail);
export const setVideos = (id, videos) =>
  F.updateDoc(ref(id), { videos: videos.map(clean), updatedAt: Date.now() }).catch(fail);

export function addVideos(id, videos) {
  const pl = state.playlists.find((p) => p.id === id);
  if (pl && pl.videos.length + videos.length > MAX_VIDEOS) {
    toast(`1つのプレイリストには${MAX_VIDEOS}本まで入れられます`, { error: true });
    return [];
  }
  const items = videos.map(clean);
  F.updateDoc(ref(id), { videos: F.arrayUnion(...items), updatedAt: Date.now() }).catch(fail);
  return items;
}

/* ---------- チャンネル別まとめ ---------- */
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
    playlists: state.playlists.map((p) => ({
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
