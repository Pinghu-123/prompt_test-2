"""Read the application's SQLite schema and describe undocumented names."""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Callable


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _source_comments(sql: str) -> dict[str, str]:
    """Read simple comments attached to column declarations in SQLite DDL."""
    comments: dict[str, str] = {}
    for line in sql.splitlines():
        comment = re.search(r'--\s*(.+)|/\*\s*(.+?)\s*\*/', line)
        if not comment:
            continue
        before = line[:comment.start()]
        depth = 0
        start = 0
        declarations = []
        for position, character in enumerate(before):
            depth += (character == "(") - (character == ")")
            if character == "," and depth == 0:
                declarations.append(before[start:position].strip())
                start = position + 1
        declarations.append(before[start:].strip())
        declaration = next((part for part in reversed(declarations) if part), "")
        match = re.match(r'^["`\[]?([\w]+)["`\]]?\s+\w', declaration)
        if match and match.group(1).lower() not in {"create", "foreign", "primary", "constraint", "unique", "check"}:
            comments[match.group(1)] = (comment.group(1) or comment.group(2)).strip()
    return comments


def read_schema(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE"
    ).fetchall()
    tables = []
    for name, sql in rows:
        comments = _source_comments(sql or "")
        columns = []
        for column in connection.execute(f"PRAGMA table_xinfo({_quote_identifier(name)})"):
            cid, column_name, data_type, not_null, default, primary, hidden = column
            if hidden:
                continue
            columns.append({
                "name": column_name,
                "type": data_type or "",
                "nullable": not bool(not_null or primary),
                "default": default,
                "primary": bool(primary),
                "comment": comments.get(column_name, ""),
            })
        tables.append({"name": name, "description": "", "columns": columns})
    return tables


def describe_schema(
    tables: list[dict[str, Any]],
    completion: Callable[[list[dict[str, str]]], str],
) -> str:
    schema_context = [
        {"name": table["name"], "columns": [
            {"name": column["name"], "type": column["type"],
             "comment": column["comment"]}
            for column in table["columns"]
        ]}
        for table in tables
    ]
    # SQLite has no native table comments. Existing column comments remain authoritative.
    messages = [
        {"role": "system", "content": (
            "你是数据库结构说明助手。仅根据表名、字段名、类型和已给出的字段注释，"
            "为缺失的表说明和字段说明写简短中文释义。不要猜测业务规则、字段取值或表中实际数据。"
            "字段说明只写字段用途，不重复主键或类型信息。"
            "只输出 JSON 对象，格式为 {\"tables\":{\"表名\":\"说明\"},"
            "\"columns\":{\"表名\":{\"字段名\":\"说明\"}}。"
            "每个输入表和缺少注释的字段都必须有对应的非空说明。"
        )},
        {"role": "user", "content": json.dumps({"tables": schema_context}, ensure_ascii=False)},
    ]
    answer = completion(messages).strip()
    if answer.startswith("```"):
        answer = re.sub(r"^```(?:json)?\s*|\s*```$", "", answer, flags=re.I).strip()
    try:
        generated = json.loads(answer)
    except json.JSONDecodeError as exc:
        raise ValueError("DeepSeek 返回的结构说明不是有效 JSON") from exc
    if not isinstance(generated, dict):
        raise ValueError("DeepSeek 返回的结构说明格式无效")
    table_notes = generated.get("tables")
    column_notes = generated.get("columns")
    if not isinstance(table_notes, dict) or not isinstance(column_notes, dict):
        raise ValueError("DeepSeek 返回的表或字段说明缺失")

    sections = []
    for table in tables:
        name = table["name"]
        note = table_notes.get(name)
        if not isinstance(note, str) or not note.strip():
            raise ValueError(f"DeepSeek 未返回 {name} 的表说明")
        lines = [f"{name} - {note.strip()}"]
        table_columns = column_notes.get(name, {})
        for column in table["columns"]:
            description = column["comment"]
            if not description:
                description = table_columns.get(column["name"]) if isinstance(table_columns, dict) else None
                if not isinstance(description, str) or not description.strip():
                    raise ValueError(f"DeepSeek 未返回 {name}.{column['name']} 的字段说明")
            if column["primary"]:
                description = re.sub(r"^主键\s*", "", description).strip()
                description = f"主键 {description}" if description else "主键"
            lines.append(f"{column['name']}\t{column['type']}\t{description.strip()}")
        sections.append("\n".join(lines))
    return "\n\n".join(sections)
