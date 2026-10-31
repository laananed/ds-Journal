"""Local synthetic-only browser harness; rejects and logs every non-GET request."""
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'frontend' / 'dist'
LOG = ROOT / 'evidence' / 's04-t12-independent-retest-requests.jsonl'
stamp = '2026-01-01T00:00:00Z'
def record(kind, ident, title, content):
    return dict(type=kind, id=ident, title=title, display_title=title, content=content,
                revision=1, folder_id=7, created_at=stamp, updated_at=stamp, deleted_at=None,
                content_blocks=None, content_doc=None, journal_date='2026-01-01',
                inbox_date='2026-01-01', is_daily=False)
inbox = record('inbox', 91, 'Synthetic Inbox', 'Synthetic inbox original')
journal = record('journal', 92, 'Synthetic Journal', 'Journal body [[Synthetic Inbox]] and [[Synthetic Insight]]')
insight = record('insight', 93, 'Synthetic Insight', 'Insight original [[Synthetic Journal]]')
items = [inbox, journal, insight]
def page(values): return dict(items=values, page=1, page_size=20, total=len(values), has_next=False)
local_id='11111111-1111-4111-8111-111111111111'
review_id='22222222-2222-4222-8222-222222222222'
count = 0
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def log(self):
        with LOG.open('a', encoding='utf-8') as f: f.write(json.dumps({'method':self.command,'path':self.path})+'\n')
    def respond(self, status, data, ctype='application/json'):
        body = json.dumps(data).encode() if ctype == 'application/json' else data
        self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(body)
    def do_POST(self): self.log(); self.respond(405, {'detail':'read-only mock'})
    do_PATCH=do_POST
    do_DELETE=do_POST
    do_PUT=do_POST
    def do_GET(self):
        self.log(); u=urlsplit(self.path); p=u.path; q=parse_qs(u.query)
        if p == '/seed':
            entries=[{'requestId':local_id,'kind':'local','source':{'type':'inbox','id':91}}, {'requestId':review_id,'kind':'review','source':{'type':'inbox','id':91}}]
            source=q.get('source',['inbox'])[0]
            ident={'inbox':91,'journal':92,'insight':93}.get(source,91)
            for entry in entries: entry['source']={'type':source,'id':ident}
            if q.get('kind') == ['local']: entries = entries[:1]
            if q.get('kind') == ['review']: entries = entries[1:]
            if q.get('order') == ['reverse']: entries.reverse()
            value=json.dumps(json.dumps({'version':1,'entries':entries}))
            body=('<button onclick="localStorage.setItem(\'seekjournal.ai.recovery.v1\', '+value.replace('"','&quot;')+'); location.href=\'/\'">Seed synthetic recovery</button>').encode()
            return self.respond(200,body,'text/html; charset=utf-8')
        if p == '/api/folders': return self.respond(200,[{'id':7,'name':'Synthetic Folder'}])
        if p == '/api/folders/7/files': return self.respond(200,page(items))
        if p == '/api/inboxes/daily': return self.respond(200,{'state':'missing','id':None,'file':None})
        for plural, obj in [('inboxes',inbox),('journals',journal),('insights',insight)]:
            if p == '/api/'+plural: return self.respond(200,page([obj]))
            if p == '/api/'+plural+'/'+str(obj['id']): return self.respond(200,obj)
        if p == '/api/search':
            term=q.get('q',[''])[0].lower(); typ=q.get('type',['all'])[0]
            return self.respond(200,page([x for x in items if term in (x['title']+' '+x['content']).lower() and (typ=='all' or typ==x['type'])]))
        if p == '/api/links/resolve':
            title=q.get('title',[''])[0]; return self.respond(200,page([x for x in items if x['title']==title]))
        if p.startswith('/api/files/') and p.endswith('/ai-calls'): return self.respond(200,page([]))
        if p == '/api/ai/requests/'+local_id:
            return self.respond(200,dict(request_id=local_id,kind='local',status='unknown',sources=[{'type':'inbox','id':91}],reply=None,file=None,review=None,saved_target=None,usage=None,web_status='not_needed',citations=[],error={'message':'Synthetic unknown request'}))
        if p == '/api/ai/requests/'+review_id:
            global count
            count += 1
            return self.respond(200,dict(request_id=review_id,kind=('review' if count == 1 else 'local'),status=('pending' if count == 1 else 'applied'),sources=[{'type':'inbox','id':91}],reply=None,file=None,review=None,saved_target=None,usage=None,web_status='not_needed',citations=[],error=None))
            return self.respond(200,dict(request_id=review_id,kind='review',status='unknown',sources=[{'type':'inbox','id':91}],reply=None,file=None,review=None,saved_target=None,usage=None,web_status='not_needed',citations=[],error={'message':'Synthetic review recovery'}))
        if p.startswith('/api/'): return self.respond(404,{'detail':'unimplemented mock endpoint'})
        target = DIST / p.lstrip('/') if p != '/' else DIST / 'index.html'
        if not target.is_file() or not target.resolve().is_relative_to(DIST.resolve()): return self.respond(404,b'Not found','text/plain')
        return self.respond(200,target.read_bytes(),mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
if __name__ == '__main__': ThreadingHTTPServer(('127.0.0.1',8039),Handler).serve_forever()
