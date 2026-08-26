from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request, error
from urllib.parse import parse_qs, quote, urlencode, urlparse
import base64
import hmac
from datetime import date, datetime, time as datetime_time, timedelta
import gzip
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import threading
import time


ROOT = Path(__file__).resolve().parent
CONF_FILE = ROOT / "conf.json"
TODAY_BUTTON_TEXT = "Получить план на сегодня"

DEFAULT_CONFIG = {
    "server": {
        "host": "127.0.0.1",
        "port": 8765,
    },
    "storage": {
        "databasePath": "data/training_coach.sqlite3",
    },
    "logging": {
        "file": "data/logs/training_coach.log",
        "level": "INFO",
        "maxBytes": 1048576,
        "backupCount": 5,
    },
    "llm": {
        "provider": "openrouter",
        "apiKey": "",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "model": "openai/gpt-oss-120b:free",
        "fallbackModels": [],
        "chatCompletionsUrl": "https://openrouter.ai/api/v1/chat/completions",
        "timeoutSeconds": 60,
        "temperature": 0.2,
        "maxTokens": 2500,
        "jsonMode": True,
        "siteUrl": "http://127.0.0.1:8765",
        "appName": "Training Coach",
    },
    "polar": {
        "enabled": True,
        "clientId": "",
        "clientSecret": "",
        "clientIdEnv": "POLAR_CLIENT_ID",
        "clientSecretEnv": "POLAR_CLIENT_SECRET",
        "redirectUri": "",
        "scope": "accesslink.read_all",
        "downloadTcx": True,
        "timeoutSeconds": 45,
        "backgroundSync": True,
        "backgroundSyncIntervalSeconds": 600,
        "backgroundSyncInitialDelaySeconds": 20,
        "syncCoachId": "coach-belousov-aleksey",
        "syncAthleteId": "athlete-belousov-aleksey",
    },
    "notifications": {
        "telegram": {
            "enabled": False,
            "botToken": "",
            "botTokenEnv": "TELEGRAM_BOT_TOKEN",
            "chatId": "",
            "chatIdEnv": "TELEGRAM_CHAT_ID",
            "dailyTime": "08:00",
            "sendOnRestDays": True,
            "removeKeyboard": True,
            "showTodayButton": True,
            "todayButtonText": TODAY_BUTTON_TEXT,
            "pollCommands": True,            "clearMenu": True,
            "timeoutSeconds": 45,
            "forceIPv4": True,
        },
    },
    "auth": {
        "enabled": False,
        "coachPassword": "",
        "coachPasswordEnv": "TRAINING_COACH_PASSWORD",
        "defaultCoachLogin": "coach",
        "allowCoachRegistration": True,
        "coachRegistrationCode": "",
        "coachRegistrationCodeEnv": "TRAINING_COACH_REGISTRATION_CODE",
        "sessionTtlHours": 24,
    },
}


def load_config():
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONF_FILE.exists():
        with CONF_FILE.open("r", encoding="utf-8-sig") as file:
            config = deep_merge(config, json.load(file))
    return config


def deep_merge(base, override):
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


CONFIG = load_config()
SERVER_CONFIG = CONFIG["server"]
STORAGE_CONFIG = CONFIG.get("storage", DEFAULT_CONFIG["storage"])
LOGGING_CONFIG = CONFIG.get("logging", DEFAULT_CONFIG["logging"])
LLM_CONFIG = CONFIG.get("llm", CONFIG.get("openai", DEFAULT_CONFIG["llm"]))
POLAR_CONFIG = CONFIG.get("polar", DEFAULT_CONFIG["polar"])
NOTIFICATIONS_CONFIG = CONFIG.get("notifications", DEFAULT_CONFIG["notifications"])
AUTH_CONFIG = CONFIG.get("auth", DEFAULT_CONFIG["auth"])
HOST = SERVER_CONFIG["host"]
PORT = int(SERVER_CONFIG["port"])
DB_PATH = (ROOT / STORAGE_CONFIG.get("databasePath", "data/training_coach.sqlite3")).resolve()
LOG_PATH = (ROOT / LOGGING_CONFIG.get("file", "data/logs/training_coach.log")).resolve()
SESSIONS = {}
POLAR_SYNC_LOCK = threading.Lock()
ORIGINAL_GETADDRINFO = socket.getaddrinfo
GETADDRINFO_LOCK = threading.Lock()
SESSION_COOKIE = "training_coach_session"
DEFAULT_COACH_ID = "coach-belousov-aleksey"
DEFAULT_ATHLETE_ID = "athlete-belousov-aleksey"
COACHES_KEY = "coaches"
STATE_KEYS = {
    "workouts",
    "profile",
    "plans",
    "plansByWeek",
    "activePlanSource",
    "selectedWeekStart",
    "coachProfile",
    "athletes",
    "activeAthleteId",
    "currentRole",
}


PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "days"],
    "properties": {
        "summary": {
            "type": "string",
            "description": "Короткое объяснение логики плана и главного ограничения.",
        },
        "stateAssessment": {
            "type": "string",
            "description": "Оценка текущего состояния спортсмена.",
        },
        "days": {
            "type": "array",
            "minItems": 7,
            "maxItems": 7,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["date", "dateLabel", "focus", "title", "details", "load"],
                "properties": {
                    "date": {"type": "string"},
                    "dateLabel": {"type": "string"},
                    "focus": {"type": "string"},
                    "title": {"type": "string"},
                    "details": {
                        "type": "string",
                        "description": "Только задание на тренировку, без факта выполнения.",
                    },
                    "plannedWorkout": {
                        "type": "string",
                        "description": "Задание на тренировку. Дублирует details для совместимости.",
                    },
                    "targetDistance": {"type": "string"},
                    "intensity": {"type": "string"},
                    "load": {"type": "string"},
                    "rationale": {"type": "string"},
                },
            },
        },
    },
}

def setup_logging():
    level_name = str(LOGGING_CONFIG.get("level", "INFO") or "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    max_bytes = int(LOGGING_CONFIG.get("maxBytes", 1048576) or 1048576)
    backup_count = int(LOGGING_CONFIG.get("backupCount", 5) or 5)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handlers = [
        RotatingFileHandler(LOG_PATH, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"),
        logging.StreamHandler(),
    ]
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(threadName)s %(message)s",
        handlers=handlers,
        force=True,
    )


def is_self_student_session(session):
    if not auth_enabled():
        return True
    return session.get("role") == "student" and session.get("athlete_id") == DEFAULT_ATHLETE_ID and (session.get("coach_id") or DEFAULT_COACH_ID) == DEFAULT_COACH_ID

class TrainingCoachHandler(BaseHTTPRequestHandler):
    server_version = "TrainingCoach/0.1"

    def do_OPTIONS(self):
        self.send_response(204)
        self.add_cors_headers()
        self.end_headers()

    def do_GET(self):
        clean_path = self.path.split("?", 1)[0]
        if clean_path == "/api/health":
            self.send_json(
                {
                    "ok": True,
                    "provider": LLM_CONFIG.get("provider", "openrouter"),
                    "model": LLM_CONFIG["model"],
                    "fallbackModels": LLM_CONFIG.get("fallbackModels", []),
                    "config": CONF_FILE.name,
                    "database": str(DB_PATH.relative_to(ROOT)) if DB_PATH.is_relative_to(ROOT) else str(DB_PATH),
                    "hasApiKey": bool(load_api_key()),
                }
            )
            return
        if clean_path == "/api/auth/status":
            self.send_json(auth_status_response(self))
            return
        if clean_path == "/api/state":
            session = self.require_session()
            if session is None:
                return
            self.send_json(state_for_session(session))
            return
        if clean_path == "/api/workout-files":
            session = self.require_workout_file_import_session()
            if session is None:
                return
            self.send_json({"files": list_workout_files()})
            return
        if clean_path == "/api/polar/status":
            session = self.require_polar_session()
            if session is None:
                return
            self.send_json(polar_status())
            return
        if clean_path == "/api/notifications/status":
            session = self.require_session()
            if session is None:
                return
            self.send_json(notification_status(session))
            return
        if clean_path == "/api/polar/connect":
            session = self.require_polar_session()
            if session is None:
                return
            try:
                self.redirect(polar_authorization_url())
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            return
        if clean_path == "/api/polar/callback":
            try:
                payload = handle_polar_callback(self.path)
                self.send_html(polar_callback_html(payload))
            except AppError as exc:
                self.send_html(polar_callback_html({"ok": False, "error": str(exc)}), status=exc.status)
            except Exception as exc:
                self.send_html(polar_callback_html({"ok": False, "error": f"unexpected server error: {exc}"}), status=500)
            return
        self.serve_static()

    def do_POST(self):
        clean_path = self.path.split("?", 1)[0]
        if clean_path == "/api/auth/login":
            try:
                payload = self.read_json()
                auth_payload, cookie = login_response(payload)
                self.send_json(auth_payload, headers={"Set-Cookie": cookie})
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                logging.exception("Unexpected server error on %s", clean_path)
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/auth/register-coach":
            try:
                payload = self.read_json()
                auth_payload, cookie = register_coach_response(self, payload)
                self.send_json(auth_payload, headers={"Set-Cookie": cookie})
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                logging.exception("Unexpected server error on %s", clean_path)
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/auth/logout":
            cookie = f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            session_id = self.session_id_from_cookie()
            if session_id:
                SESSIONS.pop(session_id, None)
            self.send_json({"ok": True}, headers={"Set-Cookie": cookie})
            return

        if clean_path == "/api/state":
            session = self.require_session()
            if session is None:
                return
            try:
                payload = self.read_json()
                save_state_for_session(payload, session)
                self.send_json({"ok": True})
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/polar/sync":
            session = self.require_polar_session()
            if session is None:
                return
            try:
                result = sync_polar_workouts()
                self.send_json(result)
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/notifications/test":
            session = self.require_session(roles={"coach"})
            if session is None:
                return
            try:
                result = send_daily_assignment_notification(force=True, coach_id=session.get("coach_id") or DEFAULT_COACH_ID)
                self.send_json(result)
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                logging.exception("Unexpected server error on %s", clean_path)
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/notifications/send":
            session = self.require_session(roles={"coach"})
            if session is None:
                return
            try:
                payload = self.read_json()
                result = send_daily_assignment_notification(force=True, athlete_id=str(payload.get("athleteId") or ""), coach_id=session.get("coach_id") or DEFAULT_COACH_ID)
                self.send_json(result)
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                logging.exception("Unexpected server error on %s", clean_path)
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/plan/review":
            session = self.require_session(roles={"coach"})
            if session is None:
                return
            try:
                payload = self.read_json()
                review = create_ai_plan_review(payload)
                self.send_json({"review": review})
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path != "/api/plan":
            self.send_json({"error": "unknown endpoint"}, status=404)
            return

        session = self.require_session(roles={"coach"})
        if session is None:
            return
        try:
            payload = self.read_json()
            plan = create_ai_plan(payload)
            self.send_json({"plan": plan})
        except AppError as exc:
            self.send_json({"error": str(exc)}, status=exc.status)
        except Exception as exc:
            self.send_json({"error": f"unexpected server error: {exc}"}, status=500)

    def serve_static(self):
        clean_path = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        target = (ROOT / clean_path).resolve()

        if ROOT not in target.parents and target != ROOT:
            self.send_error(403)
            return
        private_roots = {ROOT / "data", ROOT / ".git", ROOT / "__pycache__"}
        if target.name == CONF_FILE.name or any(root in target.parents or target == root for root in private_roots):
            self.send_error(403)
            return
        public_files = {
            "index.html",
            "app.js",
            "styles.css",
            "AvaBotTrainingPlan.png",
            "favicon.ico",
            "favicon.png",
        }
        if auth_enabled() and clean_path not in public_files:
            session = self.require_session()
            if session is None:
                return
            if clean_path.lower().startswith("workouts/") and not is_self_student_session(session):
                self.send_error(403)
                return
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "text/javascript"}:
            content_type = f"{content_type}; charset=utf-8"
        data = target.read_bytes()
        self.send_response(200)
        self.add_cors_headers()
        self.send_header("Content-Type", content_type)
        if content_type.startswith("text/") or content_type.startswith("application/javascript"):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise AppError("empty request body", 400)
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def session_id_from_cookie(self):
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE:
                return value
        return ""

    def require_session(self, roles=None):
        session = current_session(self)
        if not auth_enabled():
            return session
        if not session:
            self.send_json({"error": "auth required"}, status=401)
            return None
        if roles and session.get("role") not in roles:
            self.send_json({"error": "forbidden"}, status=403)
            return None
        return session

    def require_polar_session(self):
        session = self.require_session()
        if session is None:
            return None
        if not auth_enabled():
            return session
        if not is_self_student_session(session):
            self.send_json({"error": "forbidden"}, status=403)
            return None
        return session

    def require_workout_file_import_session(self):
        session = self.require_session()
        if session is None:
            return None
        if not auth_enabled():
            return session
        if not is_self_student_session(session):
            self.send_json({"error": "forbidden"}, status=403)
            return None
        return session

    def send_json(self, payload, status=200, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.add_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return

    def send_html(self, html, status=200):
        data = html.encode("utf-8")
        self.send_response(status)
        self.add_cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location):
        self.send_response(302)
        self.add_cors_headers()
        self.send_header("Location", location)
        self.end_headers()

    def add_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def log_message(self, format, *args):
        logging.info("%s - %s", self.address_string(), format % args)


