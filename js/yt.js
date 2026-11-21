// YouTube関連: URL解析、Data API v3 検索、動画情報の取得

const API = 'https://www.googleapis.com/youtube/v3';
const ID_RE = /^[\w-]{11}$/;

export const isVideoId = (s) => ID_RE.test(s || '');

export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (ID_RE.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  return ID_RE.test(id || '') ? id : null;
}

export function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = String(s ?? '');
  return t.value;
}

class ApiError extends Error {}

function friendly(reason, status) {
  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
    case 'rateLimitExceeded':
      return 'YouTube APIの1日の利用上限に達しました。時間をおいて（翌日以降に）再度お試しください。';
    case 'keyInvalid':
    case 'API_KEY_INVALID':
      return 'APIキーが正しくありません。設定画面で入力し直してください。';
    case 'accessNotConfigured':
    case 'SERVICE_DISABLED':
      return 'Google Cloudで「YouTube Data API v3」が有効になっていません。READMEの手順を確認してください。';
    case 'ipRefererBlocked':
    case 'forbidden':
      return 'このサイトからはAPIキーを使えません（キーのHTTPリファラー制限を確認してください）。';
    default:
      return `YouTube APIエラー（${status}${reason ? ' / ' + reason : ''}）`;
  }
}

async function call(path, params) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  let res;
  try { res = await fetch(url); } catch { throw new ApiError('通信エラーです。ネットワークを確認してください。'); }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status;
    throw new ApiError(friendly(reason, res.status));
  }
  return data;
}

const toItem = (videoId, sn) => ({
  videoId,
  title: decodeEntities(sn.title),
  channelTitle: decodeEntities(sn.channelTitle || ''),
  channelId: sn.channelId || '',
});

export async function search(query, key, pageToken = '') {
  const p = { part: 'snippet', type: 'video', maxResults: '20', videoEmbeddable: 'true', q: query, key };
  if (pageToken) p.pageToken = pageToken;
  const data = await call('search', p);
  const items = (data.items || [])
    .filter((it) => it.id?.videoId)
    .map((it) => toItem(it.id.videoId, it.snippet));
  return { items, next: data.nextPageToken || '' };
}

// videos.list（1回50件・クォータ1）
export async function fetchVideos(ids, key) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await call('videos', { part: 'snippet,status', id: chunk.join(','), key });
    for (const it of data.items || []) {
      if (it.status && it.status.embeddable === false) continue; // 埋め込み不可は除外
      out.set(it.id, toItem(it.id, it.snippet));
    }
  }
  return out;
}

// APIキー不要のoEmbed（タイトルとチャンネル名のみ）
async function oembed(id) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    if (!res.ok) return null;
    const d = await res.json();
    return { videoId: id, title: d.title || id, channelTitle: d.author_name || '', channelId: '' };
  } catch { return null; }
}

// URLから取り出したIDの動画情報をまとめて取得。APIキーがあればAPI、なければ（または失敗したら）oEmbed。
export async function resolveVideos(ids, key) {
  let map = new Map();
  let apiOk = false;
  if (key) {
    try { map = await fetchVideos(ids, key); apiOk = true; } catch { /* oEmbedへ */ }
  }
  const found = [], missing = [];
  for (const id of ids) {
    let v = map.get(id);
    if (!v && !apiOk) v = await oembed(id);
    if (v) found.push(v); else missing.push(id);
  }
  return { found, missing };
}
