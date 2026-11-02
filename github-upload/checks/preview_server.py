"""Local browser QA bridge matching the APK's HTTPS-only network bridge."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import urllib.request
import urllib.parse
import threading

root = Path(__file__).resolve().parents[1]
hosts = {'www.mangabz.com', 'mangabz.com', 'image.mangabz.com', 'cover.mangabz.com'}
headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://www.mangabz.com/', 'Cookie': 'mangabz_lang=2'}

def allowed(url):
    p = urllib.parse.urlparse(url)
    return p.scheme == 'https' and p.hostname in hosts and not p.username and p.port in (None, 443)

class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, url):
        if not allowed(url):
            raise ValueError('Invalid redirect')
        return super().redirect_request(req, fp, code, msg, hdrs, url)

opener = urllib.request.build_opener(Redirect())
media_slots = threading.Semaphore(3)
media_cache = {}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(root/'assets'), **kwargs)

    def do_POST(self):
        if self.path != '/api':
            self.send_error(404); return
        try:
            request = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', '0')), 16000)))
            url = request['url']
            if not allowed(url):
                raise ValueError('Invalid URL')
            h = {**headers, **request.get('headers', {})}
            with opener.open(urllib.request.Request(url, headers=h), timeout=30) as response:
                body = response.read(8*1024*1024).decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
                data = {'status': response.status, 'body': body}
        except Exception as e:
            data = {'status': 0, 'body': '', 'error': str(e)}
        b = json.dumps(data).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith('/media?'):
            try:
                url = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)['url'][0]
                if not allowed(url):
                    raise ValueError('Invalid URL')
                with media_slots:
                    if url not in media_cache:
                        for attempt in range(2):
                            try:
                                with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as r:
                                    b = r.read(24*1024*1024); mime = r.headers.get('Content-Type', 'image/jpeg')
                                media_cache[url] = (b, mime)
                                break
                            except Exception:
                                if attempt: raise
                    b, mime = media_cache[url]
                self.send_response(200); self.send_header('Content-Type', mime); self.end_headers(); self.wfile.write(b)
            except Exception:
                self.send_error(502)
            return
        return super().do_GET()

    def log_message(self, *args):
        pass

print('QA preview: http://127.0.0.1:8766', flush=True)
ThreadingHTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