class AppError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


def scoped_state_key(key, coach_id=DEFAULT_COACH_ID):
    coach_id = str(coach_id or DEFAULT_COACH_ID).strip()
    if key not in STATE_KEYS or coach_id == DEFAULT_COACH_ID:
        return key
    return f"coach:{coach_id}:{key}"


def load_state(coach_id=DEFAULT_COACH_ID):
    return {
        "workouts": load_state_value("workouts", [], coach_id=coach_id),
        "profile": load_state_value("profile", None, coach_id=coach_id),
        "plans": load_state_value("plans", {}, coach_id=coach_id),
        "plansByWeek": load_state_value("plansByWeek", {}, coach_id=coach_id),
        "activePlanSource": load_state_value("activePlanSource", "", coach_id=coach_id),
        "selectedWeekStart": load_state_value("selectedWeekStart", "", coach_id=coach_id),
        "coachProfile": load_state_value("coachProfile", {}, coach_id=coach_id),
        "athletes": load_state_value("athletes", [], coach_id=coach_id),
        "activeAthleteId": load_state_value("activeAthleteId", "", coach_id=coach_id),
        "currentRole": load_state_value("currentRole", "", coach_id=coach_id),
    }


def save_state(payload, coach_id=DEFAULT_COACH_ID):
    if not isinstance(payload, dict):
        raise AppError("state payload must be an object", 400)
    if "workouts" in payload:
        workouts = payload["workouts"]
        if not isinstance(workouts, list):
            raise AppError("workouts must be an array", 400)
        save_state_value("workouts", workouts, coach_id=coach_id)
    if "profile" in payload:
        profile = payload["profile"]
        if profile is not None and not isinstance(profile, dict):
            raise AppError("profile must be an object", 400)
        save_state_value("profile", profile, coach_id=coach_id)
    if "plans" in payload:
        plans = payload["plans"]
        if plans is not None and not isinstance(plans, dict):
            raise AppError("plans must be an object", 400)
        save_state_value("plans", plans or {}, coach_id=coach_id)
    if "activePlanSource" in payload:
        active_plan_source = payload["activePlanSource"]
        if active_plan_source is not None and not isinstance(active_plan_source, str):
            raise AppError("activePlanSource must be a string", 400)
        save_state_value("activePlanSource", active_plan_source or "", coach_id=coach_id)
    if "plansByWeek" in payload:
        plans_by_week = payload["plansByWeek"]
        if plans_by_week is not None and not isinstance(plans_by_week, dict):
            raise AppError("plansByWeek must be an object", 400)
        save_state_value("plansByWeek", plans_by_week or {}, coach_id=coach_id)
    if "selectedWeekStart" in payload:
        selected_week_start = payload["selectedWeekStart"]
        if selected_week_start is not None and not isinstance(selected_week_start, str):
            raise AppError("selectedWeekStart must be a string", 400)
        save_state_value("selectedWeekStart", selected_week_start or "", coach_id=coach_id)
    if "coachProfile" in payload:
        coach_profile = payload["coachProfile"]
        if coach_profile is not None and not isinstance(coach_profile, dict):
            raise AppError("coachProfile must be an object", 400)
        save_state_value("coachProfile", coach_profile or {}, coach_id=coach_id)
    if "athletes" in payload:
        athletes = payload["athletes"]
        if athletes is not None and not isinstance(athletes, list):
            raise AppError("athletes must be an array", 400)
        save_state_value("athletes", sanitize_athletes_for_storage(athletes or []), coach_id=coach_id)
    if "activeAthleteId" in payload:
        active_athlete_id = payload["activeAthleteId"]
        if active_athlete_id is not None and not isinstance(active_athlete_id, str):
            raise AppError("activeAthleteId must be a string", 400)
        save_state_value("activeAthleteId", active_athlete_id or "", coach_id=coach_id)
    if "currentRole" in payload:
        current_role = payload["currentRole"]
        if current_role is not None and not isinstance(current_role, str):
            raise AppError("currentRole must be a string", 400)
        save_state_value("currentRole", current_role or "", coach_id=coach_id)


def save_state_from_coach(payload, coach_id=DEFAULT_COACH_ID):
    if not isinstance(payload, dict):
        raise AppError("state payload must be an object", 400)

    current = load_state(coach_id)
    current_athletes = current.get("athletes") if isinstance(current.get("athletes"), list) else []
    workouts_by_id = {
        str(athlete.get("id") or ""): athlete.get("workouts") or []
        for athlete in current_athletes
        if isinstance(athlete, dict)
    }

    safe_payload = dict(payload)
    safe_payload.pop("workouts", None)

    athletes = payload.get("athletes")
    if isinstance(athletes, list):
        current_by_id = {
            str(athlete.get("id") or ""): athlete
            for athlete in current_athletes
            if isinstance(athlete, dict)
        }
        submitted_by_id = {
            str(athlete.get("id") or ""): athlete
            for athlete in athletes
            if isinstance(athlete, dict) and str(athlete.get("id") or "")
        }
        ordered_ids = []
        for athlete in current_athletes:
            if isinstance(athlete, dict) and str(athlete.get("id") or ""):
                ordered_ids.append(str(athlete.get("id") or ""))
        for athlete in athletes:
            if isinstance(athlete, dict) and str(athlete.get("id") or ""):
                ordered_ids.append(str(athlete.get("id") or ""))

        safe_athletes = []
        for athlete_id in unique_items(ordered_ids):
            athlete = submitted_by_id.get(athlete_id) or current_by_id.get(athlete_id)
            if not isinstance(athlete, dict):
                continue
            safe_athlete = dict(athlete)
            safe_athlete["workouts"] = workouts_by_id.get(athlete_id, [])
            safe_athletes.append(safe_athlete)
        safe_payload["athletes"] = safe_athletes

    save_state(safe_payload, coach_id=coach_id)


def load_state_value(key, fallback, coach_id=DEFAULT_COACH_ID):
    init_db()
    key = scoped_state_key(key, coach_id)
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
    if not row:
        return fallback
    try:
        return json.loads(row[0])
    except json.JSONDecodeError:
        return fallback


def sanitize_athletes_for_storage(athletes):
    if not isinstance(athletes, list):
        return []
    normalized = [athlete for athlete in athletes if isinstance(athlete, dict)]
    self_athlete = next((athlete for athlete in normalized if athlete.get("id") == DEFAULT_ATHLETE_ID), None)
    self_fingerprint = workouts_fingerprint(self_athlete.get("workouts") if isinstance(self_athlete, dict) else [])
    for athlete in normalized:
        is_self = athlete.get("id") == DEFAULT_ATHLETE_ID
        athlete["isSelf"] = is_self
        if not is_self and self_fingerprint and workouts_fingerprint(athlete.get("workouts")) == self_fingerprint:
            athlete["workouts"] = []
    return normalized


def workouts_fingerprint(workouts):
    if not isinstance(workouts, list) or not workouts:
        return ""
    parts = []
    for workout in workouts:
        if not isinstance(workout, dict):
            continue
        parts.append(
            "|".join(
                str(workout.get(key) or "")
                for key in ["date", "source", "durationMin", "distanceKm", "load"]
            )
        )
    return json.dumps(sorted(parts), ensure_ascii=False)


def workout_identity(workout):
    if not isinstance(workout, dict):
        return ""
    return "|".join(
        str(workout.get(key) or "")
        for key in ["date", "source", "durationMin", "distanceKm", "load"]
    )


def merge_student_workout_feedback(existing_workouts, submitted_workouts):
    if not isinstance(existing_workouts, list):
        existing_workouts = []
    if not isinstance(submitted_workouts, list):
        return existing_workouts

    submitted_by_key = {
        workout_identity(workout): workout
        for workout in submitted_workouts
        if isinstance(workout, dict) and workout_identity(workout)
    }
    merged = []
    for workout in existing_workouts:
        if not isinstance(workout, dict):
            continue
        updated = dict(workout)
        submitted = submitted_by_key.get(workout_identity(workout))
        feedback = submitted.get("feedback") if isinstance(submitted, dict) else None
        if isinstance(feedback, dict):
            updated["feedback"] = feedback
        merged.append(updated)
    return merged


def filter_student_workouts_for_storage(athlete_id, workouts, athletes):
    if not isinstance(workouts, list):
        return []
    if athlete_id == DEFAULT_ATHLETE_ID:
        return workouts

    self_athlete = next((item for item in athletes if isinstance(item, dict) and item.get("id") == DEFAULT_ATHLETE_ID), None)
    self_workouts = self_athlete.get("workouts") if isinstance(self_athlete, dict) else []
    self_identities = {
        workout_identity(workout)
        for workout in self_workouts
        if workout_identity(workout)
    }
    return [
        workout for workout in workouts
        if not workout_identity(workout) or workout_identity(workout) not in self_identities
    ]


