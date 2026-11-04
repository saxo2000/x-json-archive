/* X JSON Archive — 端末内だけで動く JSON ビューア
 * ネットワークには一切送信しない。画像URLだけは外部(pbs.twimg.com 等)から表示を試みる。
 */
'use strict';

/* ---------------- 設定 ---------------- */
const PAGE_SIZE = 40;
const INDEX_MAX = 300000;           // これ以下なら読み込み時に全文検索インデックスを作る
const DB_NAME = 'xarchive';
const DB_STORE = 'meta';
const SEARCH_DEBOUNCE = 180;

/* キー名エイリアス（取り込み側によって変わるため寛容に解釈） */
const ALIAS = {
  id: ['id','id_str','tweet_id','tweetId','status_id','statusId','rest_id'],
  username: ['username','user','screen_name','screenName','author','name_account','handle','account','user_name'],
  date: ['date','created_at','createdAt','timestamp','time','postedAt','tweeted_at','created'],
  text: ['text','full_text','fullText','content','body','tweet'],
  url: ['url','permalink','link','tweet_url','tweetUrl','status_url'],
  media: ['media','media_urls','mediaUrls','images','photos','entities_media','attachments','mediaObjects'],
  savedAt: ['savedAt','saved_at','bookmarkedAt','addedAt','importedAt'],
};
const USERNAME_FIELDS = ['screen_name','screenName','handle','username','userName'];

