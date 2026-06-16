#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vflow task state management (sole state writer).

v2 pipeline: created -> analyzed -> designed -> implementing -> verified -> archived
Every transition has mechanical exit-condition checks (R-ID trace chain,
checklist completion, machine-executed tests). Bypasses are recorded.

Usage:
  python .vflow/scripts/task.py create <slug> --title "title" [--tier T2]
  python .vflow/scripts/task.py advance [--skip-check]   # move to next state
  python .vflow/scripts/task.py back                     # verified -> implementing only
  python .vflow/scripts/task.py set risk {low|high}
  python .vflow/scripts/task.py done --summary "..." [--force]
  python .vflow/scripts/task.py status

Legacy tasks (status/phase fields, plan.md) are auto-mapped and archived
via the legacy validation path; they are not blocked.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .vflow/
TASKS = os.path.join(ROOT, "tasks")
RUNTIME = os.path.join(ROOT, ".runtime")
POINTER = os.path.join(RUNTIME, "current-task")
JOURNAL_DIR = os.path.join(ROOT, "journal")
CONFIG = os.path.join(ROOT, "config.json")

STATES = ["created", "analyzed", "designed", "implementing", "verified", "archived"]

TEST_OUTPUT_TAIL = 3000
TEST_TIMEOUT = 600

MACHINE_BLOCK_HEADER = "## 机器执行记录（task.py 写入，请勿手改）"


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def current_task_dir():
    if not os.path.exists(POINTER):
        return None
    with open(POINTER, encoding="utf-8") as f:
        name = f.read().strip()
    d = os.path.join(TASKS, name)
    return d if os.path.isdir(d) else None


def task_state(t):
    """Return v2 state, mapping legacy status/phase tasks."""
    if "state" in t:
        return t["state"]
    status = t.get("status", "")
    if status == "planning":
        return "analyzed"
    if status == "in_progress":
        return "implementing"
    if status == "completed":
        return "archived"
    return "created"


def is_legacy(t):
    return "state" not in t


def design_path(task_dir):
    """v2 tasks use design.md; legacy tasks used plan.md."""
    p = os.path.join(task_dir, "design.md")
    if os.path.exists(p):
        return p
    return os.path.join(task_dir, "plan.md")


# ---------------- R-ID trace chain (R3) ----------------

# Definition lines must have non-empty content after the colon — bare
# placeholders like "- R1:" (template residue) must not count as defined.
RID_DEF = re.compile(r"^\s*-\s*(R\d+)\s*[:：][ \t]*\S", re.M)
RID_REF = re.compile(r"[（(](R\d+(?:\s*[,，、]\s*R\d+)*)[)）]")


def parse_rid_definitions(text):
    """R-IDs defined in requirement.md / result entries in verify.md: lines '- R<n>: ...'"""
    return set(RID_DEF.findall(text))


def parse_rid_references(text):
    """R-IDs referenced in design checklist items: trailing '(R1)' or '(R1,R3)'."""
    rids = set()
    for line in text.splitlines():
        s = line.strip()
        if not (s.startswith("- [ ]") or s.startswith("- [x]") or s.startswith("- [X]")):
            continue
        for m in RID_REF.finditer(s):
            for rid in re.split(r"[,，、]", m.group(1)):
                rids.add(rid.strip())
    return rids


def check_rid_coverage(required, covered, doc_name):
    """Return (ok, messages). Missing R-IDs fail; extra ones only warn."""
    missing = sorted(required - covered, key=lambda r: int(r[1:]))
    extra = sorted(covered - required, key=lambda r: int(r[1:]))
    msgs = []
    for rid in missing:
        msgs.append("missing %s in %s" % (rid, doc_name))
    for rid in extra:
        msgs.append("warning: %s in %s is not defined in requirement.md" % (rid, doc_name))
    return (not missing, msgs)


def verify_section(text, section_no):
    """Extract a verify.md section body, e.g. section_no=1 matches '## §1 ...'."""
    pattern = re.compile(r"^##\s*§%d\b.*?$(.*?)(?=^##\s|\Z)" % section_no, re.M | re.S)
    m = pattern.search(text)
    return m.group(1) if m else ""


# ---------------- document checks ----------------

