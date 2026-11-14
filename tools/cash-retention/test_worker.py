"""Run against a fresh disposable database with the test stub and both migrations loaded."""
import os,uuid,threading
from pathlib import Path
from worker import process,psycopg,dict_row

class Objects(dict):
    def get(self,p): return self[p]
    def put(self,p,b): self[p]=b
    def delete(self,p): self.pop(p,None)

def test():
    import io
    from PIL import Image
    f=io.BytesIO()
    Image.new('RGB',(64,48),'peachpuff').save(f,'JPEG')
    store=Objects()
    with psycopg.connect(autocommit=True,row_factory=dict_row) as db:
        uid,eid,dev=[uuid.uuid4() for _ in range(3)]
        db.execute("insert into auth.users(id) values(%s)",(uid,))
        db.execute("insert into agent_devices(id,owner_id,label,channel,token_hash,store_key) values(%s,%s,'fixture','camera',%s,'fixture')",(dev,uid,str(dev)))
        raw=f"{uid}/fixture/2026-10-01/fixture/raw.jpg"
        ann=raw.replace("raw.jpg","annotated.jpg")
        store[raw]=store[ann]=f.getvalue()
        db.execute("""insert into cash_events(id,owner_id,device_id,store_key,event_uid,detected_at,snapshot_raw_path,snapshot_annotated_path)
            values(%s,%s,%s,'fixture','fixture',now(),%s,%s)""",(eid,uid,dev,raw,ann))
        assert not process(db,store,eid)
        db.execute("update cash_events set received_at=now()-interval '31 days', preserve=true")
        assert not process(db,store,eid) and len(store)==2
        db.execute("update cash_events set preserve=false")
        corrupt=Objects(store)
        corrupt.put=lambda p,b: corrupt.update({p:b'broken'})
        try: process(db,corrupt,eid)
        except ValueError: pass
        else: raise AssertionError("corruption accepted")
        assert raw in corrupt and db.execute("select snapshot_raw_path from cash_events").fetchone()["snapshot_raw_path"]==raw
        # Commit hold between verified pointer switch and destructive cleanup.
        assert process(db,store,eid)
        # With an uncommitted hold, the worker waits for the same row, then skips it.
        import concurrent.futures
        def concurrent_worker():
            with psycopg.connect(autocommit=True,row_factory=dict_row) as other:
                return process(other,store,eid)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            with db.transaction():
                db.execute("update cash_events set preserve=true")
                future=pool.submit(concurrent_worker)
                try: future.result(timeout=0.2)
                except concurrent.futures.TimeoutError: pass
                else: raise AssertionError("worker bypassed row lock")
            assert not future.result(timeout=5)
        assert not process(db,store,eid) and raw in store
        db.execute("update cash_events set preserve=false")
        while process(db,store,eid): pass
        assert len(store)==2 and all(k.endswith('.webp') for k in store)
        assert db.execute("select snapshot_raw_path from cash_events").fetchone()["snapshot_raw_path"] in store
        db.execute("update cash_retention.assets set archived_at=now()-interval '3 years 1 day'")
        db.execute("update cash_events set preserve=true")
        assert not process(db,store,eid) and len(store)==2
        db.execute("update cash_events set preserve=false")
        while process(db,store,eid):pass
        assert not store and db.execute("select count(*) n from cash_events").fetchone()["n"]==1
        db.execute("update cash_events set received_at=now()-interval '10 years 1 day', preserve=true")
        assert not process(db,store,eid)
        db.execute("update cash_events set preserve=false")
        assert process(db,store,eid) and not db.execute("select id from cash_events").fetchone()
        print("PASS young event, original hold, corrupt download, hold between phases, archive access, both expiry periods and metadata hold")
if __name__=="__main__": test()
