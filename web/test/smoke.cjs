// smoke.cjs — the browser build in headless Chromium (Playwright), without game data:
//   python3 web/serve.py & node web/test/smoke.cjs [http://localhost:8000/]
// (playwright from the repo's node_modules — npm install --no-save playwright — or NODE_PATH)
// The launcher: the isolation, an upload kept across a reload (IndexedDB), the md5 warning,
// a content pack from a .zip (only .compiled/ and exe_static.bin kept), the removals. The
// module: Play with an archive of zeros boots the game to its archive check, which ends it
// the way the original did ("Data.dat has been corrupted") — the startup on the browser's
// main thread, the working directory, the fatal exit and the page's end of game.
'use strict';
const { chromium } = require('playwright');
const zlib = require('node:zlib');

const url = process.argv[2] || 'http://localhost:8000/';
let failed = 0;
function check(ok, what) {
  console.log((ok ? 'PASS ' : 'FAIL ') + what);
  if (!ok) failed++;
}

// a .zip of the given entries (stored or deflated), as the launcher's reader takes it
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data, deflate] of entries) {
    const nm = Buffer.from(name), body = deflate ? zlib.deflateRawSync(data) : data, crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, body); centrals.push(ch, nm);
    off += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

(async () => {
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const logs = [], dialogs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
const status = (sel) => page.textContent(sel);
const ready = () => page.waitForFunction(() => document.querySelector('#play').textContent !== 'Loading…', null, { timeout: 120000 });

try {
  await page.goto(url);
  await ready();
  check(await page.evaluate(() => window.crossOriginIsolated), 'the page is cross-origin isolated');
  check(await page.isDisabled('#play'), 'Play is disabled without DATA.DAT');

  // an archive of zeros: stored, the md5 warning
  await page.setInputFiles('#in-data', { name: 'data.dat', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1570444) });
  await page.waitForSelector('#data-warn:not([hidden])', { timeout: 10000 });
  check(/checksum mismatch/.test(await status('#data-status')), 'a foreign DATA.DAT is stored with a checksum warning');
  check(!(await page.isDisabled('#play')), 'Play is enabled with DATA.DAT');

  // a content pack from a .zip: the open tree beside .compiled/ is left out
  const zip = makeZip([
    ['content/raw/manifest.json', Buffer.from('{}'), false],
    ['content/.compiled/0000.bin', Buffer.alloc(5000, 7), true],
    ['content/.compiled/0001.bin', Buffer.alloc(300, 1), false],
    ['content/exe_static.bin', Buffer.alloc(1000, 2), true],
  ]);
  await page.setInputFiles('#ex-content input[data-in=zip]', { name: 'content.zip', mimeType: 'application/zip', buffer: zip });
  await page.waitForFunction(() => /Stored/.test(document.querySelector('#ex-content [data-status]').textContent), null, { timeout: 10000 });
  check(/3 files/.test(await status('#ex-content [data-status]')), 'the content pack keeps .compiled/ and exe_static.bin (3 files)');
  await page.setInputFiles('#ex-mt32 input[data-in=files]', [{ name: 'MT32_CONTROL.ROM', mimeType: 'application/octet-stream', buffer: Buffer.alloc(65536) }]);
  await page.waitForFunction(() => /Stored/.test(document.querySelector('#ex-mt32 [data-status]').textContent), null, { timeout: 10000 });
  check(true, 'an MT-32 ROM is stored');

  // a reload: everything still there (IndexedDB)
  await page.reload();
  await ready();
  check(/checksum mismatch/.test(await status('#data-status')), 'DATA.DAT survives a reload');
  check(/3 files/.test(await status('#ex-content [data-status]')), 'the content pack survives a reload');
  await page.click('#ex-content [data-rm]');
  await page.click('#ex-mt32 [data-rm]');
  const gone = await page.waitForFunction(() => ['#ex-content', '#ex-mt32'].every((id) =>
    /Not stored/.test(document.querySelector(id + ' [data-status]').textContent)), null, { timeout: 10000 }).then(() => true, () => false);
  check(gone, 'the extras are removed');

  // Play: the game boots to its archive check and ends with the original's message
  await page.click('#play');
  await page.waitForSelector('#ended:not([hidden])', { timeout: 120000 });
  const tail = (await page.textContent('#ended-log')) + '\n' + dialogs.join('\n');
  check(/corrupted/i.test(tail), 'the game ends with "Data.dat has been corrupted"');
  check(logs.some((l) => /V2_ONLY: loaded \d+ bytes from exe_static\.bin/.test(l)), 'the static image is read from the working directory');
  check(logs.some((l) => /--coop: 2 players/.test(l)), 'Play starts 2-player co-op by default (--coop=2)');
  check(!logs.some((l) => /PAGEERROR|RuntimeError|Aborted/.test(l)), 'no page error or abort');
} catch (e) {
  check(false, 'exception: ' + e.message);
} finally {
  if (failed) console.log('--- console ---\n' + logs.slice(-80).join('\n'));
  await browser.close();
}
console.log(failed ? `${failed} check(s) FAILED` : 'smoke PASS');
process.exit(failed ? 1 : 0);
})();