def is_filled(path):
    """Template-hash comparison with content-analysis fallback."""
    if not os.path.exists(path):
        return False
    content = read_text(path)
    if not content.strip():
        return False
    hash_file = path + ".hash"
    if os.path.exists(hash_file):
        original_hash = read_text(hash_file).strip()
        current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
        return current_hash != original_hash
    non_empty = [l for l in content.splitlines()
                 if l.strip()
                 and not l.strip().startswith("#")
                 and not l.strip().startswith("<!--")
                 and not l.strip().startswith("|")
                 and not l.strip().startswith("---")
                 and not l.strip().startswith(">")
                 and not l.strip().startswith("- [ ]")]
    meaningful = [l for l in non_empty if not re.match(r"^-\s*\S+：\s*$", l.strip())]
    return len(meaningful) >= 3


def unchecked_items(task_dir):
    text = read_text(design_path(task_dir))
    return [l.strip()[6:].strip() for l in text.splitlines()
            if l.strip().startswith("- [ ]")]


def worklog_files(task_dir):
    """Parse file paths from worklog.md table rows (| time | file | change |)."""
    text = read_text(os.path.join(task_dir, "worklog.md"))
    files = []
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|") or s.startswith("| :") or s.startswith("|:"):
            continue
        cols = [c.strip() for c in s.strip("|").split("|")]
        if len(cols) >= 2 and cols[1] and cols[1] not in ("File", "文件", "----"):
            files.append(cols[1].strip("`"))
    return files


def latest_worklog_mtime(task_dir, project_root):
    latest = 0.0
    for rel in worklog_files(task_dir):
        p = os.path.join(project_root, rel)
        if os.path.isfile(p):
            latest = max(latest, os.path.getmtime(p))
        else:
            # 路径写错/漏记会让 mtime 校验失明，必须可见
            print("  [vflow] warning: worklog file not found, mtime check skipped: %s" % rel)
    return latest


# ---------------- machine-executed verification (R4) ----------------

def run_verification(task_dir, cfg, task):
    """Execute test_command via subprocess; write machine block into verify.md.

    Returns (ok, message). The exit code comes from the OS — the AI cannot
    fabricate this result. Output is written by this script, not pasted by AI.
    """
    cmd = task.get("test_scope") or (cfg.get("build") or {}).get("test_command", "")
    test_required = cfg.get("test_required", True)
    if not cmd:
        if test_required:
            return (False, "config.build.test_command is empty but test_required=true. "
                           "Configure a test command (or set test_required=false) first.")
        return (True, "test_required=false and no test_command; verification skipped")

    try:
        # 已知边界：shell=True 超时在 Windows 下只杀 shell 进程，
        # 悬挂的测试 runner 孙进程可能残留，需人工清理
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           encoding="utf-8", errors="replace",
                           timeout=TEST_TIMEOUT, cwd=os.path.dirname(ROOT))
    except subprocess.TimeoutExpired:
        return (False, "test command timed out after %ds: %s" % (TEST_TIMEOUT, cmd))

    stamp = datetime.datetime.now().isoformat(timespec="seconds")
    output = ((r.stdout or "") + (r.stderr or ""))[-TEST_OUTPUT_TAIL:]
    block = "\n".join([
        "", MACHINE_BLOCK_HEADER,
        "- 命令: `%s`" % cmd,
        "- 时间: %s" % stamp,
        "- 退出码: %d" % r.returncode,
        "```", output.strip(), "```", "",
    ])
    vp = os.path.join(task_dir, "verify.md")
    with open(vp, "a", encoding="utf-8") as f:
        f.write(block)

    if r.returncode != 0:
        return (False, "test command failed (exit %d). Output appended to verify.md; "
                       "fix the failures and advance again." % r.returncode)
    task["verified_at"] = stamp
    return (True, "tests passed; machine record appended to verify.md")


# ---------------- transition checks ----------------

def check_analyzed(task_dir, cfg, task):
    """created -> analyzed: requirement.md filled and defines at least one R-ID."""
    req = os.path.join(task_dir, "requirement.md")
    errors = []
    if not is_filled(req):
        errors.append("requirement.md is not filled (still template or missing)")
    elif not parse_rid_definitions(read_text(req)):
        errors.append("requirement.md defines no R-ID entries (need lines like '- R1: ...')")
    return errors


def check_designed(task_dir, cfg, task):
    """analyzed -> designed: design.md filled, checklist R-IDs cover requirement."""
    dp = design_path(task_dir)
    errors = []
    if not is_filled(dp):
        errors.append("%s is not filled (still template or missing)" % os.path.basename(dp))
        return errors
    required = parse_rid_definitions(read_text(os.path.join(task_dir, "requirement.md")))
    covered = parse_rid_references(read_text(dp))
    ok, msgs = check_rid_coverage(required, covered, os.path.basename(dp))
    for m in msgs:
        if m.startswith("warning:"):
            print("  [vflow] %s" % m)
        else:
            errors.append(m + " (checklist items must carry trailing '(R<n>)' tags)")
    return errors


