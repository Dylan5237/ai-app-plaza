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
    rb"(?i)(?<![A-Za-z0-9_])(?P<key_quote>[\"']?)"
    rb"(?:x-plaza-publish-key|publish[-_]?key|access[-_]?token|api[-_]?key|secret[-_]?key|client[-_]?secret|password)"
    rb"(?P=key_quote)?\s*[:=]\s*(?P<quote>[\"'`]?)\s*(?P<value>[A-Za-z0-9_./+=-]{20,})(?P=quote)?"
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


class CliError(Exception):
    pass


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
    pending_block = False
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
            pending_control_paren = not is_property and token in JS_CONTROL_PAREN_KEYWORDS
            pending_block = not is_property and token in JS_BLOCK_KEYWORDS
            expect_expression = not is_property and token in JS_REGEX_PREFIX_KEYWORDS
            last_code_char = raw[index - 1]
            continue
        if 0x30 <= current <= 0x39:
            mask[index] = 1
            expect_expression = False
            last_code_char = current
            index += 1
            continue
        mask[index] = 1
        if current == 0x28:
            paren_stack.append(pending_control_paren)
            pending_control_paren = False
            expect_expression = True
        elif current == 0x29:
            expect_expression = paren_stack.pop() if paren_stack else False
            pending_control_paren = False
            pending_block = expect_expression
        elif current == 0x7B:
            is_block = pending_block or not expect_expression or last_code_char in (0, 0x3B, 0x7B)
            brace_stack.append(is_block)
            expect_expression = True
            pending_block = False
            pending_control_paren = False
        elif current == 0x7D:
            is_block = brace_stack.pop() if brace_stack else False
            expect_expression = is_block
            pending_block = False
            pending_control_paren = False
        elif current == 0x5D:
            expect_expression = False
            pending_control_paren = False
            pending_block = False
        elif current in b"[,:;?=+-*%&|^!~<>":
            expect_expression = True
            pending_control_paren = False
            pending_block = current == 0x3E and last_code_char == 0x3D
        elif current == 0x2F:
            expect_expression = True
            pending_control_paren = False
            pending_block = False
        else:
            expect_expression = False
            pending_control_paren = False
            pending_block = False
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


