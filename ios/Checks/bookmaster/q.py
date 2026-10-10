#!/usr/bin/env python3
"""q.py 'SQL' -> JSON rows from the local BookMaster D1 database (for assertions)."""
import glob, json, os, sqlite3, sys

repo = os.environ["BOOKMASTER_REPO"]
for path in glob.glob(f"{repo}/.wrangler/state/v3/d1/**/*.sqlite", recursive=True):
    try:
        db = sqlite3.connect(path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("select 1 from users limit 1")
    except Exception:
        continue
    cur = db.execute(sys.argv[1])
    print(json.dumps([dict(r) for r in cur.fetchall()] if cur.description else []))
    db.commit()
    break
