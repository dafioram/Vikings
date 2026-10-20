# The browser build

The game build (`V2_ONLY`, what `make` builds by default) compiled to WebAssembly with
Emscripten and served as a static page. The player brings the game files; they stay in
the browser.

```sh
source ~/emsdk/emsdk_env.sh    # emsdk 4.0.15 (git clone https://github.com/emscripten-core/emsdk; ./emsdk install 4.0.15; ./emsdk activate 4.0.15)
make WEB=1 -j$(nproc)           # → web/dist/: index.html, launcher.js, style.css, coi-serviceworker.js, vikings.js, vikings.wasm
python3 web/serve.py            # http://localhost:8000 (sends the COOP / COEP headers itself)
```

`make clean` removes `web/dist` with the other build trees; the objects go to `.obj-web/`.

## The files

| In the page | In the game's working directory (`/game`) |
| --- | --- |
| DATA.DAT (required) | `DATA.DAT` |
| Console content pack — the `content/` folder or a .zip of it | `content/.compiled/*`, `content/exe_static.bin` (the rest of the open tree is not kept) |
| SC-55 ROMs | `roms/sc55/*` |
| MT-32 ROMs | `roms/mt32/*` |

`/game` is an Emscripten IDBFS mount: an in-memory directory written back to IndexedDB
(database `/game`) after every upload or removal, every 5 s while the game runs (the
options menu writes `v2_options.cfg`, a rebind `vikings_keymap.cfg`) and when the tab is
hidden or closed. The game sees the same relative paths it reads beside the native
executable, so nothing in the engine knows it is in a browser. IndexedDB rather than
localStorage: localStorage holds strings of a few MB at most, the archive alone is 1.5 MB
of binary.

`DATA.DAT` is checked against the md5 of the archive the port is built against
(`d0f8a04202070a54d1909758ecd962b5`, 1 570 444 bytes). A mismatch is a warning, not a
refusal — the game itself rejects a foreign archive with the original's message.

`ds_static.bin`, `exe_static.bin` and the default `vikings_keymap.cfg` are embedded in the
module (`/static`) and copied into `/game` at every start (the keymap only when none is
stored, so a rebind survives).

The *Advanced* section passes command-line arguments (`--debug` …) and resets the
stored settings or everything.

## How it runs

- **Threads.** The game thread, the hang detector, the SC-55 worker and the SNES loader are
  pthreads (`-pthread`, a pool of 12 workers). Web workers sharing memory need
  `SharedArrayBuffer`, which a browser grants only to a cross-origin isolated page
  (COOP `same-origin` + COEP `require-corp`). GitHub Pages cannot send headers, so
  `coi-serviceworker.js` ([coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)
  0.1.7, MIT) installs a service worker that adds them: the first visit reloads once.
- **The presenter** is the main thread natively too; in the browser its iterations are the
  animation frames (`emscripten_set_main_loop`, `v2_main.cpp`) because a page's main
  thread may not block. The present after an animation frame stands for the vsync-blocking
  present, so the vsync lock measures the display's refresh as natively and the game thread
  paces on it. The presenter's sleeps (the latch, the 15 ms fallback, the VRR wait) and the
  xBRZ worker threads are compiled out under `__EMSCRIPTEN__`; PACING VRR presents per
  animation frame like VSYNC.
- **Audio** is SDL's Web Audio device; the mixer gets the s16 stereo spec it asks for and SDL
  converts. Browsers start audio only after a user gesture: the Play click is one.
- **Exit.** The game's quit, a fatal DOS exit ("Cannot find 'data.dat' …") and a crash end
  the runtime; the page shows the last console lines and goes back to the launcher on a
  reload.

- **The link** is `-O1` (the units are compiled `-O2`): Binaryen's `-O2` inlines every function
  called once, which folds the generated executors into one 37 MB function, and browsers
  refuse any function body over 7 654 321 bytes. `web/test/wasm_limits.py` checks the module.

## Tests

```sh
python3 web/test/wasm_limits.py web/dist/vikings.wasm     # every function within the browsers' limit
python3 web/serve.py --port 8765 &
node web/test/smoke.cjs http://localhost:8765/            # needs playwright (npm install --no-save playwright)
```

The smoke test drives the page in headless Chromium without game data: the isolation,
uploads kept across a reload, the md5 warning, a content pack from a .zip, the removals,
and Play with an archive of zeros, which boots the game to its archive check and ends it
with the original's "Data.dat has been corrupted". The workflow runs both.

## Not in the browser build

- **Co-op over the network** (`--host` / `--join`): browsers have no TCP sockets. Local
  co-op with game controllers works (`--coop=2` in *Advanced*; SDL reads the Gamepad API).
- Test mode, HEADLESS, the keymap editor, the level editor (`tools/assets/edit_server.py`)
  and `make content`: they stay native. Build the content pack natively, then upload it.
- Touch controls.

## Deploying

`.github/workflows/web.yml` builds on every push and pull request and deploys `web/dist`
to GitHub Pages from the default branch (or a manual *Run workflow*). One-time setup of
the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is `https://<owner>.github.io/<repo>/`.