/* ---------------- 状態 ---------------- */
const state = {
  posts: [],        // 正規化済み {id,username,date,dateMs,text,url,media[],savedAt,h}
  view: [],         // 絞り込み・ソート済み
  q: '',
  sort: 'new',
  from: '',
  shown: 0,
  keys: {},         // 認識したキー
  raw: null,
  source: '',       // ファイル名
  index: null,      // 全文検索インデックス用の {hay:string, starts:Int32Array}
  indexBuilt: false,
  lastFile: null,
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const el = {
  q: $('q'), sort: $('sort'), from: $('from'), clear: $('topClear'), open: $('openBtn'),
  wide: $('wideBtn'), file: $('file'), meta: $('meta'), list: $('list'), keysHelp: $('keysHelp'),
  keysTable: $('keysTable'), keysBox: $('keysBox'), badge: $('srcBadge'), drop: $('drop'),
  toast: $('toast'), prog: $('prog'),
};

/* ---------------- ユーティリティ ---------------- */
function toast(msg, isErr, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.className = ''; }, ms);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) { return n.toLocaleString('ja-JP'); }
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  // +/-HH:MM
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const tz = 'UTC' + sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${tz}`;
}
function pick(obj, names) {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return undefined;
}
function isProfileUrl(u) {
  return /\/profile_images\//.test(String(u));
}
/* twimg の URL を表示用に小さくして軽くする */
function mediaUrl(u) {
  if (!u) return '';
  let s = String(u);
  if (isProfileUrl(s)) {
    // プロフィール画像は _normal(48px) に落として小さく表示
    return s.replace(/_(bigger|reasonably_small|400x400|200x200|original)(\.(png|jpe?g|webp))/i, '_normal$2');
  }
  // 原寸(orig/large/4096x4096)のものは小さく。それ以外(900x900等)はそのまま
  return s.replace(/([?&])name=(orig|4096x4096)\b/, '$1name=900x900');
}
// サムネ表示（原寸はリンク先で開く）
function upscaleProfile(u) {
  return String(u).replace(/_(normal|mini|reasonably_small)(\.(png|jpe?g|webp))/i, '_bigger$2');
}

/* ---------------- JSON パース ---------------- */
function findArray(v, depth = 0) {
  if (depth > 4 || v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) return v;
  // 典型: {tweets:[...]} / {data:[...]} / {items:{...}} など
  const keys = Object.keys(v);
  for (const k of keys) {
    if (/^(tweets|posts|statuses|items|data|results|entries|records|list|archive)$/i.test(k)) {
      const r = findArray(v[k], depth + 1);
      if (r) return r;
    }
  }
  for (const k of keys) {
    if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) {
      const r = findArray(v[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/* 数MBのJSONをUIを固めずに解析（WKWebView/Chrome の Worker なしで分割処理） */
async function parseJSONLoose(text) {
  const t = text.trim();
  if (!t) throw new Error('ファイルが空です');
  if (t[0] === '[' || t[0] === '{') {
    try { return JSON.parse(t); } catch (_) { /* 末尾切れ等を許容して修復へ */ }
  }
  // リンクドJSONなどの修復パーサ
  return repairParse(t);
}
function repairParse(t) {
  const out = [];
  let i = 0, n = t.length;
  const isWS = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  while (i < n) {
    const c = t[i];
    if (isWS(c) || c === ',' || c === '[' || c === ']') { i++; continue; }
    if (c !== '{') { i++; continue; }
    // オブジェクト境界を文字列を考慮して探す
    let depth = 0, j = i, inStr = false, esc = false, end = -1;
    for (; j < n; j++) {
      const ch = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    const slice = t.slice(i, end === -1 ? n : end + 1);
    try { out.push(JSON.parse(slice)); } catch (_) { /* 壊れた要素は捨てる */ }
    if (end === -1) break;
    i = end + 1;
  }
  if (!out.length) throw new Error('JSONとして解析できませんでした');
  return out;
}

/* ---------------- 正規化 ---------------- */
function normalize(raw, idx) {
  let g = raw || {};
  const list = [];
  const u = pick(g, ALIAS.username);
  if (u && typeof u === 'object') {
    // ネストしたユーザー情報（user.screen_name 等）
    g = Object.assign({}, g, { username: pick(u, USERNAME_FIELDS.concat(['name'])) || '', avatar: pick(u, ['profile_image_url','profile_image_url_https','avatar','icon']) });
    list.push(pick(u, ['profile_image_url','profile_image_url_https','avatar','icon']));
  }
  // media を文字列配列へ
  let m = pick(g, ALIAS.media);
  if (typeof m === 'string' && m.trim().startsWith('[')) { try { m = JSON.parse(m); } catch (_) {} }
  const urls = [];
  const push = (x) => {
    if (!x) return;
    if (typeof x === 'string') urls.push(x);
    else if (typeof x === 'object') {
      const s = pick(x, ['url','media_url','media_url_https','src','image','imageUrl','fullUrl','path','poster','thumbnail']);
      if (typeof s === 'string') urls.push(s);
      const t = pick(x, ['type']); // video/gif などはテキストとして添える
      if (t && /video|gif|animated/i.test(t)) urls[urls.length - 1] += '#video';
    }
  };
  if (Array.isArray(m)) m.forEach(push);
  else if (m && typeof m === 'object') { push(m); }
  else if (typeof m === 'string') push(m);
  // アバター（profile_images）はメディア一覧から外し、小さく横に並べる
  let avatars = [];
  const avatarRaw = g.avatar || pick(g, ['profile_image_url','profile_image_url_https','avatar']);
  if (avatarRaw) avatars.push(String(avatarRaw));
  const attach = [];
  for (const x of urls) {
    if (!x) continue;
    if (isProfileUrl(x)) avatars.push(x);
    else if (!attach.includes(x)) attach.push(x);
  }
  avatars = [...new Set(avatars)];

  const dateStr = pick(g, ALIAS.date);
  let dateMs = 0;
  if (typeof dateStr === 'number') dateMs = dateStr < 1e12 ? dateStr * 1000 : dateStr;
  else if (dateStr) {
    const t = Date.parse(dateStr);
    if (!isNaN(t)) dateMs = t;
    else {
      const num = Number(dateStr);
      if (!isNaN(num) && num > 1e8) dateMs = num < 1e12 ? num * 1000 : num;
    }
  }
  const saved = pick(g, ALIAS.savedAt);
  const user = String(pick(g, ALIAS.username) || '').trim();
  const text = String(pick(g, ALIAS.text) || '');
  return {
    i: idx,
    id: String(pick(g, ALIAS.id) || ''),
    username: user,
    date: typeof dateStr === 'number' ? new Date(dateMs).toISOString() : (dateStr || ''),
    dateMs,
    text,
    url: String(pick(g, ALIAS.url) || ''),
    media: attach,
    avatars,
    savedAt: saved || '',
    _h: null,
  };
}

function detectKeys(raw, normalized) {
  const k = {};
  const rec = (name, used, note) => { k[name] = { used: used || '(未検出)', note: note || '' }; };
  rec('id', normalized.id, '');
  rec('username', normalized.username, '');
  rec('date', normalized.date, normalized.dateMs ? 'OK' : '日付として解釈できず');
  rec('text', normalized.text ? '(あり)' : '', '');
  rec('url', normalized.url, '');
  rec('media', normalized.media.length ? normalized.media.length + '件' : '', '');
  rec('savedAt', normalized.savedAt, '');
  return k;
}

/* ---------------- 読み込み ---------------- */
async function loadFiles(files) {
  if (!files || !files.length) return;
  const f = files[0];
  const t0 = performance.now();
  showProgress(5);
  el.meta.textContent = '読み込み中… ' + f.name;
  try {
    const text = await readFile(f, (p) => showProgress(p));
    showProgress(45);
    await sleep(0);
    const json = await parseJSONLoose(text);
    let arr = Array.isArray(json) ? json : findArray(json);
    if (!arr && json && typeof json === 'object') arr = [json];
    if (!arr || !arr.length) throw new Error('投稿の配列が見つかりませんでした');
    showProgress(70);
    await sleep(0);
    const posts = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) posts[i] = normalize(arr[i], i);
    state.posts = posts;
    state.raw = null; // 元データは保持しない（メモリ節約）
    state.source = f.name;
    state.keys = detectKeys(json, posts[0] || {});
    buildUserList();
    state.index = null; state.indexBuilt = false;
    showProgress(90);
    if (arr.length <= INDEX_MAX) {
      await sleep(0);
      buildIndex();
    }
    doRefresh();
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    toast(`${fmtNum(posts.length)}件を読み込みました（${sec}秒）`);
    if (arr.length > INDEX_MAX) {
      el.wide.classList.remove('hidden');
    } else {
      el.wide.classList.add('hidden');
    }
    renderKeys();
    // 直前に開いたファイルを IndexedDB に保存（次回起動時に再接続できるように）
    saveHandleOrName(f).catch(() => {});
  } catch (e) {
    console.error(e);
    toast('読み込みに失敗: ' + (e && e.message ? e.message : e), true, 5000);
    el.meta.textContent = 'JSONを読み込めませんでした。ファイルを確認してください。';
  } finally {
    hideProgress();
  }
}

function readFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error('読み込みエラー'));
    r.onload = () => resolve(r.result);
    if (onProgress) r.onprogress = (e) => { if (e.lengthComputable) onProgress(5 + 40 * (e.loaded / e.total)); };
    r.readAsText(file, 'utf-8');
  });
}

function showProgress(p) { el.prog.classList.remove('hidden'); el.prog.style.width = Math.min(99, p) + '%'; }
function hideProgress() { el.prog.style.width = '100%'; setTimeout(() => { el.prog.classList.add('hidden'); el.prog.style.width = '0'; }, 250); }

/* ---------------- IndexedDB（ファイルハンドルの記憶） ---------------- */
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbPut(key, val) {
  try { const db = await idb(); await new Promise((r, j) => { const tx = db.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(val, key); tx.oncomplete = r; tx.onerror = () => j(tx.error); }); } catch (_) {}
}
async function idbGet(key) {
  try { const db = await idb(); return await new Promise((r, j) => { const tx = db.transaction(DB_STORE, 'readonly'); const q = tx.objectStore(DB_STORE).get(key); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); } catch (_) { return undefined; }
}
async function saveHandleOrName(f) {
  if (window.showOpenFilePicker && f._handle) await idbPut('handle', f._handle);
  await idbPut('name', f.name);
  await idbPut('size', f.size);
}

async function openWithPicker() {
  // File System Access API（Chrome/Edge デスクトップ・一部の Android Chrome）
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json', '.jsonl', '.ndjson'] } }],
        multiple: false,
      });
      if (!h) return;
      const file = await h.getFile();
      file._handle = h;
      // 権限は当面有効。不要になったら忘れる
      try { if (h.queryPermission) await h.queryPermission({ mode: 'read' }); } catch (_) {}
      await loadFiles([file]);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // 未対応・失敗時は <input type=file> にフォールバック
      console.warn('picker失敗', e);
    }
  }
  el.file.value = '';
  el.file.click();
}

async function tryRestore() {
  // 前回ファイル名とサイズを表示（自動読み込みはブラウザの制約上できないため案内のみ）
  const name = await idbGet('name');
  const size = await idbGet('size');
  if (name) {
    el.meta.innerHTML = `前回: <b>${esc(name)}</b>${size ? '（' + (size / 1024 / 1024).toFixed(1) + 'MB）' : ''} ・「JSONを開く」で選び直してください（自動読み込みはブラウザの制約で不可）`;
  }
}

/* ---------------- 検索インデックス ---------------- */
/* 全文検索: 各投稿の検索対象文字列を1本に連結し、Int32Arrayで開始位置を持つ。
 * クエリはNFKC+小文字+ひらがな→カタカナに正規化して indexOf で走査。
 * 日本語の全角/半角、大小文字、カタカナ/ひらがな の揺れを吸収する。 */
function normText(s) {
  if (!s) return '';
  let t = s;
  try { t = t.normalize('NFKC'); } catch (_) {}
  t = t.toLowerCase();
  // ひらがな→カタカナ（検索のみ。表示は元のまま）
  t = t.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  return t;
}
function hayOf(p) {
  if (p._h === null) {
    p._h = normText([p.username, p.text, p.date, p.id, p.url].join('\n'));
  }
  return p._h;
}
function buildIndex() {
  const ps = state.posts;
  const starts = new Int32Array(ps.length + 1);
  let total = 0;
  for (let i = 0; i < ps.length; i++) { starts[i] = total; total += hayOf(ps[i]).length + 1; }
  starts[ps.length] = total;
  const buf = new Array(ps.length);
  for (let i = 0; i < ps.length; i++) buf[i] = hayOf(ps[i]);
  state.index = { hay: buf.join('\n'), starts };
  state.indexBuilt = true;
}

async function buildIndexAsync(onStep) {
  const ps = state.posts;
  const starts = new Int32Array(ps.length + 1);
  const buf = new Array(ps.length);
  let total = 0;
  const CHUNK = 4000;
  for (let i = 0; i < ps.length; i++) {
    starts[i] = total;
    const h = hayOf(ps[i]);
    total += h.length + 1;
    buf[i] = h;
    if (i % CHUNK === CHUNK - 1) {
      if (onStep) onStep(i / ps.length);
      await sleep(0); // UIを固めない
    }
  }
  starts[ps.length] = total;
  state.index = { hay: buf.join('\n'), starts };
  state.indexBuilt = true;
}

function searchIndices(q) {
  const ps = state.posts;
  const needle = normText(q);
  if (!needle) return null;
  const words = needle.split(/[ \t\r\n]+/).filter(Boolean);
  const { hay, starts } = state.index;
  let hits = null;
  for (const w of words) {
    const cur = new Uint8Array(ps.length);
    let pos = 0;
    while (pos < hay.length) {
      const at = hay.indexOf(w, pos);
      if (at < 0) break;
      // この位置がどの投稿か二分探索
      let lo = 0, hi = ps.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= at) lo = mid; else hi = mid - 1;
      }
      cur[lo] = 1;
      pos = starts[lo + 1]; // 次の投稿へ
    }
    if (!hits) hits = cur;
    else for (let i = 0; i < hits.length; i++) hits[i] &= cur[i]; // AND（全語を含む投稿のみ）
  }
  return hits;
}

/* ---------------- 絞り込み・ソート・描画 ---------------- */
function buildUserList() {
  const count = new Map();
  for (const p of state.posts) if (p.username) count.set(p.username, (count.get(p.username) || 0) + 1);
  const users = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  el.from.innerHTML = '<option value="">全ユーザー (' + fmtNum(state.posts.length) + ')</option>' +
    users.slice(0, 500).map(([u, c]) => `<option value="${esc(u)}">${esc(u)} (${fmtNum(c)})</option>`).join('');
  el.from.value = '';
  state.from = '';
  el.from.classList.toggle('hidden', users.length <= 1);
  // 全ユーザー選択時の表示は件数なしで短く
  el.from.options[0].textContent = '全ユーザー';
}

const cmp = {
  new: (a, b) => (b.dateMs - a.dateMs) || (b.i - a.i),
  old: (a, b) => (a.dateMs - b.dateMs) || (a.i - b.i),
  user: (a, b) => a.username.localeCompare(b.username, 'ja') || (b.dateMs - a.dateMs),
  media: (a, b) => (b.media.length > 1) - (a.media.length > 1) || (b.dateMs - a.dateMs),
};

let refreshTimer = 0;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { doRefresh(); }, SEARCH_DEBOUNCE);
}
function doRefresh(keepScroll) {
  if (!state.posts.length) { render(); return; }
  let list;
  if (state.q) {
    if (!state.indexBuilt) {
      // インデックス未構築なら簡易逐次検索（数万件なら十分速い）
      const n = normText(state.q).split(/[ \t\r\n]+/).filter(Boolean);
      list = state.posts.filter((p) => { const h = hayOf(p); return n.every((w) => h.includes(w)); });
    } else {
      const hits = searchIndices(state.q);
      list = [];
      if (hits) for (let i = 0; i < hits.length; i++) if (hits[i]) list.push(state.posts[i]);
    }
  } else {
    list = state.posts.slice();
  }
  if (state.from) list = list.filter((p) => p.username === state.from);
  list.sort(cmp[state.sort] || cmp.new);
  state.view = list;
  state.shown = 0;
  el.list.innerHTML = '';
  if (!keepScroll) window.scrollTo({ top: 0 }); // 検索・並べ替え時は先頭から
  render(true);
}

/* 検索ヒットを黄色でハイライト。
 * 「ア」と「ｱ」、「東京」と「ﾄｳｷｮｳ」のような NFKC の揺れも拾いつつ、元の文字をそのまま表示する。 */
/* 1文字をカナ比較用コードに（NFKC で半角ｶﾅ→全角、かな→カナ） */
const HIRA2KATA_GAP = 0x60;
function kanaCode(ch) {
  let c = ch;
  try { c = ch.normalize('NFKC'); } catch (_) {}
  let code = c.charCodeAt(0);
  if (code >= 0x3041 && code <= 0x3096) code += HIRA2KATA_GAP;
  return code;
}
function kanaEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (kanaCode(a[i]) !== kanaCode(b[i])) return false;
  return true;
}
/* かなの連続（カタカナ・ひらがな・長音・半角カナ） */
const KANA_RUN = /[\u30a1-\u30f6\u30fc\uff66-\uff9f]+|[\u3041-\u3096]+/gu;
function hasKana(w) { return /[\u3041-\u3096\u30a1-\u30f6\uff66-\uff9f]/.test(w); }
function onlyKana(w) { return /^[\u3041-\u3096\u30a1-\u30f6\uff66-\uff9f\u30fc]+$/.test(w); }
function highlight(text) {
  if (!state.q) return esc(text);
  const raw = String(text);
  const q = normText(state.q);
  const words = [...new Set(q.split(/[ \t\r\n]+/).filter(Boolean))];
  const marks = new Array(raw.length).fill(false);
  for (const w of words) {
    if (!w || w.length > 60) continue;
    if (hasKana(w)) {
      // かなは NFKC で全角/半角・ひらがな/カタカナが変わるため、かな単位で比較する
      const re = new RegExp(KANA_RUN.source, 'gu');
      let m;
      while ((m = re.exec(raw))) {
        const seg = m[0];
        if (seg.length === w.length && kanaEq(seg, w)) {
          for (let k = m.index; k < m.index + seg.length; k++) marks[k] = true;
        }
        if (re.lastIndex === m.index) re.lastIndex++;
      }
      // かな以外を含む語（例: 「東京ﾗｰﾒﾝ」「Lv2つ」）は通常探索でも補う
      if (!onlyKana(w)) markPlain(raw, w, marks);
    } else {
      markPlain(raw, w, marks);
    }
  }
  // マークを <span class="hit"> で囲む
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (marks[i]) {
      let j = i;
      while (j < raw.length && marks[j]) j++;
      out += '<span class="hit">' + esc(raw.slice(i, j)) + '</span>';
      i = j;
    } else {
      let j = i;
      while (j < raw.length && !marks[j]) j++;
      out += esc(raw.slice(i, j));
      i = j;
    }
  }
  return out;
}
function markPlain(raw, w, marks) {
  const lower = raw.toLowerCase();
  const nf = normText(raw);
  if (lower.length === raw.length) {
    let pos = 0;
    while (true) {
      const at = lower.indexOf(w, pos);
      if (at < 0) break;
      for (let k = at; k < at + w.length; k++) marks[k] = true;
      pos = at + w.length;
    }
  } else if (nf.length === raw.length) {
    let pos = 0;
    while (true) {
      const at = nf.indexOf(w, pos);
      if (at < 0) break;
      for (let k = at; k < at + w.length; k++) marks[k] = true;
      pos = at + w.length;
    }
  }
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function render(reset) {
  if (reset) el.list.innerHTML = '';
  const total = state.posts.length;
  if (!total) {
    renderMetaEmpty();
    return;
  }
  const v = state.view;
  if (!v.length) {
    updateStatus();
    el.list.innerHTML = '<div class="empty">該当する投稿がありません</div>';
    renderMoreButton(false);
    return;
  }
  const end = Math.min(v.length, state.shown + PAGE_SIZE);
  const frag = document.createDocumentFragment();
  for (let i = state.shown; i < end; i++) frag.appendChild(card(v[i]));
  el.list.appendChild(frag);
  state.shown = end;
  renderMoreButton(state.shown < v.length);
  updateStatus();
}

function renderMetaEmpty() {
  updateStatus();
  el.list.innerHTML = '';
}

function renderMoreButton(more) {
  const old = el.list.querySelector('.more');
  if (old) old.remove();
  if (!more) return;
  const div = document.createElement('div');
  div.className = 'more';
  const b = document.createElement('button');
  b.className = 'btn primary';
  b.textContent = 'さらに読み込む';
  b.onclick = () => { render(); updateStatus(); }; // ページ数表示を更新（スクロール位置は保つ）
  div.appendChild(b);
  el.list.appendChild(div);
}

function card(p) {
  const d = document.createElement('article');
  d.className = 'card';
  d.dataset.i = p.i;
  const head = document.createElement('header');
  const u = document.createElement('span');
  u.className = 'uname';
  u.textContent = p.username ? '@' + p.username : '(ユーザー不明)';
  const t = document.createElement('time');
  t.className = 'time';
  t.dateTime = p.date || '';
  t.textContent = fmtDate(p.dateMs) || esc(p.date || '');
  head.append(u, t);
  if (p.url) {
    const a = document.createElement('a');
    a.className = 'ilink';
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '投稿を開く ↗';
    head.appendChild(a);
  }
  d.appendChild(head);

  const body = document.createElement('div');
  body.className = 'text';
  body.innerHTML = highlight(p.text || '');
  d.appendChild(body);

  const extra = document.createElement('div');
  extra.className = 'extras';
  if (p.avatars && p.avatars.length) {
    const av = document.createElement('div');
    av.className = 'avatars';
    for (const m of p.avatars) av.appendChild(avatar(m));
    extra.appendChild(av);
  }
  if (p.media.length) {
    const g = document.createElement('div');
    g.className = 'media' + (p.media.length === 1 ? ' single' : '');
    for (const m of p.media) g.appendChild(thumb(m));
    extra.appendChild(g);
  }
  if (extra.childNodes.length) d.appendChild(extra);
  return d;
}

/* ID画像（アバター）: 小さなサムネとして横に並べる */
function avatar(src) {
  const a = document.createElement('a');
  a.className = 'avatar';
  a.href = src;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'プロフィール画像を開く';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.onerror = () => { a.classList.add('broken'); };
  img.src = mediaUrl(src).replace(/_normal(\.(png|jpe?g|webp))/i, '_bigger$1'); // 小表示だがRetinaで見えるよう少し大きめ
  a.appendChild(img);
  return a;
}

function thumb(src) {
  const isVideo = src.endsWith('#video');
  const url = isVideo ? src.slice(0, -6) : src;
  const a = document.createElement('a');
  a.className = 'thumb';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const fb = document.createElement('div');
  fb.className = 'fallback';
  fb.innerHTML = '<span class="icon">🖼</span><span>' +
    (navigator.onLine ? '画像を表示できません' : 'オフライン') +
    (isVideo ? '<br>動画 ↗' : '<br>タップで開く') + '</span>';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.onload = () => { img.classList.add('ok'); fb.remove(); };
  img.onerror = () => {
    img.remove();
    // オフライン用の案内は残す。オンラインで取得失敗なら要素ごと詰める
    if (navigator.onLine) { a.remove(); const p = a.parentNode; if (p && p.classList.contains('media') && !p.children.length) p.remove(); }
  };
  if (!navigator.onLine) {
    // オフライン時は最初からプレースホルダ
    a.appendChild(fb);
  } else {
    img.src = mediaUrl(url);
    a.appendChild(img);
    a.appendChild(fb);
  }
  return a;
}

function renderKeys() {
  const k = state.keys;
  const rows = Object.keys(k).map((name) => `<tr><td>${esc(name)}</td><td>${esc(k[name].used)}</td><td>${esc(k[name].note)}</td></tr>`).join('');
  el.keysTable.innerHTML = '<tr><th>キー</th><th>認識</th><th>備考</th></tr>' + rows;
  el.keysHelp.textContent = `ファイル: ${state.source} ・ ${fmtNum(state.posts.length)}件 ・ 全文検索インデックス: ${state.indexBuilt ? 'あり' : 'なし（簡易検索）'}`;
  el.badge.textContent = fmtNum(state.posts.length);
  el.badge.title = state.source;
  el.badge.classList.toggle('hidden', !state.posts.length);
}

/* ヘッダー右上の件数表示（主なステータス表示） */
function updateStatus() {
  if (!state.posts.length) { el.meta.textContent = 'JSONを開くと端末内で表示します'; return; }
  const total = state.posts.length;
  const v = state.view.length;
  const pages = Math.max(1, Math.ceil(v / PAGE_SIZE));
  const page = Math.min(pages, Math.floor(state.shown / PAGE_SIZE) + 1);
  const filtered = !!(state.q || state.from);
  el.meta.textContent = fmtNum(v) + '件' + (filtered ? ' / ' + fmtNum(total) : '') + '・' + page + '/' + fmtNum(pages) + 'p';
  el.meta.title = (state.source ? state.source + ' ・ ' : '') + fmtNum(total) + '件 ・ 全' + fmtNum(pages) + 'ページ' + (filtered ? '（絞り込み中）' : '');
}

/* ---------------- イベント ---------------- */
el.open.addEventListener('click', openWithPicker);
el.file.addEventListener('change', (e) => { if (e.target.files && e.target.files.length) loadFiles(e.target.files); });
el.wide.addEventListener('click', async () => {
  if (!state.posts.length) return;
  el.wide.disabled = true;
  el.wide.textContent = '構築中…';
  showProgress(2);
  await buildIndexAsync((r) => showProgress(2 + r * 96));
  hideProgress();
  el.wide.classList.add('hidden');
  el.wide.disabled = false;
  el.wide.textContent = '全文検索を有効化';
  renderKeys();
  doRefresh();
  toast('全文検索インデックスを構築しました');
});

let qTimer = 0;
el.q.addEventListener('input', () => {
  const v = el.q.value;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = v.trim(); refresh(); }, SEARCH_DEBOUNCE);
});
el.q.addEventListener('search', () => { state.q = el.q.value.trim(); refresh(); });
el.sort.addEventListener('change', () => { state.sort = el.sort.value; doRefresh(); });
el.from.addEventListener('change', () => { state.from = el.from.value; doRefresh(); });
function clearFilters(focus) {
  el.q.value = ''; state.q = '';
  el.from.value = ''; state.from = '';
  doRefresh();
  window.scrollTo({ top: 0 });
  if (focus) el.q.focus({ preventScroll: true });
}
$('topClear').addEventListener('click', () => clearFilters(false));
$('clearQ').addEventListener('click', () => clearFilters(true));
$('keysBtn').addEventListener('click', () => {
  const d = el.keysBox;
  d.open = !d.open;
  if (d.open) {
    const close = (e) => { if (!d.contains(e.target)) { d.open = false; document.removeEventListener('click', close, true); } };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }
});
el.list.addEventListener('click', (e) => {
  const b = e.target.closest('.more button');
  if (b) render();
});

// ドラッグ＆ドロップ（PC用）
let dragN = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { dragN++; el.drop.classList.add('on'); } });
window.addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) el.drop.classList.remove('on'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; el.drop.classList.remove('on'); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

// オンライン/オフライン
window.addEventListener('online', () => { toast('オンライン：画像を表示します'); if (state.posts.length) doRefresh(); });
window.addEventListener('offline', () => toast('オフライン：画像はタップで後から開けます', true));

// ?load=<url> で直接読み込む（同一オリジンにJSONを置いたとき用）
(async function autoLoad() {
  const m = location.search.match(/[?&]load=([^&]+)/);
  if (m) {
    try {
      const url = decodeURIComponent(m[1]);
      el.meta.textContent = '読み込み中… ' + url;
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const file = new File([await res.blob()], url.split('/').pop() || 'archive.json', { type: 'application/json' });
      await loadFiles([file]);
      return;
    } catch (e) { toast('自動読み込みに失敗: ' + e.message, true); }
  }
  tryRestore();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
