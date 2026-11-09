#!/usr/bin/env python3
"""Upload a complete local AI application bundle to an AI Plaza portal."""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import http.client
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import uuid
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, quote, urlparse


MAX_FILES = 1000
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MANIFEST_NAME = "ai-app.json"

EXCLUDED_DIRS = {
    ".git", ".worktrees", "node_modules", "dist", "build", "artifacts",
    "archive", ".agent-project-ops", ".agents", ".codex", ".ssh",
}
EXCLUDED_NAMES = {"credentials.env", ".mcp.json"}
SAFE_ENV_SUFFIXES = {"example", "sample", "template"}
APP_KEY_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
VERSION_RE = re.compile(
    r"^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$"
)
SECRET_PATTERNS = [
    re.compile(rb"\b(?:glpat|gldt|glft|glcbt|glrt|glsoat|glagent|gljobtoken)-[A-Za-z0-9_-]{12,}\b"),
    re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    re.compile(rb"\bnpm_[A-Za-z0-9]{30,}\b"),
    re.compile(rb"-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"-----BEGIN PGP PRIVATE KEY BLOCK-----"),
    re.compile(rb"\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b"),
]
SECRET_ASSIGNMENT_PATTERN = re.compile(
    rb"(?i)(?<![A-Za-z0-9_])[\"']?"
    rb"(?:x-plaza-publish-key|publish[-_]?key|access[-_]?token|api[-_]?key|secret[-_]?key|client[-_]?secret|password)"
    rb"[\"']?\s*[:=]\s*"
)
JS_SOURCE_SUFFIXES = {".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".vue"}
JS_MEMBER_REFERENCE_RE = re.compile(
    rb"[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*"
)
JS_REFERENCE_CONTINUATION = b".[(+-*/%|&?^<>=!`"
JS_REFERENCE_END = b";,)]}"
JS_REGEX_PREFIX_KEYWORDS = {
    b"await", b"case", b"delete", b"do", b"else", b"in", b"instanceof",
    b"new", b"of", b"return", b"throw", b"typeof", b"void", b"yield",
}
JS_CONTROL_PAREN_KEYWORDS = {b"catch", b"for", b"if", b"switch", b"while", b"with"}
JS_BLOCK_KEYWORDS = {b"do", b"else", b"finally", b"try"}
VUE_LANG_ATTRIBUTE_PATTERN = re.compile(
    rb"(?:^|\s)(lang|:lang|v-bind:lang)(?:\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s/>]+)))?(?=\s|/?>|$)",
    re.IGNORECASE,
)
VUE_JS_LANGUAGES = {b"js", b"javascript", b"ts", b"typescript"}
VUE_VOID_ELEMENTS = {
    b"area", b"base", b"br", b"col", b"embed", b"hr", b"img", b"input",
    b"link", b"meta", b"param", b"source", b"track", b"wbr",
}
ESSENTIAL_SOURCE_SUFFIXES = {
    ".bash", ".c", ".cc", ".cfg", ".cjs", ".cpp", ".cs", ".css", ".dart", ".go",
    ".graphql", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsx",
    ".kt", ".kts", ".lua", ".mjs", ".php", ".pl", ".proto", ".py", ".r", ".rb",
    ".rs", ".sass", ".scala", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts",
    ".tsx", ".vue", ".xml", ".yaml", ".yml",
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
PREVIEW_TICKET_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
DIAGNOSTIC_RULES: dict[str, frozenset[str]] = {
    "APP_KEY_INVALID": frozenset({"managed.bundle.app_key"}),
    "FILE_COUNT_INVALID": frozenset({"managed.bundle.file_count"}),
    "REVISION_INVALID": frozenset({"managed.bundle.expected_app_revision"}),
    "FILE_ENTRY_INVALID": frozenset({"managed.bundle.file_entry"}),
    "REPOSITORY_PATH_INVALID": frozenset({
        "managed.bundle.manifest_path",
        "managed.bundle.file_path",
        "managed.bundle.document_path",
    }),
    "FILE_ENCODING_INVALID": frozenset({"managed.bundle.file_encoding"}),
    "FILE_SIZE_EXCEEDED": frozenset({"managed.bundle.file_size"}),
    "BUNDLE_SIZE_EXCEEDED": frozenset({"managed.bundle.bundle_size"}),
    "FORBIDDEN_PATH": frozenset({"managed.bundle.forbidden_path"}),
    "PATH_COLLISION": frozenset({"managed.bundle.path_collision"}),
    "SECRET_MARKER_FOUND": frozenset({"managed.bundle.secret_marker"}),
    "FILE_DIRECTORY_COLLISION": frozenset({"managed.bundle.file_directory_collision"}),
    "MANIFEST_MISSING": frozenset({"managed.bundle.manifest_missing"}),
    "MANIFEST_SIZE_EXCEEDED": frozenset({"managed.bundle.manifest_size"}),
    "MANIFEST_UTF8_INVALID": frozenset({"managed.bundle.manifest_utf8"}),
    "MANIFEST_JSON_INVALID": frozenset({"managed.bundle.manifest_json"}),
    "MANIFEST_INVALID": frozenset({"managed.bundle.manifest"}),
    "SCHEMA_VERSION_UNSUPPORTED": frozenset({"managed.bundle.schema_version"}),
    "CAPABILITY_TAGS_INVALID": frozenset({"managed.bundle.capability_tags"}),
    "PROJECT_VERSION_INVALID": frozenset({"managed.bundle.project_version"}),
    "MAINTAINER_NAME_REQUIRED": frozenset({"managed.bundle.maintainer_name"}),
    "MANIFEST_SCHEMA_INVALID": frozenset({"managed.bundle.manifest_schema"}),
    "APP_KEY_MISMATCH": frozenset({"managed.bundle.app_key_mismatch"}),
    "MANIFEST_TEXT_EMPTY": frozenset({"managed.bundle.manifest_text"}),
    "ENTRY_ID_DUPLICATE": frozenset({"managed.bundle.entry_id_unique"}),
    "ENTRY_INSTRUCTIONS_PATH_INVALID": frozenset({"managed.bundle.entry_instructions_path"}),
    "PRIMARY_ENTRY_INVALID": frozenset({"managed.bundle.primary_entry"}),
    "README_PATH_INVALID": frozenset({"managed.bundle.readme_path"}),
    "USAGE_PATH_INVALID": frozenset({"managed.bundle.usage_path"}),
    "ENTRY_URL_INVALID": frozenset({"managed.bundle.entry_url"}),
    "DOCUMENT_MISSING": frozenset({"managed.bundle.document_missing"}),
    "DISTRIBUTION_FILE_MISSING": frozenset({"managed.bundle.distribution_file"}),
    "DISTRIBUTION_PATH_INVALID": frozenset({"managed.bundle.distribution_path"}),
    "DISTRIBUTION_FILE_INVALID": frozenset({"managed.bundle.distribution_invalid"}),
    "INSTALL_SOURCE_CONFLICT": frozenset({"managed.bundle.install_source"}),
    "DOCUMENT_SIZE_EXCEEDED": frozenset({"managed.bundle.document_size"}),
    "DOCUMENT_TOTAL_SIZE_EXCEEDED": frozenset({"managed.bundle.document_total_size"}),
    "DOCUMENT_UTF8_INVALID": frozenset({"managed.bundle.document_utf8"}),
    "LFS_POINTER_NOT_ALLOWED": frozenset({"managed.bundle.lfs_pointer"}),
    "TAG_NAME_MISMATCH": frozenset({"managed.bundle.tags"}),
    "REQUEST_FIELD_INVALID": frozenset({"managed.request.schema"}),
}
SAFE_DIAGNOSTIC_FIELDS = {
    "request", "appKey", "manifestPath", "files", "files[].path", "files[].content",
    "managedAppId", "expectedAppRevision", "schemaVersion", "tags", "projectVersion",
    "maintainers", "entries", "primaryEntry", "docs.readme", "docs.usage", "manifest",
}
SAFE_PUBLICATION_STATUSES = {"checking", "preview_ready", "registered", "failed", "cancelled"}
SAFE_NEXT_ACTIONS = {"confirm", "complete", "retry", "retry_original", "submit_again", "none"}
SAFE_OPERATION_STATUSES = {"prepared", "project_ready", "commit_ready", "tag_ready", "release_ready", "submitted"}


class CliError(Exception):
    def __init__(self, message: str, diagnostic: dict[str, Any] | None = None):
        super().__init__(message)
        self.diagnostic = diagnostic


def _pairs_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CliError("ai-app.json 存在重复字段。")
        result[key] = value
    return result


def _load_manifest(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs_without_duplicates)
    except CliError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CliError("ai-app.json 必须是有效 UTF-8 JSON。") from None
    if not isinstance(value, dict) or value.get("schemaVersion") != "2":
        raise CliError("ai-app.json 必须使用 schemaVersion 2。")
    app_key = value.get("appKey")
    if not isinstance(app_key, str) or len(app_key) > 64 or not APP_KEY_RE.fullmatch(app_key):
        raise CliError("ai-app.json 的 appKey 格式无效。")
    version = value.get("projectVersion")
    if not isinstance(version, str) or len(version) > 80 or not VERSION_RE.fullmatch(version):
        raise CliError("ai-app.json 必须填写有效的 projectVersion。")
    tags = value.get("tags")
    if not isinstance(tags, list) or len(tags) > 3:
        raise CliError("单个应用最多 3 个能力标签，请保留核心能力并优先复用已有标签。")
    tag_keys: set[str] = set()
    for tag in tags:
        if not isinstance(tag, str) or not tag.strip() or len(tag) > 32:
            raise CliError("能力标签须为 1 至 32 个字符的非空文本。")
        key = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", tag).strip()).lower()
        if key in tag_keys:
            raise CliError("标签规范化后不能重复。")
        tag_keys.add(key)
    maintainers = value.get("maintainers")
    if not isinstance(maintainers, list) or not maintainers:
        raise CliError("ai-app.json 必须填写作者中文姓名和英文姓名。")
    for author in maintainers:
        if not isinstance(author, dict) or any(
            not isinstance(author.get(key), str) or not author[key].strip()
            for key in ("name", "nameEn")
        ):
            raise CliError("每位作者都必须填写中文姓名和英文姓名；不会根据 Git 配置推测。")
    docs = value.get("docs")
    if not isinstance(docs, dict):
        raise CliError("ai-app.json 必须声明 docs.readme 和 docs.usage。")
    required = [MANIFEST_NAME]
    for key in ("readme", "usage"):
        required.append(_repo_path(docs.get(key), f"docs.{key}"))
    entries = value.get("entries")
    if not isinstance(entries, list):
        raise CliError("ai-app.json 的 entries 必须是数组。")
    for entry in entries:
        if isinstance(entry, dict) and entry.get("kind") == "agent":
            required.append(_repo_path(entry.get("instructionsPath"), "entries.instructionsPath"))
            distribution = entry.get("distribution")
            if distribution is not None:
                if not isinstance(distribution, dict) or distribution.get("type") not in {"source", "artifact"} or not isinstance(distribution.get("files"), list) or not distribution["files"]:
                    raise CliError("Agent 分发资料须声明类型及非空文件清单。")
                required.extend(_repo_path(path, "entries.distribution.files") for path in distribution["files"])
    return {"manifest": value, "required": list(dict.fromkeys(required)), "appKey": app_key}


def _repo_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value or ":" in value:
        raise CliError(f"{label} 必须是安全的仓库根相对路径。")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise CliError(f"{label} 包含不允许的字符。")
    pieces = value.split("/")
    if any(piece in ("", ".", "..") for piece in pieces):
        raise CliError(f"{label} 包含不安全的路径段。")
    return str(PurePosixPath(*pieces))


def _is_env_file(name: str) -> bool:
    lower = name.casefold()
    if lower == ".env":
        return True
    if not lower.startswith(".env."):
        return False
    suffix = lower[5:].split(".", 1)[0]
    return suffix not in SAFE_ENV_SUFFIXES


def _excluded(path: str) -> bool:
    parts = path.split("/")
    if any(
        part.casefold() in EXCLUDED_DIRS or part.casefold() in EXCLUDED_NAMES or _is_env_file(part)
        for part in parts[:-1]
    ):
        return True
    name = parts[-1].casefold()
    return name in EXCLUDED_NAMES or _is_env_file(name)


def _is_reparse_or_link(path: Path, info: os.stat_result | None = None) -> bool:
    try:
        current = info if info is not None else path.lstat()
    except OSError:
        return True
    if stat.S_ISLNK(current.st_mode):
        return True
    # Junctions and other Windows reparse points can look like directories to os.walk.
    return bool(getattr(current, "st_file_attributes", 0) & 0x400)


def _repo_root_is_git_project(root: Path) -> bool:
    try:
        top = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return False
    try:
        return Path(top).resolve() == root
    except OSError:
        return False


def _candidate_paths(root: Path) -> set[str]:
    if _repo_root_is_git_project(root):
        try:
            result = subprocess.run(
                ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            raise CliError("无法安全读取 Git 文件清单。") from None
        raw_paths = result.stdout.split(b"\0")
        candidates: set[str] = set()
        for raw in raw_paths:
            if not raw:
                continue
            try:
                value = os.fsdecode(raw)
                path = _repo_path(value, "Git 文件路径")
            except CliError:
                raise CliError("Git 文件清单包含不能安全上传的路径；未开始上传。") from None
            if not _excluded(path):
                candidates.add(path)
        return candidates

    candidates = set()
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        base = Path(current)
        kept_dirs: list[str] = []
        for name in dirs:
            relative = (base / name).relative_to(root).as_posix()
            target = base / name
            if _excluded(relative + "/placeholder") or _is_reparse_or_link(target):
                continue
            kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in files:
            target = base / name
            relative = target.relative_to(root).as_posix()
            if _excluded(relative) or _is_reparse_or_link(target):
                continue
            candidates.add(relative)
    return candidates


def _checked_path(root: Path, relative: str, *, required: bool) -> Path | None:
    path = _repo_path(relative, "文件路径")
    if _excluded(path):
        if required:
            raise CliError(f"必需资料位于凭据或生成目录中，拒绝上传：{path}")
        return None
    target = root
    for segment in path.split("/"):
        target = target / segment
        try:
            info = target.lstat()
        except FileNotFoundError:
            if required:
                raise CliError(f"ai-app.json 引用的资料不存在：{path}") from None
            return None
        except OSError:
            if required:
                raise CliError(f"无法读取 ai-app.json 引用的资料：{path}") from None
            return None
        if _is_reparse_or_link(target, info):
            if required:
                raise CliError(f"拒绝跟随符号链接或 Windows junction：{path}")
            return None
    try:
        info = target.stat()
    except OSError:
        if required:
            raise CliError(f"无法读取 ai-app.json 引用的资料：{path}") from None
        return None
    if not stat.S_ISREG(info.st_mode):
        if required:
            raise CliError(f"ai-app.json 引用的资料不是普通文件：{path}")
        return None
    return target


def _read_file(root: Path, relative: str, *, required: bool) -> bytes | None:
    target = _checked_path(root, relative, required=required)
    if target is None:
        return None
    try:
        before = target.lstat()
        if before.st_size > MAX_FILE_BYTES:
            raise CliError(f"文件超过单文件 5 MiB 限制：{relative}")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(target, flags)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or _is_reparse_or_link(target, before):
                raise CliError(f"文件类型在读取时发生变化，拒绝上传：{relative}")
            if before.st_ino and opened.st_ino and (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise CliError(f"文件在读取时发生变化，拒绝上传：{relative}")
            with os.fdopen(fd, "rb") as stream:
                fd = -1
                raw = stream.read(MAX_FILE_BYTES + 1)
        finally:
            if fd >= 0:
                os.close(fd)
    except CliError:
        raise
    except OSError:
        if required:
            raise CliError(f"无法读取文件：{relative}") from None
        return None
    if len(raw) > MAX_FILE_BYTES:
        raise CliError(f"文件超过单文件 5 MiB 限制：{relative}")
    return raw


def _js_regex_literal_end(raw: bytes, start: int) -> int:
    """Return the end of a regex literal, or the input end if it is malformed."""
    index = start + 1
    in_character_class = False
    while index < len(raw):
        current = raw[index]
        if current in (0x0A, 0x0D):
            return len(raw)
        if current == 0x5C:
            index += 2
            continue
        if current == 0x5B and not in_character_class:
            in_character_class = True
        elif current == 0x5D and in_character_class:
            in_character_class = False
        elif current == 0x2F and not in_character_class:
            index += 1
            while index < len(raw) and (raw[index] == 0x5F or raw[index] == 0x24 or 0x30 <= raw[index] <= 0x39 or 0x41 <= raw[index] <= 0x5A or 0x61 <= raw[index] <= 0x7A):
                index += 1
            return index
        index += 1
    return len(raw)


def _js_code_mask(raw: bytes) -> bytearray:
    """Mark offsets in JS code, excluding strings, comments, and regex literals.

    This intentionally uses a small lexical scan rather than a parser. Template
    literals are treated as strings in full, including their interpolations; a
    credential-like assignment inside an interpolation is therefore rejected
    conservatively instead of receiving the reference exception.
    """
    mask = bytearray(len(raw))
    index = 0
    quote = 0
    expect_expression = True
    pending_control_paren = False
    pending_for_await = False
    pending_block = False
    pending_label_candidate = False
    pending_labeled_block = False
    statement_start = True
    paren_stack: list[bool] = []
    brace_stack: list[bool] = []
    last_code_char = 0
    while index < len(raw):
        current = raw[index]
        if quote:
            if current == 0x5C:  # backslash
                index += 2
                continue
            if current == quote:
                quote = 0
                expect_expression = False
                last_code_char = current
            index += 1
            continue
        if current in (0x22, 0x27, 0x60):  # double, single, or template quote
            quote = current
            pending_for_await = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
            index += 1
            continue
        if current in b" \t\r\n\v\f":
            mask[index] = 1
            index += 1
            continue
        if raw.startswith(b"//", index):
            newline = raw.find(b"\n", index + 2)
            index = len(raw) if newline < 0 else newline + 1
            continue
        if raw.startswith(b"/*", index):
            close = raw.find(b"*/", index + 2)
            index = len(raw) if close < 0 else close + 2
            continue
        if raw.startswith(b"</", index):
            # JSX also occurs in .js files. Its text is not a JS reference;
            # keep the generic scan conservative for this unsupported syntax.
            return bytearray(len(raw))
        if current == 0x2F and expect_expression:
            index = _js_regex_literal_end(raw, index)
            expect_expression = False
            last_code_char = 0x2F
            pending_for_await = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
            continue
        if current == 0x5F or current == 0x24 or 0x41 <= current <= 0x5A or 0x61 <= current <= 0x7A or current >= 0x80:
            start = index
            index += 1
            while index < len(raw):
                following = raw[index]
                if following == 0x5F or following == 0x24 or 0x30 <= following <= 0x39 or 0x41 <= following <= 0x5A or 0x61 <= following <= 0x7A or following >= 0x80:
                    index += 1
                else:
                    break
            mask[start:index] = b"\x01" * (index - start)
            token = raw[start:index].lower()
            is_property = last_code_char == 0x2E
            is_for_await = pending_for_await and token == b"await" and not is_property
            if not is_property and token == b"for":
                pending_control_paren = True
                pending_for_await = True
            elif is_for_await:
                pending_control_paren = True
                pending_for_await = False
            else:
                pending_control_paren = not is_property and token in JS_CONTROL_PAREN_KEYWORDS
                pending_for_await = False
            pending_block = not is_property and token in JS_BLOCK_KEYWORDS
            expect_expression = not is_property and token in JS_REGEX_PREFIX_KEYWORDS
            pending_label_candidate = statement_start and not is_property
            statement_start = not is_property and token in JS_BLOCK_KEYWORDS
            pending_labeled_block = False
            last_code_char = raw[index - 1]
            continue
        if 0x30 <= current <= 0x39:
            mask[index] = 1
            expect_expression = False
            pending_for_await = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
            last_code_char = current
            index += 1
            continue
        mask[index] = 1
        if current == 0x28:
            paren_stack.append(pending_control_paren)
            pending_control_paren = False
            pending_for_await = False
            expect_expression = True
            statement_start = False
        elif current == 0x29:
            expect_expression = paren_stack.pop() if paren_stack else False
            pending_control_paren = False
            pending_block = expect_expression
            pending_for_await = False
            statement_start = expect_expression
        elif current == 0x7B:
            is_block = (
                pending_block
                or pending_labeled_block
                or not expect_expression
                or last_code_char in (0, 0x3B, 0x7B)
            )
            brace_stack.append(is_block)
            expect_expression = True
            pending_block = False
            pending_control_paren = False
            pending_for_await = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = is_block
        elif current == 0x7D:
            is_block = brace_stack.pop() if brace_stack else False
            expect_expression = is_block
            pending_block = False
            pending_control_paren = False
            pending_for_await = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = is_block
        elif current == 0x5D:
            expect_expression = False
            pending_control_paren = False
            pending_for_await = False
            pending_block = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
        elif current == 0x3A:
            pending_labeled_block = pending_label_candidate
            statement_start = pending_label_candidate
            pending_label_candidate = False
            expect_expression = True
            pending_control_paren = False
            pending_for_await = False
            pending_block = False
        elif current == 0x3B:
            expect_expression = True
            pending_control_paren = False
            pending_for_await = False
            pending_block = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = not paren_stack
        elif current in b"[,?=+-*%&|^!~<>":
            expect_expression = True
            pending_control_paren = False
            pending_for_await = False
            pending_block = current == 0x3E and last_code_char == 0x3D
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
        elif current == 0x2F:
            expect_expression = True
            pending_control_paren = False
            pending_for_await = False
            pending_block = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
        else:
            expect_expression = False
            pending_control_paren = False
            pending_for_await = False
            pending_block = False
            pending_label_candidate = False
            pending_labeled_block = False
            statement_start = False
        last_code_char = current
        index += 1
    return mask


def _markup_tag_end(raw: bytes, start: int) -> int:
    quote = 0
    index = start
    while index < len(raw):
        current = raw[index]
        if quote:
            if current == quote:
                quote = 0
        elif current in (0x22, 0x27):
            quote = current
        elif current == 0x3E:
            return index
        index += 1
    return -1


def _vue_script_language_allowed(attributes: bytes) -> bool:
    matches = list(VUE_LANG_ATTRIBUTE_PATTERN.finditer(attributes))
    for match in matches:
        value = next((group for group in match.groups()[1:] if group is not None), None)
        if match.group(1) != b"lang" or value not in VUE_JS_LANGUAGES:
            return False
    return True


def _vue_script_ranges(raw: bytes) -> list[tuple[int, int]]:
    """Find script bodies that are direct children of a Vue SFC document."""
    lower = raw.lower()
    stack: list[bytes] = []
    ranges: list[tuple[int, int]] = []
    index = 0
    while index < len(raw):
        tag_start = lower.find(b"<", index)
        if tag_start < 0:
            break
        if lower.startswith(b"<!--", tag_start):
            comment_end = lower.find(b"-->", tag_start + 4)
            if comment_end < 0:
                break
            index = comment_end + 3
            continue
        if lower.startswith(b"<![cdata[", tag_start):
            cdata_end = lower.find(b"]]>", tag_start + 9)
            if cdata_end < 0:
                break
            index = cdata_end + 3
            continue
        if lower.startswith((b"<!", b"<?"), tag_start):
            tag_end = _markup_tag_end(raw, tag_start + 2)
            if tag_end < 0:
                break
            index = tag_end + 1
            continue

        name_start = tag_start + 1
        closing = name_start < len(raw) and lower[name_start] == 0x2F
        if closing:
            name_start += 1
        if name_start >= len(raw) or not (0x61 <= lower[name_start] <= 0x7A):
            index = tag_start + 1
            continue
        name_end = name_start + 1
        while name_end < len(raw) and (
            0x61 <= lower[name_end] <= 0x7A
            or 0x30 <= lower[name_end] <= 0x39
            or lower[name_end] in b"_.:-"
        ):
            name_end += 1
        name = lower[name_start:name_end]
        tag_end = _markup_tag_end(raw, name_end)
        if tag_end < 0:
            break

        if closing:
            if stack and stack[-1] == name:
                stack.pop()
        else:
            tail = tag_end - 1
            while tail > name_end and raw[tail] in b" \t\r\n":
                tail -= 1
            self_closing = raw[tail:tail + 1] == b"/"
            if name == b"script" and not stack and not self_closing:
                body_start = tag_end + 1
                close_start = lower.find(b"</script", body_start)
                while close_start >= 0:
                    after_name = close_start + len(b"</script")
                    if after_name == len(raw) or lower[after_name] in b" \t\r\n>":
                        close_end = _markup_tag_end(raw, after_name)
                        if close_end >= 0:
                            if _vue_script_language_allowed(lower[name_end:tag_end]):
                                ranges.append((body_start, close_start))
                            index = close_end + 1
                            break
                    close_start = lower.find(b"</script", close_start + 2)
                else:
                    break
                continue
            if not self_closing and name not in VUE_VOID_ELEMENTS:
                stack.append(name)
        index = tag_end + 1
    return ranges


def _js_reference_ends_expression(raw: bytes, offset: int) -> bool:
    """Accept only a complete reference RHS, followed by a real boundary."""
    index = offset
    saw_newline = False
    while index < len(raw):
        if raw[index] in b" \t\r\n\v\f":
            saw_newline = saw_newline or raw[index] in (0x0A, 0x0D)
            index += 1
            continue
        if raw.startswith(b"//", index):
            newline = raw.find(b"\n", index + 2)
            if newline < 0:
                return True
            saw_newline = True
            index = newline + 1
            continue
        if raw.startswith(b"/*", index):
            close = raw.find(b"*/", index + 2)
            if close < 0:
                return False
            comment = raw[index + 2:close]
            saw_newline = saw_newline or b"\n" in comment or b"\r" in comment
            index = close + 2
            continue
        break

    if index == len(raw) or raw[index] in JS_REFERENCE_END:
        return True
    if saw_newline:
        if raw[index:index + 1] in JS_REFERENCE_CONTINUATION:
            return False
        if re.match(rb"(?:in|instanceof|as|satisfies)\b", raw[index:]):
            return False
        return True
    return False


def _secret_string_literal(raw: bytes, start: int, allow_python_prefix: bool) -> tuple[bytes, int, int, bool] | None:
    index = start
    prefix = b""
    if allow_python_prefix and (index >= len(raw) or raw[index] not in (0x22, 0x27, 0x60)):
        for size in (2, 1):
            candidate = raw[index:index + size].lower()
            quote_index = index + size
            if candidate in {b"br", b"rb", b"fr", b"rf", b"r", b"b", b"u", b"f"} and quote_index < len(raw) and raw[quote_index] in (0x22, 0x27):
                prefix = candidate
                index = quote_index
                break

    if index >= len(raw) or raw[index] not in (0x22, 0x27, 0x60):
        return None

    quote = raw[index]
    if quote == 0x60:
        delimiter = bytes((quote,))
    elif raw.startswith(bytes((quote,)) * 3, index):
        delimiter = bytes((quote,)) * 3
    else:
        delimiter = bytes((quote,))
    content_start = index + len(delimiter)
    cursor = content_start
    while cursor < len(raw):
        current = raw[cursor]
        if current == 0x5C:
            if cursor + 1 >= len(raw):
                return raw[content_start:cursor], content_start, len(raw), False
            if raw[cursor + 1:cursor + 3] == b"\r\n":
                cursor += 3
            else:
                cursor += 2
            continue
        if quote == 0x60 and raw.startswith(b"${", cursor):
            return raw[content_start:cursor], content_start, len(raw), False
        if raw.startswith(delimiter, cursor):
            content = raw[content_start:cursor]
            interpolated = b"f" in prefix and (b"{" in content or b"}" in content)
            return content, content_start, cursor + len(delimiter), not interpolated
        if len(delimiter) == 1 and quote != 0x60 and current in (0x0A, 0x0D):
            return raw[content_start:cursor], content_start, cursor, False
        cursor += 1
    return raw[content_start:cursor], content_start, cursor, False


def _skip_secret_trivia(raw: bytes, start: int, allow_python_prefix: bool) -> tuple[int, bool, bool, bool]:
    index = start
    saw_newline = False
    explicit_continuation = False
    while index < len(raw):
        if raw[index] in b" \t\r\n\v\f":
            saw_newline = saw_newline or raw[index] in b"\r\n"
            index += 1
            continue
        if allow_python_prefix and raw[index:index + 1] == b"\\":
            if raw.startswith(b"\\\r\n", index):
                index += 3
            elif raw[index:index + 2] in (b"\\\n", b"\\\r"):
                index += 2
            else:
                break
            saw_newline = True
            explicit_continuation = True
            continue
        if allow_python_prefix and raw[index:index + 1] == b"#":
            newline = min((position for position in (raw.find(b"\n", index + 1), raw.find(b"\r", index + 1)) if position >= 0), default=-1)
            if newline < 0:
                return len(raw), saw_newline, explicit_continuation, True
            saw_newline = True
            index = newline + (2 if raw.startswith(b"\r\n", newline) else 1)
            continue
        if not allow_python_prefix and raw.startswith(b"//", index):
            newline = min((position for position in (raw.find(b"\n", index + 2), raw.find(b"\r", index + 2)) if position >= 0), default=-1)
            if newline < 0:
                return len(raw), saw_newline, explicit_continuation, True
            saw_newline = True
            index = newline + (2 if raw.startswith(b"\r\n", newline) else 1)
            continue
        if not allow_python_prefix and raw.startswith(b"/*", index):
            close = raw.find(b"*/", index + 2)
            if close < 0:
                return len(raw), saw_newline, explicit_continuation, False
            comment = raw[index + 2:close]
            saw_newline = saw_newline or b"\n" in comment or b"\r" in comment
            index = close + 2
            continue
        break
    return index, saw_newline, explicit_continuation, True


def _secret_line_has_open_delimiter(raw: bytes, start: int, line_end: int, allow_python_prefix: bool) -> bool:
    delimiters = {0x28: 0x29, 0x5B: 0x5D, 0x7B: 0x7D}
    closing = {value: key for key, value in delimiters.items()}
    stack: list[int] = []
    index = start
    while index < line_end:
        if allow_python_prefix and raw[index:index + 1] == b"#":
            break
        if not allow_python_prefix and raw.startswith(b"//", index):
            break
        if not allow_python_prefix and raw.startswith(b"/*", index):
            close = raw.find(b"*/", index + 2)
            if close < 0 or close >= line_end:
                return True
            index = close + 2
            continue
        if raw[index] in (0x22, 0x27, 0x60):
            literal = _secret_string_literal(raw, index, allow_python_prefix)
            if literal is None or literal[2] > line_end:
                return True
            index = literal[2]
            continue
        current = raw[index]
        if current in delimiters:
            stack.append(current)
        elif current in closing:
            if not stack:
                return False
            if stack.pop() != closing[current]:
                return True
        elif current in b";," and not stack:
            return False
        index += 1
    return bool(stack)


def _secret_expression_continues(raw: bytes, start: int, line_end: int, allow_python_prefix: bool, allow_vue_markup: bool) -> bool:
    line = raw[start:line_end].rstrip()
    if _secret_line_has_open_delimiter(raw, start, line_end, allow_python_prefix):
        return True
    continuation_suffixes = (b"\\",) + tuple(bytes((character,)) for character in JS_REFERENCE_CONTINUATION)
    if line.endswith(continuation_suffixes):
        return True
    next_index, saw_newline, _, reliable = _skip_secret_trivia(raw, line_end, allow_python_prefix)
    if not reliable:
        return True
    if allow_vue_markup and re.match(rb"</(?:script|template|style)\b", raw[next_index:], re.IGNORECASE):
        return False
    return saw_newline and next_index < len(raw) and raw[next_index] in JS_REFERENCE_CONTINUATION


def _secret_assignment_value(raw: bytes, start: int, allow_python_prefix: bool = False, allow_vue_markup: bool = False) -> tuple[bytes, int, bool, bool]:
    index, _, _, trivia_reliable = _skip_secret_trivia(raw, start, allow_python_prefix)
    if not trivia_reliable:
        return b"", index, True, False
    if index >= len(raw):
        return b"", index, False, True

    opening_parentheses = 0
    probe = index
    while probe < len(raw) and raw[probe] == 0x28:
        opening_parentheses += 1
        probe += 1
        probe, _, _, trivia_reliable = _skip_secret_trivia(raw, probe, allow_python_prefix)
        if not trivia_reliable:
            return b"", probe, True, False
    literal = _secret_string_literal(raw, probe, allow_python_prefix)

    if literal is None:
        if opening_parentheses:
            return b"", probe, True, False
        line_end = len(raw)
        for newline in (raw.find(b"\n", index), raw.find(b"\r", index)):
            if newline >= 0:
                line_end = min(line_end, newline)
        if _secret_expression_continues(raw, index, line_end, allow_python_prefix, allow_vue_markup):
            return b"", index, True, False
        return raw[index:line_end].strip(), index, False, True

    first_content_start = literal[1]
    values = [literal[0]]
    reliable = literal[3]
    cursor = literal[2]
    while True:
        next_index, saw_newline, explicit_continuation, trivia_reliable = _skip_secret_trivia(raw, cursor, allow_python_prefix)
        if not trivia_reliable:
            return b"".join(values), first_content_start, True, False

        if next_index < len(raw) and raw[next_index] == 0x29 and opening_parentheses:
            opening_parentheses -= 1
            cursor = next_index + 1
            continue
        if allow_python_prefix and saw_newline and not opening_parentheses and not explicit_continuation:
            break
        if next_index >= len(raw) or raw[next_index] in b";,]}):":
            if opening_parentheses:
                return b"".join(values), first_content_start, True, False
            break

        if raw[next_index] == 0x2B:
            next_index += 1
            next_index, plus_newline, plus_continuation, trivia_reliable = _skip_secret_trivia(raw, next_index, allow_python_prefix)
            if not trivia_reliable or (allow_python_prefix and plus_newline and not opening_parentheses and not plus_continuation):
                return b"".join(values), first_content_start, True, False
            following = _secret_string_literal(raw, next_index, allow_python_prefix)
            if following is None:
                return b"".join(values), first_content_start, True, False
            values.append(following[0])
            reliable = reliable and following[3]
            cursor = following[2]
            continue

        following = _secret_string_literal(raw, next_index, allow_python_prefix)
        if following is not None and (allow_python_prefix and (opening_parentheses or explicit_continuation) or not allow_python_prefix and not saw_newline):
            values.append(following[0])
            reliable = reliable and following[3]
            cursor = following[2]
            continue

        if saw_newline and not opening_parentheses and (not allow_python_prefix or not explicit_continuation):
            break
        return b"".join(values), first_content_start, True, False

    return b"".join(values), first_content_start, True, reliable


def _looks_secret(raw: bytes, path: str) -> bool:
    if any(pattern.search(raw) for pattern in SECRET_PATTERNS):
        return True
    suffix = PurePosixPath(path).suffix.casefold()
    is_js_source = suffix in JS_SOURCE_SUFFIXES
    code_mask = None
    python_source = suffix in {".py", ".pyi", ".pyw"}
    for match in SECRET_ASSIGNMENT_PATTERN.finditer(raw):
        if suffix in {".yaml", ".yml"} and raw[match.end():match.end() + 1] in {b"|", b">"}:
            return True
        value, value_start, quoted, reliable = _secret_assignment_value(raw, match.end(), python_source, suffix == ".vue")
        if quoted:
            if not reliable or len(value) >= 20:
                return True
            continue
        if not reliable or len(value) < 20:
            continue
        if not is_js_source:
            return True
        if code_mask is None:
            code_mask = bytearray(len(raw))
            if suffix == ".vue":
                for start, end in _vue_script_ranges(raw):
                    code_mask[start:end] = _js_code_mask(raw[start:end])
            else:
                code_mask = _js_code_mask(raw)
        reference = JS_MEMBER_REFERENCE_RE.match(raw, value_start)
        if (
            not reference or not code_mask[value_start]
            or not _js_reference_ends_expression(raw, reference.end())
        ):
            return True
    return False


def _is_essential_source(path: str) -> bool:
    return PurePosixPath(path).suffix.casefold() in ESSENTIAL_SOURCE_SUFFIXES


def _collect(root: Path) -> tuple[dict[str, Any], list[dict[str, str]], str, int, int, list[str]]:
    root_info = root.lstat()
    if _is_reparse_or_link(root, root_info) or not stat.S_ISDIR(root_info.st_mode):
        raise CliError("项目根目录必须是普通目录，不能是符号链接或 junction。")
    raw_manifest = _read_file(root, MANIFEST_NAME, required=True)
    assert raw_manifest is not None
    decoded = _load_manifest(raw_manifest)
    candidates = _candidate_paths(root)
    candidates.update(decoded["required"])
    files: list[dict[str, str]] = []
    sizes: list[tuple[str, bytes]] = []
    skipped: list[str] = []
    total = 0
    for relative in sorted(candidates):
        required = relative in decoded["required"]
        raw = _read_file(root, relative, required=required)
        if raw is None:
            if _is_essential_source(relative):
                raise CliError(f"必要源码无法安全读取：{relative}；请调整 AI 的项目范围后重试。")
            skipped.append(relative)
            continue
        if _looks_secret(raw, relative):
            if required or _is_essential_source(relative):
                raise CliError(f"必要源码或资料疑似包含真实密钥或 token：{relative}；请调整 AI 的项目范围后重试。")
            skipped.append(relative)
            continue
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise CliError("项目资料超过总计 20 MiB 限制；未开始上传。")
        sizes.append((relative, raw))
        if len(sizes) > MAX_FILES:
            raise CliError("项目资料超过 1000 个文件限制；未开始上传。")
    present = {name for name, _ in sizes}
    missing = [name for name in decoded["required"] if name not in present]
    if missing:
        raise CliError(f"必需资料未能安全收集：{missing[0]}")
    digest_parts = {
        "appKey": decoded["appKey"],
        "manifestPath": MANIFEST_NAME,
        "files": [
            {"path": name, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            for name, raw in sizes
        ],
    }
    canonical = json.dumps(digest_parts, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    for name, raw in sizes:
        files.append({"path": name, "content": base64.b64encode(raw).decode("ascii")})
    return decoded["manifest"], files, digest, len(files), total, skipped


def _normalize_origin(value: str) -> tuple[str, str, str, int | None]:
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        raise CliError("--origin 必须是有效的门户 URL。") from None
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise CliError("--origin 只接受不含凭据的 HTTP(S) 门户地址。")
    if not re.fullmatch(r"/?(?:[a-zA-Z0-9_-]+/?)?", parsed.path) or parsed.params or parsed.query or parsed.fragment:
        raise CliError("--origin 只接受门户根地址或单层固定挂载路径，不含查询参数或片段。")
    host = parsed.hostname.casefold()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    normalized = f"{parsed.scheme}://{netloc}{parsed.path.rstrip('/')}"
    return normalized, parsed.scheme, parsed.hostname, port


def _is_inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolve_project_root(value: Path) -> Path:
    absolute = Path(os.path.abspath(value))
    cursor = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except OSError:
            raise CliError("--project 路径不存在或无法读取。") from None
        if _is_reparse_or_link(cursor, info):
            raise CliError("--project 路径不能经过符号链接或 Windows junction。")
    try:
        root = absolute.resolve(strict=True)
    except OSError:
        raise CliError("--project 路径不存在或无法读取。") from None
    if not root.is_dir():
        raise CliError("--project 必须指向项目根目录。")
    return root


def _default_state_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        return (Path(base) if base else Path.home() / "AppData" / "Local") / "AIAppPlaza" / "publisher"
    base = os.environ.get("XDG_STATE_HOME")
    return (Path(base).expanduser() if base else Path.home() / ".local" / "state") / "ai-app-plaza" / "publisher"


def _protect_windows(raw: bytes) -> bytes:
    if os.name != "nt":
        return raw

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    source_buffer = ctypes.create_string_buffer(raw)
    source = DataBlob(len(raw), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = DataBlob()
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    if not crypt32.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise CliError("无法使用 Windows DPAPI 保护发布凭据。")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)  # type: ignore[attr-defined]


def _unprotect_windows(raw: bytes) -> bytes:
    if os.name != "nt":
        return raw

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    source_buffer = ctypes.create_string_buffer(raw)
    source = DataBlob(len(raw), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = DataBlob()
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    if not crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise CliError("无法解密本机发布凭据；请保留 receipt 并在原 Windows 用户下重试。")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)  # type: ignore[attr-defined]


class ReceiptStore:
    def __init__(self, path: Path, project_root: Path):
        resolved = path.expanduser().resolve()
        if _is_inside(resolved, project_root):
            raise CliError("--state-dir 必须位于项目目录之外。")
        self.directory = resolved
        self.path: Path | None = None

    def open(self, origin: str, project_root: Path, app_key: str, *, readonly: bool = False) -> dict[str, Any] | None:
        try:
            if readonly:
                info = self.directory.lstat()
            else:
                self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                info = self.directory.lstat()
            if _is_reparse_or_link(self.directory, info) or not stat.S_ISDIR(info.st_mode):
                raise CliError("receipt 目录不能是符号链接或 junction。")
            if not readonly and os.name != "nt":
                os.chmod(self.directory, 0o700)
        except FileNotFoundError:
            if readonly:
                self.path = self.directory / (hashlib.sha256(json.dumps(
                    {"origin": origin, "projectRoot": str(project_root), "appKey": app_key},
                    sort_keys=True, separators=(",", ":")
                ).encode("utf-8")).hexdigest() + ".receipt")
                return None
            raise CliError("无法建立项目外的私有 receipt 目录。") from None
        except CliError:
            raise
        except OSError:
            raise CliError("无法建立项目外的私有 receipt 目录。") from None
        identity = {"origin": origin, "projectRoot": str(project_root), "appKey": app_key}
        identity_text = json.dumps(identity, sort_keys=True, separators=(",", ":"))
        self.path = self.directory / (hashlib.sha256(identity_text.encode("utf-8")).hexdigest() + ".receipt")
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            return None
        except OSError:
            raise CliError("无法读取本机发布 receipt。") from None
        if _is_reparse_or_link(self.path, info) or not stat.S_ISREG(info.st_mode):
            raise CliError("receipt 必须是普通文件。")
        try:
            if not readonly and os.name != "nt":
                os.chmod(self.path, 0o600)
            raw = self.path.read_bytes()
            if os.name == "nt":
                raw = _unprotect_windows(raw)
            receipt = json.loads(raw.decode("utf-8"))
        except CliError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise CliError("本机 receipt 无法读取或已损坏；不会自动重建凭据。") from None
        if not isinstance(receipt, dict) or receipt.get("identity") != identity:
            raise CliError("本机 receipt 与当前门户或项目不匹配。")
        if not isinstance(receipt.get("publishKey"), str) or not receipt["publishKey"]:
            raise CliError("本机 receipt 缺少发布凭据；不会自动创建新所有者。")
        return receipt

    def save(self, receipt: dict[str, Any]) -> None:
        if self.path is None:
            raise CliError("receipt 目录尚未初始化。")
        try:
            raw = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if os.name == "nt":
                raw = _protect_windows(raw)
            fd, temporary = tempfile.mkstemp(prefix=".publisher-", suffix=".tmp", dir=self.directory)
            try:
                if os.name != "nt":
                    os.chmod(temporary, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                if os.name != "nt":
                    os.chmod(self.path, 0o600)
            finally:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
        except CliError:
            raise
        except OSError:
            raise CliError("无法安全保存发布 receipt。") from None


def _request(origin_parts: tuple[str, str, str, int | None], method: str, path: str,
             headers: dict[str, str], body: bytes | None = None) -> tuple[int, bytes]:
    normalized, scheme, host, port = origin_parts
    connection: http.client.HTTPConnection
    try:
        if scheme == "https":
            connection = http.client.HTTPSConnection(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS)
        else:
            connection = http.client.HTTPConnection(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS)
        try:
            connection.request(method, urlparse(normalized).path + path, body=body, headers=headers)
            response = connection.getresponse()
            response_body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(response_body) > MAX_RESPONSE_BYTES:
                raise CliError("门户响应超过允许大小。")
            return response.status, response_body
        finally:
            connection.close()
    except CliError:
        raise
    except (OSError, http.client.HTTPException, TimeoutError):
        raise CliError("门户连接失败或超时；receipt 已保留，请使用相同项目内容重试。") from None


def _json_response(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CliError("门户响应不是有效 JSON；receipt 已保留，可使用相同项目内容重试。") from None
    if not isinstance(value, dict):
        raise CliError("门户响应结构无效；receipt 已保留，可使用相同项目内容重试。")
    return value


def _response_error_code(raw: bytes) -> str | None:
    """Read only a bounded error code for safe retry classification."""
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    error = value.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", code):
        return None
    return code


def _safe_diagnostic_path(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 512:
        return None
    if value.startswith(("/", "\\")) or "\\" in value or ":" in value:
        return None
    if re.search(r"[\x00-\x1f\x7f]", value) or re.search(r"(?:https?|ssh|file)://|[A-Za-z0-9_-]{32,}", value, re.IGNORECASE):
        return None
    if re.search(r"(?:password|token|secret|private[-_ ]?key)\s*[=:]", value, re.IGNORECASE):
        return None
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return value


def _safe_diagnostic_field(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 128 or re.search(r"[\x00-\x1f\x7f]|[A-Za-z0-9_-]{32,}", value):
        return None
    if value in SAFE_DIAGNOSTIC_FIELDS:
        return value
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(?:(?:\.[A-Za-z][A-Za-z0-9_]*)|(?:\[\d{1,3}\]))*", value):
        return value
    return None


def _fallback_diagnostic(code: str = "VALIDATION_FAILED", rule_id: str = "managed.cli.validation_failed") -> dict[str, str]:
    return {"code": code, "ruleId": rule_id, "suggestion": "按对应字段提示修正资料后重新校验。"}


def _sanitize_server_diagnostics(raw: bytes) -> list[dict[str, Any]]:
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return [_fallback_diagnostic()]
    error = body.get("error") if isinstance(body, dict) else None
    values = error.get("diagnostics") if isinstance(error, dict) else None
    if not isinstance(values, list):
        return [_fallback_diagnostic()]
    sanitized: list[dict[str, Any]] = []
    for item in values[:50]:
        if not isinstance(item, dict):
            continue
        code = item.get("code")
        allowed_rules = DIAGNOSTIC_RULES.get(code) if isinstance(code, str) else None
        rule_id = item.get("ruleId")
        if allowed_rules is None or not isinstance(rule_id, str) or rule_id not in allowed_rules:
            continue
        result: dict[str, Any] = {"code": code, "ruleId": rule_id}
        safe_path = _safe_diagnostic_path(item.get("path"))
        safe_field = _safe_diagnostic_field(item.get("field"))
        if safe_path:
            result["path"] = safe_path
        if safe_field:
            result["field"] = safe_field
        for key in ("line", "column"):
            number = item.get(key)
            if isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= 1_000_000:
                result[key] = number
        suggestion = item.get("suggestion")
        if isinstance(suggestion, str) and suggestion in {
            "检查字段类型、长度和格式后重新校验。",
            "修正 ai-app.json 中的字段和值后重新校验。",
            "使用仓库根目录下的安全相对路径。",
            "将新发布资料升级到 schemaVersion 2。",
            "每个应用最多使用 3 个非空且规范化后唯一的标签。",
            "使用有效的 MAJOR.MINOR.PATCH 版本号。",
            "修正 JSON 语法并移除重复键后重新校验。",
        }:
            result["suggestion"] = suggestion
        else:
            result["suggestion"] = "按对应字段提示修正资料后重新校验。"
        sanitized.append(result)
    return sanitized or [_fallback_diagnostic()]


def _local_diagnostic(error: CliError) -> dict[str, Any]:
    if error.diagnostic:
        value = dict(error.diagnostic)
        path_value = _safe_diagnostic_path(value.get("path"))
        field_value = _safe_diagnostic_field(value.get("field"))
        result = {"code": value.get("code", "LOCAL_VALIDATION_FAILED"),
                  "ruleId": value.get("ruleId", "managed.cli.local_validation")}
        if path_value:
            result["path"] = path_value
        if field_value:
            result["field"] = field_value
        for key in ("line", "column"):
            number = value.get(key)
            if isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= 1_000_000:
                result[key] = number
        result["suggestion"] = "修正本地资料后重新校验。"
        return result

    message = str(error)
    code, rule_id, field_value = "LOCAL_VALIDATION_FAILED", "managed.cli.local_validation", None
    if "疑似包含真实密钥或 token" in message:
        code, rule_id = "SECRET_MARKER_FOUND", "managed.bundle.secret_marker"
    elif "最多 3 个" in message or "标签规范化后不能重复" in message or "能力标签须" in message:
        code, rule_id, field_value = "CAPABILITY_TAGS_INVALID", "managed.bundle.capability_tags", "tags"
    elif "超过总计 20 MiB" in message:
        code, rule_id = "BUNDLE_SIZE_EXCEEDED", "managed.bundle.bundle_size"
    elif "超过单文件 5 MiB" in message:
        code, rule_id = "FILE_SIZE_EXCEEDED", "managed.bundle.file_size"
    elif "不是有效 UTF-8 JSON" in message:
        code, rule_id, field_value = "MANIFEST_UTF8_INVALID", "managed.bundle.manifest_utf8", "manifest"
    elif "重复字段" in message or "必须是有效 UTF-8 JSON" in message:
        code, rule_id, field_value = "MANIFEST_JSON_INVALID", "managed.bundle.manifest_json", "manifest"
    elif "schemaVersion 2" in message:
        code, rule_id, field_value = "SCHEMA_VERSION_UNSUPPORTED", "managed.bundle.schema_version", "schemaVersion"
    elif "projectVersion" in message:
        code, rule_id, field_value = "PROJECT_VERSION_INVALID", "managed.bundle.project_version", "projectVersion"
    elif "appKey" in message:
        code, rule_id, field_value = "APP_KEY_INVALID", "managed.bundle.app_key", "appKey"

    path_value = None
    if code == "SECRET_MARKER_FOUND":
        candidate = re.search(r"：([^；]+)", message)
        path_value = _safe_diagnostic_path(candidate.group(1).strip()) if candidate else None
    elif message.startswith(("必要源码无法安全读取：", "必要源码或资料疑似包含真实密钥或 token：", "必需资料未能安全收集：")):
        candidate = re.search(r"：([^；]+)", message)
        path_value = _safe_diagnostic_path(candidate.group(1).strip()) if candidate else None
    if field_value:
        field_value = _safe_diagnostic_field(field_value)
    result: dict[str, Any] = {"code": code, "ruleId": rule_id}
    if path_value:
        result["path"] = path_value
    if field_value:
        result["field"] = field_value
    result["suggestion"] = "修正本地资料后重新校验。"
    return result


def _print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _read_app_key(project_root: Path) -> str:
    raw = _read_file(project_root, MANIFEST_NAME, required=True)
    assert raw is not None
    try:
        manifest = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs_without_duplicates)
    except (CliError, UnicodeDecodeError, json.JSONDecodeError):
        raise CliError("ai-app.json 无法安全读取回执身份；不会采集源码或创建回执。") from None
    app_key = manifest.get("appKey") if isinstance(manifest, dict) else None
    if not isinstance(app_key, str) or len(app_key) > 64 or not APP_KEY_RE.fullmatch(app_key):
        raise CliError("ai-app.json 的 appKey 无效，无法定位本机 receipt。")
    return app_key


def _is_author_preview_url(value: str, origin: str) -> bool:
    return _author_preview_details(value, origin) is not None


def _author_preview_details(value: str, origin: str) -> tuple[str, str] | None:
    try:
        parsed = urlparse(value)
        if (
            parsed.username or parsed.password or not parsed.scheme or not parsed.netloc
            or parsed.params or parsed.query or not parsed.fragment
        ):
            return None
        preview_origin, _, _, _ = _normalize_origin(f"{parsed.scheme}://{parsed.netloc}{parsed.path}")
        if preview_origin != origin:
            return None
        fragment = parse_qs(parsed.fragment, strict_parsing=True, keep_blank_values=True, max_num_fields=2)
        if set(fragment) != {"publish", "key"}:
            return None
        if len(fragment["publish"]) != 1 or len(fragment["key"]) != 1:
            return None
        publication_id = fragment["publish"][0]
        ticket = fragment["key"][0]
        if UUID_RE.fullmatch(publication_id) and PREVIEW_TICKET_RE.fullmatch(ticket):
            return str(uuid.UUID(publication_id)), ticket
        return None
    except (CliError, ValueError):
        return None


def _publication_handoff(response: dict[str, Any], origin: str) -> tuple[dict[str, Any], bool]:
    raw_status = response.get("status")
    status_value = raw_status if isinstance(raw_status, str) and raw_status in SAFE_PUBLICATION_STATUSES else None
    raw_id = response.get("id")
    raw_publication_id = response.get("publicationId")
    publication_id: str | None = None
    try:
        if raw_id is not None and raw_publication_id is not None:
            if _valid_uuid(raw_id, "publication id") != _valid_uuid(raw_publication_id, "publicationId"):
                raise CliError("门户返回的发布 ID 不一致。")
        chosen_id = raw_publication_id if raw_publication_id is not None else raw_id
        if chosen_id is not None:
            publication_id = _valid_uuid(chosen_id, "publication id")
    except CliError:
        publication_id = None

    managed_id: str | None = None
    try:
        managed_id = _valid_uuid(response.get("managedAppId"), "managedAppId")
    except CliError:
        pass

    source_uploaded = response.get("sourceUploaded")
    if not isinstance(source_uploaded, bool):
        source_uploaded = None
    next_action = response.get("nextAction")
    if not isinstance(next_action, str) or next_action not in SAFE_NEXT_ACTIONS:
        next_action = None
    revision = response.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        revision = None
    expires_at = response.get("expiresAt")
    if not isinstance(expires_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", expires_at):
        expires_at = None

    details: dict[str, Any] = {
        "status": status_value or "unknown",
    }
    if source_uploaded is not None:
        details["sourceUploaded"] = source_uploaded
    if managed_id:
        details["managedAppId"] = managed_id
    if publication_id:
        details["publicationId"] = publication_id
    if next_action:
        details["nextAction"] = next_action
    if revision is not None:
        details["revision"] = revision
    if expires_at:
        details["expiresAt"] = expires_at

    preview_url = response.get("previewUrl")
    url_details = _author_preview_details(preview_url, origin) if isinstance(preview_url, str) else None
    raw_ticket = response.get("ticket")
    ticket_matches = "ticket" not in response or (
        isinstance(raw_ticket, str) and url_details is not None and raw_ticket == url_details[1]
    )
    valid_url = bool(
        url_details and publication_id and url_details[0] == publication_id and ticket_matches
    )
    complete = bool(
        status_value == "preview_ready" and source_uploaded is True and managed_id and publication_id and valid_url
    )
    if complete:
        details["handoffState"] = "complete"
    elif status_value == "registered" and source_uploaded and managed_id and publication_id:
        details["handoffState"] = "registered"
    elif status_value == "checking" and managed_id and publication_id:
        details["handoffState"] = "pending"
    else:
        details["handoffState"] = "recovery_required"
    if complete:
        details["previewUrl"] = preview_url
    failed_retry_recovery = bool(
        status_value == "failed" and next_action == "retry" and source_uploaded is True
        and managed_id and publication_id and url_details and url_details[0] == publication_id
        and isinstance(raw_ticket, str) and raw_ticket == url_details[1]
    )
    if failed_retry_recovery:
        details["recoveryUrl"] = preview_url
        details["recoveryTicket"] = raw_ticket
    return details, complete


def _clear_saved_recovery_capability(receipt: dict[str, Any]) -> bool:
    changed = False
    for key in ("recoveryUrl", "recoveryTicket"):
        if key in receipt:
            receipt.pop(key, None)
            changed = True
    return changed


def _discard_saved_recovery_capability(store: ReceiptStore, receipt: dict[str, Any]) -> None:
    if _clear_saved_recovery_capability(receipt):
        store.save(receipt)


def _store_publication_result(store: ReceiptStore, receipt: dict[str, Any], details: dict[str, Any], complete: bool) -> None:
    _clear_saved_recovery_capability(receipt)
    receipt.pop("verifiedRecoveryAction", None)
    receipt.pop("recoveryResponseStatus", None)
    receipt.pop("operationStatus", None)
    receipt["responseKnown"] = True
    receipt.pop("knownRequestRejection", None)
    receipt["publicationId"] = details.get("publicationId")
    receipt["publicationStatus"] = details.get("status", "unknown")
    source_uploaded = details.get("sourceUploaded")
    if isinstance(source_uploaded, bool):
        receipt["sourceUploaded"] = source_uploaded
    else:
        receipt.pop("sourceUploaded", None)
    receipt["managedAppId"] = details.get("managedAppId", receipt.get("managedAppId"))
    for key in ("nextAction", "revision", "expiresAt"):
        if key in details:
            receipt[{"revision": "publicationRevision"}.get(key, key)] = details[key]
        else:
            receipt.pop({"revision": "publicationRevision"}.get(key, key), None)
    if complete:
        receipt["previewUrl"] = details["previewUrl"]
        link = _author_preview_details(details["previewUrl"], receipt["identity"]["origin"])
        assert link is not None
        receipt["publicationTicket"] = link[1]
        receipt["handoffState"] = "complete"
        receipt["handoffComplete"] = True
        receipt.pop("handoffRecoveryRequired", None)
    else:
        receipt.pop("previewUrl", None)
        receipt.pop("publicationTicket", None)
        receipt["handoffState"] = details.get("handoffState", "recovery_required")
        receipt["handoffComplete"] = False
        if receipt["handoffState"] == "recovery_required":
            receipt["handoffRecoveryRequired"] = True
        else:
            receipt.pop("handoffRecoveryRequired", None)
        if (
            details.get("status") == "failed" and details.get("nextAction") == "retry"
            and details.get("sourceUploaded") is True and details.get("handoffState") == "recovery_required"
            and isinstance(details.get("recoveryUrl"), str) and isinstance(details.get("recoveryTicket"), str)
        ):
            identity = receipt.get("identity")
            origin = identity.get("origin") if isinstance(identity, dict) else None
            url = details["recoveryUrl"]
            link = _author_preview_details(url, origin) if isinstance(origin, str) else None
            publication_id = None
            managed_id = None
            try:
                publication_id = _valid_uuid(details.get("publicationId"), "publicationId")
                managed_id = _valid_uuid(details.get("managedAppId"), "managedAppId")
            except CliError:
                link = None
            if (
                link and link[0] == publication_id and link[1] == details["recoveryTicket"]
                and managed_id == details.get("managedAppId")
            ):
                receipt["recoveryUrl"] = url
                receipt["recoveryTicket"] = link[1]
    store.save(receipt)


def _get_revision(
    origin_parts: tuple[str, str, str, int | None],
    receipt: dict[str, Any],
    app_key: str,
    managed_id: str,
) -> int:
    publish_key = receipt.get("publishKey")
    if not isinstance(publish_key, str) or not publish_key:
        raise CliError("本地 receipt 缺少托管应用凭证；停止更新，不创建新应用。")
    status, raw = _request(
        origin_parts, "GET", f"/api/managed-apps/{quote(managed_id, safe='')}/status",
        {"Accept": "application/json", "X-Plaza-Publish-Key": publish_key},
    )
    if status < 200 or status >= 300:
        raise CliError(f"读取托管应用状态失败（HTTP {status}）；尚未提交更新，不会创建新应用，receipt 已保留。")
    response = _json_response(raw)
    returned_managed = _valid_uuid(response.get("managedAppId"), "托管应用状态 managedAppId")
    if returned_managed != managed_id or response.get("appKey") != app_key:
        raise CliError("托管应用状态与本机 receipt 的 managedAppId 或 appKey 不匹配；尚未提交更新。")
    revision = response.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise CliError("托管应用 catalog revision 响应无效；尚未提交更新，receipt 已保留。")
    catalog_app_id = response.get("appId")
    if catalog_app_id is not None:
        catalog_app_id = _valid_uuid(catalog_app_id, "托管应用状态 appId")
    receipt["catalogAppId"] = catalog_app_id
    receipt["catalogRevision"] = revision
    return revision


def _decode_receipt_files(receipt: dict[str, Any]) -> list[dict[str, str]]:
    files = receipt.get("files")
    if not isinstance(files, list):
        raise CliError("本机 receipt 缺少待重试资料；不会生成新的幂等键。")
    checked: list[dict[str, str]] = []
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
            raise CliError("本机 receipt 中的资料结构无效。")
        try:
            raw = base64.b64decode(item["content"], validate=True)
        except ValueError:
            raise CliError("本机 receipt 中的资料编码无效。") from None
        checked.append({"path": item["path"], "content": item["content"]})
        if len(raw) > MAX_FILE_BYTES:
            raise CliError("本机 receipt 中存在超限文件。")
    return checked


def _saved_preview_url(receipt: dict[str, Any], origin: str) -> str | None:
    if (
        receipt.get("handoffComplete") is not True
        or receipt.get("handoffState") != "complete"
        or receipt.get("publicationStatus") != "preview_ready"
        or receipt.get("sourceUploaded") is not True
    ):
        return None
    try:
        publication_id = _valid_uuid(receipt.get("publicationId"), "publicationId")
        _valid_uuid(receipt.get("managedAppId"), "managedAppId")
    except CliError:
        return None
    preview_url = receipt.get("previewUrl")
    if not isinstance(preview_url, str):
        return None
    link = _author_preview_details(preview_url, origin)
    if not link or link[0] != publication_id or link[1] != receipt.get("publicationTicket"):
        return None
    return preview_url


def _saved_recovery_url(receipt: dict[str, Any], origin: str) -> str | None:
    if (
        receipt.get("responseKnown") is not True
        or receipt.get("handoffComplete") is not False
        or receipt.get("handoffState") != "recovery_required"
        or receipt.get("handoffRecoveryRequired") is not True
        or receipt.get("publicationStatus") != "failed"
        or receipt.get("nextAction") != "retry"
        or receipt.get("sourceUploaded") is not True
    ):
        return None
    identity = receipt.get("identity")
    if not isinstance(identity, dict) or identity.get("origin") != origin:
        return None
    try:
        publication_id = _valid_uuid(receipt.get("publicationId"), "publicationId")
        _valid_uuid(receipt.get("managedAppId"), "managedAppId")
    except CliError:
        return None
    recovery_url = receipt.get("recoveryUrl")
    recovery_ticket = receipt.get("recoveryTicket")
    if not isinstance(recovery_url, str) or not isinstance(recovery_ticket, str):
        return None
    link = _author_preview_details(recovery_url, origin)
    if not link or link[0] != publication_id or link[1] != recovery_ticket:
        return None
    return recovery_url


def _receipt_status_output(receipt: dict[str, Any], origin: str) -> dict[str, Any]:
    publication_status = receipt.get("publicationStatus")
    if not isinstance(publication_status, str) or publication_status not in SAFE_PUBLICATION_STATUSES:
        publication_status = "unknown"
    if receipt.get("handoffState") == "recovery_required" or receipt.get("handoffRecoveryRequired") is True:
        handoff_state = "recovery_required"
    elif _saved_preview_url(receipt, origin):
        handoff_state = "complete"
    elif receipt.get("handoffState") == "registered" and publication_status == "registered" and receipt.get("sourceUploaded") is True:
        handoff_state = "registered"
    elif receipt.get("handoffState") == "pending" or publication_status in {"checking", "unknown"}:
        handoff_state = "pending"
    else:
        handoff_state = "recovery_required"
    result: dict[str, Any] = {
        "status": "receipt_saved",
        "handoffState": handoff_state,
        "publicationStatus": publication_status,
    }
    source_uploaded = receipt.get("sourceUploaded")
    if isinstance(source_uploaded, bool):
        result["sourceUploaded"] = source_uploaded
    app_key = receipt.get("identity", {}).get("appKey") if isinstance(receipt.get("identity"), dict) else None
    if isinstance(app_key, str) and APP_KEY_RE.fullmatch(app_key):
        result["appKey"] = app_key
    for key in ("managedAppId", "publicationId"):
        try:
            result[key] = _valid_uuid(receipt.get(key), key)
        except CliError:
            pass
    preview_url = _saved_preview_url(receipt, origin)
    if preview_url:
        result["previewUrl"] = preview_url
    recovery_url = _saved_recovery_url(receipt, origin)
    if recovery_url:
        result["recoveryUrl"] = recovery_url
    next_action = receipt.get("nextAction")
    if isinstance(next_action, str) and next_action in SAFE_NEXT_ACTIONS:
        result["nextAction"] = next_action
    return result


def _safe_operation_status(value: Any) -> str | None:
    return value if isinstance(value, str) and value in SAFE_OPERATION_STATUSES else None


def _can_retry_original(receipt: dict[str, Any]) -> bool:
    if (
        receipt.get("handoffRecoveryRequired") is not True
        or receipt.get("recoveryResponseStatus") != "recovery_required"
        or receipt.get("verifiedRecoveryAction") != "retry_original"
        or receipt.get("nextAction") != "retry_original"
        or _safe_operation_status(receipt.get("operationStatus")) is None
    ):
        return False
    try:
        managed_id = _valid_uuid(receipt.get("managedAppId"), "receipt managedAppId")
        _valid_uuid(receipt.get("idempotencyKey"), "receipt Idempotency-Key")
    except CliError:
        return False
    if "requestManagedAppId" not in receipt:
        return False
    request_managed_id = receipt.get("requestManagedAppId")
    if request_managed_id is not None:
        try:
            if _valid_uuid(request_managed_id, "receipt request managedAppId") != managed_id:
                return False
        except CliError:
            return False
        request_revision = receipt.get("requestExpectedAppRevision")
        if not isinstance(request_revision, int) or isinstance(request_revision, bool) or request_revision < 0:
            return False
    elif receipt.get("requestExpectedAppRevision") is not None:
        return False
    publish_key = receipt.get("publishKey")
    if not isinstance(publish_key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{43,128}", publish_key):
        return False
    digest = receipt.get("bundleDigest")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        return False
    try:
        _decode_receipt_files(receipt)
    except CliError:
        return False
    return True


def _can_submit_again(receipt: dict[str, Any], *, changed_bundle: bool) -> bool:
    if (
        not changed_bundle
        or receipt.get("handoffRecoveryRequired") is not True
        or receipt.get("responseKnown") is not True
        or receipt.get("publicationStatus") != "failed"
        or receipt.get("nextAction") != "submit_again"
    ):
        return False
    try:
        _valid_uuid(receipt.get("managedAppId"), "receipt managedAppId")
        _valid_uuid(receipt.get("publicationId"), "receipt publicationId")
    except CliError:
        return False
    return receipt.get("sourceUploaded") is True


def _recovery_required_output(*, managed_id: str | None = None, operation_status: str | None = None,
                              next_action: str | None = None, source_uploaded: bool | None = None,
                              code: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "HANDOFF_RECOVERY_REQUIRED", "handoffState": "recovery_required"}
    if managed_id:
        result["managedAppId"] = managed_id
    if operation_status:
        result["operationStatus"] = operation_status
    if next_action in SAFE_NEXT_ACTIONS:
        result["nextAction"] = next_action
    if source_uploaded is not None:
        result["sourceUploaded"] = source_uploaded
        result["recoveryRequired"] = True
    if code:
        result["code"] = code
    return result


def _publish_output(details: dict[str, Any], complete: bool) -> dict[str, Any]:
    if complete:
        return {key: details[key] for key in (
            "status", "handoffState", "publicationId", "managedAppId", "sourceUploaded", "previewUrl",
            "nextAction", "revision", "expiresAt",
        ) if key in details}
    if details.get("handoffState") == "registered":
        return {key: details[key] for key in (
            "status", "handoffState", "publicationId", "managedAppId", "sourceUploaded", "nextAction", "revision",
        ) if key in details}
    if details.get("handoffState") == "pending":
        return {key: details[key] for key in (
            "status", "handoffState", "publicationId", "managedAppId", "sourceUploaded", "nextAction",
        ) if key in details}
    if details.get("status") in {"failed", "cancelled"}:
        return {key: details[key] for key in (
            "status", "handoffState", "publicationId", "managedAppId", "sourceUploaded", "nextAction", "recoveryUrl",
        ) if key in details}
    return _recovery_required_output(managed_id=details.get("managedAppId"))


def _run_validate(origin_parts: tuple[str, str, str, int | None], candidate: dict[str, Any]) -> int:
    try:
        status, raw = _request(
            origin_parts, "POST", "/api/managed-publications/validate",
            {"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
            json.dumps(candidate, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
    except CliError:
        _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                     "diagnostics": [_fallback_diagnostic("PORTAL_UNAVAILABLE", "managed.cli.portal")]})
        return 2
    if status == 200:
        try:
            response = _json_response(raw)
        except CliError:
            response = {}
        file_count = response.get("fileCount")
        total_bytes = response.get("totalBytes")
        if (
            response.get("status") == "validated" and response.get("published") is False
            and response.get("sourceUploaded") is False
            and isinstance(file_count, int) and not isinstance(file_count, bool) and 0 <= file_count <= MAX_FILES
            and isinstance(total_bytes, int) and not isinstance(total_bytes, bool) and 0 <= total_bytes <= MAX_TOTAL_BYTES
        ):
            _print_json({"status": "validated", "published": False, "sourceUploaded": False,
                         "fileCount": file_count, "totalBytes": total_bytes})
            return 0
        _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                     "diagnostics": [_fallback_diagnostic()]})
        return 2
    if status == 400:
        _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                     "diagnostics": _sanitize_server_diagnostics(raw)})
        return 2
    _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                 "diagnostics": [_fallback_diagnostic("PORTAL_REJECTED", "managed.cli.portal")]})
    return 2


def _run_receipt_mode(args: argparse.Namespace, project_root: Path, origin: str,
                      origin_parts: tuple[str, str, str, int | None], *, recover: bool) -> int:
    app_key = _read_app_key(project_root)
    store = ReceiptStore(Path(args.state_dir) if args.state_dir else _default_state_dir(), project_root)
    receipt = store.open(origin, project_root, app_key, readonly=True)
    if receipt is None:
        if recover:
            _print_json(_recovery_required_output(code="LOCAL_RECEIPT_NOT_FOUND"))
            return 1
        _print_json({"status": "receipt_not_found", "handoffState": "not_started", "publicationStatus": "unknown",
                     "sourceUploaded": False})
        return 0
    if not recover:
        _print_json(_receipt_status_output(receipt, origin))
        return 0

    try:
        publish_key = receipt.get("publishKey")
        idempotency_key = _valid_uuid(receipt.get("idempotencyKey"), "receipt Idempotency-Key")
        expected_managed = None
        if receipt.get("managedAppId") is not None:
            expected_managed = _valid_uuid(receipt.get("managedAppId"), "receipt managedAppId")
        if not isinstance(publish_key, str) or len(publish_key) < 20:
            raise CliError("本机 receipt 缺少恢复凭据。")
    except CliError:
        _print_json(_recovery_required_output())
        return 1
    _discard_saved_recovery_capability(store, receipt)
    try:
        status, raw = _request(
            origin_parts, "GET", "/api/managed-publications/receipt",
            {"Accept": "application/json", "Idempotency-Key": idempotency_key,
             "X-Plaza-Publish-Key": publish_key},
        )
    except CliError:
        _print_json(_recovery_required_output(managed_id=receipt.get("managedAppId")
                                              if isinstance(receipt.get("managedAppId"), str) else None))
        return 1
    if status == 404 and _response_error_code(raw) == "MANAGED_OPERATION_NOT_FOUND":
        _print_json(_recovery_required_output(code="MANAGED_OPERATION_NOT_FOUND"))
        return 1
    if status < 200 or status >= 300:
        _print_json(_recovery_required_output())
        return 1
    try:
        response = _json_response(raw)
    except CliError:
        _print_json(_recovery_required_output())
        return 1

    if expected_managed and response.get("managedAppId") is not None:
        try:
            returned_managed = _valid_uuid(response.get("managedAppId"), "managedAppId")
        except CliError:
            returned_managed = None
        if returned_managed != expected_managed:
            _print_json(_recovery_required_output(managed_id=expected_managed
                                                  if isinstance(expected_managed, str) else None))
            return 1

    if response.get("status") == "recovery_required":
        managed_id = None
        try:
            managed_id = _valid_uuid(response.get("managedAppId"), "managedAppId")
        except CliError:
            pass
        if managed_id and receipt.get("managedAppId") and managed_id != receipt.get("managedAppId"):
            managed_id = None
        operation_status = _safe_operation_status(response.get("operationStatus"))
        source_uploaded = response.get("sourceUploaded")
        if not isinstance(source_uploaded, bool):
            source_uploaded = None
        retry_original = bool(
            response.get("recoveryRequired") is True
            and response.get("nextAction") == "retry_original"
            and managed_id
            and operation_status
        )
        next_action = "retry_original" if retry_original else None
        receipt["managedAppId"] = managed_id or receipt.get("managedAppId")
        receipt["handoffState"] = "recovery_required"
        receipt["handoffComplete"] = False
        receipt["handoffRecoveryRequired"] = True
        receipt["publicationStatus"] = "unknown"
        receipt.pop("nextAction", None)
        receipt.pop("operationStatus", None)
        receipt.pop("verifiedRecoveryAction", None)
        receipt.pop("recoveryResponseStatus", None)
        if operation_status:
            receipt["operationStatus"] = operation_status
        if next_action:
            receipt["nextAction"] = next_action
            receipt["verifiedRecoveryAction"] = next_action
            receipt["recoveryResponseStatus"] = "recovery_required"
        if source_uploaded is not None:
            receipt["sourceUploaded"] = source_uploaded
        else:
            receipt.pop("sourceUploaded", None)
        receipt.pop("previewUrl", None)
        receipt.pop("publicationTicket", None)
        _clear_saved_recovery_capability(receipt)
        try:
            store.save(receipt)
        except CliError:
            pass
        _print_json(_recovery_required_output(managed_id=managed_id or receipt.get("managedAppId"),
                                             operation_status=operation_status if retry_original else None,
                                             next_action=next_action, source_uploaded=source_uploaded))
        return 1

    details, complete = _publication_handoff(response, origin)
    if expected_managed and details.get("managedAppId") != expected_managed:
        _print_json(_recovery_required_output(managed_id=expected_managed
                                              if isinstance(expected_managed, str) else None))
        return 1
    try:
        _store_publication_result(store, receipt, details, complete)
    except CliError:
        _print_json(_recovery_required_output(managed_id=details.get("managedAppId")))
        return 1
    _print_json(_publish_output(details, complete))
    if details.get("status") == "failed":
        print("源文件已上传，广场收录失败；请按返回状态处理，不能视为发布成功。", file=sys.stderr)
    registered_recovery_complete = (
        details.get("status") == "registered"
        and details.get("handoffState") == "registered"
        and details.get("sourceUploaded") is True
        and isinstance(details.get("managedAppId"), str)
        and isinstance(details.get("publicationId"), str)
    )
    return 0 if complete or registered_recovery_complete else 1


def _run(args: argparse.Namespace) -> int:
    validation_mode = bool(args.validate or args.dry_run)
    try:
        if args.managed_app_id and (args.validate or args.dry_run or args.status or args.recover):
            raise CliError("--managed-app-id 仅用于正式发布模式。")
        origin, scheme, host, port = _normalize_origin(args.origin)
        origin_parts = (origin, scheme, host, port)
        project_input = Path(args.project).expanduser()
        if not project_input.is_absolute():
            raise CliError("--project 必须是绝对路径。")
        project_root = _resolve_project_root(project_input)

        if args.status or args.recover:
            return _run_receipt_mode(args, project_root, origin, origin_parts, recover=bool(args.recover))

        manifest, files, digest, file_count, total_bytes, skipped_paths = _collect(project_root)
        app_key = manifest["appKey"]
        if skipped_paths:
            if args.validate:
                print("已跳过非必要文件，请检查发布范围。", file=sys.stderr)
            elif not args.dry_run:
                displayed = skipped_paths[:20]
                extra = len(skipped_paths) - len(displayed)
                summary = "、".join(displayed)
                if extra:
                    summary += f" 等 {len(skipped_paths)} 个路径（另有 {extra} 个未显示）"
                print(f"已排除非必要文件，请让 AI 检查发布范围后再决定是否发布：{summary}", file=sys.stderr)
        if args.dry_run:
            _print_json({"dryRun": True, "appKey": app_key, "fileCount": file_count,
                         "totalBytes": total_bytes, "digest": digest})
            return 0
        if args.validate:
            return _run_validate(origin_parts, {"appKey": app_key, "manifestPath": MANIFEST_NAME, "files": files})

        store = ReceiptStore(Path(args.state_dir) if args.state_dir else _default_state_dir(), project_root)
        receipt = store.open(origin, project_root, app_key)
        if args.managed_app_id:
            supplied = _valid_uuid(args.managed_app_id, "--managed-app-id")
            saved = receipt.get("managedAppId") if receipt else None
            if not isinstance(saved, str) or saved.lower() != supplied:
                raise CliError("--managed-app-id 与本机项目 receipt 不匹配；不会创建或冒名更新应用。")
        if receipt is None:
            receipt = {
                "identity": {"origin": origin, "projectRoot": str(project_root), "appKey": app_key},
                "publishKey": secrets.token_urlsafe(32),
                "managedAppId": None,
                "catalogAppId": None,
                "catalogRevision": None,
                "publicationRevision": None,
                "refreshRevisionAfterRejection": False,
            }
        old_digest = receipt.get("bundleDigest")
        response_known = receipt.get("responseKnown") is True
        refresh_revision = receipt.get("refreshRevisionAfterRejection") is True
        known_request_rejection = receipt.get("knownRequestRejection") is True
        changed_bundle = bool(old_digest and old_digest != digest)
        retry_original_authorized = bool(receipt and _can_retry_original(receipt))
        submit_again_authorized = bool(receipt and _can_submit_again(receipt, changed_bundle=changed_bundle))
        deferred_update = bool(
            old_digest and old_digest != digest and (not response_known or retry_original_authorized)
        )
        known_completed_handoff = receipt.get("handoffState") in {"complete", "registered"}
        if (
            receipt.get("handoffRecoveryRequired") is True
            and not retry_original_authorized
            and not submit_again_authorized
        ):
            _print_json(_recovery_required_output(managed_id=receipt.get("managedAppId")
                                                  if isinstance(receipt.get("managedAppId"), str) else None))
            return 1
        if (
            changed_bundle and response_known and not refresh_revision and not known_request_rejection
            and not known_completed_handoff and not retry_original_authorized and not submit_again_authorized
        ):
            _print_json(_recovery_required_output(managed_id=receipt.get("managedAppId")
                                                  if isinstance(receipt.get("managedAppId"), str) else None))
            return 1
        if old_digest is None:
            receipt["idempotencyKey"] = str(uuid.uuid4())
            receipt["bundleDigest"] = digest
            receipt["files"] = files
            receipt["responseKnown"] = False
            receipt.pop("knownRequestRejection", None)
            receipt["refreshRevisionAfterRejection"] = False
            receipt["requestManagedAppId"] = None
            receipt["requestExpectedAppRevision"] = None
            receipt["handoffState"] = "pending"
            receipt["handoffComplete"] = False
        elif retry_original_authorized:
            # Replay the saved body, owner, idempotency key, managed ID, and revision.
            # The current source tree is deliberately ignored until this request resolves.
            pass
        elif refresh_revision or (changed_bundle and (known_request_rejection or known_completed_handoff or submit_again_authorized)):
            receipt["idempotencyKey"] = str(uuid.uuid4())
            receipt["bundleDigest"] = digest
            receipt["files"] = files
            receipt["responseKnown"] = False
            receipt.pop("knownRequestRejection", None)
            receipt["refreshRevisionAfterRejection"] = False
            receipt["requestManagedAppId"] = receipt.get("managedAppId")
            receipt["requestExpectedAppRevision"] = None
            receipt["handoffState"] = "pending"
            receipt["handoffComplete"] = False
            receipt.pop("handoffRecoveryRequired", None)
            receipt.pop("previewUrl", None)
            receipt.pop("publicationTicket", None)
        elif not receipt.get("idempotencyKey") or not isinstance(receipt.get("files"), list):
            raise CliError("本机 receipt 缺少重试标识或原始资料；不会重新创建发布请求。")
        elif old_digest == digest and receipt.get("files") != files:
            raise CliError("本机 receipt 的资料与内容摘要不一致；不会重用幂等键。")
        idempotency_key = _valid_uuid(receipt.get("idempotencyKey"), "receipt Idempotency-Key")
        retry_files = _decode_receipt_files(receipt)
        managed_id = receipt.get("managedAppId")
        if managed_id is not None:
            managed_id = _valid_uuid(managed_id, "receipt managedAppId")
        request_managed_id = receipt.get("requestManagedAppId")
        if request_managed_id is not None:
            request_managed_id = _valid_uuid(request_managed_id, "receipt request managedAppId")
        receipt["identity"] = {"origin": origin, "projectRoot": str(project_root), "appKey": app_key}
        # Starting or retrying a POST makes its outcome unknown until the response is
        # durably recorded. A prior rejection cannot authorize a later changed bundle
        # if this retry loses its response.
        receipt["responseKnown"] = False
        receipt.pop("knownRequestRejection", None)
        receipt.pop("verifiedRecoveryAction", None)
        receipt.pop("recoveryResponseStatus", None)
        receipt.pop("nextAction", None)
        receipt.pop("operationStatus", None)
        receipt.pop("handoffRecoveryRequired", None)
        receipt["handoffState"] = "pending"
        receipt["handoffComplete"] = False
        receipt["publicationStatus"] = "unknown"
        receipt.pop("sourceUploaded", None)
        receipt.pop("previewUrl", None)
        receipt.pop("publicationTicket", None)
        _clear_saved_recovery_capability(receipt)
        store.save(receipt)

        expected_revision: int | None = None
        request_revision = receipt.get("requestExpectedAppRevision")
        if request_managed_id and isinstance(request_revision, int) and not isinstance(request_revision, bool) and request_revision >= 0:
            expected_revision = request_revision
        elif request_managed_id:
            expected_revision = _get_revision(origin_parts, receipt, app_key, request_managed_id)
            receipt["requestExpectedAppRevision"] = expected_revision
            store.save(receipt)

        request_value: dict[str, Any] = {"appKey": app_key, "manifestPath": MANIFEST_NAME, "files": retry_files}
        if request_managed_id:
            request_value["managedAppId"] = request_managed_id
            request_value["expectedAppRevision"] = expected_revision
        request_body = json.dumps(request_value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        status, raw = _request(
            origin_parts, "POST", "/api/managed-publications",
            {"Content-Type": "application/json; charset=utf-8", "Accept": "application/json",
             "Idempotency-Key": idempotency_key, "X-Plaza-Publish-Key": receipt["publishKey"]}, request_body,
        )
        if status < 200 or status >= 300:
            error_code = _response_error_code(raw)
            if status == 400 and error_code in {"VALIDATION_FAILED", "INVALID_REQUEST"}:
                receipt["responseKnown"] = True
                receipt["knownRequestRejection"] = True
                store.save(receipt)
                _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                             "diagnostics": _sanitize_server_diagnostics(raw)})
                return 2
            if status == 409 and error_code in {"REVISION_CONFLICT", "VERSION_NOT_NEWER"}:
                receipt["responseKnown"] = True
                receipt["knownRequestRejection"] = True
                if error_code == "REVISION_CONFLICT":
                    receipt["refreshRevisionAfterRejection"] = True
                    receipt["requestExpectedAppRevision"] = None
                store.save(receipt)
            raise CliError(f"门户拒绝发布请求（HTTP {status}）；receipt 已保留，可安全重试。")

        try:
            response = _json_response(raw)
        except CliError:
            _print_json(_recovery_required_output(managed_id=managed_id))
            return 1
        details, complete = _publication_handoff(response, origin)
        if managed_id and details.get("managedAppId") != managed_id:
            _print_json(_recovery_required_output(managed_id=managed_id))
            return 1
        try:
            _store_publication_result(store, receipt, details, complete)
        except CliError:
            _print_json(_recovery_required_output(managed_id=details.get("managedAppId") or managed_id))
            return 1
        _print_json(_publish_output(details, complete))
        if details.get("status") == "failed":
            print("源文件已上传，广场收录失败；请按返回状态处理，不能视为发布成功。", file=sys.stderr)
        if not complete:
            return 1
        if deferred_update:
            print("已恢复上次未确认的同一资料包；当前项目内容有变化，尚未上传当前内容，请再次运行以提交更新。", file=sys.stderr)
            return 3
        return 0
    except CliError as error:
        if validation_mode:
            _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                         "diagnostics": [_local_diagnostic(error)]})
        elif args.status:
            _print_json({"status": "receipt_error", "handoffState": "recovery_required",
                         "publicationStatus": "unknown"})
        elif args.recover:
            _print_json(_recovery_required_output())
        else:
            print(str(error), file=sys.stderr)
        return 2
    except OSError:
        if validation_mode:
            _print_json({"status": "validation_failed", "published": False, "sourceUploaded": False,
                         "diagnostics": [_fallback_diagnostic("LOCAL_READ_FAILED", "managed.cli.local_read")]})
        elif args.status:
            _print_json({"status": "receipt_error", "handoffState": "recovery_required",
                         "publicationStatus": "unknown"})
        elif args.recover:
            _print_json(_recovery_required_output())
        else:
            print("本地文件或私有 receipt 操作失败；未输出凭据。", file=sys.stderr)
        return 2


def _valid_uuid(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise CliError(f"{label} 必须是 UUID。")
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise CliError(f"{label} 必须是 UUID。") from None


def main() -> int:
    parser = argparse.ArgumentParser(description="安全地把本地 AI 应用资料上传到 AI 应用广场。")
    parser.add_argument("--origin", required=True, help="门户根地址，例如 https://plaza.example")
    parser.add_argument("--project", required=True, help="AI 应用项目的绝对路径")
    parser.add_argument("--managed-app-id", help="只允许更新与本机 receipt 匹配的应用 UUID")
    parser.add_argument("--state-dir", help=argparse.SUPPRESS)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="只检查资料并输出数量摘要，不访问门户")
    modes.add_argument("--validate", action="store_true", help="本地检查并向门户预检，不创建或修改发布回执")
    modes.add_argument("--status", action="store_true", help="只读查看本机发布回执，不访问门户或采集源码")
    modes.add_argument("--recover", action="store_true", help="仅用原回执向门户读取发布结果，不重传源码")
    return _run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
