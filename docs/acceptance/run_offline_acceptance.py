"""Run the design-stage suite and write separate machine/human evidence.

The runner deliberately returns non-zero if a design contract fails.  That is
evidence for the implementation gate, not a reason to weaken a test.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.runner import _WritelnDecorator


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

import test_offline_acceptance as acceptance


class MachineResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []

    def _record(self, test, outcome, detail=""):
        detail = detail.replace(acceptance.TEST_ONLY_KEY, "[TEST-ONLY-REDACTED]")
        if len(detail) > 2400:
            detail = detail[:1600] + "\n...[failure detail truncated]...\n" + detail[-600:]
        self.records.append({
            "test": test.id(),
            "caseIds": acceptance.method_case_ids(test),
            "outcome": outcome,
            "mode": "SIMULATED_OFFLINE",
            "detail": detail,
        })

    def addSuccess(self, test):
        super().addSuccess(test)
        self._record(test, "PASS")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._record(test, "FAIL", self._exc_info_to_string(err, test))

    def addError(self, test, err):
        super().addError(test, err)
        self._record(test, "ERROR", self._exc_info_to_string(err, test))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._record(test, "BLOCKED", reason)


def run_acceptance():
    suite = unittest.defaultTestLoader.loadTestsFromModule(acceptance)
    result = MachineResult(stream=_WritelnDecorator(sys.stdout), descriptions=True, verbosity=2)
    suite.run(result)
    return result


def run_existing_regression():
    command = [sys.executable, "-B", "-m", "unittest", "discover", "-p", "test_*.py", "-v"]
    completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    return {
        "command": "python -B -m unittest discover -p \"test_*.py\" -v",
        "returnCode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def write_reports(acceptance_result, old):
    counts = {"PASS": 0, "FAIL": 0, "ERROR": 0, "BLOCKED": 0}
    for record in acceptance_result.records:
        counts[record["outcome"]] += 1
    manifest = json.loads((HERE.parent / "03_自测用例.json").read_text(encoding="utf-8"))
    # A simulated/static success is supporting evidence, never a whole-case
    # PASS.  Conversely, any linked failed test wins over that support.
    case_status = {case["id"]: case["status"] for case in manifest["cases"]}
    failure_impacts = {
        case["id"]: case.get("failureImpacts", []) for case in manifest["cases"]
    }
    for record in acceptance_result.records:
        if record["outcome"] not in {"FAIL", "ERROR"}:
            continue
        for case_id in record["caseIds"]:
            if case_id in case_status:
                case_status[case_id] = "FAIL"
                for impacted_id in failure_impacts.get(case_id, []):
                    if impacted_id in case_status:
                        case_status[impacted_id] = "FAIL"
    case_counts = {"PASS": 0, "PARTIAL": 0, "FAIL": 0, "BLOCKED": 0, "NOT_RUN": 0}
    for status in case_status.values():
        case_counts[status] += 1
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "Design-stage offline acceptance only; no real provider, browser, or production service.",
        "commands": [
            "python -B docs/acceptance/run_offline_acceptance.py",
            old["command"],
        ],
        "safety": {
            "realProviderCalls": False,
            "realCliProcesses": False,
            "productionPort8791Touched": False,
            "loopbackRandomPorts": sorted(set(acceptance.LOOPBACK_PORTS)),
            "temporaryLoopbackServersClosed": True,
        },
        "newAcceptance": {"counts": counts, "records": acceptance_result.records},
        "designCaseSummary": case_counts,
        "designCases": [{"id": case["id"], "status": case_status[case["id"]]} for case in manifest["cases"]],
        "existingRegression": {
            "mode": "OFFLINE_REGRESSION",
            "returnCode": old["returnCode"],
            "passed": old["returnCode"] == 0,
            "output": (old["stdout"] + old["stderr"]).replace(acceptance.TEST_ONLY_KEY, "[TEST-ONLY-REDACTED]"),
        },
        "browser": {"status": "BLOCKED", "reason": "No isolated browser automation was authorized or available in this design-only run."},
        "realBackends": {
            "R01": "NOT_RUN",
            "R02": "NOT_RUN",
            "R03": "NOT_RUN",
            "reason": "No user-approved provider/CLI integration was executed; simulated results are not availability evidence.",
        },
    }
    (HERE / "offline-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# 离线验收运行报告",
        "",
        f"生成时间（UTC）：{report['generatedAt']}",
        "",
        "范围：仅设计阶段离线测试。未调用真实供应商、未启动真实 CLI、未接触 8791。临时 HTTP 仅绑定随机回环端口，结束后已关闭。",
        "",
        "## 新增验收测试（模拟）",
        "",
        f"PASS {counts['PASS']}；FAIL {counts['FAIL']}；ERROR {counts['ERROR']}；BLOCKED {counts['BLOCKED']}。",
        f"映射后的 32 个设计用例：PASS {case_counts['PASS']}；PARTIAL {case_counts['PARTIAL']}；FAIL {case_counts['FAIL']}；BLOCKED {case_counts['BLOCKED']}；NOT_RUN {case_counts['NOT_RUN']}。",
        "",
        "| 测试 | 用例 | 结果 |",
        "| --- | --- | --- |",
    ]
    for record in report["newAcceptance"]["records"]:
        lines.append(f"| `{record['test'].rsplit('.', 1)[-1]}` | {', '.join(record['caseIds']) or 'support'} | {record['outcome']} |")
    lines += [
        "",
        "聚合规则：模拟/静态/假进程成功仅为 PARTIAL；同一或关联用例有 FAIL/ERROR 时 FAIL 优先。第二轮红测是修复实施输入；本次绿测不替代浏览器或真实后端。静态 U02/U05 仅是代码证据，浏览器验证仍为 BLOCKED。",
        "",
        "## 既有回归（单独运行）",
        "",
        f"命令：`{old['command']}`。退出码：{old['returnCode']}。该入口目前是旧有 26 项离线单元测试，不覆盖本报告中的浏览器或真实三后端结论。",
        "",
        "## 未运行的真实后端",
        "",
        "R01 API、R02 Codex、R03 ZCode 均为 NOT_RUN：本次没有用户批准的模型、登录或供应商调用。",
        "",
        "详细机器可读记录见 `offline-report.json`；失败堆栈仅保存在该 JSON 中，并已替换测试占位字符串。",
    ]
    (HERE / "offline-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main():
    acceptance_result = run_acceptance()
    old = run_existing_regression()
    report = write_reports(acceptance_result, old)
    failures = report["newAcceptance"]["counts"]["FAIL"] + report["newAcceptance"]["counts"]["ERROR"]
    return 1 if failures or old["returnCode"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