def save_state_value(key, value, coach_id=DEFAULT_COACH_ID):
    init_db()
    key = scoped_state_key(key, coach_id)
    raw = json.dumps(value, ensure_ascii=False)
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            INSERT INTO app_state (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            """,
            (key, raw),
        )


def auth_enabled():
    return bool(AUTH_CONFIG.get("enabled", False))


def coach_password():
    value = str(AUTH_CONFIG.get("coachPassword") or "").strip()
    if value:
        return value
    env_name = str(AUTH_CONFIG.get("coachPasswordEnv") or "TRAINING_COACH_PASSWORD").strip()
    return os.environ.get(env_name, "").strip() if env_name else ""


def coach_registration_code():
    value = str(AUTH_CONFIG.get("coachRegistrationCode") or "").strip()
    if value:
        return value
    env_name = str(AUTH_CONFIG.get("coachRegistrationCodeEnv") or "TRAINING_COACH_REGISTRATION_CODE").strip()
    return os.environ.get(env_name, "").strip() if env_name else ""


def normalize_coach_login(value):
    return re.sub(r"[^a-z0-9_.@-]+", "", str(value or "").strip().lower())[:80]


def password_hash(password):
    salt = secrets.token_hex(16)
    rounds = 120000
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt.encode("utf-8"), rounds).hex()
    return f"pbkdf2_sha256${rounds}${salt}${digest}"


def verify_password(stored_hash, password):
    parts = str(stored_hash or "").split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
        return False
    try:
        rounds = int(parts[1])
    except ValueError:
        return False
    salt, expected = parts[2], parts[3]
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt.encode("utf-8"), rounds).hex()
    return hmac.compare_digest(digest, expected)


def default_coach_record():
    profile = load_state_value("coachProfile", {}) or {}
    login = normalize_coach_login(AUTH_CONFIG.get("defaultCoachLogin") or "coach") or "coach"
    password = coach_password()
    return {
        "id": DEFAULT_COACH_ID,
        "login": login,
        "name": profile.get("name") or "Белоусов Алексей",
        "passwordHash": password_hash(password) if password else "",
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "isDefault": True,
    }


def load_saved_coaches():
    coaches = load_state_value(COACHES_KEY, [], coach_id="")
    return [coach for coach in coaches if isinstance(coach, dict)] if isinstance(coaches, list) else []


def load_coaches():
    coaches = load_saved_coaches()
    if coaches:
        return coaches
    return [default_coach_record()]


def save_coaches(coaches):
    clean = []
    seen = set()
    for coach in coaches:
        if not isinstance(coach, dict):
            continue
        coach_id = str(coach.get("id") or "").strip()
        login = normalize_coach_login(coach.get("login"))
        if not coach_id or not login or coach_id in seen:
            continue
        seen.add(coach_id)
        clean.append({
            "id": coach_id,
            "login": login,
            "name": str(coach.get("name") or login).strip() or login,
            "passwordHash": str(coach.get("passwordHash") or ""),
            "createdAt": str(coach.get("createdAt") or datetime.now().isoformat(timespec="seconds")),
            "updatedAt": str(coach.get("updatedAt") or datetime.now().isoformat(timespec="seconds")),
            "isDefault": bool(coach.get("isDefault")),
        })
    save_state_value(COACHES_KEY, clean, coach_id="")


def coach_by_id(coach_id):
    coach_id = str(coach_id or DEFAULT_COACH_ID).strip()
    return next((coach for coach in load_coaches() if str(coach.get("id") or "") == coach_id), None)


def coach_by_login(login):
    login = normalize_coach_login(login)
    coaches = load_coaches()
    if not login:
        return next((coach for coach in coaches if coach.get("id") == DEFAULT_COACH_ID), coaches[0] if coaches else None)
    return next((coach for coach in coaches if normalize_coach_login(coach.get("login")) == login), None)


def coach_registration_allowed():
    return bool(AUTH_CONFIG.get("allowCoachRegistration", False)) or not load_saved_coaches()


def register_coach_response(handler, payload):
    if not isinstance(payload, dict):
        raise AppError("registration payload must be an object", 400)
    current = current_session(handler)
    current_is_coach = bool(current and current.get("role") == "coach")
    if auth_enabled() and not coach_registration_allowed() and not current_is_coach:
        raise AppError("Coach registration is disabled.", 403)
    expected_code = coach_registration_code()
    provided_code = str(payload.get("registrationCode") or "").strip()
    if expected_code and not current_is_coach and not hmac.compare_digest(provided_code, expected_code):
        raise AppError("Invalid coach registration code.", 401)

    login = normalize_coach_login(payload.get("coachLogin") or payload.get("login"))
    name = str(payload.get("coachName") or payload.get("name") or "").strip()
    password = str(payload.get("password") or "")
    if len(login) < 3:
        raise AppError("Логин тренера должен быть не короче 3 символов.", 400)
    if len(password) < 4:
        raise AppError("Пароль тренера должен быть не короче 4 символов.", 400)
    coaches = load_coaches()
    if any(normalize_coach_login(coach.get("login")) == login for coach in coaches):
        raise AppError("Тренер с таким логином уже существует.", 409)

    coach_id = f"coach-{secrets.token_urlsafe(8).lower().replace('_', '-') }"
    now = datetime.now().isoformat(timespec="seconds")
    coach = {
        "id": coach_id,
        "login": login,
        "name": name or login,
        "passwordHash": password_hash(password),
        "createdAt": now,
        "updatedAt": now,
        "isDefault": False,
    }
    coaches.append(coach)
    save_coaches(coaches)
    save_state({
        "coachProfile": {"id": coach_id, "name": coach["name"]},
        "athletes": [],
        "activeAthleteId": "",
        "currentRole": "coach",
    }, coach_id=coach_id)
    session, cookie = create_session("coach", "", coach_id=coach_id)
    return auth_login_payload(session, enabled=auth_enabled()), cookie


def current_session(handler):
    if not auth_enabled():
        return {"role": "coach", "athlete_id": load_state_value("activeAthleteId", ""), "coach_id": DEFAULT_COACH_ID}
    session_id = handler.session_id_from_cookie()
    if not session_id:
        return None
    session = SESSIONS.get(session_id)
    if not session:
        return None
    if session.get("expires_at", 0) < time.time():
        SESSIONS.pop(session_id, None)
        return None
    return session


def create_session(role, athlete_id="", coach_id=DEFAULT_COACH_ID):
    session_id = secrets.token_urlsafe(32)
    ttl_hours = int(AUTH_CONFIG.get("sessionTtlHours", 24) or 24)
    SESSIONS[session_id] = {
        "role": role,
        "athlete_id": athlete_id or "",
        "coach_id": coach_id or DEFAULT_COACH_ID,
        "created_at": int(time.time()),
        "expires_at": int(time.time() + ttl_hours * 3600),
    }
    cookie = f"{SESSION_COOKIE}={session_id}; Path=/; Max-Age={ttl_hours * 3600}; HttpOnly; SameSite=Lax"
    return SESSIONS[session_id], cookie


def auth_status_response(handler):
    enabled = auth_enabled()
    session = current_session(handler)
    coach = coach_by_id(session.get("coach_id")) if session else None
    return {
        "enabled": enabled,
        "authenticated": bool(session),
        "role": session.get("role", "") if session else "",
        "athleteId": session.get("athlete_id", "") if session else "",
        "coachId": session.get("coach_id", "") if session else "",
        "coachName": coach.get("name", "") if coach else "",
        "coachConfigured": bool(coach_password() or load_saved_coaches()) if enabled else True,
        "coachRegistrationAllowed": coach_registration_allowed(),
        "coachRegistrationRequiresCode": bool(coach_registration_code()),
    }


def auth_login_payload(session, enabled=True):
    coach = coach_by_id(session.get("coach_id")) if session else None
    return {
        "ok": True,
        "enabled": bool(enabled),
        "authenticated": True,
        "role": session.get("role", ""),
        "athleteId": session.get("athlete_id", ""),
        "coachId": session.get("coach_id", ""),
        "coachName": coach.get("name", "") if coach else "",
        "coachConfigured": bool(coach_password() or load_saved_coaches()) if enabled else True,
        "coachRegistrationAllowed": coach_registration_allowed(),
        "coachRegistrationRequiresCode": bool(coach_registration_code()),
    }


def login_response(payload):
    if not auth_enabled():
        session, cookie = create_session("coach", load_state_value("activeAthleteId", ""), coach_id=DEFAULT_COACH_ID)
        return auth_login_payload(session, enabled=False), cookie
    if not isinstance(payload, dict):
        raise AppError("login payload must be an object", 400)

    role = str(payload.get("role") or "").strip().lower()
    if role == "coach":
        provided = str(payload.get("password") or "")
        login = normalize_coach_login(payload.get("coachLogin") or payload.get("login"))
        coach = coach_by_login(login)
        if not coach:
            raise AppError("Неверный логин или пароль тренера.", 401)
        saved_coaches = load_saved_coaches()
        legacy_default = not saved_coaches and coach.get("id") == DEFAULT_COACH_ID and coach_password()
        password_ok = hmac.compare_digest(provided, coach_password()) if legacy_default else verify_password(coach.get("passwordHash"), provided)
        if not password_ok:
            raise AppError("Неверный логин или пароль тренера.", 401)
        coach_id = coach.get("id") or DEFAULT_COACH_ID
        session, cookie = create_session("coach", load_state_value("activeAthleteId", "", coach_id=coach_id), coach_id=coach_id)
        return auth_login_payload(session, enabled=True), cookie

    if role == "student":
        code = normalize_access_code(payload.get("accessCode") or payload.get("password"))
        athlete, coach_id = athlete_by_access_code(code)
        if not athlete:
            raise AppError("Неверный код ученика.", 401)
        session, cookie = create_session("student", str(athlete.get("id") or ""), coach_id=coach_id)
        return auth_login_payload(session, enabled=True), cookie

    raise AppError("Unknown role.", 400)

def normalize_access_code(value):
    return str(value or "").strip().upper().replace(" ", "")


def athlete_auth_data(athlete):
    return athlete.get("auth") if isinstance(athlete, dict) and isinstance(athlete.get("auth"), dict) else {}


def athlete_access_code(athlete):
    return normalize_access_code(athlete_auth_data(athlete).get("accessCode"))


def athlete_by_access_code(code):
    if not code:
        return None, ""
    for coach in load_coaches():
        coach_id = coach.get("id") or DEFAULT_COACH_ID
        athlete = next((athlete for athlete in telegram_athletes(coach_id) if athlete_access_code(athlete) == code), None)
        if athlete:
            return athlete, coach_id
    return None, ""


def state_for_session(session):
    coach_id = session.get("coach_id") or DEFAULT_COACH_ID
    state = load_state(coach_id)
    coach = coach_by_id(coach_id)
    if coach and not state.get("coachProfile"):
        state["coachProfile"] = {"id": coach_id, "name": coach.get("name") or "Тренер"}
    if not auth_enabled() or session.get("role") == "coach":
        state["currentRole"] = "coach"
        return state

    athlete_id = session.get("athlete_id", "")
    athletes = state.get("athletes") if isinstance(state.get("athletes"), list) else []
    athlete = next((item for item in athletes if isinstance(item, dict) and str(item.get("id") or "") == athlete_id), None)
    if not athlete:
        return {
            "workouts": [],
            "profile": None,
            "plans": {},
            "plansByWeek": {},
            "activePlanSource": "",
            "selectedWeekStart": "",
            "coachProfile": {},
            "athletes": [],
            "activeAthleteId": "",
            "currentRole": "student",
        }

    return {
        "workouts": athlete.get("workouts") or [],
        "profile": athlete.get("profile") or {},
        "plans": athlete.get("plans") or {},
        "plansByWeek": athlete.get("plansByWeek") or {},
        "activePlanSource": athlete.get("activePlanSource") or "json",
        "selectedWeekStart": athlete.get("selectedWeekStart") or "",
        "coachProfile": state.get("coachProfile") or ({"id": coach_id, "name": coach.get("name") or "Тренер"} if coach else {}),
        "athletes": [athlete],
        "activeAthleteId": athlete_id,
        "currentRole": "student",
    }


def save_state_for_session(payload, session):
    coach_id = session.get("coach_id") or DEFAULT_COACH_ID
    if not auth_enabled():
        save_state(payload, coach_id=coach_id)
        return
    if session.get("role") == "coach":
        save_state_from_coach(payload, coach_id=coach_id)
        return

    if not isinstance(payload, dict):
        raise AppError("state payload must be an object", 400)
    athlete_id = session.get("athlete_id", "")
    athletes = telegram_athletes(coach_id)
    index = next((idx for idx, item in enumerate(athletes) if str(item.get("id") or "") == athlete_id), -1)
    if index < 0:
        raise AppError("Athlete not found.", 404)

    athlete = athletes[index]
    submitted_athlete = {}
    submitted_athletes = payload.get("athletes")
    if isinstance(submitted_athletes, list):
        submitted_athlete = next((item for item in submitted_athletes if isinstance(item, dict) and str(item.get("id") or "") == athlete_id), submitted_athletes[0] if submitted_athletes else {})

    profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else submitted_athlete.get("profile")
    workouts = payload.get("workouts") if isinstance(payload.get("workouts"), list) else submitted_athlete.get("workouts")
    selected_week = payload.get("selectedWeekStart") or submitted_athlete.get("selectedWeekStart")

    if isinstance(profile, dict):
        athlete["profile"] = profile
        athlete["name"] = profile.get("name") or athlete.get("name") or "Спортсмен"
    if isinstance(workouts, list):
        athlete["workouts"] = filter_student_workouts_for_storage(athlete_id, workouts, athletes)
    if isinstance(selected_week, str):
        athlete["selectedWeekStart"] = selected_week
    athlete["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    athletes[index] = athlete
    save_telegram_athletes(athletes, coach_id=coach_id)


def notification_status(session=None):
    telegram = telegram_notification_config()
    coach_id = session.get("coach_id") if isinstance(session, dict) else DEFAULT_COACH_ID
    athletes = telegram_athletes(coach_id or DEFAULT_COACH_ID)
    plan_day = get_today_plan_day(default_telegram_athlete(coach_id or DEFAULT_COACH_ID))
    return {
        "provider": "telegram",
        "enabled": telegram["enabled"],
        "configured": bool(telegram["bot_token"]),
        "dailyTime": telegram["daily_time"],
        "automaticDaily": False,
        "lastSent": load_state_value("dailyNotificationLastSent", ""),
        "lastSentAt": load_state_value("dailyNotificationLastSentAt", ""),
        "hasTodayAssignment": bool(plan_day),
        "todayButton": telegram["today_button_text"] if telegram["show_today_button"] else "",
        "linkedAthletes": len([athlete for athlete in athletes if athlete_chat_id(athlete)]),
    }

def mask_secret(value):
    text = str(value or "")
    if len(text) <= 4:
        return "***"
    return "***" + text[-4:]

def clean_telegram_button_text(value):
    text = str(value or "").strip()
    compact = text.replace(" ", "")
    if not text or "\ufffd" in text or (compact and set(compact) <= {"?"}):
        return TODAY_BUTTON_TEXT
    return text


def telegram_notification_config():
    telegram = NOTIFICATIONS_CONFIG.get("telegram", {})
    return {
        "enabled": bool(telegram.get("enabled", False)),
        "bot_token": telegram.get("botToken") or os.environ.get(telegram.get("botTokenEnv", "TELEGRAM_BOT_TOKEN"), ""),
        "chat_id": telegram.get("chatId") or os.environ.get(telegram.get("chatIdEnv", "TELEGRAM_CHAT_ID"), ""),
        "daily_time": telegram.get("dailyTime", "08:00"),
        "send_on_rest_days": bool(telegram.get("sendOnRestDays", True)),
        "remove_keyboard": bool(telegram.get("removeKeyboard", True)),
        "show_today_button": bool(telegram.get("showTodayButton", True)),
        "today_button_text": clean_telegram_button_text(telegram.get("todayButtonText")),
        "poll_commands": bool(telegram.get("pollCommands", True)),
        "clear_menu": bool(telegram.get("clearMenu", True)),
        "timeout_seconds": int(telegram.get("timeoutSeconds", 45) or 45),
        "force_ipv4": bool(telegram.get("forceIPv4", True)),
    }


def start_notification_worker():
    telegram = telegram_notification_config()
    if not telegram["bot_token"]:
        return
    if telegram["clear_menu"]:
        menu_thread = threading.Thread(target=configure_telegram_bot_ui, args=(telegram,), name="telegram-menu", daemon=True)
        menu_thread.start()
    if telegram["poll_commands"]:
        command_thread = threading.Thread(target=telegram_command_worker_loop, name="telegram-commands", daemon=True)
        command_thread.start()


def telegram_command_worker_loop():
    while True:
        try:
            poll_telegram_updates()
        except Exception as exc:
            logging.warning("Telegram command error: %s", exc)
            time.sleep(10)


def send_daily_assignment_notification(force=False, athlete_id="", coach_id=DEFAULT_COACH_ID):
    telegram = telegram_notification_config()
    if not force and not telegram["enabled"]:
        return {"ok": False, "skipped": "notifications disabled"}
    if not telegram["bot_token"]:
        raise AppError("Telegram notifications are not configured. Add notifications.telegram.botToken to conf.json.", 500)

    athlete = telegram_athlete_by_id(athlete_id, coach_id=coach_id) if athlete_id else default_telegram_athlete(coach_id=coach_id)
    chat_id = athlete_chat_id(athlete) or telegram["chat_id"]
    if not chat_id:
        raise AppError("Telegram chat is not linked. Generate a student code and ask the student to send it to the bot.", 400)
    if not force and not notification_time_reached(telegram["daily_time"]):
        return {"ok": False, "skipped": "not time yet"}

    sent_key = f"{coach_id}:{athlete.get('id') or str(chat_id)}"
    if not force and daily_assignment_sent_today(sent_key):
        return {"ok": False, "skipped": "already sent today"}

    plan_day = get_today_plan_day(athlete)
    if not plan_day:
        raise AppError("No saved plan assignment for today.", 404)
    if not telegram["send_on_rest_days"] and is_rest_assignment(plan_day):
        return {"ok": False, "skipped": "rest day"}

    text = format_daily_assignment_message(plan_day)
    logging.info("Telegram send assignment: athlete=%s chat=%s force=%s", athlete.get("id") or "", mask_secret(str(chat_id)), force)
    send_telegram_message(
        telegram["bot_token"],
        chat_id,
        text,
        reply_markup=telegram_reply_markup(telegram),
    )
    if not force:
        mark_daily_assignment_sent(sent_key)
    return {"ok": True, "message": text, "athleteId": athlete.get("id") or "", "chatId": str(chat_id)}


def daily_assignment_sent_today(key="default"):
    today = date.today().isoformat()
    sent_by_athlete = load_state_value("dailyNotificationSentByAthlete", {})
    if isinstance(sent_by_athlete, dict) and sent_by_athlete.get(str(key)) == today:
        return True
    return key == "default" and load_state_value("dailyNotificationLastSent", "") == today


def mark_daily_assignment_sent(key="default"):
    now = datetime.now().isoformat(timespec="seconds")
    today = date.today().isoformat()
    sent_by_athlete = load_state_value("dailyNotificationSentByAthlete", {})
    if not isinstance(sent_by_athlete, dict):
        sent_by_athlete = {}
    sent_by_athlete[str(key)] = today
    save_state_value("dailyNotificationSentByAthlete", sent_by_athlete)
    save_state_value("dailyNotificationLastSent", today)
    save_state_value("dailyNotificationLastSentAt", now)


def notification_time_reached(value):
    try:
        hour, minute = [int(part) for part in str(value).split(":", 1)]
        target = datetime_time(hour=hour, minute=minute)
    except (TypeError, ValueError):
        target = datetime_time(hour=8, minute=0)
    now = datetime.now().time()
    return now >= target


def telegram_athletes(coach_id=DEFAULT_COACH_ID):
    athletes = load_state_value("athletes", [], coach_id=coach_id)
    if isinstance(athletes, list) and athletes:
        return [athlete for athlete in athletes if isinstance(athlete, dict)]
    if coach_id != DEFAULT_COACH_ID:
        return []
    profile = load_state_value("profile", {}, coach_id=coach_id) or {}
    return [
        {
            "id": "athlete-belousov-aleksey",
            "name": profile.get("name") or "Белоусов Алексей",
            "isSelf": True,
            "profile": profile,
            "workouts": load_state_value("workouts", [], coach_id=coach_id),
            "plansByWeek": load_state_value("plansByWeek", {}, coach_id=coach_id),
            "activePlanSource": load_state_value("activePlanSource", "", coach_id=coach_id),
        }
    ]


def save_telegram_athletes(athletes, coach_id=DEFAULT_COACH_ID):
    athletes = sanitize_athletes_for_storage(athletes)
    save_state_value("athletes", athletes, coach_id=coach_id)
    active_id = load_state_value("activeAthleteId", "", coach_id=coach_id)
    active = next((athlete for athlete in athletes if athlete.get("id") == active_id), None)
    if active:
        save_state_value("profile", active.get("profile") or {}, coach_id=coach_id)
        save_state_value("workouts", active.get("workouts") or [], coach_id=coach_id)
        save_state_value("plansByWeek", active.get("plansByWeek") or {}, coach_id=coach_id)
        save_state_value("activePlanSource", active.get("activePlanSource") or "", coach_id=coach_id)

def athlete_chat_id(athlete):
    telegram = athlete.get("telegram") if isinstance(athlete, dict) and isinstance(athlete.get("telegram"), dict) else {}
    return str(telegram.get("chatId") or "").strip()


def athlete_bind_code(athlete):
    telegram = athlete.get("telegram") if isinstance(athlete, dict) and isinstance(athlete.get("telegram"), dict) else {}
    return str(telegram.get("bindCode") or "").strip().upper()


def default_telegram_athlete(coach_id=DEFAULT_COACH_ID):
    athletes = telegram_athletes(coach_id)
    if not athletes:
        return {}
    return next((athlete for athlete in athletes if athlete.get("isSelf")), athletes[0])


def telegram_athlete_by_id(athlete_id, coach_id=DEFAULT_COACH_ID):
    athlete = next((item for item in telegram_athletes(coach_id) if str(item.get("id") or "") == str(athlete_id or "")), None)
    if not athlete:
        raise AppError("Athlete not found.", 404)
    return athlete


def telegram_athlete_by_chat(chat_id, telegram):
    chat_id = str(chat_id or "").strip()
    if not chat_id:
        return None
    for coach in load_coaches():
        athlete = next((item for item in telegram_athletes(coach.get("id") or DEFAULT_COACH_ID) if athlete_chat_id(item) == chat_id), None)
        if athlete:
            return athlete
    if telegram.get("chat_id") and chat_id == str(telegram["chat_id"]):
        return default_telegram_athlete(DEFAULT_COACH_ID)
    return None


def bind_telegram_chat(bind_code, chat):
    normalized_code = str(bind_code or "").strip().upper().replace(" ", "")
    if not normalized_code:
        return None
    for coach in load_coaches():
        coach_id = coach.get("id") or DEFAULT_COACH_ID
        athletes = telegram_athletes(coach_id)
        for index, athlete in enumerate(athletes):
            if athlete_bind_code(athlete) != normalized_code:
                continue
            telegram_data = athlete.get("telegram") if isinstance(athlete.get("telegram"), dict) else {}
            telegram_data.update(
                {
                    "chatId": str(chat.get("id") or ""),
                    "username": str(chat.get("username") or ""),
                    "firstName": str(chat.get("first_name") or ""),
                    "lastName": str(chat.get("last_name") or ""),
                    "linkedAt": datetime.now().isoformat(timespec="seconds"),
                    "bindCode": "",
                }
            )
            athlete["telegram"] = telegram_data
            athletes[index] = athlete
            save_telegram_athletes(athletes, coach_id=coach_id)
            return athlete
    return None


def bind_code_from_text(text):
    normalized = str(text or "").strip()
    if not normalized:
        return ""
    match = re.search(r"(?:/start|/bind)?\s*([A-Za-zА-Яа-я0-9_-]{5,16})", normalized, flags=re.IGNORECASE)
    return match.group(1).upper() if match else ""


def get_today_plan_day(athlete=None):
    today = date.today()
    week_key = monday_of_week(today).isoformat()
    plans_by_week = athlete.get("plansByWeek") if isinstance(athlete, dict) else None
    if not isinstance(plans_by_week, dict):
        plans_by_week = load_state_value("plansByWeek", {})
    bucket = plans_by_week.get(week_key) if isinstance(plans_by_week, dict) else None
    if not isinstance(bucket, dict):
        return None

    sources = bucket.get("sources") if isinstance(bucket.get("sources"), dict) else {}
    active_source = bucket.get("activePlanSource") or (athlete.get("activePlanSource") if isinstance(athlete, dict) else "") or load_state_value("activePlanSource", "")
    ordered_sources = unique_items([active_source, "json", "ai", "local", *sources.keys()])
    for source in ordered_sources:
        plan = sources.get(source)
        days = plan.get("days") if isinstance(plan, dict) else None
        if not isinstance(days, list):
            continue
        for day in days:
            if not isinstance(day, dict):
                continue
            day_date = parse_plan_day_date(day.get("date"))
            if day_date == today:
                return {**day, "source": source}
    return None


def monday_of_week(value):
    return value - timedelta(days=value.weekday())


def parse_plan_day_date(value):
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            return None


def unique_items(items):
    result = []
    for item in items:
        if item and item not in result:
            result.append(item)
    return result


def is_rest_assignment(day):
    text = " ".join(str(day.get(key, "")) for key in ["focus", "title", "details", "plannedWorkout"]).lower()
    return "отдых" in text or "rest" in text


def format_daily_assignment_message(day):
    planned_parts = unique_items([day.get("plannedWorkout"), day.get("details")])
    planned = "\n\n".join(planned_parts) if planned_parts else "Задание не указано."
    parameters = []
    if day.get("targetDistance"):
        parameters.append(f"Ориентир: {day.get('targetDistance')}")
    if day.get("intensity"):
        parameters.append(f"Интенсивность: {day.get('intensity')}")
    if day.get("load"):
        parameters.append(f"Нагрузка: {day.get('load')}")

    lines = [
        "План на сегодня",
        f"{day.get('dateLabel') or date.today().strftime('%d.%m.%Y')}",
        "",
        f"{day.get('focus') or 'Тренировка'}: {day.get('title') or 'Задание'}",
        "",
        "Задание:",
        planned,
    ]
    if parameters:
        lines.extend(["", "Параметры:", *parameters])
    if day.get("rationale"):
        lines.extend(["", "Почему так:", str(day.get("rationale"))])
    return "\n".join(lines)


def telegram_reply_markup(telegram):
    if telegram.get("show_today_button"):
        return {
            "keyboard": [[{"text": telegram["today_button_text"]}]],
            "resize_keyboard": True,
            "one_time_keyboard": False,
            "is_persistent": True,
        }
    if telegram.get("remove_keyboard"):
        return {"remove_keyboard": True}
    return None


def configure_telegram_bot_ui(telegram):
    try:
        scopes = [
            None,
            {"type": "all_private_chats"},
            {"type": "all_group_chats"},
            {"type": "all_chat_administrators"},
        ]
        if telegram.get("chat_id"):
            scopes.append({"type": "chat", "chat_id": telegram["chat_id"]})
        for scope in scopes:
            for language_code in [None, "ru", "en"]:
                delete_telegram_commands(telegram["bot_token"], scope, language_code)
        if telegram.get("chat_id"):
            set_telegram_menu_button(telegram["bot_token"], telegram["chat_id"])
    except Exception as exc:
        logging.warning("Telegram menu cleanup error: %s", exc)


def delete_telegram_commands(bot_token, scope=None, language_code=None):
    payload = {}
    if scope:
        payload["scope"] = scope
    if language_code:
        payload["language_code"] = language_code
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    url = f"https://api.telegram.org/bot{bot_token}/deleteMyCommands"
    http_json(url, method="POST", data=data, headers=headers)


def set_telegram_menu_button(bot_token, chat_id):
    payload = {
        "chat_id": chat_id,
        "menu_button": {"type": "default"},
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    url = f"https://api.telegram.org/bot{bot_token}/setChatMenuButton"
    http_json(url, method="POST", data=data, headers=headers)


def send_telegram_message(bot_token, chat_id, text, reply_markup=None):
    payload = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    http_json(url, method="POST", data=data, headers=headers)


def poll_telegram_updates():
    telegram = telegram_notification_config()
    if not telegram["poll_commands"] or not telegram["bot_token"]:
        time.sleep(10)
        return

    params = {
        "timeout": 25,
        "allowed_updates": json.dumps(["message"]),
    }
    offset = int(load_state_value("telegramUpdateOffset", 0) or 0)
    if offset:
        params["offset"] = offset
    url = f"https://api.telegram.org/bot{telegram['bot_token']}/getUpdates?{urlencode(params)}"
    payload = http_json(url)
    updates = payload.get("result") if isinstance(payload, dict) else []
    if not isinstance(updates, list):
        return

    last_update_id = None
    for update in updates:
        if not isinstance(update, dict):
            continue
        update_id = update.get("update_id")
        if isinstance(update_id, int):
            last_update_id = update_id if last_update_id is None else max(last_update_id, update_id)
        handle_telegram_update(update, telegram)

    if last_update_id is not None:
        save_state_value("telegramUpdateOffset", last_update_id + 1)


def handle_telegram_update(update, telegram):
    message = update.get("message") if isinstance(update.get("message"), dict) else {}
    text = str(message.get("text") or "").strip()
    chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
    chat_id = str(chat.get("id") or "")
    if not text or not chat_id:
        return

    bind_code = bind_code_from_text(text)
    if bind_code:
        bound_athlete = bind_telegram_chat(bind_code, chat)
        if bound_athlete:
            send_telegram_message(
                telegram["bot_token"],
                chat_id,
                f"Telegram подключен к спортсмену: {bound_athlete.get('name') or 'спортсмен'}. Теперь можно нажать «{telegram['today_button_text']}».",
                reply_markup=telegram_reply_markup(telegram),
            )
            return

    if not is_today_plan_command(text, telegram):
        return

    athlete = telegram_athlete_by_chat(chat_id, telegram)
    if not athlete:
        response = "Чат не привязан к ученику. Попросите тренера сгенерировать код Telegram и отправьте его сюда."
        send_telegram_message(telegram["bot_token"], chat_id, response, reply_markup=telegram_reply_markup(telegram))
        return

    sent_key = athlete.get("id") or chat_id
    if daily_assignment_sent_today(sent_key):
        response = "План на сегодня уже был отправлен ранее. Повторно не отправляю, чтобы не дублировать."
    else:
        plan_day = get_today_plan_day(athlete)
        if plan_day:
            response = format_daily_assignment_message(plan_day)
            mark_daily_assignment_sent(sent_key)
        else:
            response = "На сегодня нет сохраненного плана. Тренеру нужно создать или загрузить план на текущую неделю."
    send_telegram_message(
        telegram["bot_token"],
        chat_id,
        response,
        reply_markup=telegram_reply_markup(telegram),
    )


def is_today_plan_command(text, telegram):
    normalized = str(text or "").strip().lower()
    commands = {telegram["today_button_text"].strip().lower(), "/today", "/plan", "/start"}
    if normalized in commands:
        return True
    return bool(normalized) and all(char in {"?", " "} for char in normalized)


def polar_status():
    credentials = load_polar_credentials()
    token = load_state_value("polarToken", {})
    return {
        "enabled": bool(POLAR_CONFIG.get("enabled", True)),
        "configured": bool(credentials.get("client_id") and credentials.get("client_secret")),
        "connected": bool(token.get("access_token")),
        "userId": token.get("x_user_id") or token.get("user_id") or "",
        "lastSync": load_state_value("polarLastSync", ""),
        "downloadTcx": bool(POLAR_CONFIG.get("downloadTcx", True)),
        "backgroundSync": bool(POLAR_CONFIG.get("backgroundSync", True)),
        "backgroundSyncIntervalSeconds": positive_int(POLAR_CONFIG.get("backgroundSyncIntervalSeconds"), 600, minimum=300),
        "syncAthleteId": polar_sync_target_athlete_id(),
    }


def load_polar_credentials():
    return {
        "client_id": POLAR_CONFIG.get("clientId") or os.environ.get(POLAR_CONFIG.get("clientIdEnv", "POLAR_CLIENT_ID"), ""),
        "client_secret": POLAR_CONFIG.get("clientSecret") or os.environ.get(POLAR_CONFIG.get("clientSecretEnv", "POLAR_CLIENT_SECRET"), ""),
        "redirect_uri": POLAR_CONFIG.get("redirectUri", f"http://{HOST}:{PORT}/api/polar/callback"),
        "scope": POLAR_CONFIG.get("scope", "accesslink.read_all"),
    }


def polar_authorization_url():
    credentials = load_polar_credentials()
    if not credentials.get("client_id") or not credentials.get("client_secret"):
        raise AppError("Polar credentials not found. Add polar.clientId and polar.clientSecret to conf.json.", 500)

    state = secrets.token_urlsafe(24)
    save_state_value("polarOAuthState", {"state": state, "createdAt": int(time.time())})
    params = {
        "response_type": "code",
        "client_id": credentials["client_id"],
        "scope": credentials.get("scope", "accesslink.read_all"),
        "state": state,
    }
    if credentials.get("redirect_uri"):
        params["redirect_uri"] = credentials["redirect_uri"]
    return "https://flow.polar.com/oauth2/authorization?" + urlencode(params)


def handle_polar_callback(path):
    query = parse_qs(urlparse(path).query)
    if query.get("error"):
        raise AppError(f"Polar authorization error: {query['error'][0]}", 400)
    code = first_query_value(query, "code")
    state = first_query_value(query, "state")
    if not code:
        raise AppError("Polar callback has no authorization code", 400)

    stored_state = load_state_value("polarOAuthState", {})
    if stored_state.get("state") and state != stored_state.get("state"):
        raise AppError("Polar OAuth state mismatch", 400)

    token = exchange_polar_code(code)
    token["connected_at"] = int(time.time())
    save_state_value("polarToken", token)
    register_polar_user(token)
    save_state_value("polarOAuthState", {})
    return {"ok": True, "userId": token.get("x_user_id") or token.get("user_id") or ""}


def first_query_value(query, key):
    values = query.get(key) or []
    return values[0] if values else ""


def exchange_polar_code(code):
    credentials = load_polar_credentials()
    data = urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            **({"redirect_uri": credentials["redirect_uri"]} if credentials.get("redirect_uri") else {}),
        }
    ).encode("utf-8")
    headers = {
        "Authorization": "Basic " + basic_auth_token(credentials["client_id"], credentials["client_secret"]),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json;charset=UTF-8",
    }
    return http_json("https://polarremote.com/v2/oauth2/token", method="POST", data=data, headers=headers)


def register_polar_user(token):
    access_token = token.get("access_token")
    if not access_token:
        return
    member_id = f"training-coach-{token.get('x_user_id') or token.get('user_id') or 'local'}"
    body = json.dumps({"member-id": member_id}).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        result = http_json("https://www.polaraccesslink.com/v3/users", method="POST", data=body, headers=headers)
        if result.get("polar-user-id"):
            token["polar_user_id"] = result.get("polar-user-id")
            save_state_value("polarToken", token)
    except AppError as exc:
        if exc.status not in {409, 400}:
            raise


def start_polar_sync_worker():
    if not POLAR_CONFIG.get("enabled", True) or not POLAR_CONFIG.get("backgroundSync", True):
        logging.info("Polar background sync is disabled")
        return
    credentials = load_polar_credentials()
    if not credentials.get("client_id") or not credentials.get("client_secret"):
        logging.info("Polar background sync is not started: credentials are missing")
        return
    interval = positive_int(POLAR_CONFIG.get("backgroundSyncIntervalSeconds"), 600, minimum=300)
    initial_delay = positive_int(POLAR_CONFIG.get("backgroundSyncInitialDelaySeconds"), 20, minimum=0)
    thread = threading.Thread(
        target=polar_sync_worker_loop,
        args=(interval, initial_delay),
        name="polar-sync",
        daemon=True,
    )
    thread.start()
    logging.info("Polar background sync enabled: every %s seconds", interval)


def polar_sync_worker_loop(interval, initial_delay):
    if initial_delay:
        time.sleep(initial_delay)
    waiting_for_connection_logged = False
    while True:
        try:
            result = sync_polar_workouts(store=True, automatic=True)
            waiting_for_connection_logged = False
            if result.get("count") or result.get("added") or result.get("savedTcx"):
                logging.info(
                    "Polar background sync: received=%s added=%s duplicates=%s tcx=%s athlete=%s",
                    result.get("count", 0),
                    result.get("added", 0),
                    result.get("duplicates", 0),
                    len(result.get("savedTcx") or []),
                    result.get("athleteId") or "",
                )
        except AppError as exc:
            if exc.status == 401:
                if not waiting_for_connection_logged:
                    logging.info("Polar background sync is waiting for a connected Polar account")
                waiting_for_connection_logged = True
            else:
                logging.warning("Polar background sync failed: %s", exc)
        except Exception:
            logging.exception("Unexpected Polar background sync error")
        time.sleep(interval)


def positive_int(value, fallback, minimum=1):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, parsed)


def polar_sync_target_coach_id():
    return str(POLAR_CONFIG.get("syncCoachId") or DEFAULT_COACH_ID).strip() or DEFAULT_COACH_ID


def polar_sync_target_athlete_id():
    return str(POLAR_CONFIG.get("syncAthleteId") or DEFAULT_ATHLETE_ID).strip() or DEFAULT_ATHLETE_ID


def sync_polar_workouts(store=True, automatic=False, coach_id=None, athlete_id=None):
    acquired = POLAR_SYNC_LOCK.acquire(blocking=not automatic)
    if not acquired:
        return {
            "ok": True,
            "count": 0,
            "workouts": [],
            "savedTcx": [],
            "added": 0,
            "duplicates": 0,
            "skipped": True,
            "message": "Polar sync is already running.",
        }
    try:
        return sync_polar_workouts_locked(store=store, automatic=automatic, coach_id=coach_id, athlete_id=athlete_id)
    finally:
        POLAR_SYNC_LOCK.release()


def sync_polar_workouts_locked(store=True, automatic=False, coach_id=None, athlete_id=None):
    credentials = load_polar_credentials()
    if not credentials.get("client_id") or not credentials.get("client_secret"):
        raise AppError("Polar credentials not found. Check polar.clientId and polar.clientSecret in conf.json.", 500)
    token = load_state_value("polarToken", {})
    access_token = token.get("access_token")
    if not access_token:
        raise AppError("Polar is not connected. Open /api/polar/connect first.", 401)

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    logging.info("Polar sync started%s", " automatically" if automatic else "")
    exercises = http_json("https://www.polaraccesslink.com/v3/exercises?zones=true", headers=headers)
    if not isinstance(exercises, list):
        exercises = []

    workouts = [polar_exercise_to_workout(item) for item in exercises]
    saved_tcx = []
    if POLAR_CONFIG.get("downloadTcx", True):
        for exercise in exercises:
            saved = download_polar_tcx(exercise, access_token)
            if saved:
                saved_tcx.append(saved)

    target_coach_id = coach_id or polar_sync_target_coach_id()
    target_athlete_id = athlete_id or polar_sync_target_athlete_id()
    store_result = {"added": 0, "duplicates": 0, "stored": 0}
    if store:
        store_result = merge_polar_workouts_into_athlete(workouts, target_coach_id, target_athlete_id)

    save_state_value("polarLastSync", int(time.time()))
    return {
        "ok": True,
        "count": len(workouts),
        "workouts": workouts,
        "savedTcx": saved_tcx,
        "added": store_result.get("added", 0),
        "duplicates": store_result.get("duplicates", 0),
        "stored": store_result.get("stored", 0),
        "coachId": target_coach_id,
        "athleteId": target_athlete_id,
    }


def merge_polar_workouts_into_athlete(workouts, coach_id, athlete_id):
    if not isinstance(workouts, list):
        return {"added": 0, "duplicates": 0, "stored": 0}
    valid = [dict(workout) for workout in workouts if isinstance(workout, dict) and workout.get("date") and number_or_none(workout.get("durationMin"))]
    if not valid:
        return {"added": 0, "duplicates": 0, "stored": 0}

    athletes = telegram_athletes(coach_id)
    target_index = next((index for index, athlete in enumerate(athletes) if str(athlete.get("id") or "") == str(athlete_id)), -1)
    if target_index < 0:
        raise AppError(f"Polar target athlete not found: {athlete_id}", 500)

    target = dict(athletes[target_index])
    existing_workouts = target.get("workouts") if isinstance(target.get("workouts"), list) else []
    if not existing_workouts and athlete_id == DEFAULT_ATHLETE_ID:
        existing_workouts = load_state_value("workouts", [], coach_id=coach_id)

    existing_keys = {workout_dedup_key(workout) for workout in existing_workouts if workout_dedup_key(workout)}
    incoming_unique = dedupe_backend_workouts(valid)
    duplicate_rows = len(valid) - len(incoming_unique)
    incoming_existing_duplicates = sum(1 for workout in incoming_unique if workout_dedup_key(workout) in existing_keys)
    added = len(incoming_unique) - incoming_existing_duplicates

    merged_workouts = dedupe_backend_workouts([*existing_workouts, *incoming_unique])
    merged_workouts.sort(key=workout_sort_timestamp, reverse=True)
    target["workouts"] = merged_workouts
    athletes[target_index] = target
    save_telegram_athletes(athletes, coach_id=coach_id)

    active_athlete_id = load_state_value("activeAthleteId", "", coach_id=coach_id)
    if athlete_id == active_athlete_id or athlete_id == DEFAULT_ATHLETE_ID:
        save_state_value("workouts", merged_workouts, coach_id=coach_id)

    if added:
        logging.info("Polar sync stored %s new workout(s) for athlete %s", added, athlete_id)
    return {"added": added, "duplicates": duplicate_rows + incoming_existing_duplicates, "stored": len(merged_workouts)}


def dedupe_backend_workouts(workouts):
    by_key = {}
    order = []
    for workout in workouts:
        if not isinstance(workout, dict):
            continue
        key = workout_dedup_key(workout)
        if not key:
            continue
        if key not in by_key:
            by_key[key] = workout
            order.append(key)
        else:
            by_key[key] = merge_duplicate_backend_workouts(by_key[key], workout)
    return [by_key[key] for key in order]


def workout_dedup_key(workout):
    polar_id = polar_exercise_id_from_source(workout.get("source") if isinstance(workout, dict) else "")
    if polar_id:
        return f"polar-{polar_id}"
    date_key = workout_date_key(workout.get("date") if isinstance(workout, dict) else "")
    sport_key = normalized_sport_key(workout.get("sport") if isinstance(workout, dict) else "")
    duration_key = round(number_or_none(workout.get("durationMin") if isinstance(workout, dict) else 0) or 0)
    distance_key = f"{round(number_or_none(workout.get('distanceKm') if isinstance(workout, dict) else 0) or 0, 2):.2f}"
    return f"{date_key}-{sport_key}-{duration_key}-{distance_key}"


def polar_exercise_id_from_source(source):
    value = str(source or "").strip()
    direct_match = re.match(r"^Polar:([^/\\]+)$", value, flags=re.IGNORECASE)
    if direct_match:
        return direct_match.group(1).lower()
    file_name = Path(value).name
    file_match = re.match(r"^Polar_.+_([A-Za-z0-9-]+)\.TCX$", file_name, flags=re.IGNORECASE)
    return file_match.group(1).lower() if file_match else ""


def workout_date_key(value):
    text = str(value or "").replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
        return parsed.isoformat()[:16]
    except ValueError:
        return text[:16]


def normalized_sport_key(sport):
    value = str(sport or "").strip().lower()
    if "run" in value or "бег" in value:
        return "running"
    return value or "unknown"


def workout_sort_timestamp(workout):
    text = str(workout.get("date") if isinstance(workout, dict) else "").replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0


def merge_duplicate_backend_workouts(a, b):
    use_b = workout_richness_score(b) > workout_richness_score(a)
    base = dict(b if use_b else a)
    other = a if use_b else b
    if is_generic_sport(base.get("sport")) and other.get("sport"):
        base["sport"] = other.get("sport")
    for key in ["intervalSignals", "lapSignals", "avgSpeed", "maxSpeed", "hrMax", "hrRest", "feedback", "workoutTypeOverride"]:
        if not base.get(key) and other.get(key):
            base[key] = other.get(key)
    if not base.get("paceSource") and other.get("paceSource"):
        base["paceMinPerKm"] = other.get("paceMinPerKm")
        base["pace"] = other.get("pace")
        base["paceSource"] = other.get("paceSource")
    if (not base.get("loadSource") or base.get("loadSource") == "duration") and other.get("loadSource") and other.get("loadSource") != "duration":
        base["load"] = other.get("load")
        base["loadSource"] = other.get("loadSource")
    return base


def workout_richness_score(workout):
    if not isinstance(workout, dict):
        return 0
    source = str(workout.get("source") or "").lower()
    load_source = str(workout.get("loadSource") or "")
    return sum([
        4 if source.endswith(".csv") else 0,
        3 if workout.get("intervalSignals") else 0,
        2 if workout.get("lapSignals") else 0,
        1 if workout.get("paceSource") else 0,
        2 if load_source == "imported" else 0,
        2 if load_source.startswith("trimp-") else 0,
    ])


def is_generic_sport(sport):
    return str(sport or "").strip().lower() in {"", "other", "polar", "unknown"}


def polar_exercise_to_workout(exercise):
    exercise_id = str(exercise.get("id") or "")
    start_time = exercise.get("start_time") or exercise.get("start-time") or exercise.get("upload_time") or exercise.get("upload-time")
    offset = exercise.get("start_time_utc_offset", exercise.get("start-time-utc-offset"))
    heart_rate = exercise.get("heart_rate") or exercise.get("heart-rate") or {}
    training_load_pro = exercise.get("training_load_pro") or exercise.get("training-load-pro") or {}
    load = (
        exercise.get("training_load")
        or exercise.get("training-load")
        or training_load_pro.get("cardio-load")
        or training_load_pro.get("cardio_load")
    )
    distance_m = number_or_none(exercise.get("distance"))
    duration_min = minutes_from_iso_duration(exercise.get("duration"))
    sport = exercise.get("detailed_sport_info") or exercise.get("detailed-sport-info") or exercise.get("sport") or "Polar"
    avg_hr = (heart_rate or {}).get("average")
    max_hr = (heart_rate or {}).get("maximum")
    date = polar_start_to_iso(start_time, offset)
    distance_km = round(distance_m / 1000, 2) if distance_m else 0
    return {
        "id": f"{date[:16]}-polar-{exercise_id or duration_min}-{distance_km}",
        "source": f"Polar:{exercise_id}" if exercise_id else "Polar",
        "date": date,
        "sport": sport,
        "durationMin": duration_min,
        "distanceKm": distance_km,
        "avgHr": int(round(avg_hr)) if avg_hr else None,
        "maxHr": int(round(max_hr)) if max_hr else None,
        "load": int(round(load)) if load else duration_min,
        "loadSource": "imported" if load else "duration",
        "notes": "Polar Flow sync",
    }


def download_polar_tcx(exercise, access_token):
    exercise_id = str(exercise.get("id") or "")
    if not exercise_id:
        return ""
    start_time = exercise.get("start_time") or exercise.get("start-time") or exercise.get("upload_time") or exercise.get("upload-time") or ""
    safe_date = re.sub(r"[^0-9T-]+", "-", start_time)[:19].replace("T", "_") or "exercise"
    safe_id = re.sub(r"[^A-Za-z0-9_-]+", "", exercise_id)
    folder = ROOT / "Workouts" / "TCX"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"Polar_{safe_date}_{safe_id}.TCX"
    if target.exists() and target.stat().st_size > 0:
        return target.name

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.garmin.tcx+xml",
    }
    url = f"https://www.polaraccesslink.com/v3/exercises/{quote(exercise_id)}/tcx"
    try:
        raw = http_bytes(url, headers=headers)
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        if raw.strip():
            target.write_bytes(raw)
            return target.name
    except AppError:
        return ""
    return ""


def polar_start_to_iso(value, offset_minutes=None):
    if not value:
        return ""
    text = str(value)
    if text.endswith("Z") or re.search(r"[+-]\d\d:?\d\d$", text):
        return text.replace("Z", "+00:00")
    if offset_minutes is None:
        return text
    try:
        offset = int(offset_minutes)
    except (TypeError, ValueError):
        return text
    sign = "+" if offset >= 0 else "-"
    offset = abs(offset)
    return f"{text}{sign}{offset // 60:02d}:{offset % 60:02d}"


def minutes_from_iso_duration(value):
    if not value:
        return 0
    match = re.fullmatch(r"P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", str(value))
    if not match:
        return 0
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = float(match.group(3) or 0)
    return int(round(hours * 60 + minutes + seconds / 60))


def number_or_none(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def basic_auth_token(client_id, client_secret):
    return base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")


def http_json(url, method="GET", data=None, headers=None):
    raw = http_bytes(url, method=method, data=data, headers=headers)
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def http_bytes(url, method="GET", data=None, headers=None):
    is_telegram = "api.telegram.org" in url
    telegram = telegram_notification_config() if is_telegram else {}
    service_name = "Telegram API" if is_telegram else "Polar API"
    timeout = telegram.get("timeout_seconds", 45) if is_telegram else int(POLAR_CONFIG.get("timeoutSeconds", 45))
    req = request.Request(url, data=data, method=method, headers=headers or {})
    force_ipv4 = is_telegram and telegram.get("force_ipv4", True)
    try:
        if force_ipv4:
            return urlopen_ipv4(req, timeout)
        with request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"{service_name} error {exc.code}: {details}", exc.code)
    except TimeoutError:
        raise AppError(f"{service_name} timeout after {timeout} seconds", 504)
    except error.URLError as exc:
        raise AppError(f"failed to connect to {service_name}: {exc.reason}", 502)


def urlopen_ipv4(req, timeout):
    def getaddrinfo_ipv4(host, port, family=0, type=0, proto=0, flags=0):
        results = ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)
        ipv4_results = [item for item in results if item[0] == socket.AF_INET]
        return ipv4_results or results

    with GETADDRINFO_LOCK:
        original = socket.getaddrinfo
        socket.getaddrinfo = getaddrinfo_ipv4
        try:
            with request.urlopen(req, timeout=timeout) as response:
                return response.read()
        finally:
            socket.getaddrinfo = original

def polar_callback_html(payload):
    if payload.get("ok"):
        message = "Polar Flow подключен. Можно закрыть эту вкладку и вернуться в Training Coach."
        title = "Polar подключен"
    else:
        message = payload.get("error") or "Polar Flow не подключен."
        title = "Ошибка Polar"
    return f"""<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>{title}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;max-width:720px;margin:48px auto;line-height:1.5">
  <h1>{title}</h1>
  <p>{message}</p>
  <p><a href="/">Вернуться в приложение</a></p>
</body>
</html>"""


def list_workout_files():
    folders = [
        ("csv", ROOT / "Workouts" / "CSV"),
        ("tcx", ROOT / "Workouts" / "TCX"),
        ("gpx", ROOT / "Workouts" / "GPX"),
        ("json", ROOT / "Workouts" / "JSON"),
    ]
    extensions = {
        "csv": {".csv"},
        "tcx": {".tcx"},
        "gpx": {".gpx"},
        "json": {".json"},
    }
    files = []

    for kind, folder in folders:
        if not folder.exists() or not folder.is_dir():
            continue
        for path in folder.iterdir():
            if not path.is_file() or path.suffix.lower() not in extensions[kind]:
                continue
            relative = path.relative_to(ROOT).as_posix()
            files.append(
                {
                    "name": path.name,
                    "path": relative,
                    "url": "/" + "/".join(quote(part) for part in relative.split("/")),
                    "type": kind,
                    "size": path.stat().st_size,
                    "mtime": path.stat().st_mtime,
                }
            )

    return sorted(files, key=lambda item: (item["type"] == "tcx", item["path"].lower()))


def create_ai_plan(payload):
    api_key = load_api_key()
    if not api_key:
        raise AppError("API key не найден. Укажите llm.apiKey или llm.apiKeyEnv в conf.json.", 500)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if LLM_CONFIG.get("siteUrl"):
        headers["HTTP-Referer"] = LLM_CONFIG["siteUrl"]
    if LLM_CONFIG.get("appName"):
        headers["X-Title"] = LLM_CONFIG["appName"]

    retryable_errors = []
    for model in get_model_sequence():
        body = build_chat_body(payload, model)
        response = request.Request(
            LLM_CONFIG["chatCompletionsUrl"],
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with request.urlopen(response, timeout=int(LLM_CONFIG["timeoutSeconds"])) as result:
                data = json.loads(result.read().decode("utf-8"))
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429:
                retryable_errors.append(f"{model}: 429 {details}")
                continue
            raise AppError(f"OpenRouter API error {exc.code} ({model}): {details}", exc.code)
        except error.URLError as exc:
            raise AppError(f"не удалось подключиться к OpenRouter API: {exc.reason}", 502)

        text = extract_chat_text(data)
        try:
            plan = parse_plan_json(text)
            strip_model_actuals(plan)
            plan["modelUsed"] = model
            return plan
        except AppError as exc:
            retryable_errors.append(f"{model}: {exc}")
            continue

    tried = ", ".join(get_model_sequence())
    raise AppError(f"Не удалось получить валидный JSON от моделей: {tried}. Последняя ошибка: {retryable_errors[-1] if retryable_errors else 'нет деталей'}", 502)


def create_ai_plan_review(payload):
    api_key = load_api_key()
    if not api_key:
        raise AppError("API key не найден. Укажите llm.apiKey или llm.apiKeyEnv в conf.json.", 500)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if LLM_CONFIG.get("siteUrl"):
        headers["HTTP-Referer"] = LLM_CONFIG["siteUrl"]
    if LLM_CONFIG.get("appName"):
        headers["X-Title"] = LLM_CONFIG["appName"]

    retryable_errors = []
    for model in get_model_sequence():
        body = build_review_chat_body(payload, model)
        response = request.Request(
            LLM_CONFIG["chatCompletionsUrl"],
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with request.urlopen(response, timeout=int(LLM_CONFIG["timeoutSeconds"])) as result:
                data = json.loads(result.read().decode("utf-8"))
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429:
                retryable_errors.append(f"{model}: 429 {details}")
                continue
            raise AppError(f"OpenRouter API error {exc.code} ({model}): {details}", exc.code)
        except error.URLError as exc:
            raise AppError(f"не удалось подключиться к OpenRouter API: {exc.reason}", 502)

        text = extract_chat_text(data)
        try:
            review = normalize_review_json(parse_plan_json(text))
            review["modelUsed"] = model
            return review
        except AppError as exc:
            retryable_errors.append(f"{model}: {exc}")
            continue

    tried = ", ".join(get_model_sequence())
    raise AppError(f"Не удалось получить валидный JSON ревью от моделей: {tried}. Последняя ошибка: {retryable_errors[-1] if retryable_errors else 'нет деталей'}", 502)


def get_model_sequence():
    models = [LLM_CONFIG["model"], *LLM_CONFIG.get("fallbackModels", [])]
    result = []
    for model in models:
        if model and model not in result:
            result.append(model)
    return result


def build_chat_body(payload, model):
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": payload.get("system", ""),
            },
            {
                "role": "user",
                "content": build_user_prompt(payload),
            },
        ],
        "temperature": float(LLM_CONFIG.get("temperature", 0.2)),
        "max_tokens": int(LLM_CONFIG.get("maxTokens", 2500)),
    }
    if LLM_CONFIG.get("jsonMode", True):
        body["response_format"] = {"type": "json_object"}
    return body


def build_review_chat_body(payload, model):
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": payload.get(
                    "system",
                    "Ты опытный тренер-ревьюер. Проверяй готовый недельный план на риски и противоречия.",
                ),
            },
            {
                "role": "user",
                "content": build_review_user_prompt(payload),
            },
        ],
        "temperature": float(LLM_CONFIG.get("temperature", 0.2)),
        "max_tokens": min(int(LLM_CONFIG.get("maxTokens", 2500)), 1800),
    }
    if LLM_CONFIG.get("jsonMode", True):
        body["response_format"] = {"type": "json_object"}
    return body


def build_user_prompt(payload):
    context = payload.get("context", {})
    planning_week = payload.get("planningWeek", {})
    schema = {
        "summary": "Короткое объяснение текущего состояния и логики плана.",
        "stateAssessment": "Оценка формы: восстановление / поддержание / развитие / осторожное развитие.",
        "days": [
            {
                "date": "ISO дата",
                "dateLabel": "короткая дата для UI",
                "focus": "фокус дня",
                "title": "название тренировки",
                "details": "только задание на тренировку: разминка, основная часть, интенсивность, восстановление, заминка и риск перегруза; не пиши сюда факт выполнения",
                "plannedWorkout": "задание на тренировку, то же содержание что details; используй для явного отделения плана от факта",
                "targetDistance": "целевой километраж или длительность дня",
                "intensity": "целевая зона/усилие/темп, если есть надежные импортированные темпы",
                "load": "низкая/умеренная/средняя/высокая нагрузка",
                "rationale": "Почему эта тренировка соответствует текущему состоянию по данным",
            }
        ],
    }
    return (
        "Сформируй персональный календарный недельный план на 7 дней с понедельника по воскресенье "
        "на основе фактического тренировочного состояния. "
        "Не используй жесткое расписание по дням. Сначала выбери нужные тренировочные стимулы недели по цели, фазе подготовки, "
        "истории тренировок и текущей нагрузке, затем разложи их по календарю с учетом восстановления. "
        "Базовая развивающая неделя обычно содержит один скоростной/интервальный стимул, один темповый/пороговый/специфический стимул, "
        "одну длительную, легкие кроссы и восстановление, но это ориентир, а не обязательная схема вторник-суббота-воскресенье. "
        "Можешь заменять классические интервалы или темпо на бег в гору, фартлек, прогрессивный бег, марафонский темп, strides, "
        "силовую, прыжковые упражнения, ОФП/мобилити или кросс-тренинг, если это лучше соответствует состоянию и цели. "
        "Длительная чаще всего удобна в воскресенье, но ее можно перенести, если это лучше по гонке, восстановлению или фактически выполненным тренировкам. "
        "Темповая + длительная в соседние дни допустимы как специфическая связка, но не обязательны каждую неделю. "
        "Между тяжелыми беговыми стимулами желательно не меньше 48 часов; если делаешь связку ближе, объясни смысл и снизь объем. "
        "Не ставь больше двух тяжелых беговых работ в неделю плюс длительную, если данные не показывают очень хорошую переносимость. "
        "Силовую и прыжковые упражнения не ставь накануне тяжелой беговой работы или длительной при признаках усталости. "
        "Каждый выбранный стимул должен быть привязан к целевой дистанции спортсмена. "
        "Учитывай profile.athleteLevel и profile.ageGroup: для начинающих снижай объем, избегай двух тяжелых беговых работ без устойчивой истории; "
        "для детей 8-10 лет не используй взрослые объемы, марафонские длительные, жесткие темповые блоки и тренировки до отказа, "
        "делай акцент на игре, технике, координации, коротких ускорениях, ОФП и восстановлении; для 11-14 лет ограничивай монотонный объем и жесткие анаэробные работы. "
        "Если отклоняешься от базовой структуры, явно объясни причину в rationale.\n\n"
        f"Контекст спортсмена и тренировок:\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\n"
        f"Планируемая неделя:\n{json.dumps(planning_week, ensure_ascii=False, indent=2)}\n\n"
        "Не используй текущий отображаемый план как основу: строй план по фактически выполненным тренировкам, состоянию спортсмена, цели, гонке и правилам недели. "
        "Целевая дистанция из profile.targetDistance и trainingState.targetDistance должна определять акценты плана: "
        "1 км - техника, координация, короткие расслабленные ускорения, короткие интервалы 100-300 м или 20-60 секунд, умеренная аэробная поддержка; "
        "3 км - интервалы 300-600 м или 1-3 минуты, VO2max/усилие 3-5 км, пороговая поддержка малым объемом, техника и экономичность; "
        "5 км - короткие интенсивные интервалы, VO2max, экономичность, короткое темпо и умеренная длительная; "
        "10 км - интервалы 800-1200 м или 3-5 минут, пороговая работа, темповая устойчивость и умеренный объем; "
        "21 км - длинные интервалы, темпо/полумарафонское усилие, длительная аэробная работа и устойчивость к утомлению; "
        "42 км - контролируемые интервалы без чрезмерной остроты, марафонское усилие, аэробная база, длинные тренировки, питание и восстановление. "
        "Опирайся на load7Days, load28Days, previous7DaysLoad, acuteChronicRatio, rampRate, hoursSinceLast, "
        "частоту тренировок и последние тренировки. "
        "Для каждого дня укажи конкретную длительность, интенсивность, зоны/RPE при необходимости и смысл тренировки. "
        "В ответе указывай только план: details/plannedWorkout - только задание на тренировку. "
        "Не возвращай поле actualWorkout и не описывай факт выполнения в details, plannedWorkout или rationale; приложение само покажет факт из импортированных тренировок. "
        "Для интервального дня в details/plannedWorkout обязательно пропиши: разминку, количество повторов, длину или время каждого отрезка, целевую интенсивность, восстановление между отрезками и заминку. "
        "Пример: разминка 15 минут, затем 6 x 1000 м в усилии 10 км или 3:55-4:05 мин/км при наличии импортированных темпов, восстановление 400 м трусцой, заминка 10 минут. "
        "Для темпового дня в details/plannedWorkout обязательно пропиши: разминку, длительность или блоки темпо, интенсивность, восстановление между блоками и заминку. "
        "Для длительной в details/plannedWorkout укажи длительность или диапазон километража, интенсивность, допустимый прогресс/ускорение и питание/питье, если это актуально для целевой дистанции. "
        "Для бега в гору, силовой, прыжковых упражнений, ОФП или мобилити укажи конкретные подходы/повторы/длительность, интенсивность и место в неделе относительно беговых работ. "
        "Темп используй только если в recentWorkouts есть непустой paceSource и paceMinPerKm/pace; "
        "paceMinPerKm означает минуты на километр, а не километры в час. "
        "Не вычисляй и не восстанавливай темп из durationMin и distanceKm; если надежного темпа с paceSource нет, "
        "задавай интенсивность через RPE/пульс/разговорный темп. "
        "План должен быть реалистичным, но развивающим, если состояние это позволяет. "
        "Не назначай только легкие тренировки, если нет признаков перегруза. "
        "Пиши по-русски, кратко и практически.\n\n"
        "Верни ровно 7 элементов в days, даты и порядок должны соответствовать planningWeek.days: понедельник-воскресенье. "
        "Верни только один валидный JSON-объект без Markdown, комментариев, префиксов и пояснений. "
        f"Форма JSON:\n{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


def build_review_user_prompt(payload):
    schema = {
        "summary": "Краткий вывод по качеству готового плана.",
        "verdict": "Итог: план согласован / есть риски / лучше скорректировать.",
        "verdictLevel": "ok | warn | danger",
        "issues": [
            {
                "severity": "info | warn | danger",
                "day": "дата или день недели, если замечание относится к конкретному дню",
                "title": "короткое название проблемы",
                "details": "почему это важно и что именно проверить или поправить",
            }
        ],
        "recommendations": [
            "короткая практическая рекомендация перед выполнением плана"
        ],
    }
    return (
        "Проверь готовый недельный план тренировок. Не создавай новый план и не переписывай все дни целиком. "
        "Найди только реальные риски, противоречия и недостающую конкретику. "
        "Особенно проверь: соответствие заголовков заданию, частоту тяжелых стимулов, расстояние между интервалами/темпо/длительной/гонкой, "
        "соответствие цели и этапу подготовки, реалистичность нагрузки по recentWorkouts и локальному анализу, "
        "конкретность заданий для интервалов, темпо, горок, силовой и длительной. "
        "Если план выглядит хорошим, так и напиши, но можешь оставить 1-2 мягких пункта контроля. "
        "Не описывай факт выполнения как часть задания. Не давай медицинских диагнозов.\n\n"
        f"Контекст:\n{json.dumps(payload.get('context', {}), ensure_ascii=False, indent=2)}\n\n"
        f"Планируемая неделя:\n{json.dumps(payload.get('planningWeek', {}), ensure_ascii=False, indent=2)}\n\n"
        f"Готовый план для ревью:\n{json.dumps(payload.get('plan', {}), ensure_ascii=False, indent=2)}\n\n"
        f"Локальный анализ выполнения и предупреждений:\n{json.dumps(payload.get('localAnalysis', {}), ensure_ascii=False, indent=2)}\n\n"
        f"Правила ревью:\n{json.dumps(payload.get('reviewRules', []), ensure_ascii=False, indent=2)}\n\n"
        "Верни только один валидный JSON-объект без Markdown, комментариев и пояснений. "
        f"Форма JSON:\n{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


def extract_chat_text(data):
    choices = data.get("choices", [])
    if choices:
        message = choices[0].get("message", {})
        content = message.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            if parts:
                return "\n".join(parts)

    raise AppError("OpenRouter API не вернул текст плана", 502)


def parse_plan_json(text):
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError:
                pass
    raise AppError("OpenRouter API вернул невалидный JSON плана", 502)


def normalize_review_json(review):
    if not isinstance(review, dict):
        raise AppError("OpenRouter API вернул невалидный JSON ревью", 502)

    issues = review.get("issues", [])
    if not isinstance(issues, list):
        issues = []
    recommendations = review.get("recommendations", [])
    if not isinstance(recommendations, list):
        recommendations = []

    return {
        "summary": str(review.get("summary") or "Ревью плана выполнено.").strip(),
        "verdict": str(review.get("verdict") or "ревью готово").strip(),
        "verdictLevel": str(review.get("verdictLevel") or review.get("level") or "ok").strip(),
        "issues": [
            item for item in issues[:8]
            if isinstance(item, dict)
        ],
        "recommendations": [
            str(item).strip() for item in recommendations[:6]
            if str(item).strip()
        ],
    }


def strip_model_actuals(plan):
    if not isinstance(plan, dict):
        return
    days = plan.get("days")
    if not isinstance(days, list):
        return
    for day in days:
        if isinstance(day, dict):
            day.pop("actualWorkout", None)
            day.pop("actual", None)
            day.pop("completedWorkout", None)


def load_api_key():
    key = LLM_CONFIG.get("apiKey", "")
    if key:
        return key.strip()

    env_name = LLM_CONFIG.get("apiKeyEnv", "")
    return os.getenv(env_name, "").strip() if env_name else ""


def main():
    setup_logging()
    init_db()
    start_notification_worker()
    start_polar_sync_worker()
    logging.info("Training Coach: http://%s:%s", HOST, PORT)
    logging.info("Config: %s", CONF_FILE)
    logging.info("Database: %s", DB_PATH)
    logging.info("Log: %s", LOG_PATH)
    ThreadingHTTPServer((HOST, PORT), TrainingCoachHandler).serve_forever()


if __name__ == "__main__":
    main()
