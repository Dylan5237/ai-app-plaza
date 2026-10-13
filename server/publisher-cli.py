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
    re.compile(rb"(?i)\b(?:x-plaza-publish-key|publish[-_]?key|access[-_]?token|api[-_]?key|secret[-_]?key|client[-_]?secret|password)\s*[:=]\s*[\"']?[A-Za-z0-9_./+=-]{20,}"),
    re.compile(rb"\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b"),
]
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


def _looks_secret(raw: bytes) -> bool:
    return any(pattern.search(raw) for pattern in SECRET_PATTERNS)


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
        if _looks_secret(raw):
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
            }
        old_digest = receipt.get("bundleDigest")
        response_known = receipt.get("responseKnown") is True
        deferred_update = bool(old_digest and old_digest != digest and not response_known)
        if old_digest is None:
            receipt["idempotencyKey"] = str(uuid.uuid4())
            receipt["bundleDigest"] = digest
            receipt["files"] = files
            receipt["responseKnown"] = False
            receipt["requestManagedAppId"] = None
            receipt["requestExpectedAppRevision"] = None
        elif old_digest != digest and response_known:
            receipt["idempotencyKey"] = str(uuid.uuid4())
            receipt["bundleDigest"] = digest
            receipt["files"] = files
            receipt["responseKnown"] = False
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
