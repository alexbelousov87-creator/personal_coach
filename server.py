from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request, error
from urllib.parse import quote
import json
import mimetypes
import os
import sqlite3


ROOT = Path(__file__).resolve().parent
CONF_FILE = ROOT / "conf.json"

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
        "Структура нормальной недели обязательна: понедельник - восстановительный бег или отдых при необходимости, "
        "вторник - интенсивная интервальная работа, среда - легкий кросс, четверг - легкий кросс, "
        "пятница - легкий кросс, суббота - темповая работа, воскресенье - длительная тренировка. "
        "Темповая работа в субботу и длительная в воскресенье образуют стандартную связку нагрузки на фоне усталости. "
        "Между интервальной и темповой тренировками должно быть не меньше 2 полных дней без качественных работ. "
        "Каждый тип работы должен быть строго привязан к целевой дистанции спортсмена. "
        "Не делай план слишком легким по умолчанию: если данные показывают нормальное восстановление и стабильную нагрузку, "
        "оставь обе качественные тренировки недели: интервалы во вторник и темпо в субботу, плюс длительную в воскресенье. "
        "Если данные показывают перегруз или резкий рост нагрузки, сохраняй недельную структуру, но снижай объем/интенсивность "
        "и явно объясни причину.\n\n"
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
        "Темп используй только если в recentWorkouts есть paceSource='imported' и paceMinPerKm/pace; "
        "paceMinPerKm означает минуты на километр, а не километры в час. "
        "Не вычисляй и не восстанавливай темп из durationMin и distanceKm; если импортированного темпа нет, "
        "задавай интенсивность через RPE/пульс/разговорный темп. "
        "План должен быть реалистичным, но развивающим, если состояние это позволяет. "
        "Не назначай только легкие тренировки, если нет признаков перегруза. "
        "Пиши по-русски, кратко и практически.\n\n"
        "Верни ровно 7 элементов в days, даты и порядок должны соответствовать planningWeek.days: понедельник-воскресенье. "
        "Верни только один валидный JSON-объект без Markdown, комментариев, префиксов и пояснений. "
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
    print(f"Training Coach: http://{HOST}:{PORT}")
    print(f"Config: {CONF_FILE}")
    print(f"Database: {DB_PATH}")
    ThreadingHTTPServer((HOST, PORT), TrainingCoachHandler).serve_forever()


if __name__ == "__main__":
    main()
