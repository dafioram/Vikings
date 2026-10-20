#!/usr/bin/env python3
"""serve.py — serve web/dist on localhost for the browser build (make WEB=1).

The game's threads need SharedArrayBuffer, which a browser grants only to a
cross-origin isolated page: this server sends the COOP / COEP headers itself
(GitHub Pages cannot, there coi-serviceworker.js adds them).

  python3 web/serve.py [--port 8000] [--dir web/dist]
"""
import argparse
import functools
import http.server
import os


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--dir', default=os.path.join(here, 'dist'))
    a = ap.parse_args()
    if not os.path.exists(os.path.join(a.dir, 'vikings.wasm')):
        raise SystemExit(f'{a.dir}: no vikings.wasm — build it first: make WEB=1 -j$(nproc)')
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', a.port), functools.partial(Handler, directory=a.dir))
    print(f'serving {a.dir} on http://localhost:{a.port}/ (Ctrl-C stops)')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
