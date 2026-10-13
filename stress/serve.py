#!/usr/bin/env python3
"""STRESS HARNESS (temporary). The no-cache dev server plus POST /__stress_result, which writes stress/results/<time>.json.
Usage (from the repo root): python3 stress/serve.py [port]   then open http://localhost:8090/stress/?autostart=1"""
import os, sys, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'stress', 'results')

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=ROOT, **kw)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()
    def do_POST(self):
        if self.path != '/__stress_result': self.send_error(404); return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        os.makedirs(OUT, exist_ok=True)
        name = time.strftime('%Y%m%d-%H%M%S') + '.json'
        with open(os.path.join(OUT, name), 'wb') as f: f.write(body)
        msg = ('stress/results/' + name).encode()
        self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.send_header('Content-Length', str(len(msg))); self.end_headers()
        self.wfile.write(msg)
        print('saved', name, flush=True)

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
print(f'Stress server http://localhost:{port}/stress/?autostart=1  (results -> stress/results/)', flush=True)
ThreadingHTTPServer(('', port), Handler).serve_forever()
