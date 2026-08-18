from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request, error
from urllib.parse import parse_qs, quote, urlencode, urlparse
import base64
from datetime import date, datetime, time as datetime_time, timedelta
import gzip
import json
import mimetypes
import os
import re
import secrets
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
            "pollCommands": True,
            "clearMenu": True,
            "proxyUrl": "",
            "proxyUrlEnv": "TELEGRAM_PROXY_URL",
        },
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
LLM_CONFIG = CONFIG.get("llm", CONFIG.get("openai", DEFAULT_CONFIG["llm"]))
POLAR_CONFIG = CONFIG.get("polar", DEFAULT_CONFIG["polar"])
NOTIFICATIONS_CONFIG = CONFIG.get("notifications", DEFAULT_CONFIG["notifications"])
HOST = SERVER_CONFIG["host"]
PORT = int(SERVER_CONFIG["port"])
DB_PATH = (ROOT / STORAGE_CONFIG.get("databasePath", "data/training_coach.sqlite3")).resolve()


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
        if clean_path == "/api/state":
            self.send_json(load_state())
            return
        if clean_path == "/api/workout-files":
            self.send_json({"files": list_workout_files()})
            return
        if clean_path == "/api/polar/status":
            self.send_json(polar_status())
            return
        if clean_path == "/api/notifications/status":
            self.send_json(notification_status())
            return
        if clean_path == "/api/polar/connect":
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
        if clean_path == "/api/state":
            try:
                payload = self.read_json()
                save_state(payload)
                self.send_json({"ok": True})
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/polar/sync":
            try:
                result = sync_polar_workouts()
                self.send_json(result)
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/notifications/test":
            try:
                result = send_daily_assignment_notification(force=True)
                self.send_json(result)
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            except Exception as exc:
                self.send_json({"error": f"unexpected server error: {exc}"}, status=500)
            return

        if clean_path == "/api/plan/review":
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

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.add_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
        print("%s - %s" % (self.address_string(), format % args))


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


def load_state():
    return {
        "workouts": load_state_value("workouts", []),
        "profile": load_state_value("profile", None),
        "plans": load_state_value("plans", {}),
        "plansByWeek": load_state_value("plansByWeek", {}),
        "activePlanSource": load_state_value("activePlanSource", ""),
        "selectedWeekStart": load_state_value("selectedWeekStart", ""),
    }


def save_state(payload):
    if not isinstance(payload, dict):
        raise AppError("state payload must be an object", 400)
    if "workouts" in payload:
        workouts = payload["workouts"]
        if not isinstance(workouts, list):
            raise AppError("workouts must be an array", 400)
        save_state_value("workouts", workouts)
    if "profile" in payload:
        profile = payload["profile"]
        if profile is not None and not isinstance(profile, dict):
            raise AppError("profile must be an object", 400)
        save_state_value("profile", profile)
    if "plans" in payload:
        plans = payload["plans"]
        if plans is not None and not isinstance(plans, dict):
            raise AppError("plans must be an object", 400)
        save_state_value("plans", plans or {})
    if "activePlanSource" in payload:
        active_plan_source = payload["activePlanSource"]
        if active_plan_source is not None and not isinstance(active_plan_source, str):
            raise AppError("activePlanSource must be a string", 400)
        save_state_value("activePlanSource", active_plan_source or "")
    if "plansByWeek" in payload:
        plans_by_week = payload["plansByWeek"]
        if plans_by_week is not None and not isinstance(plans_by_week, dict):
            raise AppError("plansByWeek must be an object", 400)
        save_state_value("plansByWeek", plans_by_week or {})
    if "selectedWeekStart" in payload:
        selected_week_start = payload["selectedWeekStart"]
        if selected_week_start is not None and not isinstance(selected_week_start, str):
            raise AppError("selectedWeekStart must be a string", 400)
        save_state_value("selectedWeekStart", selected_week_start or "")


def load_state_value(key, fallback):
    init_db()
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
    if not row:
        return fallback
    try:
        return json.loads(row[0])
    except json.JSONDecodeError:
        return fallback


def save_state_value(key, value):
    init_db()
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


