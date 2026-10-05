from __future__ import annotations

import contextlib
import json
import logging
import math
import os
import shutil
import sqlite3
import time
import tomllib
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit

import streamlit as st
import streamlit.components.v1 as components
from schema_service import describe_schema, read_schema


logging.basicConfig(level=logging.INFO)

BASE_DIR = Path(__file__).resolve().parent
DB_FILENAME = "Prompt_Improve_DB"
LOCAL_DB_PATH = BASE_DIR / DB_FILENAME
MODELSCOPE_WORKSPACE = Path("/mnt/workspace")
COMPONENT_PATH = BASE_DIR / "components" / "improve_prompt"


def resolve_db_path() -> Path:
    configured_path = os.environ.get("PROMPT_IMPROVE_DB_PATH", "").strip()
    if configured_path:
        return Path(configured_path).expanduser()

    if MODELSCOPE_WORKSPACE.is_dir() and os.access(
        MODELSCOPE_WORKSPACE, os.W_OK
    ):
        return MODELSCOPE_WORKSPACE / DB_FILENAME

    return LOCAL_DB_PATH


DB_PATH = resolve_db_path()

SCHEMA = """
CREATE TABLE IF NOT EXISTS srv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plat_name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    co_name TEXT NOT NULL,
    home_url TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS mdl (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    srv_id INTEGER NOT NULL,
    mdl_name TEXT NOT NULL,
    in_tok_fee DECIMAL(12, 6) NOT NULL DEFAULT 0,
    out_tok_fee DECIMAL(12, 6) NOT NULL DEFAULT 0,
    unit TEXT NOT NULL,
    mdl_type TEXT DEFAULT NULL,
    url TEXT DEFAULT NULL,
    CONSTRAINT fk_mdl_srv
        FOREIGN KEY (srv_id)
        REFERENCES srv (id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mdl_srv_id ON mdl (srv_id);

CREATE TABLE IF NOT EXISTS prompt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_name TEXT,
    model_id INTEGER,
    api_key TEXT,
    sys_prompt TEXT,
    user_prompt1 TEXT,
    user_prompt2 TEXT,
    user_prompt3 TEXT,
    user_prompt4 TEXT,
    user_prompt5 TEXT,
    user_prompt6 TEXT,
    u_promt_count INTEGER
);

CREATE TABLE IF NOT EXISTS evaluate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER NOT NULL REFERENCES prompt(id),
    question TEXT,
    s_answer TEXT,
    m_answer TEXT,
    is_true INTEGER CHECK (is_true IN (0, 1)),
    is_correct INTEGER CHECK (is_correct IN (0, 1)),
    run_id TEXT,
    evaluated_at TEXT,
    needs_rerun INTEGER NOT NULL DEFAULT 0
);

"""

improve_prompt = components.declare_component(
    "improve_prompt",
    path=COMPONENT_PATH,
)


class ModelCallError(RuntimeError):
    pass


@contextlib.contextmanager
def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=10.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if (
        DB_PATH != LOCAL_DB_PATH
        and not DB_PATH.exists()
        and LOCAL_DB_PATH.exists()
    ):
        shutil.copy2(LOCAL_DB_PATH, DB_PATH)

    with connect_db() as connection:
        connection.executescript(SCHEMA)
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(evaluate)")}
        for name in ("run_id", "evaluated_at"):
            if name not in columns:
                connection.execute(f"ALTER TABLE evaluate ADD COLUMN {name} TEXT")
        if "needs_rerun" not in columns:
            connection.execute("ALTER TABLE evaluate ADD COLUMN needs_rerun INTEGER NOT NULL DEFAULT 0")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_evaluate_prompt_run ON evaluate(prompt_id, run_id)")


