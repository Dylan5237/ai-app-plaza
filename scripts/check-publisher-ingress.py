#!/usr/bin/env python3
"""Run the repository's publisher in preflight mode with a synthetic Skill."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


REPO = Path(__file__).resolve().parents[1]
SAMPLE_BYTES = 84_749


def write_skill(root: Path) -> int:
    manifest = json.loads((REPO / "docs/architecture/examples/agent-app.json").read_text(encoding="utf-8"))
    notes = [f"examples/note-{i:02d}.txt" for i in range(11)]
    distribution = ["SKILL.md", "README.md", "docs/install.md", *notes]
    manifest.update(
        appKey="publisher-ingress-check", name="广场预检合成 Skill", tags=[],
        docs={"readme": "README.md", "usage": "docs/install.md"}, primaryEntry="skill",
        entries=[{"id": "skill", "kind": "agent", "label": "合成技能", "instructionsPath": "docs/install.md",
                  "compatibility": ["WorkBuddy"], "distribution": {"type": "source", "files": distribution}}],
    )
    files = {
        "ai-app.json": json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
        "SKILL.md": b"---\nname: publisher-ingress-check\ndescription: A synthetic preflight fixture.\n---\nRead the sample notes.\n",
        "README.md": b"# Synthetic Skill\nFor the Plaza read-only preflight.\n",
        "docs/install.md": b"Extract the Plaza distribution package and inspect SKILL.md.\n",
    }
    # Use a realistic request that must pass through ingress request-body buffering.
    remaining = SAMPLE_BYTES - sum(len(files[name]) for name in distribution if name in files)
    size, extra = divmod(remaining, len(notes))
    for index, name in enumerate(notes):
        files[name] = b"Example note.\n".ljust(size + int(index < extra), b" ")
    for name, data in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return sum(map(len, files.values()))


def main() -> int:
    parser = argparse.ArgumentParser(description="用合成 Skill 验证广场入口，只执行一次官方 --validate。")
    parser.add_argument("--origin", required=True, help="完整门户入口，保留 /plaza 等部署前缀")
    parser.add_argument("--ca-file", type=Path, help="可信 PEM 证书文件，用于校验门户 HTTPS")
    args = parser.parse_args()
    env = {**os.environ, "PYTHONUTF8": "1"}
    if args.ca_file:
        if not args.ca_file.is_file():
            parser.error("找不到指定的 CA 文件")
        env["SSL_CERT_FILE"] = str(args.ca_file.resolve())
    with tempfile.TemporaryDirectory(prefix="plaza-ingress-") as directory:
        root = Path(directory, "skill")
        total_bytes = write_skill(root)
        run = subprocess.run([sys.executable, str(REPO / "server/publisher-cli.py"), "--origin", args.origin,
                              "--project", str(root), "--validate"], env=env, capture_output=True, encoding="utf-8")
    result = json.loads(run.stdout)
    print(json.dumps(result, ensure_ascii=False))
    if run.returncode:
        return run.returncode
    if (result.get("status") != "validated" or result.get("published") is not False
            or result.get("sourceUploaded") is not False or result.get("totalBytes") != total_bytes
            or result.get("fileCount") != 15):
        print("预检回包与合成 Skill 的文件数或大小不符。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
