// sjnav service worker. One release = app shell + required map pack, installed and validated together.
// The previous complete release stays in charge until the new one is fully cached; failures never delete it.
const BUILD = 'c5ddd1f7e2', V = 'sjrel-' + BUILD, PACKURL = 'pack_big.bin.gz?v=6', PACKBYTES = 26604586;
const T_CACHE = self.__t1 || 4000, T_NET = self.__t2 || 20000, T_PACK = self.__t3 || 180000;
const SHELL = ['./', 'index.html'];
async function packOK(r) { // size and gzip magic must match what the build recorded
  try { const b = new Uint8Array(await r.clone().arrayBuffer()); return b.byteLength === PACKBYTES && b[0] === 0x1f && b[1] === 0x8b; } catch (e) { return false; }
}
async function complete(c) {
  for (const u of SHELL) if (!(await c.match(u))) return false;
  const p = await c.match(PACKURL); return !!p && await packOK(p);
}
async function timed(url, ms = T_PACK, opts = {}) { // one deadline covers headers AND body
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, Object.assign({ signal: ac.signal }, opts)); await r.clone().arrayBuffer(); return r; } finally { clearTimeout(to); }
}
const marked = html => html.indexOf('name="sj-build" content="' + BUILD + '"') >= 0;
const isPage = u => u.pathname.endsWith('/') || u.pathname.endsWith('index.html');
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    if (await caches.has(V)) { const c0 = await caches.open(V); if (await complete(c0)) return; await caches.delete(V); } // same release already complete: leave it alone; leftovers of a failed attempt are rebuilt
    const c = await caches.open(V);
    try {
      for (const u of SHELL) { // bypass the HTTP cache, and require the page to be the same build as this worker
        const rs = await timed(u, T_NET, { cache: 'reload' }); if (!rs.ok) throw new Error('shell ' + rs.status);
        const html = await rs.clone().text(); if (!marked(html)) throw new Error('shell is a different build');
        await c.put(u, rs);
      }
      const r = await timed(PACKURL); if (!r.ok) throw new Error('pack ' + r.status);
      if (!(await packOK(r))) throw new Error('pack failed validation');
      await c.put(PACKURL, r);
      if (!(await complete(c))) throw new Error('release incomplete');
    } catch (err) { try { await caches.delete(V); } catch (x) { } throw err; } // install fails: previous release keeps running
  })());
  // no skipWaiting: the new release takes over when old pages close, so a page never mixes generations
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== V && (k.startsWith('sjrel-') || k.startsWith('sjapp-') || k === 'sjpack')).map(k => caches.delete(k))); // only after V is complete
    await self.clients.claim();
  })());
});
const inV = async (req, o) => { const c = await caches.open(V); return (await c.match(req, o)) || null; }; // lookups are scoped to this release
function shell(req) {
  return new Promise(resolve => {
    let done = false; const fin = r => { if (!done) { done = true; resolve(r); } };
    const fromCache = () => inV(req, isPage(new URL(req.url)) ? { ignoreSearch: true } : undefined).catch(() => null); // /?utm=1 offline still gets this release's page
    const ac = new AbortController(), kill = setTimeout(() => ac.abort(), T_NET);
    const timer = setTimeout(() => { fromCache().then(r => { if (r) fin(r); }); }, T_CACHE); // slow network: use this release's copy if present, else keep waiting
    fetch(req, { signal: ac.signal }).then(n => {
      clearTimeout(timer); clearTimeout(kill);
      const u = new URL(req.url);
      if (n.ok && isPage(u)) { // a page from a DIFFERENT build must not enter or replace this release; keep serving this release's copy
        n.clone().text().then(t => { if (marked(t)) { caches.open(V).then(c => c.put(req, n.clone())).catch(() => { }); fin(n); } else fromCache().then(r => fin(r || n)); }).catch(() => fromCache().then(r => fin(r || n)));
      } else if (n.ok) fin(n); // other same-origin files: passed through, never added to the release
      else fromCache().then(r => fin(r || n)); // 404/5xx: prefer this release's good copy
    }).catch(() => { clearTimeout(timer); clearTimeout(kill); fromCache().then(r => fin(r || Response.error())); }); // always settles
  });
}
async function pack(req) {
  const r = await inV(req).catch(() => null); if (r) return r;
  try { return await timed(req.url); } catch (e) { return Response.error(); } // bounded: never hangs
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // never touch TomTom or other origins
  e.respondWith(u.pathname.endsWith('.bin.gz') ? pack(e.request) : shell(e.request));
});