def list_servers(platform: str, company: str) -> list[dict[str, Any]]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT id, plat_name, base_url, co_name, home_url
            FROM srv
            WHERE instr(lower(plat_name), lower(?)) > 0
              AND instr(lower(co_name), lower(?)) > 0
            ORDER BY id DESC
            """,
            (platform.strip(), company.strip()),
        ).fetchall()
    return [dict(row) for row in rows]


def list_server_options() -> list[dict[str, Any]]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT id, plat_name, base_url, co_name, home_url
            FROM srv
            ORDER BY id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def list_prompts() -> list[dict[str, Any]]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT p.id, p.prompt_name, p.model_id, p.sys_prompt,
                   p.user_prompt1, p.user_prompt2, p.user_prompt3,
                   p.user_prompt4, p.u_promt_count,
                   m.mdl_name, s.plat_name
            FROM prompt AS p
            LEFT JOIN mdl AS m ON m.id = p.model_id
            LEFT JOIN srv AS s ON s.id = m.srv_id
            ORDER BY p.id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def list_evaluations() -> list[dict[str, Any]]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT e.id, e.prompt_id, e.question, e.s_answer, e.m_answer,
                   e.is_true, e.is_correct, e.run_id, e.evaluated_at,
                   e.needs_rerun,
                   p.prompt_name
            FROM evaluate AS e
            JOIN prompt AS p ON p.id = e.prompt_id
            ORDER BY e.id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def save_evaluation(payload: dict[str, Any]) -> list[int]:
    prompt_id = int(payload["prompt_id"])
    run_id = str(payload["run_id"])
    rows = payload["rows"]
    if not isinstance(rows, list):
        raise ValueError("评测数据格式无效")
    saved_ids: list[int] = []
    with connect_db() as connection:
        if connection.execute("SELECT 1 FROM prompt WHERE id = ?", (prompt_id,)).fetchone() is None:
            raise ValueError("评测方案不存在")
        connection.execute(
            "DELETE FROM evaluate WHERE prompt_id = ? AND run_id = ?",
            (prompt_id, run_id),
        )
        evaluated_at = str(payload.get("evaluated_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        for row in rows:
            judgment = row.get("judgment")
            is_true = 1 if judgment == "正确" else 0 if judgment == "错误" else None
            cursor = connection.execute(
                """
                INSERT INTO evaluate
                    (prompt_id, question, s_answer, m_answer, is_true,
                     is_correct, run_id, evaluated_at, needs_rerun)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (prompt_id, str(row.get("question", "")), str(row.get("expected", "")),
                 str(row.get("result", "")), is_true, 1 if row.get("corrected") else 0,
                 run_id, evaluated_at, 1 if row.get("needsRerun") else 0),
            )
            saved_ids.append(cursor.lastrowid)
    return saved_ids