def _looks_secret(raw: bytes, path: str) -> bool:
    if any(pattern.search(raw) for pattern in SECRET_PATTERNS):
        return True
    suffix = PurePosixPath(path).suffix.casefold()
    is_js_source = suffix in JS_SOURCE_SUFFIXES
    code_mask = None
    for match in SECRET_ASSIGNMENT_PATTERN.finditer(raw):
        value = match.group("value")
        is_reference_candidate = (
            is_js_source
            and not match.group("quote")
            and JS_MEMBER_REFERENCE_RE.fullmatch(value)
        )
        if not is_reference_candidate:
            return True
        if code_mask is None:
            code_mask = bytearray(len(raw))
            if suffix == ".vue":
                for start, end in _vue_script_ranges(raw):
                    code_mask[start:end] = _js_code_mask(raw[start:end])
            else:
                code_mask = _js_code_mask(raw)
        if (
            not code_mask[match.start("value")]
            or not _js_reference_ends_expression(raw, match.end("value"))
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
    if parsed.path not in ("", "/") or parsed.params or parsed.query or parsed.fragment:
        raise CliError("--origin 只能填写门户根地址，不含路径、查询参数或片段。")
    host = parsed.hostname.casefold()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    normalized = f"{parsed.scheme}://{netloc}"
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

    def open(self, origin: str, project_root: Path, app_key: str) -> dict[str, Any] | None:
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            info = self.directory.lstat()
            if _is_reparse_or_link(self.directory, info) or not stat.S_ISDIR(info.st_mode):
                raise CliError("receipt 目录不能是符号链接或 junction。")
            if os.name != "nt":
                os.chmod(self.directory, 0o700)
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
            if os.name != "nt":
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
    _, scheme, host, port = origin_parts
    connection: http.client.HTTPConnection
    try:
        if scheme == "https":
            connection = http.client.HTTPSConnection(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS)
        else:
            connection = http.client.HTTPConnection(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS)
        try:
            connection.request(method, path, body=body, headers=headers)
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


def _is_author_preview_url(value: str, origin: str) -> bool:
    try:
        parsed = urlparse(value)
        if (
            parsed.username or parsed.password or not parsed.scheme or not parsed.netloc
            or parsed.path not in ("", "/") or parsed.params or parsed.query or not parsed.fragment
        ):
            return False
        preview_origin, _, _, _ = _normalize_origin(f"{parsed.scheme}://{parsed.netloc}")
        if preview_origin != origin:
            return False
        fragment = parse_qs(parsed.fragment, strict_parsing=True, keep_blank_values=True, max_num_fields=2)
        if set(fragment) != {"publish", "key"}:
            return False
        if len(fragment["publish"]) != 1 or len(fragment["key"]) != 1:
            return False
        publication_id = fragment["publish"][0]
        ticket = fragment["key"][0]
        return bool(UUID_RE.fullmatch(publication_id) and PREVIEW_TICKET_RE.fullmatch(ticket))
    except (CliError, ValueError):
        return False


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


def _run(args: argparse.Namespace) -> int:
    try:
        project_input = Path(args.project).expanduser()
        if not project_input.is_absolute():
            raise CliError("--project 必须是绝对路径。")
        project_root = _resolve_project_root(project_input)
        manifest, files, digest, file_count, total_bytes, skipped_paths = _collect(project_root)
        app_key = manifest["appKey"]
        if skipped_paths:
            displayed = skipped_paths[:20]
            extra = len(skipped_paths) - len(displayed)
            summary = "、".join(displayed)
            if extra:
                summary += f" 等 {len(skipped_paths)} 个路径（另有 {extra} 个未显示）"
            print(f"已排除非必要文件，请让 AI 检查发布范围后再决定是否发布：{summary}", file=sys.stderr)
        if args.dry_run:
            print(json.dumps({"dryRun": True, "appKey": app_key, "fileCount": file_count,
                              "totalBytes": total_bytes, "digest": digest}, ensure_ascii=False))
            return 0

        origin, scheme, host, port = _normalize_origin(args.origin)
        origin_parts = (origin, scheme, host, port)
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
        deferred_update = bool(old_digest and old_digest != digest and not response_known)
        if old_digest is None:
            receipt["idempotencyKey"] = str(uuid.uuid4())
            receipt["bundleDigest"] = digest
            receipt["files"] = files
            receipt["responseKnown"] = False
            receipt["refreshRevisionAfterRejection"] = False
            receipt["requestManagedAppId"] = None
            receipt["requestExpectedAppRevision"] = None
        elif refresh_revision or (old_digest != digest and response_known):
            receipt["idempotencyKey"] = str(uuid.uuid4())
            receipt["bundleDigest"] = digest
            receipt["files"] = files
            receipt["responseKnown"] = False
            receipt["refreshRevisionAfterRejection"] = False
            receipt["requestManagedAppId"] = receipt.get("managedAppId")
            receipt["requestExpectedAppRevision"] = None
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
        # Persist the key, idempotency ID, digest, and complete retry bundle before any request.
        store.save(receipt)

        expected_revision: int | None = None
        request_revision = receipt.get("requestExpectedAppRevision")
        if request_managed_id and isinstance(request_revision, int) and not isinstance(request_revision, bool) and request_revision >= 0:
            expected_revision = request_revision
        elif request_managed_id:
            expected_revision = _get_revision(origin_parts, receipt, app_key, request_managed_id)
            receipt["requestExpectedAppRevision"] = expected_revision
            store.save(receipt)

        request_value: dict[str, Any] = {
            "appKey": app_key,
            "manifestPath": MANIFEST_NAME,
            "files": retry_files,
        }
        if request_managed_id:
            request_value["managedAppId"] = request_managed_id
            request_value["expectedAppRevision"] = expected_revision
        request_body = json.dumps(request_value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        status, raw = _request(
            origin_parts, "POST", "/api/managed-publications",
            {
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "application/json",
                "Idempotency-Key": idempotency_key,
                "X-Plaza-Publish-Key": receipt["publishKey"],
            },
            request_body,
        )
        if status < 200 or status >= 300:
            error_code = _response_error_code(raw)
            if status == 400 and error_code in {"VALIDATION_FAILED", "INVALID_REQUEST"}:
                # These codes are returned before an operation can write to GitLab.
                receipt["responseKnown"] = True
                store.save(receipt)
            elif status == 409 and error_code in {"REVISION_CONFLICT", "VERSION_NOT_NEWER"}:
                # Managed revision checks happen before GitLab source writes. A revision
                # conflict must get a fresh operation ID and owner-authenticated status.
                receipt["responseKnown"] = True
                if error_code == "REVISION_CONFLICT":
                    receipt["refreshRevisionAfterRejection"] = True
                    receipt["requestExpectedAppRevision"] = None
                store.save(receipt)
            raise CliError(f"门户拒绝发布请求（HTTP {status}）；receipt 已保留，可安全重试。")
        response = _json_response(raw)
        returned_managed = response.get("managedAppId")
        if returned_managed is None:
            returned_managed = managed_id
        if not isinstance(returned_managed, str):
            raise CliError("门户响应缺少 managedAppId；receipt 已保留，可使用相同项目内容重试。")
        returned_managed = _valid_uuid(returned_managed, "门户 managedAppId")
        if managed_id and returned_managed != managed_id:
            raise CliError("门户返回的 managedAppId 与本机 receipt 不一致；receipt 已保留。")
        revision = response.get("revision")
        if isinstance(revision, int) and not isinstance(revision, bool) and revision >= 0:
            receipt["publicationRevision"] = revision
        receipt["managedAppId"] = returned_managed
        receipt["responseKnown"] = True
        store.save(receipt)

        status_value = response.get("status")
        if not isinstance(status_value, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", status_value):
            status_value = "unknown"
        result: dict[str, Any] = {
            "status": status_value,
            "sourceUploaded": response.get("sourceUploaded") is True,
            "managedAppId": returned_managed,
        }
        preview_url = response.get("previewUrl")
        if isinstance(preview_url, str) and preview_url and _is_author_preview_url(preview_url, origin):
            result["previewUrl"] = preview_url
        elif preview_url:
            print("门户返回了无效预览链接，已隐藏；请从门户内查看作者预览。", file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False))
        if status_value.casefold() == "failed":
            print("源文件已上传，广场收录失败；请按返回状态处理，不能视为发布成功。", file=sys.stderr)
            return 1
        if result["sourceUploaded"] is not True:
            print("门户未确认源码上传完成；receipt 已保留。", file=sys.stderr)
            return 1
        if deferred_update:
            print("已恢复上次未确认的同一资料包；当前项目内容有变化，尚未上传当前内容，请再次运行以提交更新。", file=sys.stderr)
            return 3
        return 0
    except CliError as error:
        print(str(error), file=sys.stderr)
        return 2
    except OSError:
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
    parser.add_argument("--dry-run", action="store_true", help="只检查资料并输出数量摘要，不访问门户")
    return _run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
