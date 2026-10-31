"""Synthetic read-only server: a review ID returns a mismatched local kind."""
import importlib.util
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit

path = Path(__file__).with_name('s04-t12-mock-server.py')
spec = importlib.util.spec_from_file_location('s04_t12_mock', path)
mock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mock)
mock.LOG = path.with_name('s04-t12-recovery-mismatch-requests.jsonl')

class Handler(mock.Handler):
    def do_GET(self):
        if urlsplit(self.path).path == '/api/ai/requests/' + mock.review_id:
            self.log()
            return self.respond(200, dict(request_id=mock.review_id, kind='local', status='applied',
                                          sources=[], reply=None, file=None, review=None,
                                          saved_target={'type':'journal', 'id':92}, usage=None,
                                          web_status='not_needed', citations=[], error=None))
        return super().do_GET()

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8038), Handler).serve_forever()