def save_prompt(payload: dict[str, Any]) -> None:
    prompts = payload.get("user_prompts") or []
    values = (
        str(payload.get("prompt_name", "")),
        int(payload["model_id"]),
        str(payload.get("api_key", "")),
        str(payload.get("sys_prompt", "")),
        *(str(prompts[index]) if index < len(prompts) else None for index in range(4)),
        min(len(prompts), 4),
    )
    with connect_db() as connection:
        prompt_id = payload.get("prompt_id")
        if prompt_id is None:
            existing = connection.execute(
                """
                SELECT id FROM prompt
                WHERE model_id = ? AND sys_prompt = ? AND user_prompt1 = ?
                ORDER BY id DESC LIMIT 1
                """,
                (values[1], values[3], values[4]),
            ).fetchone()
            prompt_id = existing["id"] if existing else None
        if prompt_id is None:
            connection.execute(
                """
                INSERT INTO prompt (prompt_name, model_id, api_key, sys_prompt,
                                    user_prompt1, user_prompt2, user_prompt3,
                                    user_prompt4, u_promt_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
        else:
            cursor = connection.execute(
                """
                UPDATE prompt
                SET prompt_name = ?, model_id = ?,
                    api_key = CASE WHEN ? = '' THEN api_key ELSE ? END,
                    sys_prompt = ?, user_prompt1 = ?, user_prompt2 = ?,
                    user_prompt3 = ?, user_prompt4 = ?, u_promt_count = ?
                WHERE id = ?
                """,
                (values[0], values[1], values[2], values[2], *values[3:], int(prompt_id)),
            )
            if cursor.rowcount == 0:
                raise ValueError("提示词不存在或已被删除")


def list_models(filters: dict[str, Any]) -> list[dict[str, Any]]:
    conditions: list[str] = []
    params: list[Any] = []

    text_filters = (
        ("platform", "s.plat_name"),
        ("type", "m.mdl_type"),
        ("model", "m.mdl_name"),
    )
    for key, column in text_filters:
        value = str(filters.get(key, "") or "").strip()
        if value:
            conditions.append(f"instr(lower({column}), lower(?)) > 0")
            params.append(value)

    cost_filters = (
        ("input_min", "m.in_tok_fee", ">="),
        ("input_max", "m.in_tok_fee", "<="),
        ("output_min", "m.out_tok_fee", ">="),
        ("output_max", "m.out_tok_fee", "<="),
    )
    for key, column, operator in cost_filters:
        value = filters.get(key)
        if value is None or value == "":
            continue
        conditions.append(f"CAST({column} AS REAL) {operator} ?")
        params.append(float(value))

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    with connect_db() as connection:
        rows = connection.execute(
            f"""
            SELECT
                m.id,
                m.srv_id,
                s.plat_name,
                s.co_name,
                s.home_url,
                m.mdl_name,
                m.in_tok_fee,
                m.out_tok_fee,
                m.unit,
                m.mdl_type,
                m.url
            FROM mdl AS m
            JOIN srv AS s ON s.id = m.srv_id
            {where_clause}
            ORDER BY m.id DESC
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def create_server(payload: dict[str, Any]) -> None:
    with connect_db() as connection:
        connection.execute(
            """
            INSERT INTO srv (plat_name, base_url, co_name, home_url)
            VALUES (?, ?, ?, ?)
            """,
            (
                payload["plat_name"],
                payload["base_url"],
                payload["co_name"],
                payload["home_url"],
            ),
        )


def update_server(payload: dict[str, Any]) -> None:
    with connect_db() as connection:
        cursor = connection.execute(
            """
            UPDATE srv
            SET plat_name = ?,
                base_url = ?,
                co_name = ?,
                home_url = ?
            WHERE id = ?
            """,
            (
                payload["plat_name"],
                payload["base_url"],
                payload["co_name"],
                payload["home_url"],
                int(payload["id"]),
            ),
        )
        if cursor.rowcount == 0:
            raise ValueError("服务器不存在或已被删除")


def create_model(payload: dict[str, Any]) -> None:
    with connect_db() as connection:
        connection.execute(
            """
            INSERT INTO mdl (
                srv_id,
                mdl_name,
                in_tok_fee,
                out_tok_fee,
                unit,
                mdl_type,
                url
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(payload["srv_id"]),
                payload["mdl_name"],
                payload["in_tok_fee"],
                payload["out_tok_fee"],
                payload["unit"],
                payload["mdl_type"],
                payload["url"] or None,
            ),
        )


def update_model(payload: dict[str, Any]) -> None:
    with connect_db() as connection:
        cursor = connection.execute(
            """
            UPDATE mdl
            SET srv_id = ?,
                mdl_name = ?,
                in_tok_fee = ?,
                out_tok_fee = ?,
                unit = ?,
                mdl_type = ?,
                url = ?
            WHERE id = ?
            """,
            (
                int(payload["srv_id"]),
                payload["mdl_name"],
                payload["in_tok_fee"],
                payload["out_tok_fee"],
                payload["unit"],
                payload["mdl_type"],
                payload["url"] or None,
                int(payload["id"]),
            ),
        )
        if cursor.rowcount == 0:
            raise ValueError("模型不存在或已被删除")


def delete_servers(server_ids: list[int]) -> dict[str, Any]:
    if not server_ids:
        return {"deleted": 0, "blocked": []}

    placeholders = ", ".join("?" for _ in server_ids)
    with connect_db() as connection:
        blocked_rows = connection.execute(
            f"""
            SELECT
                s.id,
                s.plat_name,
                COUNT(m.id) AS model_count
            FROM srv AS s
            LEFT JOIN mdl AS m ON m.srv_id = s.id
            WHERE s.id IN ({placeholders})
            GROUP BY s.id, s.plat_name
            HAVING COUNT(m.id) > 0
            ORDER BY s.plat_name COLLATE NOCASE
            """,
            server_ids,
        ).fetchall()
        if blocked_rows:
            return {
                "deleted": 0,
                "blocked": [dict(row) for row in blocked_rows],
            }

        cursor = connection.execute(
            f"DELETE FROM srv WHERE id IN ({placeholders})",
            server_ids,
        )
        return {"deleted": cursor.rowcount, "blocked": []}


def delete_models(model_ids: list[int]) -> dict[str, Any]:
    if not model_ids:
        return {"deleted": 0}

    placeholders = ", ".join("?" for _ in model_ids)
    with connect_db() as connection:
        cursor = connection.execute(
            f"DELETE FROM mdl WHERE id IN ({placeholders})",
            model_ids,
        )
        return {"deleted": cursor.rowcount}


def get_model_config(server_id: int, model_id: int) -> dict[str, Any]:
    with connect_db() as connection:
        row = connection.execute(
            """
            SELECT
                s.id AS srv_id,
                s.plat_name,
                s.base_url,
                s.co_name,
                m.id AS mdl_id,
                m.mdl_name,
                m.in_tok_fee,
                m.out_tok_fee,
                m.unit,
                m.mdl_type
            FROM srv AS s
            JOIN mdl AS m ON m.srv_id = s.id
            WHERE s.id = ? AND m.id = ?
            """,
            (server_id, model_id),
        ).fetchone()

    if row is None:
        raise ModelCallError("未找到所选服务器或模型，请重新选择")
    return dict(row)


def chat_completion_urls(base_url: str) -> list[str]:
    clean_url = base_url.strip().rstrip("/")
    if not clean_url:
        raise ModelCallError("服务器 base_url 为空")

    if clean_url.endswith("/chat/completions"):
        return [clean_url]

    if clean_url.endswith(("/v1", "/v3", "/compatible-mode/v1")):
        return [f"{clean_url}/chat/completions"]

    host = urlsplit(clean_url).netloc.lower()
    if "deepseek.com" in host:
        return [
            f"{clean_url}/chat/completions",
            f"{clean_url}/v1/chat/completions",
        ]

    return [
        f"{clean_url}/v1/chat/completions",
        f"{clean_url}/chat/completions",
    ]


def error_message_from_response(body: str) -> str:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, dict):
        error_value = payload.get("error")
        if isinstance(error_value, dict):
            message = error_value.get("message")
            if message:
                return str(message)
        for key in ("message", "detail", "msg"):
            if payload.get(key):
                return str(payload[key])

    compact = " ".join(body.split())
    return compact[:300] if compact else "接口未返回错误详情"


def normalize_api_key(value: Any) -> str:
    api_key = str(value or "").strip().strip("\"'").strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()
    for invisible_character in ("\ufeff", "\u200b", "\u200c", "\u200d"):
        api_key = api_key.replace(invisible_character, "")
    return "".join(api_key.split())


def post_chat_completion(
    base_url: str,
    api_key: str,
    model_name: str,
    messages: list[dict[str, str]],
) -> dict[str, Any]:
    urls = chat_completion_urls(base_url)
    payload = {
        "model": model_name,
        "messages": messages,
    }
    timeout_seconds = float(
        os.environ.get("PROMPT_IMPROVE_REQUEST_TIMEOUT", "120")
    )
    last_http_error: ModelCallError | None = None

    for index, url in enumerate(urls):
        request = urllib_request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Improve_Prompt/1.0",
            },
            method="POST",
        )

        try:
            with urllib_request.urlopen(
                request, timeout=timeout_seconds
            ) as response:
                body = response.read().decode("utf-8", errors="replace")
        except urllib_error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            message = error_message_from_response(body)
            if exc.code in {401, 403}:
                raise ModelCallError(
                    f"认证失败（{url}）：{message}。请确认 API Key "
                    "与当前服务器匹配，并直接填写 Key，不要包含 "
                    "Bearer 前缀"
                ) from exc
            last_http_error = ModelCallError(
                f"接口返回 HTTP {exc.code}：{message}"
            )
            if exc.code in {404, 405} and index < len(urls) - 1:
                continue
            raise last_http_error from exc
        except urllib_error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            raise ModelCallError(f"无法连接模型接口：{reason}") from exc
        except TimeoutError as exc:
            raise ModelCallError("模型接口请求超时，请稍后重试") from exc

        try:
            result = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ModelCallError("模型接口返回了无法解析的数据") from exc

        if not isinstance(result, dict):
            raise ModelCallError("模型接口返回格式不正确")
        return result

    raise last_http_error or ModelCallError("模型接口调用失败")


def response_text(result: dict[str, Any]) -> str:
    choices = result.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            message = choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    parts: list[str] = []
                    for item in content:
                        if isinstance(item, str):
                            parts.append(item)
                        elif isinstance(item, dict) and item.get("text"):
                            parts.append(str(item["text"]))
                    if parts:
                        return "\n".join(parts)

            if isinstance(choice.get("text"), str):
                return choice["text"]

    output_text = result.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    raise ModelCallError("模型接口未返回文本结果")


def response_usage(result: dict[str, Any]) -> tuple[int, int]:
    usage = result.get("usage")
    if not isinstance(usage, dict):
        usage = {}

    input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
    output_tokens = usage.get(
        "completion_tokens", usage.get("output_tokens", 0)
    )
    try:
        return int(input_tokens or 0), int(output_tokens or 0)
    except (TypeError, ValueError):
        return 0, 0


def estimate_token_count(value: str) -> int:
    compact = " ".join(value.split())
    cjk_count = sum("\u3400" <= character <= "\u9fff" for character in value)
    other_count = max(0, len(compact) - cjk_count)
    return max(1, math.ceil(cjk_count * 0.95 + other_count / 3.4))


def run_prompt_debug(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        server_id = int(payload["server_id"])
        model_id = int(payload["model_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ModelCallError("服务器或模型参数无效，请重新选择") from exc

    api_key = normalize_api_key(payload.get("api_key"))
    if not api_key:
        raise ModelCallError("API Key 为必填项")

    raw_prompts = payload.get("prompts")
    prompts = (
        [str(prompt).strip() for prompt in raw_prompts if str(prompt).strip()]
        if isinstance(raw_prompts, list)
        else []
    )
    if not prompts:
        raise ModelCallError("用户提示词为空，请填写后再调试")

    model_config = get_model_config(server_id, model_id)
    system_prompt = str(payload.get("system_prompt", ""))
    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt})

    outputs: list[str] = []
    input_tokens = 0
    output_tokens = 0

    for prompt in prompts:
        messages.append({"role": "user", "content": prompt})
        result = post_chat_completion(
            model_config["base_url"],
            api_key,
            model_config["mdl_name"],
            messages,
        )
        output = response_text(result)
        outputs.append(output)
        messages.append({"role": "assistant", "content": output})

        prompt_tokens, completion_tokens = response_usage(result)
        if not prompt_tokens:
            prompt_tokens = estimate_token_count(
                json.dumps(messages[:-1], ensure_ascii=False)
            )
        if not completion_tokens:
            completion_tokens = estimate_token_count(output)
        input_tokens += prompt_tokens
        output_tokens += completion_tokens

    if len(outputs) == 1:
        combined_output = outputs[0]
    else:
        combined_output = "\n\n".join(
            f"第 {index} 轮模型输出\n{output}"
            for index, output in enumerate(outputs, start=1)
        )

    return {
        "status": "success",
        "output": combined_output,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "rounds": len(outputs),
        "model_name": model_config["mdl_name"],
    }


def judge_config() -> dict[str, str]:
    config_path = BASE_DIR / ".streamlit" / "secrets.toml"
    try:
        with config_path.open("rb") as config_file:
            config = tomllib.load(config_file)["judge"]
        api_key = normalize_api_key(config["api_key"])
        if not api_key:
            raise ValueError("empty API key")
        return {
            "base_url": str(config["base_url"]),
            "model": str(config["model"]),
            "api_key": api_key,
        }
    except (OSError, KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as exc:
        raise ModelCallError("DeepSeek 判定器配置不可用，请检查 .streamlit/secrets.toml") from exc


def schema_database() -> dict[str, Any]:
    with connect_db() as connection:
        return {"name": DB_PATH.name, "tables": read_schema(connection)}


def generate_schema_description(names: list[str]) -> str:
    with connect_db() as connection:
        available = {table["name"]: table for table in read_schema(connection)}
    selected = [available[name] for name in names if name in available]
    if not selected:
        raise ValueError("请选择需要生成说明的数据表")
    config = judge_config()
    return describe_schema(
        selected,
        lambda messages: response_text(post_chat_completion(
            config["base_url"], config["api_key"], config["model"], messages,
        )),
    )


def judge_answers(question: str, standard: str, model_answer: str) -> int:
    config = judge_config()
    result = post_chat_completion(
        config["base_url"], config["api_key"], config["model"],
        [
            {"role": "system", "content": (
                "你是严格的答案等价性判定器。根据问题判断标准答案与模型答案是否含义一致；"
                "若答案是代码，只需判断实现的功能是否一致。允许不同措辞、格式和等价实现，"
                "但关键信息缺失或功能不同应判为错误。只输出 JSON：{\"is_true\": 1} "
                "或 {\"is_true\": 0}，不要解释。"
            )},
            {"role": "user", "content": json.dumps({
                "question": question, "standard_answer": standard,
                "model_answer": model_answer,
            }, ensure_ascii=False)},
        ],
    )
    answer = response_text(result).strip()
    try:
        parsed = json.loads(answer)
    except json.JSONDecodeError:
        start, end = answer.find("{"), answer.rfind("}")
        try:
            parsed = json.loads(answer[start:end + 1]) if start >= 0 and end > start else None
        except json.JSONDecodeError:
            parsed = None
    if isinstance(parsed, dict) and parsed.get("is_true") in (0, 1):
        return int(parsed["is_true"])
    raise ModelCallError("DeepSeek 判定器返回格式无效，请重新评测")


def run_evaluation(payload: dict[str, Any]) -> dict[str, Any]:
    prompt_id = int(payload["prompt_id"])
    raw_rows = payload["rows"]
    if not isinstance(raw_rows, list):
        raise ValueError("评测数据格式无效")
    with connect_db() as connection:
        plan = connection.execute(
            """
            SELECT p.*, m.mdl_name, s.base_url
            FROM prompt AS p
            JOIN mdl AS m ON m.id = p.model_id
            JOIN srv AS s ON s.id = m.srv_id
            WHERE p.id = ?
            """, (prompt_id,),
        ).fetchone()
    if plan is None:
        raise ModelCallError("所选评测方案或模型不存在")
    api_key = normalize_api_key(plan["api_key"])
    if not api_key:
        raise ModelCallError("所选评测方案尚未配置 API Key")
    prompt_count = min(max(int(plan["u_promt_count"] or 1), 1), 6)
    user_prompts = [str(plan[f"user_prompt{index}"] or "").strip()
                    for index in range(1, prompt_count + 1)]
    instructions = "\n\n".join(value for value in user_prompts if value)
    completed = []
    for index, row in enumerate(raw_rows):
        question = str(row.get("question", ""))
        standard = str(row.get("expected", ""))
        messages = []
        if plan["sys_prompt"]:
            messages.append({"role": "system", "content": str(plan["sys_prompt"])})
        user_message = f"{instructions}\n\n问题：{question}" if instructions else question
        messages.append({"role": "user", "content": user_message})
        try:
            model_answer = response_text(post_chat_completion(
                str(plan["base_url"]), api_key, str(plan["mdl_name"]), messages,
            ))
        except ModelCallError as exc:
            return {"status": "error", "message": f"第 {index + 1} 条评测失败：{exc}",
                    "rows": completed}
        try:
            is_true = judge_answers(question, standard, model_answer)
        except ModelCallError as exc:
            completed.append({"index": index, "result": model_answer,
                              "judgment": "待判定"})
            return {"status": "error", "message": f"第 {index + 1} 条判定失败：{exc}",
                    "rows": completed}
        completed.append({"index": index, "result": model_answer,
                          "judgment": "正确" if is_true else "错误"})
    return {"status": "success", "rows": completed}


def init_state() -> None:
    defaults = {
        "page": "server_list",
        "platform_filter": "",
        "company_filter": "",
        "model_filters": {
            "platform": "",
            "type": "",
            "model": "",
            "input_min": None,
            "input_max": None,
            "output_min": None,
            "output_max": None,
        },
        "component_nonce": 0,
        "toast": None,
        "prompt_debug_result": None,
        "last_debug_action_token": "",
        "evaluation_result": None,
        "evaluation_save_result": None,
        "last_evaluation_action_token": "",
        "last_evaluation_save_token": "",
        "schema_data": None,
        "schema_result": None,
        "schema_selected": [],
        "schema_search": "",
        "last_schema_action_token": "",
    }
    for key, value in defaults.items():
        st.session_state.setdefault(key, value)


def handle_action(action: dict[str, Any]) -> None:
    action_name = action.get("action")

    if action_name in {"connect_schema", "generate_schema", "clear_schema_result"}:
        token = str(action.get("token", ""))
        if token and token == st.session_state.last_schema_action_token:
            return
        st.session_state.last_schema_action_token = token

    if action_name == "connect_schema":
        st.session_state.schema_result = None
        st.session_state.schema_selected = []
        st.session_state.schema_search = ""
        if action.get("db_type") != "sqlite" or action.get("db_name") != DB_PATH.name:
            st.session_state.schema_data = {"status": "error", "message": "当前仅支持连接 Prompt_Improve_DB SQLite 数据库"}
        else:
            try:
                st.session_state.schema_data = {"status": "success", "database": schema_database()}
            except sqlite3.Error:
                logging.exception("读取数据库表结构失败")
                st.session_state.schema_data = {"status": "error", "message": "连接数据库失败，请检查数据库文件"}
        st.rerun()
        return

    if action_name == "generate_schema":
        raw_names = action.get("tables", [])
        names = list(dict.fromkeys(str(name) for name in raw_names)) if isinstance(raw_names, list) else []
        st.session_state.schema_selected = names
        st.session_state.schema_search = str(action.get("search", ""))
        try:
            output = generate_schema_description(names)
            st.session_state.schema_result = {"status": "success", "output": output, "tables": names}
        except (ValueError, ModelCallError) as exc:
            st.session_state.schema_result = {"status": "error", "message": str(exc), "tables": names}
        except Exception:
            logging.exception("生成数据库结构说明失败")
            st.session_state.schema_result = {"status": "error", "message": "生成失败，请检查模型配置和网络连接", "tables": names}
        st.rerun()
        return

    if action_name == "clear_schema_result":
        st.session_state.schema_result = None
        st.session_state.schema_selected = list(action.get("tables", []))
        st.session_state.schema_search = str(action.get("search", ""))
        st.rerun()
        return

    if action_name == "evaluate_rows":
        token = str(action.get("token", ""))
        if token and token == st.session_state.last_evaluation_action_token:
            return
        st.session_state.last_evaluation_action_token = token
        try:
            result = run_evaluation(action)
        except (KeyError, TypeError, ValueError, ModelCallError) as exc:
            result = {"status": "error", "message": str(exc), "rows": []}
        except Exception:
            logging.exception("提示词评测失败")
            result = {"status": "error", "message": "评测失败，请检查模型配置和网络连接", "rows": []}
        st.session_state.evaluation_result = {**result, "token": token,
                                              "run_id": action.get("run_id")}
        st.rerun()
        return

    if action_name == "save_evaluation":
        token = str(action.get("token", ""))
        if token and token == st.session_state.last_evaluation_save_token:
            return
        st.session_state.last_evaluation_save_token = token
        try:
            ids = save_evaluation(action)
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"评测数据保存失败：{exc}"
            st.session_state.evaluation_save_result = None
        else:
            st.session_state.toast = "评测方案、测试数据和纠正结果已保存"
            st.session_state.evaluation_save_result = {
                "token": action.get("token"), "run_id": action.get("run_id"), "ids": ids,
            }
        st.rerun()
        return

    if action_name == "save_prompt":
        try:
            save_prompt(action)
            prompt_id = action.get("prompt_id")
            if prompt_id is not None:
                with connect_db() as connection:
                    connection.execute(
                        "UPDATE evaluate SET needs_rerun = 1 WHERE prompt_id = ?",
                        (int(prompt_id),),
                    )
                    edit = action.get("result_edit")
                    if isinstance(edit, dict):
                        connection.execute(
                            """
                            UPDATE evaluate
                            SET question = ?, s_answer = ?, needs_rerun = 1
                            WHERE id = ? AND prompt_id = ?
                            """,
                            (str(edit.get("question", "")), str(edit.get("expected", "")),
                             int(edit["id"]), int(prompt_id)),
                        )
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"提示词保存失败：{exc}"
        else:
            st.session_state.page = "prompt_list"
            st.session_state.toast = f"已保存为评测方案：{action.get('prompt_name', '')}"
        st.session_state.component_nonce += 1
        st.rerun()
        return

    if action_name == "navigate":
        target = action.get("page")
        if target in {
            "server_add",
            "server_list",
            "model_add",
            "model_list",
            "prompt_dis",
            "prompt_list",
            "prompt_eval",
            "eval_results",
            "db_schema",
        }:
            if target != "prompt_dis":
                st.session_state.prompt_debug_result = None
            st.session_state.page = target
            st.session_state.component_nonce += 1
            st.rerun()
        return

    if action_name == "create":
        try:
            create_server(
                {
                    "plat_name": action["plat_name"],
                    "base_url": action["base_url"],
                    "co_name": action["co_name"],
                    "home_url": action["home_url"],
                }
            )
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"服务器信息保存失败：{exc}"
        else:
            st.session_state.page = "server_list"
            st.session_state.toast = "服务器信息已保存"

        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "update_server":
        try:
            update_server(
                {
                    "id": action["id"],
                    "plat_name": action["plat_name"],
                    "base_url": action["base_url"],
                    "co_name": action["co_name"],
                    "home_url": action["home_url"],
                }
            )
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"服务器信息更新失败：{exc}"
        else:
            st.session_state.toast = "服务器信息已更新"

        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "search_servers":
        st.session_state.platform_filter = str(action.get("platform", ""))
        st.session_state.company_filter = str(action.get("company", ""))
        if action.get("refresh"):
            st.session_state.toast = "服务器列表已刷新"
        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "delete_servers":
        raw_ids = action.get("ids", [])
        try:
            ids = list(dict.fromkeys(int(server_id) for server_id in raw_ids))
            result = delete_servers(ids)
        except (TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"服务器删除失败：{exc}"
        else:
            if result["blocked"]:
                blocked = "、".join(
                    f"{item['plat_name']}（{item['model_count']} 个模型）"
                    for item in result["blocked"]
                )
                st.session_state.toast = (
                    f"无法删除：{blocked} 仍有关联模型，请先删除其下的模型"
                )
            else:
                st.session_state.toast = f"已删除 {result['deleted']} 个服务器"

        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "create_model":
        model_name = str(action.get("mdl_name", ""))
        try:
            create_model(
                {
                    "srv_id": action["srv_id"],
                    "mdl_name": model_name,
                    "in_tok_fee": action["in_tok_fee"],
                    "out_tok_fee": action["out_tok_fee"],
                    "unit": action["unit"],
                    "mdl_type": action["mdl_type"],
                    "url": action.get("url", ""),
                }
            )
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"模型信息保存失败：{exc}"
        else:
            st.session_state.page = "model_list"
            st.session_state.model_filters = {
                "platform": "",
                "type": "",
                "model": "",
                "input_min": None,
                "input_max": None,
                "output_min": None,
                "output_max": None,
            }
            st.session_state.toast = f"{model_name} 已保存"

        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "update_model":
        model_name = str(action.get("mdl_name", ""))
        try:
            update_model(
                {
                    "id": action["id"],
                    "srv_id": action["srv_id"],
                    "mdl_name": model_name,
                    "in_tok_fee": action["in_tok_fee"],
                    "out_tok_fee": action["out_tok_fee"],
                    "unit": action["unit"],
                    "mdl_type": action["mdl_type"],
                    "url": action.get("url", ""),
                }
            )
        except (KeyError, TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"模型信息更新失败：{exc}"
        else:
            st.session_state.toast = f"{model_name} 已更新"

        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "search_models":
        incoming = action.get("filters")
        if not isinstance(incoming, dict):
            incoming = {}
        st.session_state.model_filters = {
            "platform": str(incoming.get("platform", "") or ""),
            "type": str(incoming.get("type", "") or ""),
            "model": str(incoming.get("model", "") or ""),
            "input_min": incoming.get("input_min"),
            "input_max": incoming.get("input_max"),
            "output_min": incoming.get("output_min"),
            "output_max": incoming.get("output_max"),
        }
        if action.get("refresh"):
            st.session_state.toast = "模型列表已刷新"
        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "delete_models":
        raw_ids = action.get("ids", [])
        try:
            ids = list(dict.fromkeys(int(model_id) for model_id in raw_ids))
            result = delete_models(ids)
        except (TypeError, ValueError, sqlite3.Error) as exc:
            st.session_state.toast = f"模型删除失败：{exc}"
        else:
            st.session_state.toast = f"已删除 {result['deleted']} 个模型"

        st.session_state.component_nonce += 1
        st.rerun()

    if action_name == "debug_model":
        action_token = str(action.get("token", "")).strip()
        if (
            action_token
            and action_token == st.session_state.last_debug_action_token
        ):
            return
        st.session_state.last_debug_action_token = action_token

        started_at = time.perf_counter()
        try:
            result = run_prompt_debug(action)
        except ModelCallError as exc:
            result = {
                "status": "error",
                "message": str(exc),
            }
        except Exception as exc:
            logging.exception("提示词调试调用失败")
            message = "模型调用失败，请检查服务器配置和网络连接"
            if os.environ.get("PROMPT_IMPROVE_DEBUG"):
                message = f"{message}（开发模式：{exc}）"
            result = {
                "status": "error",
                "message": message,
            }

        result["duration_ms"] = round(
            (time.perf_counter() - started_at) * 1000
        )
        st.session_state.prompt_debug_result = result
        st.rerun()
        return


def main() -> None:
    st.set_page_config(
        page_title="Improve_Prompt",
        page_icon=":material/tune:",
        layout="wide",
        initial_sidebar_state="collapsed",
    )
    initialize_database()
    init_state()

    st.markdown(
        """
        <style>
          html, body, #root, [data-testid="stAppViewContainer"] {
            margin: 0 !important;
            padding: 0 !important;
            width: 100% !important;
            height: 100% !important;
            overflow: hidden !important;
            background: #0f1112 !important;
          }

          [data-testid="stHeader"],
          [data-testid="stToolbar"],
          [data-testid="stDecoration"],
          [data-testid="stStatusWidget"],
          footer {
            display: none !important;
          }

          [data-testid="stAppViewBlockContainer"],
          .block-container {
            width: 100% !important;
            max-width: 100% !important;
            height: 100vh !important;
            padding: 0 !important;
            margin: 0 !important;
          }

          [data-testid="stVerticalBlock"],
          [data-testid="stVerticalBlockBorderWrapper"] {
            gap: 0 !important;
          }

          iframe[title="python-框架.app.improve_prompt"],
          iframe[title$=".improve_prompt"],
          iframe[title="improve_prompt"] {
            display: block !important;
            width: 100% !important;
            height: 100vh !important;
            border: 0 !important;
          }
        </style>
        """,
        unsafe_allow_html=True,
    )

    page = st.session_state.page
    platform_filter = st.session_state.platform_filter
    company_filter = st.session_state.company_filter
    servers = (
        list_servers(platform_filter, company_filter)
        if page == "server_list"
        else []
    )
    server_options = (
        list_server_options()
        if page in {"server_add", "model_add", "model_list", "prompt_dis"}
        else []
    )
    models = (
        list_models(
            st.session_state.model_filters
            if page == "model_list"
            else {}
        )
        if page in {"model_list", "prompt_dis"}
        else []
    )
    prompts = list_prompts() if page in {"prompt_dis", "prompt_list", "prompt_eval"} else []
    evaluations = list_evaluations() if page in {"prompt_eval", "eval_results", "prompt_dis"} else []
    debug_result = (
        st.session_state.prompt_debug_result
        if page == "prompt_dis"
        else None
    )
    toast = st.session_state.toast
    st.session_state.toast = None

    value = improve_prompt(
        page=page,
        servers=servers,
        server_options=server_options,
        models=models,
        prompts=prompts,
        evaluations=evaluations,
        evaluation_result=st.session_state.evaluation_result if page == "prompt_eval" else None,
        evaluation_save_result=st.session_state.evaluation_save_result if page == "prompt_eval" else None,
        debug_result=debug_result,
        schema_database_name=DB_PATH.name,
        schema_data=st.session_state.schema_data if page == "db_schema" else None,
        schema_result=st.session_state.schema_result if page == "db_schema" else None,
        schema_selected=st.session_state.schema_selected if page == "db_schema" else [],
        schema_search=st.session_state.schema_search if page == "db_schema" else "",
        filters={
            "server": {
                "platform": platform_filter,
                "company": company_filter,
            },
            "model": st.session_state.model_filters,
        },
        toast=toast,
        height=900,
        key=f"improve_prompt_{st.session_state.component_nonce}",
        default=None,
    )

    if isinstance(value, dict) and value.get("action"):
        handle_action(value)


if __name__ == "__main__":
    main()
