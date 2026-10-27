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
  const SAVE_RE = /^v2_save_([1-9])\.state$/;            // the game's save slots (F2 / F3, --save-states)
  const BUILD = '__BUILD__';                              // this launcher's deploy (written by the Makefile)

  const $ = (id) => document.getElementById(id);
  let FS = null;
  let running = false, ended = false, firstRefresh = true;
  let padsWanted = 1, padHintDismissed = false, toastT = 0;
  const pads = new Map();   // player -> the controller's name (the game's own assignment, from its log)
  let liveBuild = null;     // version.json of the deploy being served: { build, date, wasm }
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

  // a .zip of the given files, stored (the game files hardly compress, and a backup must be quick)
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipBlob(files) {   // [{ path, data, mtime }]
    const te = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = te.encode(f.path), crc = crc32(f.data), n = f.data.length, d = new Date(f.mtime || Date.now());
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const lh = new DataView(new ArrayBuffer(30)), ch = new DataView(new ArrayBuffer(46));
      for (const [v, base] of [[lh, 4], [ch, 6]]) {   // the fields both headers share, at their offsets
        v.setUint16(base, 20, true); v.setUint16(base + 2, 0x0800, true);   // version 2.0, UTF-8 names
        v.setUint16(base + 6, time, true); v.setUint16(base + 8, date, true);
        v.setUint32(base + 10, crc, true); v.setUint32(base + 14, n, true); v.setUint32(base + 18, n, true);
        v.setUint16(base + 22, name.length, true);
      }
      lh.setUint32(0, 0x04034b50, true);
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint32(42, off, true);
      parts.push(lh, name, f.data); central.push(ch, name);
      off += 30 + name.length + n;
      if (off > 0xffffffff) throw new Error('the backup is over 4 GB');
    }
    const cd = central.reduce((a, p) => a + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cd, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // what a backup carries and gives back: the game files (optional on export), the settings, the slots
  function isGameData(p) {
    return /^data\.dat$/i.test(p) || p === 'content/exe_static.bin' || /^content\/\.compiled\/[^/]+$/.test(p) ||
           /^roms\/(sc55|mt32)\/[^/]+$/.test(p);
  }
  function isBackupFile(p) { return isGameData(p) || CFG.includes(p) || SAVE_RE.test(p); }

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

    let anyExtra = false;
    for (const id in EXTRAS) {
      const sec = $(id), files = walk(GAME + '/' + EXTRAS[id]);
      anyExtra = anyExtra || files.length > 0;
      const total = files.reduce((a, f) => a + f.size, 0);
      setStatus(sec.querySelector('[data-status]'),
        files.length ? 'Stored · ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' · ' + fmtSize(total) : 'Not stored',
        files.length ? 'ok' : '');
      sec.querySelector('[data-rm]').hidden = !files.length;
    }
    // the save slots, newest first
    const slots = (isDir(GAME) ? FS.readdir(GAME) : []).filter((n) => SAVE_RE.test(n))
      .map((n) => ({ n, slot: +SAVE_RE.exec(n)[1], st: FS.stat(GAME + '/' + n) }))
      .sort((a, b) => b.st.mtime - a.st.mtime);
    const ul = $('slot-list');
    ul.textContent = '';
    for (const s of slots) {
      const li = document.createElement('li'), label = document.createElement('span'), when = document.createElement('span');
      label.textContent = 'Slot ' + s.slot + ' ';
      when.className = 'when'; when.textContent = new Date(s.st.mtime).toLocaleString() + ' · ' + fmtSize(s.st.size);
      label.appendChild(when);
      const rm = document.createElement('button');
      rm.className = 'btn ghost small'; rm.textContent = 'Remove'; rm.dataset.slot = s.n;
      li.append(label, rm); ul.appendChild(li);
    }
    if (!slots.length) { const li = document.createElement('li'); li.className = 'when'; li.textContent = 'No save states yet.'; ul.appendChild(li); }

    if (firstRefresh && anyExtra) $('sec-extra').open = true;   // what is stored is in view at the start
    if (firstRefresh && slots.length) $('sec-saves').open = true;
    firstRefresh = false;
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
    // DATA.DAT from the picker or dropped on the page: stored under its DOS name, one copy
    const storeData = (f) => guarded(async () => {
      const old = dataPath(); if (old) FS.unlink(old);
      writeFile('DATA.DAT', new Uint8Array(await f.arrayBuffer()));
    });
    $('in-data').addEventListener('change', (ev) => {
      const f = ev.target.files[0]; ev.target.value = '';
      if (f) storeData(f);
    });
    // a file dragged over the launcher lands on the DATA.DAT card; over a running game a drop
    // is swallowed (the browser's default would open the file in place of the game)
    let dragDepth = 0;
    const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const dragOff = () => { dragDepth = 0; document.body.classList.remove('dragging'); };
    window.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (!running && FS && dragDepth++ === 0) document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = running || !FS ? 'none' : 'copy';
    });
    window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) dragOff(); });
    window.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragOff();
      if (running || !FS) return;
      const files = Array.from(e.dataTransfer.files);
      const f = files.find((x) => /\.dat$/i.test(x.name));
      if (f) storeData(f);
      else alert('Drop the game\u2019s DATA.DAT file' + (files.length ? ' (got ' + files.map((x) => x.name).join(', ') + ')' : '') +
                 '. Extra content and backups have their own buttons.');
    });
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

    $('slot-list').addEventListener('click', (ev) => {
      const n = ev.target.dataset && ev.target.dataset.slot;
      if (n && confirm('Remove the save state in ' + n.replace(SAVE_RE, 'slot $1') + '?')) guarded(async () => FS.unlink(GAME + '/' + n));
    });
    $('bk-export').addEventListener('click', () => guarded(async () => {
      const withData = $('bk-data').checked;
      const files = walk(GAME).filter((f) => isBackupFile(f.path) && (withData || !isGameData(f.path)));
      if (!files.length) throw new Error('Nothing to back up yet.');
      const blob = zipBlob(files.map((f) => ({ path: f.path, data: FS.readFile(GAME + '/' + f.path), mtime: f.mtime })));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lost-vikings-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }));
    $('bk-import').addEventListener('change', (ev) => guarded(async () => {
      const f = ev.target.files[0]; ev.target.value = '';
      if (!f) return;
      // only the files a backup carries, under their own paths (a stray .zip writes nothing else)
      const got = await unzip(f, (entries) => entries.filter((e) => isBackupFile(e.path)).map((e) => Object.assign(e, { rel: e.path })));
      if (!got.length) throw new Error('This .zip holds no files of a backup (DATA.DAT, settings, save states, extra content).');
      if (got.some((e) => /^data\.dat$/i.test(e.rel))) { const old = dataPath(); if (old) FS.unlink(old); }
      for (const e of got) writeFile(e.rel, e.data);
    }));

    $('rm-cfg').addEventListener('click', () => guarded(async () => {
      for (const n of CFG) if (exists(GAME + '/' + n)) FS.unlink(GAME + '/' + n);
    }));
    $('rm-all').addEventListener('click', () => {
      if (!confirm('Delete DATA.DAT, the extra content and the settings from this browser?')) return;
      guarded(async () => { for (const n of FS.readdir(GAME)) if (n !== '.' && n !== '..') rmTree(GAME + '/' + n); });
    });

    try {
      $('in-args').value = localStorage.getItem('vikings.args') || '';
      const pl = localStorage.getItem('vikings.players');
      if (pl === '1' || pl === '2' || pl === '3') $('in-players').value = pl;
    } catch (e) { /* storage blocked */ }
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

  // ------------------------------------------------------------------ the controllers
  // The game assigns the pads (v2_coop_pad_added: the first free player, the first pad beside the
  // keyboard as player 1) and logs it; the page shows what it did, and while a co-op game still
  // waits for pads, how many are missing — a browser shows a pad only after one of its buttons.
  function toast(text) {
    const el = $('pad-toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function padHint() {
    const el = $('pad-hint'), need = padsWanted >= 2 ? padsWanted : 0;
    if (!running || padHintDismissed || !need || pads.size >= need) { el.hidden = true; return; }
    $('pad-hint-text').textContent = pads.size === 0
      ? 'Co-op: press a button on each controller to connect it — ' + need + ' needed (the first one plays player 1 with the keyboard).'
      : 'Co-op: ' + pads.size + ' of ' + need + ' controllers connected — press a button on the next one.';
    el.hidden = false;
  }
  function padLog(t) {
    let m = /^v2_coop: controller '(.*)' -> player (\d)/.exec(t);
    if (m) { pads.set(+m[2], m[1]); toast('🎮 ' + m[1] + ' → Player ' + m[2]); padHint(); return; }
    m = /^v2_coop: player (\d)'s controller removed/.exec(t);
    if (m) { pads.delete(+m[1]); toast('Player ' + m[1] + '’s controller disconnected'); padHint(); return; }
    if (/^v2_coop: controller \d+ ignored/.test(t)) toast('Controller not used — every player already has one');
  }

  // ------------------------------------------------------------------ loading
  function progress(frac, text) {
    const bar = $('load-bar'), st = $('load-status');
    bar.hidden = frac === null; if (frac !== null) bar.firstElementChild.style.width = (frac * 100).toFixed(1) + '%';
    st.hidden = !text; st.textContent = text || '';
  }
  // the module, counted as it arrives (compiled while it streams): the size comes from version.json,
  // the transfer itself may be compressed
  async function loadWasm(url, imports) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
    const size = liveBuild && liveBuild.wasm;
    let src = resp;
    if (resp.body && size > 0) {
      const reader = resp.body.getReader();
      let got = 0;
      src = new Response(new ReadableStream({
        async pull(ctl) {
          const r = await reader.read();
          if (r.done) { progress(1, 'Compiling…'); ctl.close(); return; }
          got += r.value.length;
          progress(Math.min(got / size, 1), 'Downloading the game ' + fmtSize(got) + ' of ' + fmtSize(size));
          ctl.enqueue(r.value);
        },
      }), { headers: { 'Content-Type': 'application/wasm' } });
    } else progress(null, 'Downloading the game…');
    try { return await WebAssembly.instantiateStreaming(src, imports); }
    catch (e) {
      if (e instanceof WebAssembly.LinkError || e instanceof WebAssembly.CompileError) throw e;
      progress(null, 'Compiling…');   // a browser without streaming instantiation
      return WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), imports);
    }
  }
  // a module of another deploy than its loader (a cache that kept one of them): one reload, then the error
  function reloadOnce(why) {
    let tried = false;
    try { tried = sessionStorage.getItem('vikings.reloaded') === why; sessionStorage.setItem('vikings.reloaded', why); } catch (e) { tried = true; }
    if (!tried) location.reload();
    return !tried;
  }

  function start() {
    if (running || !dataPath()) return;
    running = true;
    // the build's images, always this build's (a stored copy of an older deploy is replaced)
    for (const n of STATIC) FS.writeFile(GAME + '/' + n, FS.readFile('/static/' + n));
    if (!exists(GAME + '/vikings_keymap.cfg')) FS.writeFile(GAME + '/vikings_keymap.cfg', FS.readFile('/static/vikings_keymap.cfg'));
    FS.chdir(GAME);
    const argStr = $('in-args').value.trim(), players = $('in-players').value;
    try { localStorage.setItem('vikings.args', argStr); localStorage.setItem('vikings.players', players); } catch (e) { /* storage blocked */ }
    // the Players choice (--coop=N); a --coop= of the arguments wins
    const args = parseArgs(argStr);
    if (!args.some((a) => a.startsWith('--coop='))) args.unshift('--coop=' + players);
    if (!args.includes('--save-states')) args.push('--save-states');   // F2 / F3 without --debug's cheats
    const coop = args.find((a) => a.startsWith('--coop='));
    padsWanted = coop ? parseInt(coop.slice(7), 10) || 1 : 1;
    // the canvas must be laid out before SDL creates its window: SDL takes the CSS size as the window's
    $('launcher').hidden = true;
    $('game').hidden = false;
    $('canvas').focus();
    setInterval(sync, 5000);   // the options and key bindings the game writes
    Module.callMain(args);   // inside the click: the audio context may start
    padHint();
  }

  function gameEnded(what) {
    if (ended) return;
    ended = true; running = false;
    sync();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('canvas').hidden = true; $('toolbar').hidden = true; $('pad-hint').hidden = true; $('pad-toast').hidden = true;
    $('ended-title').textContent = what;
    $('ended-log').textContent = logTail.slice(-12).join('\n');
    $('ended').hidden = false;
  }

  // ------------------------------------------------------------------ the Emscripten module
  window.Module = {
    canvas: $('canvas'),
    print: (t) => { console.log(t); keep(t); },
    printErr: (t) => { console.warn(t); keep(t); padLog(t); },
    // the module and the files it locates, under the served deploy's build: a cached copy of
    // another deploy's is never taken for this one's
    locateFile: (path) => path + '?v=' + encodeURIComponent((liveBuild && liveBuild.build) || BUILD),
    instantiateWasm(imports, done) {
      loadWasm(Module.locateFile('vikings.wasm'), imports).then((r) => done(r.instance, r.module), (e) => {
        console.error(e);
        if (e instanceof WebAssembly.LinkError && reloadOnce('link:' + BUILD)) return;
        progress(null, '');
        const b = $('env-error'); b.hidden = false;
        b.textContent = 'The game could not be loaded: ' + (e && e.message ? e.message : e) +
          (e instanceof WebAssembly.LinkError ? ' — a new version is being deployed; reload in a minute.' : '');
        $('play').textContent = 'Unavailable';
      });
      return {};
    },
    onRuntimeInitialized() {
      progress(null, '');
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

  document.addEventListener('DOMContentLoaded', async () => {
    wire();
    $('pad-hint-close').addEventListener('click', () => { padHintDismissed = true; padHint(); $('canvas').focus(); });
    const problem = envProblem();
    if (problem) {
      const b = $('env-error'); b.hidden = false; b.textContent = problem;
      $('play').textContent = 'Unavailable';
      return;
    }
    // the deploy being served (never from a cache): a page or launcher of an older one reloads once
    try { const r = await fetch('version.json', { cache: 'no-store' }); if (r.ok) liveBuild = await r.json(); } catch (e) { /* a local copy without it */ }
    const pageBuild = (document.querySelector('meta[name=build]') || {}).content;
    if (liveBuild && liveBuild.build && (liveBuild.build !== BUILD || pageBuild !== BUILD) && reloadOnce('page:' + liveBuild.build)) return;
    $('build-label').textContent = 'Build ' + ((liveBuild && liveBuild.build) || BUILD) + (liveBuild && liveBuild.date ? ' · ' + liveBuild.date : '');
    progress(null, 'Downloading the game…');
    const s = document.createElement('script');
    s.src = 'vikings.js?v=' + encodeURIComponent((liveBuild && liveBuild.build) || BUILD);
    s.onerror = () => { const b = $('env-error'); b.hidden = false; b.textContent = 'vikings.js could not be loaded.'; };
    document.body.appendChild(s);
  });

})();
