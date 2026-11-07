#!/usr/bin/env python3
"""X archive JSON viewer for Termux. Open in a browser and search locally."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json, html, urllib.parse, mimetypes, os, sys

ROOT = Path.cwd()
HOST, PORT = "127.0.0.1", 8765

PAGE = r'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X Archive Viewer</title><style>
:root{color-scheme:light;--bg:#fff;--card:#fff;--line:#d8dde5;--muted:#5f6b7a;--accent:#1769aa;--hit:#d60000}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#18202a;font:15px system-ui,-apple-system,sans-serif}header{position:sticky;top:0;z-index:2;padding:12px;background:#fffffff2;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}h1{font-size:18px;margin:0 0 8px}.toolbar{display:flex;gap:8px;flex-wrap:wrap}input,button,select{font:inherit;border:1px solid #bfc7d2;border-radius:8px;background:#fff;color:#18202a;padding:9px}input{flex:1;min-width:180px}button{cursor:pointer}.hint{color:var(--muted);font-size:12px;margin-top:7px}main{max-width:850px;margin:auto;padding:12px}.post{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 12px;padding:14px;box-shadow:0 1px 3px #18202a12}.meta{color:var(--muted);font-size:13px;display:flex;gap:8px;flex-wrap:wrap}.meta a,.url{color:var(--accent);text-decoration:none}.text{white-space:pre-wrap;line-height:1.6;margin:12px 0}.media{max-width:100%;border-radius:8px;margin-top:7px}.empty{padding:40px 10px;text-align:center;color:var(--muted)}mark{background:transparent;color:var(--hit);font-weight:700}.count{color:var(--muted);font-size:13px;margin:10px 0}.pager{display:flex;justify-content:center;gap:8px;margin:18px 0}</style></head><body><header><h1>📦 X JSON Archive</h1><div class="toolbar"><input id="q" placeholder="本文・ユーザー名・日付・URLを検索…"><select id="sort"><option value="new">新しい順</option><option value="old">古い順</option></select><button id="clear">検索をクリア</button><button id="open">JSONを開く</button><input id="file" type="file" accept=".json,application/json" hidden></div><div class="hint">JSONファイルを選択すると、この端末内だけで表示します。</div></header><main><div id="count" class="count"></div><section id="list"></section><div class="pager"><button id="prev">‹ 前へ</button><button id="next">次へ ›</button></div></main><script>
let data={posts:[]}, filtered=[], page=0; const size=20;
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function highlight(s,q){let t=esc(s);if(!q)return t;let parts=q.trim().split(/\s+/).filter(Boolean).map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));if(!parts.length)return t;return t.replace(new RegExp('('+parts.join('|')+')','gi'),'<mark>$1</mark>')}
function render(){let q=$('q').value.trim().toLowerCase();filtered=(data.posts||[]).filter(p=>!q||[p.username,p.text,p.date,p.url,p.id].some(v=>String(v??'').toLowerCase().includes(q)));filtered.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));if($('sort').value==='old')filtered.reverse();let total=filtered.length,pages=Math.max(1,Math.ceil(total/size));page=Math.min(page,pages-1);$('count').textContent=`${total}件 / 全${(data.posts||[]).length}件 · ${page+1}/${pages}ページ`;let rows=filtered.slice(page*size,(page+1)*size);$('list').innerHTML=rows.length?rows.map(p=>`<article class="post"><div class="meta"><b>${highlight(p.username?'@'+p.username:'',q)}</b><span>${esc(p.date||'')}</span><a href="${esc(p.url||'#')}" target="_blank" rel="noreferrer">投稿を開く</a></div><div class="text">${highlight(p.text||'',q)}</div>${(p.media||[]).map(u=>`<a href="${esc(u)}" target="_blank" rel="noreferrer"><img class="media" src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</article>`).join(''):'<div class="empty">該当する投稿はありません。</div>';$('prev').disabled=page===0;$('next').disabled=page>=pages-1}
function load(obj){data=Array.isArray(obj)?{posts:obj}:obj||{posts:[]};if(!Array.isArray(data.posts))data.posts=[];const seen=new Set();data.posts=data.posts.filter(p=>{const rawId=String(p?.id??'').trim();const url=String(p?.url??'').trim().replace(/\?.*$/,'').replace(/\/$/,'');const m=url.match(/(?:status|statuses)\/(\d+)/i);const k=m?m[1]:rawId||[String(p?.username??'').trim().toLowerCase(),String(p?.date??'').trim(),String(p?.text??'').replace(/\s+/g,' ').trim(),url].join('|');if(!k||seen.has(k))return false;seen.add(k);return true});page=0;render()}
$('open').onclick=()=>$('file').click();$('file').onchange=async e=>{let f=e.target.files[0];if(!f)return;try{load(JSON.parse(await f.text()))}catch(x){alert('JSONを読み込めませんでした。')}};$('q').oninput=()=>{page=0;render()};$('sort').onchange=()=>{page=0;render()};$('clear').onclick=()=>{$('q').value='';page=0;render()};$('prev').onclick=()=>{page--;render();scrollTo(0,0)};$('next').onclick=()=>{page++;render();scrollTo(0,0)};render();
</script></body></html>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?', 1)[0] != '/':
            self.send_error(404); return
        body = PAGE.encode()
        self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass

if __name__ == '__main__':
    print(f'X JSON Viewer: http://{HOST}:{PORT}')
    print('ブラウザでJSONを選択してください。終了: Ctrl+C')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
