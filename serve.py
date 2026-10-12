#!/usr/bin/env python3
"""Static server with caching disabled, so browsers never mix old and new module files.
Usage: python3 serve.py [port]   (default 8080)"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f'Serving http://localhost:{port}  (no-cache)  Ctrl+C to stop')
ThreadingHTTPServer(('', port), NoCache).serve_forever()
