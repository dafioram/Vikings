// The launcher of the browser build: the game files the player uploads live in /game, an
// IndexedDB-backed directory (Emscripten IDBFS) that is the game's working directory — the
// same relative paths the native build reads beside its executable (DATA.DAT, content/,
// roms/sc55, roms/mt32, v2_options.cfg, vikings_keymap.cfg). Nothing leaves the browser.
'use strict';
(function () {
  const GAME = '/game';
  const DATA_MD5 = 'd0f8a04202070a54d1909758ecd962b5';   // the archive this port is built against (README)
  const DATA_SIZE = 1570444;
  const STATIC = ['ds_static.bin', 'exe_static.bin'];       // the build's own images (embedded at /static), copied at every start
  const CFG = ['v2_options.cfg', 'vikings_keymap.cfg'];
  const EXTRAS = { 'ex-content': 'content', 'ex-sc55': 'roms/sc55', 'ex-mt32': 'roms/mt32' };

  const $ = (id) => document.getElementById(id);
  let FS = null;
  let running = false, ended = false;
  let dataMd5 = null;   // [size, mtime, md5] of the stored archive (the hash is computed once per file)
  const logTail = [];

  function keep(line) {
    logTail.push(line);
    if (logTail.length > 60) logTail.shift();
  }

  // ------------------------------------------------------------------ the environment
  function envProblem() {
    if (typeof WebAssembly !== 'object') return 'This browser has no WebAssembly support.';
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      if (!window.isSecureContext) return 'The page must be served over HTTPS (or from localhost).';
      if (navigator.serviceWorker && !navigator.serviceWorker.controller)
        return 'Enabling cross-origin isolation for the game\'s threads — the page reloads by itself. ' +
               'If it does not, reload it; a private window may block the service worker this needs.';
      return 'This page is not cross-origin isolated, so the game\'s threads (SharedArrayBuffer) are unavailable. ' +
             'Reload the page; a private window may block the service worker this needs.';
    }
    return null;
  }

  // ------------------------------------------------------------------ the file system
  function exists(p) { try { FS.stat(p); return true; } catch (e) { return false; } }
  function isDir(p) { try { return FS.isDir(FS.stat(p).mode); } catch (e) { return false; } }

  function walk(dir, out, rel) {
    out = out || []; rel = rel || '';
    if (!isDir(dir)) return out;
    for (const n of FS.readdir(dir)) {
      if (n === '.' || n === '..') continue;
      const p = dir + '/' + n, r = rel ? rel + '/' + n : n;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) walk(p, out, r);
      else out.push({ path: r, size: st.size, mtime: +st.mtime });
    }
    return out;
  }

  function rmTree(p) {
    if (!exists(p)) return;
    if (isDir(p)) {
      for (const n of FS.readdir(p)) if (n !== '.' && n !== '..') rmTree(p + '/' + n);
      FS.rmdir(p);
    } else FS.unlink(p);
  }

  function writeFile(rel, bytes) {
    const p = GAME + '/' + rel;
    const d = p.slice(0, p.lastIndexOf('/'));
    if (d !== GAME) FS.mkdirTree(d);
    FS.writeFile(p, bytes);
  }

  // IndexedDB write-back; calls arriving while one runs coalesce into one more
  let syncing = null, syncQueued = false;
  function sync() {
    if (!FS) return Promise.resolve();
    if (syncing) { syncQueued = true; return syncing; }
    syncing = new Promise((resolve) => {
      FS.syncfs(false, (err) => {
        if (err) console.warn('IndexedDB sync failed', err);
        syncing = null;
        if (syncQueued) { syncQueued = false; sync().then(resolve); } else resolve();
      });
    });
    return syncing;
  }

  // the archive under its DOS name: the game matches it without regard to case, keep one copy
  function dataPath() {
    for (const n of isDir(GAME) ? FS.readdir(GAME) : []) if (/^data\.dat$/i.test(n)) return GAME + '/' + n;
    return null;
  }

  // ------------------------------------------------------------------ md5 (the archive check)
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = new Int32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  function md5(bytes) {
    const len = bytes.length, nblk = ((len + 8) >>> 6) + 1;
    const buf = new Uint8Array(nblk * 64);
    buf.set(bytes); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, (len * 8) >>> 0, true);
    dv.setUint32(buf.length - 4, Math.floor(len / 0x20000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < buf.length; off += 64) {
      for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const s = MD5_S[(i >> 4) * 4 + (i & 3)];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    let hex = '';
    for (const w of [a0, b0, c0, d0])
      for (let k = 0; k < 4; k++) hex += ((w >>> (8 * k)) & 0xff).toString(16).padStart(2, '0');
    return hex;
  }

  // ------------------------------------------------------------------ zip (the content pack as one file)
  async function unzip(file, want) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a .zip file');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    const td = new TextDecoder(), entries = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('damaged .zip directory');
      const e = {
        method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true),
        lho: dv.getUint32(p + 42, true),
        path: td.decode(buf.subarray(p + 46, p + 46 + dv.getUint16(p + 28, true))),
      };
      p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      if (!e.path.endsWith('/')) entries.push(e);
    }
    const out = [];
    for (const e of want(entries)) {
      const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
      const raw = buf.subarray(start, start + e.csize);
      let data;
      if (e.method === 0) data = raw.slice();
      else if (e.method === 8) {
        const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(s).arrayBuffer());
      } else throw new Error('unsupported compression (method ' + e.method + ') in ' + e.path);
      out.push({ rel: e.rel, data });
    }
    return out;
  }

  // the pack's root is the directory holding .compiled/0000.bin; only .compiled/ and exe_static.bin are the game's
  function packEntries(entries) {
    const anchor = entries.find((e) => /(^|\/)\.compiled\/0000\.bin$/.test(e.path));
    if (!anchor) throw new Error('no .compiled/0000.bin inside — this is not a content pack (make content writes it)');
    const root = anchor.path.slice(0, anchor.path.length - '.compiled/0000.bin'.length);
    const keep = entries.filter((e) => e.path.startsWith(root + '.compiled/') || e.path === root + 'exe_static.bin');
    if (!keep.some((e) => e.path === root + 'exe_static.bin')) throw new Error('no exe_static.bin beside .compiled/ — this is not a content pack');
    for (const e of keep) e.rel = 'content/' + e.path.slice(root.length);
    return keep;
  }

  // ------------------------------------------------------------------ the page
  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  }

  function setStatus(el, text, cls) { el.textContent = text; el.className = 'status' + (cls ? ' ' + cls : ''); }

  function refresh() {
    if (!FS) return;
    const dp = dataPath();
    const st = $('data-status'), warn = $('data-warn');
    warn.hidden = true;
    if (dp) {
      const s = FS.stat(dp);
      if (!dataMd5 || dataMd5[0] !== s.size || dataMd5[1] !== +s.mtime) dataMd5 = [s.size, +s.mtime, md5(FS.readFile(dp))];
      if (dataMd5[2] === DATA_MD5) setStatus(st, 'Stored · ' + fmtSize(s.size) + ' · checksum OK', 'ok');
      else {
        setStatus(st, 'Stored · ' + fmtSize(s.size) + ' · checksum mismatch', 'warn');
        warn.hidden = false;
        warn.textContent = 'This DATA.DAT is not the one the port is built against (md5 ' + dataMd5[2] +
          (s.size !== DATA_SIZE ? ', ' + s.size + ' bytes instead of ' + DATA_SIZE : '') +
          '; expected ' + DATA_MD5 + '). You can still play — but a different release, the Blizzard Arcade ' +
          'Collection repack or a damaged copy may be refused ("Data.dat has been corrupted") or misbehave.';
      }
    } else setStatus(st, 'Not stored', '');
    $('rm-data').hidden = !dp;

    for (const id in EXTRAS) {
      const sec = $(id), files = walk(GAME + '/' + EXTRAS[id]);
      const total = files.reduce((a, f) => a + f.size, 0);
      setStatus(sec.querySelector('[data-status]'),
        files.length ? 'Stored · ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' · ' + fmtSize(total) : 'Not stored',
        files.length ? 'ok' : '');
      sec.querySelector('[data-rm]').hidden = !files.length;
    }
    const cfgs = CFG.filter((n) => exists(GAME + '/' + n));
    $('cfg-list').textContent = cfgs.length ? cfgs.join(', ') : 'none';

    const play = $('play');
    play.disabled = !dp || running;
    play.textContent = dp ? 'Play' : 'Add DATA.DAT to play';
  }

  async function guarded(fn) {
    try { await fn(); }
    catch (e) { console.error(e); alert(e && e.message ? e.message : String(e)); }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
    await sync();
    refresh();
  }

  function wire() {
    $('in-data').addEventListener('change', (ev) => guarded(async () => {
      const f = ev.target.files[0]; ev.target.value = '';
      if (!f) return;
      const old = dataPath(); if (old) FS.unlink(old);
      writeFile('DATA.DAT', new Uint8Array(await f.arrayBuffer()));
    }));
    $('rm-data').addEventListener('click', () => guarded(async () => { const p = dataPath(); if (p) FS.unlink(p); }));

    for (const id in EXTRAS) {
      const sec = $(id), dir = EXTRAS[id];
      sec.querySelectorAll('input[type=file]').forEach((inp) => inp.addEventListener('change', (ev) => guarded(async () => {
        const list = Array.from(ev.target.files); ev.target.value = '';
        if (!list.length) return;
        const kind = inp.dataset.in;
        if (kind === 'files') {   // ROMs: added to what is stored (a set may come in several picks)
          for (const f of list) writeFile(dir + '/' + f.name, new Uint8Array(await f.arrayBuffer()));
          return;
        }
        let got;
        if (kind === 'zip') got = await unzip(list[0], packEntries);
        else {
          const sel = packEntries(list.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
          got = [];
          for (const e of sel) got.push({ rel: e.rel, data: new Uint8Array(await e.file.arrayBuffer()) });
        }
        rmTree(GAME + '/' + dir);   // a pack replaces the stored one whole
        for (const e of got) writeFile(e.rel, e.data);
      })));
      sec.querySelector('[data-rm]').addEventListener('click', () => guarded(async () => rmTree(GAME + '/' + dir)));
    }

    $('rm-cfg').addEventListener('click', () => guarded(async () => {
      for (const n of CFG) if (exists(GAME + '/' + n)) FS.unlink(GAME + '/' + n);
    }));
    $('rm-all').addEventListener('click', () => {
      if (!confirm('Delete DATA.DAT, the extra content and the settings from this browser?')) return;
      guarded(async () => { for (const n of FS.readdir(GAME)) if (n !== '.' && n !== '..') rmTree(GAME + '/' + n); });
    });

    try { $('in-args').value = localStorage.getItem('vikings.args') || ''; } catch (e) { /* storage blocked */ }
    $('play').addEventListener('click', start);

    // the in-game toolbar: shown while the pointer moves
    let hideT = 0;
    $('game').addEventListener('mousemove', () => {
      $('toolbar').classList.add('show');
      clearTimeout(hideT); hideT = setTimeout(() => $('toolbar').classList.remove('show'), 1800);
    });
    $('canvas').addEventListener('contextmenu', (e) => e.preventDefault());
    $('tb-fs').addEventListener('click', () => { const g = $('game'); (g.requestFullscreen || g.webkitRequestFullscreen).call(g); $('canvas').focus(); });
    $('tb-quit').addEventListener('click', () => sync().then(() => location.reload()));
    $('ended-reload').addEventListener('click', () => location.reload());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sync(); });
    window.addEventListener('pagehide', () => { sync(); });
  }

  function parseArgs(s) {
    const out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    return out;
  }

  function start() {
    if (running || !dataPath()) return;
    running = true;
    // the build's images, always this build's (a stored copy of an older deploy is replaced)
    for (const n of STATIC) FS.writeFile(GAME + '/' + n, FS.readFile('/static/' + n));
    if (!exists(GAME + '/vikings_keymap.cfg')) FS.writeFile(GAME + '/vikings_keymap.cfg', FS.readFile('/static/vikings_keymap.cfg'));
    FS.chdir(GAME);
    const argStr = $('in-args').value.trim();
    try { localStorage.setItem('vikings.args', argStr); } catch (e) { /* storage blocked */ }
    // the canvas must be laid out before SDL creates its window: SDL takes the CSS size as the window's
    $('launcher').hidden = true;
    $('game').hidden = false;
    $('canvas').focus();
    setInterval(sync, 5000);   // the options and key bindings the game writes
    Module.callMain(parseArgs(argStr));   // inside the click: the audio context may start
  }

  function gameEnded(what) {
    if (ended) return;
    ended = true; running = false;
    sync();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('canvas').hidden = true; $('toolbar').hidden = true;
    $('ended-title').textContent = what;
    $('ended-log').textContent = logTail.slice(-12).join('\n');
    $('ended').hidden = false;
  }

  // ------------------------------------------------------------------ the Emscripten module
  window.Module = {
    canvas: $('canvas'),
    print: (t) => { console.log(t); keep(t); },
    printErr: (t) => { console.warn(t); keep(t); },
    onRuntimeInitialized() {
      FS = Module.FS;
      FS.mkdir(GAME);
      FS.mount(FS.filesystems.IDBFS, {}, GAME);
      FS.syncfs(true, (err) => {
        if (err) {
          const b = $('env-error'); b.hidden = false;
          b.textContent = 'The browser storage (IndexedDB) could not be read: ' + err + '. Uploads will not persist.';
        }
        refresh();
      });
    },
    onExit: (code) => gameEnded(code ? 'The game exited (code ' + code + ')' : 'The game has ended'),
    onAbort: (what) => gameEnded('The game stopped with an error'),
  };

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    const problem = envProblem();
    if (problem) {
      const b = $('env-error'); b.hidden = false; b.textContent = problem;
      $('play').textContent = 'Unavailable';
      return;
    }
    const s = document.createElement('script');
    s.src = 'vikings.js';
    s.onerror = () => { const b = $('env-error'); b.hidden = false; b.textContent = 'vikings.js could not be loaded.'; };
    document.body.appendChild(s);
  });

})();
