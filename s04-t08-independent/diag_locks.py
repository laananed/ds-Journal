import os
os.environ['SEEKJOURNAL_TEST_DB'] = 'seekjournal_test_03'
from scripts.prepare_test_db import get_test_database_url
import psycopg

url = get_test_database_url().set(drivername='postgresql').render_as_string(hide_password=False)
Q1 = "select pid, state, wait_event_type||'/'||wait_event, left(query,90), xact_start from pg_stat_activity where datname=current_database() order by pid"
Q2 = "select l.pid, l.locktype, l.relation::regclass, l.mode, l.granted from pg_locks l where not l.granted"
Q3 = ("select a.pid, a.state, l.locktype, l.relation::regclass, l.mode, left(a.query,60), a.xact_start "
      "from pg_locks l join pg_stat_activity a on a.pid=l.pid "
      "where l.granted and a.xact_start is not null and a.pid <> pg_backend_pid()")
with psycopg.connect(url, autocommit=True) as c:
    print('--- connections ---')
    for r in c.execute(Q1).fetchall():
        print(r)
    print('--- ungranted ---')
    for r in c.execute(Q2).fetchall():
        print(r)
    print('--- holders ---')
    for r in c.execute(Q3).fetchall():
        print(r)
