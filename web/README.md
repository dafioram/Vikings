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

**Players** (beside Play) is `--coop=N`, 1 by default: 2 or 3 is local co-op with one game controller
per player — SDL reads the browser's Gamepad API ("Standard Gamepad" layout), the first
controller is player 1 beside the keyboard, the second player 2. A browser shows a pad to
the page only after one of its buttons is pressed. Player 2 owns a viking from the level's
start with or without a controller (the switch skips it), so a solo game is Players 1. A
`--coop=` among the arguments wins.

**Save states**: the page starts the game with `--save-states` — F2 saves the whole game
state to the slot chosen in the F1 menu (SAVE SLOT / LOAD SLOT, 1–9), F3 loads it; the files
(`v2_save_<n>.state`) are in `/game` like the settings, and *Saves & backup* lists them with
their dates. `--debug`'s LEVEL jump, REWIND and cheat keys are not part of it.

**Backup**: *Saves & backup → Export* writes everything stored as one .zip (the settings,
the key bindings, the save slots and, with the box checked, DATA.DAT and the extra content);
*Import* restores one — only the files a backup carries, under their own paths, added to
what is stored (a file of the same name is replaced). The build's own images are never in it.

**Controllers**: the game logs which controller became which player
(`v2_coop: controller '…' -> player N`); the page shows each change as a toast, and while a
co-op game has fewer pads than players a hint asks for a button press on the next one.

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
- **Audio** is SDL's Web Audio device, always float32: `sound_init` reopens it without an
  obtained spec (its general fallback for a device that is not s16 stereo), so the mixer gets
  the s16 stereo it writes and SDL converts. Browsers start audio only after a user gesture: the Play click is one.
- **The F1 menu** leaves out the network lobby (CO-OP, DELAY, HOST, JOIN): a page has no sockets.
- **Loading.** The launcher fetches `vikings.wasm` itself (`Module.instantiateWasm`) to show the
  download against the module's size from `version.json`, then "Compiling…" until the runtime
  is up; the module compiles while it streams.
- **Deploys and the cache.** GitHub Pages lets a browser keep any file for 10 minutes, so a
  page, a launcher and a module of two deploys could meet. The Makefile writes the build (the
  commit) into the page (`<meta name="build">`, `?v=` on launcher.js and style.css), the
  launcher and `version.json`; the launcher reads `version.json` past the cache, reloads the
  page once when it names another build, and loads `vikings.js` / `vikings.wasm` under
  `?v=<build>` — a cached copy of another deploy's is never taken. A module that still fails to
  link to its loader reloads once more, then says a deploy is in progress. The footer shows the
  build and its date.
- **Exit.** The game's quit, a fatal DOS exit ("Cannot find 'data.dat' …") and a crash end
  the runtime; the page shows the last console lines and goes back to the launcher on a
  reload.
- **The link** is `-O1` (the units are compiled `-O2`): Binaryen's `-O2` inlines every function
  called once, which folds the generated executors into one 37 MB function, and browsers
  refuse any function body over 7 654 321 bytes.

## Not in the browser build

- **Co-op over the network** (`--host` / `--join`): browsers have no TCP sockets.
- Test mode, HEADLESS, the keymap editor, the level editor (`tools/assets/edit_server.py`)
  and `make content`: they stay native. Build the content pack natively, then upload it.
- Touch controls.