def check_implementing(task_dir, cfg, task):
    """designed -> implementing: no doc precondition (gate is human approval)."""
    return []


def check_verified(task_dir, cfg, task):
    """implementing -> verified: checklist complete + machine-executed tests pass."""
    errors = []
    items = unchecked_items(task_dir)
    if items:
        errors.append("%d unchecked items in %s:" % (len(items), os.path.basename(design_path(task_dir))))
        for item in items:
            errors.append("  - [ ] %s" % item)
        return errors
    ok, msg = run_verification(task_dir, cfg, task)
    print("  [vflow] %s" % msg)
    if not ok:
        errors.append(msg)
    return errors


def check_archived(task_dir, cfg, task):
    """verified -> archived: verify.md closes the R-ID loop; mtime cross-check."""
    errors = []
    vp = os.path.join(task_dir, "verify.md")
    if not is_filled(vp):
        errors.append("verify.md is not filled")
        return errors
    vtext = read_text(vp)
    required = parse_rid_definitions(read_text(os.path.join(task_dir, "requirement.md")))
    sec1 = verify_section(vtext, 1)
    if not sec1.strip():
        # 不回退全文扫描：机器记录/评审区里的 R-ID 行不能充当闭环证据
        errors.append("verify.md is missing section '## §1 ...' with per-R-ID results")
        return errors
    closed = parse_rid_definitions(sec1)
    ok, msgs = check_rid_coverage(required, closed, "verify.md")
    for m in msgs:
        if m.startswith("warning:"):
            print("  [vflow] %s" % m)
        else:
            errors.append(m + " (each R-ID needs a result entry '- R<n>: ...')")
    # mtime cross-check (R5): code must not change after machine verification
    verified_at = task.get("verified_at", "")
    if verified_at:
        # +1s tolerance: verified_at is truncated to whole seconds
        vts = datetime.datetime.fromisoformat(verified_at).timestamp() + 1.0
        latest = latest_worklog_mtime(task_dir, os.path.dirname(ROOT))
        if latest > vts:
            errors.append("source files changed after verification (%s). "
                          "Run 'task.py back' then 'task.py advance' to re-verify."
                          % datetime.datetime.fromtimestamp(latest).isoformat(timespec="seconds"))
    elif cfg.get("test_required", True):
        errors.append("no machine verification record (verified_at missing); "
                      "run 'task.py back' then 'task.py advance' to verify with tests")
    return errors


TRANSITION_CHECKS = {
    "analyzed": check_analyzed,
    "designed": check_designed,
    "implementing": check_implementing,
    "verified": check_verified,
    "archived": check_archived,
}


# ---------------- commands ----------------

