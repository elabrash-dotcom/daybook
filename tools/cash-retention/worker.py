"""Run a bounded batch; PostgreSQL serializes retention with Daybook hold updates."""
import hashlib
import io
import json
import logging
import os
import re
import sys
from pathlib import Path
from urllib import request, parse
from urllib.error import HTTPError

import psycopg
from psycopg.rows import dict_row
from PIL import Image

LIMIT = 10 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 20_000_000
COLUMNS = {"raw":"snapshot_raw_path", "annotated":"snapshot_annotated_path"}

def digest(b):
    return hashlib.sha256(b).hexdigest()

class Storage:
    def __init__(self, ref, key):
        if not re.fullmatch("[a-z]{20}", ref):
            raise ValueError("project reference")
        self.base = f"https://{ref}.supabase.co/storage/v1/object/"
        self.headers = {"apikey":key, "Authorization":"Bearer "+key}

    def request(self, method, path, data=None, mime=None):
        headers = self.headers.copy()
        if mime:
            headers["Content-Type"] = mime
        req = request.Request(self.base+path, method=method, headers=headers, data=data)
        with request.urlopen(req, timeout=25) as r:
            result = r.read(LIMIT+1)
            if len(result)>LIMIT:
                raise ValueError("object too large")
            return result

    def get(self, path):
        return self.request("GET","authenticated/cash-snapshots/"+parse.quote(path))

    def put(self, path, data):
        try:
            self.request("POST","cash-snapshots/"+parse.quote(path),data,"image/webp")
        except HTTPError as err:
            if err.code not in (400,409): raise
            # A retry may encounter an existing content-addressed object.
            if self.get(path)!=data: raise

    def delete(self, path):
        self.request("DELETE","cash-snapshots",json.dumps({"prefixes":[path]}).encode(),"application/json")

def decoded(data, fmt):
    with Image.open(io.BytesIO(data), formats=[fmt]) as im:
        if im.width * im.height > Image.MAX_IMAGE_PIXELS: raise ValueError("image too large")
        im.load()
        return im.convert("RGB")

def encode(data, quality):
    original=decoded(data,"JPEG")
    out=io.BytesIO()
    original.save(out,format="WEBP",quality=quality,method=6)
    return out.getvalue(), original.size

def verify(data, sha, size):
    if digest(data)!=sha or decoded(data,"WEBP").size!=size:
        raise ValueError("archive verification failed")

def log(db, eid, action):
    db.execute("insert into cash_retention.audit(event_id,action) values(%s,%s)",(eid,action))

def process(db, store, eid):
    # One transaction per phase. Commit the verified replacement pointer before any original deletion.
    with db.transaction():
        row=db.execute("""
          select e.*, p.quality, now() >= e.received_at + make_interval(days=>p.original_days) as archive_due,
            now() >= e.received_at + make_interval(years=>p.metadata_years) as metadata_due
          from public.cash_events e cross join cash_retention.policy p where e.id=%s for update of e
        """,(eid,)).fetchone()
        if not row or row["preserve"] or not row["archive_due"]: return False
        assets={a["kind"]:a for a in db.execute("""
          select a.*, now() >= a.archived_at + make_interval(years=>p.archive_years) as expiry_due
          from cash_retention.assets a cross join cash_retention.policy p where event_id=%s
        """,(eid,))}
        for kind,col in COLUMNS.items():
            a=assets.get(kind)
            path=row[col]
            if not a and path:
                parts=path.split("/")
                if (len(parts)!=5 or parts[:2]!=[str(row["owner_id"]),row["store_key"]]
                    or parts[-2:]!=[row["event_uid"],kind+".jpg"] or not re.fullmatch(r"\d{4}-\d{2}-\d{2}",parts[2])):
                    raise ValueError("unexpected source path")
                src=store.get(path)
                webp,size=encode(src,row["quality"])
                sha=digest(webp)
                dest=path[:-4]+"-"+sha+".webp"
                store.put(dest,webp)
                verify(store.get(dest),sha,size)
                db.execute("insert into cash_retention.assets(event_id,kind,original,archive,source_sha,archive_sha) values(%s,%s,%s,%s,%s,%s)",
                           (eid,kind,path,dest,digest(src),sha))
                db.execute(f"update public.cash_events set {col}=%s where id=%s",(dest,eid))
                log(db,eid,"verified "+kind)
                return True
            if not a: continue
            if not a["original_deleted"]:
                if path!=a["archive"]: raise ValueError("archive pointer changed")
                archive=store.get(path)
                if digest(archive)!=a["archive_sha"]: raise ValueError("archive digest mismatch")
                size=decoded(archive,"WEBP").size
                try: src=store.get(a["original"])
                except HTTPError as err:
                    if err.code!=404: raise
                else:
                    if digest(src)!=a["source_sha"] or decoded(src,"JPEG").size!=size:
                        raise ValueError("source changed")
                    store.delete(a["original"])
                db.execute("update cash_retention.assets set original_deleted=true where event_id=%s and kind=%s",(eid,kind))
                log(db,eid,"removed verified source "+kind)
                return True
            if a["expiry_due"] and not a["expired"]:
                if path:
                    if path!=a["archive"]: raise ValueError("unexpected expiry path")
                    db.execute(f"update public.cash_events set {col}=null where id=%s",(eid,))
                else:
                    store.delete(a["archive"])
                    db.execute("update cash_retention.assets set expired=true where event_id=%s and kind=%s",(eid,kind))
                log(db,eid,"expiry "+kind)
                return True
        if row["metadata_due"] and all(a["expired"] for a in assets.values()):
            if row["clip_path"]: raise ValueError("unexpected cloud clip")
            db.execute("delete from cash_retention.assets where event_id=%s",(eid,))
            db.execute("delete from public.cash_events where id=%s",(eid,))
            log(db,eid,"expired metadata")
            return True
        return False

def run(db,store):
    # keyset pagination avoids starving later events behind held, failed or already archived rows.
    cursor="00000000-0000-0000-0000-000000000000"
    failed=0
    while True:
        ids=db.execute("""select id from public.cash_events cross join cash_retention.policy
             where not preserve and id>%s and received_at<=now()-make_interval(days=>original_days)
             order by id limit 100""",(cursor,)).fetchall()
        if not ids: break
        for item in ids:
            cursor=item["id"]
            try:
                while process(db,store,cursor): pass
            except Exception as exc:
                failed+=1
                logging.error("retention event=%s error=%s",cursor,type(exc).__name__)
                log(db,cursor,"failure "+type(exc).__name__)
    return failed

if __name__=="__main__":
    try:
        with psycopg.connect(os.environ["RETENTION_DSN"],autocommit=True,row_factory=dict_row) as db:
            failed=run(db,Storage(os.environ["SUPABASE_PROJECT_REF"],os.environ["RETENTION_STORAGE_KEY"]))
        sys.exit(bool(failed))
    except Exception as exc:
        sys.exit("Retention failed: "+type(exc).__name__)
