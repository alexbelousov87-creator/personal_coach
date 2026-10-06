"""Credential-free sync journal, bounded per athlete and provider."""
import logging
import threading
import time
import uuid

MESSAGES = {
    "access": "Источник отклонил доступ. Проверьте подключение или права токена.",
    "rate_limit": "Источник временно ограничил запросы. Повторите позже.",
    "timeout": "Источник не ответил вовремя. Повторите позже.",
    "network": "Не удалось связаться с источником. Проверьте соединение.",
    "provider": "Источник вернул ошибку. Повторите позже.",
    "internal": "Синхронизация не завершена. Обратитесь к администратору.",
    "tcx": "Не все TCX получены; подробные данные части тренировок могут отсутствовать.",
    "busy": "Источник занят другой синхронизацией. Эта попытка пропущена.",
    "interrupted": "Сервер перезапущен до завершения попытки. Результат не подтвержден.",
}


def error_code(exc):
    status = getattr(exc, "status", None)
    if status in (401, 403): return "access"
    if status == 429: return "rate_limit"
    if isinstance(exc, TimeoutError) or status == 504: return "timeout"
    if isinstance(exc, OSError): return "network"
    if status is not None: return "provider"
    return "internal"


def ensure_schema(connection):
    connection.execute("""CREATE TABLE IF NOT EXISTS sync_journal (
        id TEXT PRIMARY KEY, boot TEXT NOT NULL, coach TEXT NOT NULL, athlete TEXT NOT NULL,
        provider TEXT NOT NULL, trigger TEXT NOT NULL, started REAL NOT NULL, finished REAL,
        state TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0, tcx INTEGER NOT NULL DEFAULT 0, code TEXT NOT NULL DEFAULT ''
    )""")
    connection.execute("CREATE INDEX IF NOT EXISTS sync_journal_scope ON sync_journal(coach,athlete,provider,started)")


class Monitor:
    def __init__(self, connect, clock=time.time):
        self.connect, self.clock = connect, clock
        self.boot = uuid.uuid4().hex
        self.started = clock()
        self.lock = threading.RLock()
        self.active = {}
        self.journal_available = True
        self.worker = {"state": "not_started", "lastStarted": None, "lastFinished": None, "nextCheckAt": None}
        self.thread = None

    def worker_update(self, **values):
        with self.lock:
            self.worker.update(values)

    def worker_status(self):
        with self.lock:
            return {**self.worker, "alive": bool(self.thread and self.thread.is_alive())}

    def record(self, event, scope):
        try:
            with self.connect() as db:
                ensure_schema(db)
                db.execute("""INSERT INTO sync_journal
                    (id,boot,coach,athlete,provider,trigger,started,finished,state,received,added,duplicates,tcx,code)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                    finished=excluded.finished,state=excluded.state,received=excluded.received,
                    added=excluded.added,duplicates=excluded.duplicates,tcx=excluded.tcx,code=excluded.code""",
                    (event["id"],self.boot,*scope,event["trigger"],event["started"],event.get("finished"),event["state"],
                     event.get("received",0),event.get("added",0),event.get("duplicates",0),event.get("tcx",0),event.get("code","")))
                db.execute("""DELETE FROM sync_journal WHERE coach=? AND athlete=? AND provider=? AND id NOT IN
                    (SELECT id FROM sync_journal WHERE coach=? AND athlete=? AND provider=? ORDER BY started DESC,rowid DESC LIMIT 20)
                    AND NOT (state='running' AND boot=?)""", (*scope,*scope,self.boot))
            self.journal_available = True
        except Exception as exc:
            self.journal_available = False
            logging.warning("Sync journal unavailable: %s", type(exc).__name__)

    def execute(self, scope, callback, automatic=False, expect_tcx=False):
        with self.lock:
            if scope in self.active:
                return {"ok": True,"skipped":True,"message":"Синхронизация уже выполняется.","provider":scope[2],"workouts":[],"count":0,"added":0}
            event = {"id":uuid.uuid4().hex,"trigger":"background" if automatic else "manual","started":self.clock(),"state":"running"}
            self.active[scope] = event
        self.record(event, scope)
        logging.info("Sync attempt started id=%s provider=%s trigger=%s",event["id"],scope[2],event["trigger"])
        try:
            result = callback()
            def count(key): return max(0, int(result.get(key) or 0))
            event.update(received=count("count"), added=count("added"), duplicates=count("duplicates"),tcx=len(result.get("savedTcx") or []))
            if result.get("skipped"):
                event.update(state="skipped",code="busy")
            elif result.get("ok") is False:
                event.update(state="error",code="provider")
            elif expect_tcx and event["tcx"] < event["received"]:
                event.update(state="partial",code="tcx")
            else:
                event.update(state="success")
            return result
        except Exception as exc:
            event.update(state="error",code=error_code(exc))
            raise
        finally:
            event["finished"] = self.clock()
            self.record(event, scope)
            logging.info("Sync attempt finished id=%s provider=%s state=%s received=%s added=%s duplicates=%s code=%s",
                         event["id"],scope[2],event["state"],event.get("received",0),event.get("added",0),event.get("duplicates",0),event.get("code",""))
            with self.lock:
                self.active.pop(scope, None)

    def history(self, scope):
        with self.connect() as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_journal'").fetchone()
            rows = db.execute("""SELECT id,boot,trigger,started,finished,state,received,added,duplicates,tcx,code
                FROM sync_journal WHERE coach=? AND athlete=? AND provider=? ORDER BY started DESC,rowid DESC LIMIT 20""", scope).fetchall() if exists else []
        events = []
        for row in rows:
            id, boot, trigger, started, finished, state, received, added, duplicates, tcx, code = row
            if state == "running" and boot != self.boot:
                state, code = "interrupted", "interrupted"
            events.append({"id":id,"trigger":trigger,"startedAt":started,"finishedAt":finished,"state":state,
                "received":received,"added":added,"duplicates":duplicates,"tcx":tcx,
                "code":code,"message":MESSAGES.get(code,""),"durationSeconds":round(max(0,(finished or self.clock())-started))})
        with self.lock:
            active = self.active.get(scope)
            if active:
                running = {"id":active["id"],"trigger":active["trigger"],"state":"running","startedAt":active["started"],
                    "finishedAt":None,"durationSeconds":round(max(0,self.clock()-active["started"])),"message":""}
                events = [running]+[e for e in events if e["id"]!=active["id"]]
        return events[:20]