def cmd_create(args):
    today = datetime.date.today()
    name = "%02d-%02d-%s" % (today.month, today.day, args.slug)
    d = os.path.join(TASKS, name)
    if os.path.exists(d):
        print("[vflow] Task already exists: %s" % name)
        return 1
    os.makedirs(d)
    write_json(os.path.join(d, "task.json"), {
        "id": name,
        "title": args.title or args.slug,
        "tier": args.tier,
        "state": "created",
        "risk": "unset",
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    tpl = os.path.join(ROOT, "templates")
    for f in ("requirement.md", "design.md", "verify.md"):
        src = os.path.join(tpl, f)
        if os.path.exists(src):
            dst = os.path.join(d, f)
            shutil.copy(src, dst)
            h = hashlib.sha256(read_text(dst).encode("utf-8")).hexdigest()[:16]
            with open(dst + ".hash", "w", encoding="utf-8") as fh:
                fh.write(h)
    cfg = read_json(CONFIG, {})
    if cfg.get("execution_log"):
        with open(os.path.join(d, "execution.log"), "w", encoding="utf-8") as f:
            f.write("")
    os.makedirs(RUNTIME, exist_ok=True)
    with open(POINTER, "w", encoding="utf-8") as f:
        f.write(name)
    print("[vflow] Created task %s (state=created)" % name)
    print("Pipeline: created -> analyzed -> designed -> implementing -> verified -> archived")
    return 0


def _record_bypass(task, transition):
    task.setdefault("bypasses", []).append({
        "transition": transition,
        "time": datetime.datetime.now().isoformat(timespec="seconds"),
    })


def cmd_advance(args):
    d = current_task_dir()
    if not d:
        print("[vflow] No active task")
        return 1
    p = os.path.join(d, "task.json")
    t = read_json(p)
    if is_legacy(t):
        print("[vflow] Legacy task (status/phase format). Use legacy commands "
              "(set phase / start / done); advance applies to v2 tasks only.")
        return 1
    state = task_state(t)
    if state == "archived":
        print("[vflow] Task already archived")
        return 1
    if state == "verified":
        print("[vflow] Next step is archival: run task.py done --summary \"...\"")
        return 1
    nxt = STATES[STATES.index(state) + 1]
    cfg = read_json(CONFIG, {})

    if args.skip_check:
        _record_bypass(t, "%s->%s" % (state, nxt))
        print("[vflow] Check skipped by user request (recorded in task.json bypasses)")
    else:
        errors = TRANSITION_CHECKS[nxt](d, cfg, t)
        if errors:
            print("[vflow] ERROR: Cannot advance %s -> %s:" % (state, nxt))
            for e in errors:
                print("  - %s" % e)
            print("Fix the above, or use --skip-check to bypass (recorded in task.json).")
            return 1

    t["state"] = nxt
    if nxt == "implementing":
        wl = os.path.join(d, "worklog.md")
        if not os.path.exists(wl):
            with open(wl, "w", encoding="utf-8") as f:
                f.write("# Implementation Log\n\n| Time | File | Change |\n| :--- | :--- | :--- |\n")
    write_json(p, t)
    print("[vflow] %s -> %s" % (state, nxt))
    return 0


def cmd_back(args):
    d = current_task_dir()
    if not d:
        print("[vflow] No active task")
        return 1
    p = os.path.join(d, "task.json")
    t = read_json(p)
    if task_state(t) != "verified":
        print("[vflow] back is only allowed from 'verified' (current: %s)" % task_state(t))
        return 1
    t["state"] = "implementing"
    t.pop("verified_at", None)
    t.setdefault("backs", []).append(datetime.datetime.now().isoformat(timespec="seconds"))
    write_json(p, t)
    print("[vflow] verified -> implementing (re-verify required before archive)")
    return 0


def cmd_set(args):
    d = current_task_dir()
    if not d:
        print("[vflow] No active task")
        return 1
    p = os.path.join(d, "task.json")
    t = read_json(p)
    allowed = ("risk", "phase", "test_scope") if is_legacy(t) else ("risk", "test_scope")
    if args.key not in allowed:
        print("[vflow] Only %s can be set" % "/".join(allowed))
        return 1
    if args.key == "risk" and args.value not in ("low", "high"):
        print("[vflow] risk must be 'low' or 'high'")
        return 1
    t[args.key] = args.value
    write_json(p, t)
    print("[vflow] %s = %s" % (args.key, args.value))
    return 0


# ---------------- legacy support (pre-v2 tasks) ----------------

def cmd_start(args):
    """Legacy: planning -> in_progress. v2 tasks should use advance."""
    d = current_task_dir()
    if not d:
        print("[vflow] No active task")
        return 1
    p = os.path.join(d, "task.json")
    t = read_json(p)
    if not is_legacy(t):
        print("[vflow] v2 task: use task.py advance instead of start")
        return 1
    if args.skip:
        t["planning_skipped"] = True
        print("[vflow] Planning skipped by user request (--skip)")
    else:
        errors = []
        if not is_filled(os.path.join(d, "requirement.md")):
            errors.append("requirement.md is not filled (still template or missing)")
        if not is_filled(design_path(d)):
            errors.append("plan/design doc is not filled (still template or missing)")
        if errors:
            print("[vflow] ERROR: Cannot start implementation. Planning docs incomplete:")
            for e in errors:
                print("  - %s" % e)
            return 1
    t["status"] = "in_progress"
    t["phase"] = "implement"
    write_json(p, t)
    tpl = os.path.join(ROOT, "templates")
    dst = os.path.join(d, "verify.md")
    src = os.path.join(tpl, "verify.md")
    if os.path.exists(src) and not os.path.exists(dst):
        shutil.copy(src, dst)
        h = hashlib.sha256(read_text(dst).encode("utf-8")).hexdigest()[:16]
        with open(dst + ".hash", "w", encoding="utf-8") as fh:
            fh.write(h)
    wl = os.path.join(d, "worklog.md")
    if not os.path.exists(wl):
        with open(wl, "w", encoding="utf-8") as f:
            f.write("# Implementation Log\n\n| Time | File | Change |\n| :--- | :--- | :--- |\n")
    print("[vflow] Task entered implementation phase (status=in_progress)")
    return 0


def git_head():
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def append_journal(task, summary):
    os.makedirs(JOURNAL_DIR, exist_ok=True)
    jp = os.path.join(JOURNAL_DIR, "journal-1.md")
    line = "- [%s] [%s] [%s] %s" % (
        datetime.date.today().isoformat(), task["title"], task.get("tier", "T2"), summary)
    commit = git_head()
    if commit:
        line += " (commit:%s)" % commit
    new = not os.path.exists(jp)
    with open(jp, "a", encoding="utf-8") as f:
        if new:
            f.write("# Developer Journal\n\n")
        f.write(line + "\n")
    cfg = read_json(CONFIG, {})
    nb = (cfg.get("journal") or {}).get("notebook_path")
    if nb and os.path.isdir(nb):
        try:
            with open(os.path.join(nb, "vflow-log.md"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception as e:
            print("[vflow] warning: notebook journal write failed: %s" % e)


def _archive_move(d, t, summary):
    t["completed"] = datetime.datetime.now().isoformat(timespec="seconds")
    write_json(os.path.join(d, "task.json"), t)
    month_dir = os.path.join(TASKS, "archive", datetime.date.today().strftime("%Y-%m"))
    os.makedirs(month_dir, exist_ok=True)
    dst = os.path.join(month_dir, os.path.basename(d))
    shutil.move(d, dst)
    append_journal(t, summary)
    if os.path.exists(POINTER):
        os.remove(POINTER)
    print("[vflow] Task archived to %s" % os.path.relpath(dst, ROOT))


def cmd_done(args):
    d = current_task_dir()
    if not d:
        print("[vflow] No active task")
        return 1
    p = os.path.join(d, "task.json")
    t = read_json(p)
    cfg = read_json(CONFIG, {})

    if is_legacy(t):
        # Legacy validation path: filled verify.md + no unchecked items.
        if args.force:
            t["force_archived"] = True
            print("[vflow] Archiving with --force (skipping completion checks)")
        else:
            errors = []
            if not is_filled(os.path.join(d, "verify.md")):
                errors.append("verify.md is not filled (must contain real build/test output)")
            items = unchecked_items(d)
            if items:
                errors.append("%d unchecked items in plan/design doc:" % len(items))
                for item in items:
                    errors.append("  - [ ] %s" % item)
            if errors:
                print("[vflow] ERROR: Cannot archive. Completion checks failed:")
                for e in errors:
                    print("  %s" % e)
                return 1
        t["status"] = "completed"
        _archive_move(d, t, args.summary or "")
        return 0

    state = task_state(t)
    if state != "verified" and not args.force:
        print("[vflow] ERROR: done requires state=verified (current: %s). "
              "Advance through the pipeline first." % state)
        return 1
    if args.force:
        t["force_archived"] = True
        print("[vflow] Archiving with --force (skipping completion checks)")
    else:
        errors = check_archived(d, cfg, t)
        if errors:
            print("[vflow] ERROR: Cannot archive:")
            for e in errors:
                print("  - %s" % e)
            return 1
    t["state"] = "archived"
    _archive_move(d, t, args.summary or "")
    return 0


def cmd_status(args):
    d = current_task_dir()
    if not d:
        print("[vflow] No active task (no_task)")
        return 0
    t = read_json(os.path.join(d, "task.json"), {})
    state = task_state(t)
    marker = " [legacy]" if is_legacy(t) else ""
    pipeline = " -> ".join(("[%s]" % s) if s == state else s for s in STATES)
    print("[vflow] %s | %s | state=%s risk=%s%s" % (
        t.get("id"), t.get("title"), state, t.get("risk"), marker))
    print("  %s" % pipeline)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("slug")
    c.add_argument("--title", default="")
    c.add_argument("--tier", default="T2")
    adv = sub.add_parser("advance")
    adv.add_argument("--skip-check", action="store_true",
                     help="Bypass transition checks (recorded in task.json bypasses)")
    sub.add_parser("back")
    s = sub.add_parser("set")
    s.add_argument("key")
    s.add_argument("value")
    st = sub.add_parser("start")
    st.add_argument("--skip", action="store_true",
                    help="(legacy) Skip planning validation")
    dn = sub.add_parser("done")
    dn.add_argument("--summary", default="")
    dn.add_argument("--force", action="store_true",
                    help="Skip completion checks (records force_archived in task.json)")
    sub.add_parser("status")
    args = ap.parse_args()
    return {"create": cmd_create, "advance": cmd_advance, "back": cmd_back,
            "set": cmd_set, "start": cmd_start, "done": cmd_done,
            "status": cmd_status}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