def notification_status():
    telegram = telegram_notification_config()
    plan_day = get_today_plan_day()
    return {
        "provider": "telegram",
        "enabled": telegram["enabled"],
        "configured": bool(telegram["bot_token"] and telegram["chat_id"]),
        "dailyTime": telegram["daily_time"],
        "lastSent": load_state_value("dailyNotificationLastSent", ""),
        "lastSentAt": load_state_value("dailyNotificationLastSentAt", ""),
        "hasTodayAssignment": bool(plan_day),
        "todayButton": telegram["today_button_text"] if telegram["show_today_button"] else "",
        "proxyConfigured": bool(telegram["proxy_url"]),
    }


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
        "proxy_url": (telegram.get("proxyUrl") or os.environ.get(telegram.get("proxyUrlEnv", "TELEGRAM_PROXY_URL"), "")).strip(),
    }


def start_notification_worker():
    telegram = telegram_notification_config()
    if not telegram["enabled"]:
        return
    if telegram["bot_token"] and telegram["clear_menu"]:
        configure_telegram_bot_ui(telegram)
    thread = threading.Thread(target=notification_worker_loop, name="daily-notifications", daemon=True)
    thread.start()
    if telegram["bot_token"] and telegram["chat_id"] and telegram["poll_commands"]:
        command_thread = threading.Thread(target=telegram_command_worker_loop, name="telegram-commands", daemon=True)
        command_thread.start()


def notification_worker_loop():
    while True:
        try:
            send_daily_assignment_notification()
        except Exception as exc:
            print(f"Daily notification error: {exc}")
        time.sleep(60)


def telegram_command_worker_loop():
    while True:
        try:
            poll_telegram_updates()
        except Exception as exc:
            print(f"Telegram command error: {exc}")
            time.sleep(10)


def send_daily_assignment_notification(force=False):
    telegram = telegram_notification_config()
    if not force and not telegram["enabled"]:
        return {"ok": False, "skipped": "notifications disabled"}
    if not telegram["bot_token"] or not telegram["chat_id"]:
        raise AppError("Telegram notifications are not configured. Add notifications.telegram.botToken and chatId to conf.json.", 500)
    if not force and not notification_time_reached(telegram["daily_time"]):
        return {"ok": False, "skipped": "not time yet"}

    if not force and daily_assignment_sent_today():
        return {"ok": False, "skipped": "already sent today"}

    plan_day = get_today_plan_day()
    if not plan_day:
        raise AppError("No saved plan assignment for today.", 404)
    if not telegram["send_on_rest_days"] and is_rest_assignment(plan_day):
        return {"ok": False, "skipped": "rest day"}

    text = format_daily_assignment_message(plan_day)
    send_telegram_message(
        telegram["bot_token"],
        telegram["chat_id"],
        text,
        reply_markup=telegram_reply_markup(telegram),
        proxy_url=telegram["proxy_url"],
    )
    if not force:
        mark_daily_assignment_sent()
    return {"ok": True, "message": text}


def daily_assignment_sent_today():
    return load_state_value("dailyNotificationLastSent", "") == date.today().isoformat()


def mark_daily_assignment_sent():
    save_state_value("dailyNotificationLastSent", date.today().isoformat())
    save_state_value("dailyNotificationLastSentAt", datetime.now().isoformat(timespec="seconds"))


def notification_time_reached(value):
    try:
        hour, minute = [int(part) for part in str(value).split(":", 1)]
        target = datetime_time(hour=hour, minute=minute)
    except (TypeError, ValueError):
        target = datetime_time(hour=8, minute=0)
    now = datetime.now().time()
    return now >= target


def get_today_plan_day():
    today = date.today()
    week_key = monday_of_week(today).isoformat()
    plans_by_week = load_state_value("plansByWeek", {})
    bucket = plans_by_week.get(week_key) if isinstance(plans_by_week, dict) else None
    if not isinstance(bucket, dict):
        return None

    sources = bucket.get("sources") if isinstance(bucket.get("sources"), dict) else {}
    active_source = bucket.get("activePlanSource") or load_state_value("activePlanSource", "")
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
            {"type": "chat", "chat_id": telegram["chat_id"]},
        ]
        for scope in scopes:
            for language_code in [None, "ru", "en"]:
                delete_telegram_commands(telegram["bot_token"], scope, language_code, telegram["proxy_url"])
        set_telegram_menu_button(telegram["bot_token"], telegram["chat_id"], telegram["proxy_url"])
    except Exception as exc:
        print(f"Telegram menu cleanup error: {exc}")


