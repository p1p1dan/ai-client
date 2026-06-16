#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vflow hook injection script.

Usage (registered in .claude/settings.json, cwd = project root):
  python .vflow/scripts/inject.py prompt    # UserPromptSubmit: inject current state breadcrumb
  python .vflow/scripts/inject.py session   # SessionStart: inject project context + spec index
Output to stdout is added to conversation context. Errors exit silently.
"""
import json
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .vflow/
POINTER = os.path.join(ROOT, ".runtime", "current-task")
WORKFLOW = os.path.join(ROOT, "workflow.md")
SPEC_INDEX = os.path.join(ROOT, "spec", "index.md")
CONFIG = os.path.join(ROOT, "config.json")

PIPELINE = ["created", "analyzed", "designed", "implementing", "verified", "archived"]

# Legacy status/phase tasks map onto v2 states so old archives keep working.
LEGACY_MAP = {"planning": "analyzed", "in_progress": "implementing"}

SKIP_DETECTION_SUMMARY = """Skip Detection Rule: ONLY these exact user phrases constitute a skip signal:
  "skip" | "直接做" | "跳过" | "不用规划" | "不走流程"
Implementation strategy phrases (e.g. "use goal mode", "fix file by file") are NOT skip signals."""

SUGGEST_ENABLE = """<vflow-auto-init>
vflow 已安装但尚未进行项目配置探测（config.json 为模板默认值）。
收到用户第一条消息时，先自动执行 /vflow:init 技能扫描项目并生成配置，然后再处理用户的消息。
无需用 AskUserQuestion 询问——用户已通过 vflow init 表达了启用意愿，直接走探测流程即可。
探测流程的阶段 C 会展示结果让用户确认，这是唯一需要用户干预的步骤。
如果用户明确表示跳过探测（如"跳过"、"不用了"），则用 python 将 .vflow/config.json 中 enabled 设为 true，然后正常处理用户消息。
</vflow-auto-init>"""


def get_enabled(cfg):
    if "enabled" in cfg:
        return cfg["enabled"]
    return True


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def task_state(t):
    if "state" in t:
        return t["state"]
    return LEGACY_MAP.get(t.get("status", ""), "no_task")


def current_state():
    """Return (state, task, task_dir). state falls back to no_task."""
    name = read(POINTER).strip()
    if not name:
        return "no_task", None, None
    task_dir = os.path.join(ROOT, "tasks", name)
    try:
        t = json.loads(read(os.path.join(task_dir, "task.json")))
        state = task_state(t)
        if state in ("archived", "no_task") or t.get("status") == "completed":
            return "no_task", None, None
        return state, t, task_dir
    except Exception:
        return "no_task", None, None


def state_block(state):
    text = read(WORKFLOW)
    m = re.search(r"\[workflow-state:%s\](.*?)\[/workflow-state:%s\]" % (state, state),
                  text, re.S)
    return m.group(1).strip() if m else ""


def design_path(task_dir):
    p = os.path.join(task_dir, "design.md")
    if os.path.exists(p):
        return p
    return os.path.join(task_dir, "plan.md")


def unchecked_items(task_dir):
    if not task_dir:
        return []
    dp = design_path(task_dir)
    if not os.path.exists(dp):
        return []
    items = []
    with open(dp, encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith("- [ ]"):
                items.append(line.strip()[6:].strip())
    return items


def spec_manifest(task_dir):
    """Parse design.md '关联规范' table and return list of (spec_file, reason)."""
    if not task_dir:
        return []
    dp = design_path(task_dir)
    if not os.path.exists(dp):
        return []
    text = read(dp)
    in_section = False
    in_table = False
    entries = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## 关联规范"):
            in_section = True
            continue
        if in_section and stripped.startswith("## "):
            break
        if in_section and stripped.startswith("| :"):
            in_table = True
            continue
        if in_section and in_table and stripped.startswith("|"):
            cols = [c.strip() for c in stripped.split("|")]
            cols = [c for c in cols if c]
            # skip placeholder rows and a stray header row, keep real spec/ paths
            if (len(cols) >= 1 and cols[0] and not cols[0].startswith("（")
                    and cols[0] not in ("spec 文件", "spec文件")):
                reason = cols[1] if len(cols) >= 2 else ""
                entries.append((cols[0], reason))
        elif in_section and in_table and not stripped.startswith("|"):
            break
    return entries


def load_spec_contents(entries):
    results = []
    for spec_file, reason in entries:
        rel = spec_file.strip().lstrip("/")
        if rel.startswith(".vflow/"):
            rel = rel[7:]
        if rel.startswith("spec/"):
            rel = rel[5:]
        spec_path = os.path.join(ROOT, "spec", rel)
        if not os.path.exists(spec_path):
            spec_path = os.path.join(ROOT, rel)
        if not os.path.exists(spec_path):
            continue
        content = read(spec_path)
        if content.strip():
            results.append((spec_file, reason, content))
    return results


def pipeline_line(state):
    return " -> ".join(("[%s]" % s) if s == state else s for s in PIPELINE)


def do_prompt():
    cfg = read_json(CONFIG, {})
    enabled = get_enabled(cfg)
    if enabled is not True:
        return
    state, task, task_dir = current_state()
    block = state_block(state)
    if not block:
        return
    lines = ["<vflow-state>"]
    if task:
        lines.append("Active task: %s | %s | tier=%s risk=%s" % (
            task.get("id"), task.get("title"), task.get("tier"), task.get("risk")))
        lines.append("Pipeline: %s" % pipeline_line(state))
        if "state" not in task:
            lines.append("(legacy task: use legacy commands set phase/start/done)")

    lines.append(block)

    if state == "implementing" and task_dir:
        items = unchecked_items(task_dir)
        if items:
            lines.append("")
            lines.append("Remaining checklist (from design doc):")
            for item in items:
                lines.append("  - [ ] %s" % item)
            lines.append("If the user changes scope, update the checklist BEFORE implementing.")

    if task_dir and state in ("analyzed", "designed", "implementing"):
        entries = spec_manifest(task_dir)
        if entries:
            specs = load_spec_contents(entries)
            if specs:
                lines.append("")
                lines.append("--- Auto-loaded specs (from design doc spec manifest) ---")
                for spec_file, reason, content in specs:
                    lines.append("")
                    lines.append("[spec:%s] (reason: %s)" % (spec_file, reason))
                    lines.append(content.rstrip())
                    lines.append("[/spec:%s]" % spec_file)

    if cfg.get("execution_log"):
        lines.append("")
        lines.append("Execution logging is ON. Append to execution.log after each significant "
                      "action (key file reads, edits, writes, command runs, test/build results, "
                      "consequential decisions), and verify it before task completion.")

    lines.append("</vflow-state>")
    print("\n".join(lines))


def do_session():
    cfg = read_json(CONFIG, {})
    enabled = get_enabled(cfg)
    if enabled is None:
        print(SUGGEST_ENABLE)
        return
    if enabled is False:
        return
    feats = cfg.get("features") or {}
    on = [k for k, v in feats.items() if v]
    lines = [
        "<vflow-context>",
        "This project uses the vflow workflow (definition: .vflow/workflow.md).",
        "Project: %s | Language: %s | Features: %s | Test required: %s" % (
            cfg.get("project", "?"), cfg.get("language", "?"),
            ", ".join(map(str, on)) if on else "none",
            "yes" if cfg.get("test_required", True) else "no"),
    ]
    if cfg.get("execution_log"):
        lines.append("Execution logging: enabled")

    state, task, _ = current_state()
    if task:
        lines.append("Active task: %s (state=%s)" % (task.get("id"), state))
        lines.append("Pipeline: %s" % pipeline_line(state))
    else:
        lines.append("No active task.")

    lines.append("")
    lines.append(SKIP_DETECTION_SUMMARY)

    idx = read(SPEC_INDEX)
    if idx:
        lines.append("")
        lines.append("--- Spec index (read full spec files on demand, do not preload) ---")
        lines.append(idx)

    lines.append("</vflow-context>")
    print("\n".join(lines))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "prompt"
    try:
        if mode == "session":
            do_session()
        else:
            do_prompt()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