def delete_telegram_commands(bot_token, scope=None, language_code=None, proxy_url=""):
    payload = {}
    if scope:
        payload["scope"] = scope
    if language_code:
        payload["language_code"] = language_code
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    url = f"https://api.telegram.org/bot{bot_token}/deleteMyCommands"
    http_json(url, method="POST", data=data, headers=headers, proxy_url=proxy_url)


def set_telegram_menu_button(bot_token, chat_id, proxy_url=""):
    payload = {
        "chat_id": chat_id,
        "menu_button": {"type": "default"},
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    url = f"https://api.telegram.org/bot{bot_token}/setChatMenuButton"
    http_json(url, method="POST", data=data, headers=headers, proxy_url=proxy_url)


def send_telegram_message(bot_token, chat_id, text, reply_markup=None, proxy_url=""):
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
    http_json(url, method="POST", data=data, headers=headers, proxy_url=proxy_url)


def poll_telegram_updates():
    telegram = telegram_notification_config()
    if not telegram["enabled"] or not telegram["poll_commands"] or not telegram["bot_token"] or not telegram["chat_id"]:
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
    payload = http_json(url, proxy_url=telegram["proxy_url"])
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
    if not text or chat_id != str(telegram["chat_id"]):
        return

    if not is_today_plan_command(text, telegram):
        return

    if daily_assignment_sent_today():
        response = "План на сегодня уже был отправлен ранее. Повторно не отправляю, чтобы не дублировать."
    else:
        plan_day = get_today_plan_day()
        if plan_day:
            response = format_daily_assignment_message(plan_day)
            mark_daily_assignment_sent()
        else:
            response = "На сегодня нет сохраненного плана. Откройте приложение и создайте или загрузите план на текущую неделю."
    send_telegram_message(
        telegram["bot_token"],
        telegram["chat_id"],
        response,
        reply_markup=telegram_reply_markup(telegram),
        proxy_url=telegram["proxy_url"],
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


def sync_polar_workouts():
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

    save_state_value("polarLastSync", int(time.time()))
    return {
        "ok": True,
        "count": len(workouts),
        "workouts": workouts,
        "savedTcx": saved_tcx,
    }


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


def http_json(url, method="GET", data=None, headers=None, proxy_url=""):
    raw = http_bytes(url, method=method, data=data, headers=headers, proxy_url=proxy_url)
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def http_bytes(url, method="GET", data=None, headers=None, proxy_url=""):
    timeout = int(POLAR_CONFIG.get("timeoutSeconds", 45))
    req = request.Request(url, data=data, method=method, headers=headers or {})
    service_name = "Telegram API" if "api.telegram.org" in url else "Polar API"
    try:
        opener = request.build_opener(request.ProxyHandler({"http": proxy_url, "https": proxy_url})) if proxy_url else None
        open_request = opener.open if opener else request.urlopen
        with open_request(req, timeout=timeout) as response:
            return response.read()
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"{service_name} error {exc.code}: {details}", exc.code)
    except error.URLError as exc:
        raise AppError(f"failed to connect to {service_name}: {exc.reason}", 502)


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
        "Если отклоняешься от базовой структуры, явно объясни причину в rationale.\n\n"
        f"Контекст спортсмена и тренировок:\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\n"
        f"Планируемая неделя:\n{json.dumps(planning_week, ensure_ascii=False, indent=2)}\n\n"
        "Не используй текущий отображаемый план как основу: строй план по фактически выполненным тренировкам, состоянию спортсмена, цели, гонке и правилам недели. "
        "Целевая дистанция из profile.targetDistance и trainingState.targetDistance должна определять акценты плана: "
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
    init_db()
    start_notification_worker()
    print(f"Training Coach: http://{HOST}:{PORT}")
    print(f"Config: {CONF_FILE}")
    print(f"Database: {DB_PATH}")
    ThreadingHTTPServer((HOST, PORT), TrainingCoachHandler).serve_forever()


if __name__ == "__main__":
    main()
