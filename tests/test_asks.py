import copy
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import fcntl


SCRIPT = Path(__file__).resolve().parents[1] / "bin/herdr-asks"
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("asks", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
asks = importlib.util.module_from_spec(spec)
loader.exec_module(asks)

QUESTION = "⏺ The implementation is ready.\n  Which database should we use?\n────────────────\n❯ \n"
DIALOG = "Which database?\n❯ 1. Postgres\n  2. SQLite\n  3. Other\n"


class FakeAPI:
    def __init__(self, blocked=False):
        self.agent = dict(pane_id="w1:p1", terminal_id="t1", agent="claude", workspace_id="w1",
                          agent_session={"value": "s1"}, state_change_seq=4, completion_seq=3,
                          agent_status="blocked" if blocked else "done", cwd="/tmp")
        self.screen = DIALOG if blocked else QUESTION
        self.sent = []
        self.reads = 0
        self.fail_send = False
        self.on_read = None

    def agents(self):
        return [copy.deepcopy(self.agent)]

    def get(self, pane):
        return copy.deepcopy(self.agent)

    def read(self, pane, blocked):
        self.reads += 1
        if self.on_read:
            self.on_read()
        return self.screen

    def send(self, pane, answer, option):
        self.sent.append((pane, answer, option))
        if self.fail_send:
            raise TimeoutError()


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.api = FakeAPI()
        self.store = asks.Store(self.tmp.name)
        self.engine = asks.Engine(self.api, self.store)

    def test_repeated_scan_caches_completed_turn_and_dismissal_survives_restart(self):
        card = self.engine.scan()[0]
        self.engine.scan()
        self.assertEqual(self.api.reads, 1)
        self.engine.dismiss(card)
        second = asks.Engine(self.api, self.store)
        self.assertEqual(second.scan(), [])
        self.api.agent["completion_seq"] += 1
        self.assertEqual(len(second.scan()), 1)

    def test_submission_sends_exact_text_once_and_persists_receipt_and_audit(self):
        card = self.engine.scan()[0]
        answer = 'Use Postgres; $(do not execute) `literal`'
        self.engine.answer(card, answer)
        self.assertEqual(self.api.sent, [("w1:p1", answer, False)])
        self.assertEqual(self.engine.scan(), [])
        record = json.loads((Path(self.tmp.name) / "decisions.jsonl").read_text())
        self.assertEqual(record["answer"], answer)
        self.assertEqual(record["cwd"], "/tmp")
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, answer)
        self.assertEqual(len(self.api.sent), 1)
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)

    def test_identity_turn_screen_and_working_state_each_reject_stale_answers(self):
        for field, value in (("terminal_id", "t2"), ("agent_session", {"value": "s2"}),
                             ("completion_seq", 9), ("agent_status", "working")):
            with self.subTest(field=field):
                original = copy.deepcopy(self.api.agent)
                card = self.engine.scan()[0]
                self.api.agent[field] = value
                with self.assertRaises(RuntimeError):
                    self.engine.answer(card, "Postgres")
                self.api.agent = original
        card = self.engine.scan()[0]
        self.api.screen = QUESTION.replace("database", "region")
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, "Postgres")
        self.assertEqual(self.api.sent, [])

    def test_agent_change_during_read_is_rejected_on_scan_and_delivery(self):
        self.api.on_read = lambda: self.api.agent.update(completion_seq=8)
        self.assertEqual(self.engine.scan(), [])
        self.api.on_read = None
        card = self.engine.scan()[0]
        self.api.on_read = lambda: self.api.agent.update(agent_status="working")
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, "Postgres")
        self.assertEqual(self.api.sent, [])

    def test_blocked_choice_sends_only_number_without_enter(self):
        self.api = FakeAPI(blocked=True)
        self.engine.api = self.api
        card = self.engine.scan()[0]
        self.engine.answer(card, "2", option=True)
        self.assertEqual(self.api.sent, [("w1:p1", "2", True)])

    def test_invalid_blocked_input_does_not_reach_agent(self):
        self.engine.api = self.api = FakeAPI(blocked=True)
        card = self.engine.scan()[0]
        for answer, option in (("4", True), ("SQLite", False), ("", False)):
            with self.assertRaises(RuntimeError):
                self.engine.answer(card, answer, option)
        self.assertEqual(self.api.sent, [])

    def test_unknown_dialog_cannot_be_answered(self):
        self.engine.api = self.api = FakeAPI(blocked=True)
        self.api.agent["agent"] = "codex"
        card = self.engine.scan()[0]
        self.assertEqual(card["options"], [])
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, "1", option=True)
        self.assertEqual(self.api.sent, [])

    def test_numbered_prose_without_dialog_cursor_is_not_actionable(self):
        self.engine.api = self.api = FakeAPI(blocked=True)
        self.api.screen = DIALOG.replace("❯", " ")
        card = self.engine.scan()[0]
        self.assertEqual(card["options"], [])
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, "1", option=True)
        self.assertEqual(self.api.sent, [])

    def test_delivery_timeout_is_never_retried_and_no_success_log_written(self):
        card = self.engine.scan()[0]
        self.api.fail_send = True
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, "Postgres")
        with self.assertRaises(RuntimeError):
            self.engine.answer(card, "Postgres")
        self.assertEqual(len(self.api.sent), 1)
        self.assertEqual(self.store.read()[card["id"]]["state"], "delivery-uncertain")
        self.assertFalse((Path(self.tmp.name) / "decisions.jsonl").exists())

    def test_sending_receipt_exists_before_rpc_and_survives_new_engine(self):
        card = self.engine.scan()[0]
        self.api.send = lambda *args: self.assertEqual(self.store.read()[card["id"]]["state"], "sending")
        self.engine.answer(card, "Postgres")
        self.assertEqual(asks.Engine(self.api, self.store).scan(), [])

    def test_scope_excludes_other_workspaces_and_current_pane(self):
        self.engine.workspace = "w2"
        self.assertEqual(self.engine.scan(), [])
        self.engine.workspace = None
        self.engine.exclude = "w1:p1"
        self.assertEqual(self.engine.scan(), [])

    def test_completed_question_detection_ignores_old_turn_and_user_input(self):
        self.api.screen = QUESTION + "⏺ Finished successfully.\n────\n❯ Which one?\n"
        self.assertEqual(self.engine.scan(), [])

    def test_classifier_receives_only_current_message_and_can_reject(self):
        seen = []
        self.engine.classifier = lambda message: seen.append(message) or False
        self.assertEqual(self.engine.scan(), [])
        self.assertEqual(seen, [asks.last_message(QUESTION)])

    def test_dialog_only_mode_never_reads_completed_agents(self):
        self.engine.trailing = False
        self.assertEqual(self.engine.scan(), [])
        self.assertEqual(self.api.reads, 0)

    def test_dialog_changes_get_new_identity_but_no_duplicate_numbers_are_actionable(self):
        self.engine.api = self.api = FakeAPI(blocked=True)
        first = self.engine.scan()[0]
        self.api.screen = DIALOG.replace("Postgres", "MySQL")
        second = self.engine.scan()[0]
        self.assertNotEqual(first["id"], second["id"])
        with self.assertRaises(RuntimeError):
            self.engine.answer(first, "1", True)
        self.api.screen = DIALOG + DIALOG
        card = self.engine.scan()[0]
        self.assertEqual(card["options"], [])


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.fixture = self.root / "fixture.json"
        self.fake = FakeAPI()
        self.fixture.write_text(json.dumps({"agent": self.fake.agent, "screen": QUESTION, "sent": []}))
        executable = self.root / "herdr"
        executable.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p=Path(os.environ['ASKS_FIXTURE'])
f=json.loads(p.read_text())
a=sys.argv[1:]
if a[:2]==['agent','list']: result={'agents':[f['agent']]}
elif a[:2]==['agent','get']: result={'agent':f['agent']}
elif a[:2]==['agent','read']:
 print(f['screen']); sys.exit(0)
elif a[:2] in (['agent','prompt'],['agent','send-keys'],['agent','focus']):
 f['sent'].append(a)
 if a[1]!='focus': f['agent']['agent_status']='working'
 p.write_text(json.dumps(f)); result={}
else: sys.exit(2)
print(json.dumps({'result':result}))
''')
        executable.chmod(0o755)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        self.addCleanup(os.close, self.master)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"],
                        TERM="xterm-256color", HERDR_ENV="1", HERDR_PANE_ID="w9:p9",
                        ASKS_FIXTURE=str(self.fixture))
        self.proc = subprocess.Popen([sys.executable, str(SCRIPT), "--state-dir", str(self.root / "state")],
                                     stdin=slave, stdout=slave, stderr=slave, env=self.env)
        os.close(slave)
        self.addCleanup(self.stop)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=5)

    def wait_exit(self):
        # A PTY consumer must drain curses output, including terminal-restoration bytes.
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if self.proc.poll() is not None:
                return self.proc.returncode
            if select.select([self.master], [], [], .05)[0]:
                try:
                    os.read(self.master, 65536)
                except OSError:
                    pass
        raise TimeoutError("Inbox did not exit")

    def until_output(self, control_locator):
        # UI text is only a locator for interacting; assertions below prove actual requests.
        output = b""
        end = time.monotonic() + 8
        while time.monotonic() < end:
            if select.select([self.master], [], [], .05)[0]:
                output += os.read(self.master, 65536)
                if control_locator.encode() in output:
                    return
        raise TimeoutError("Terminal did not become interactive")

    def wait_sent(self):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            try:
                data = json.loads(self.fixture.read_text())
                if data['sent']:
                    return data['sent']
            except json.JSONDecodeError:
                pass
            time.sleep(.05)
        raise TimeoutError("No request delivered")

    def test_edit_confirm_submit_and_exit_in_real_curses_process(self):
        self.until_output("private answer log")
        os.write(self.master, b"\r")
        self.until_output("Enter to review")
        os.write(self.master, b"Use SQLite\r")
        self.until_output("y sends")
        os.write(self.master, b"y")
        self.assertEqual(self.wait_sent(), [["agent", "prompt", "w1:p1", "Use SQLite"]])
        os.write(self.master, b"q")
        self.assertEqual(self.wait_exit(), 0)

    def test_cancel_draft_then_open_original_agent(self):
        self.until_output("private answer log")
        os.write(self.master, b"\r")
        self.until_output("Enter to review")
        os.write(self.master, b"Do not send\x1b")
        self.until_output("private answer log")
        os.write(self.master, b"o")
        self.assertEqual(self.wait_sent(), [["agent", "focus", "w1:p1"]])
        self.assertEqual(self.wait_exit(), 0)


if __name__ == "__main__":
    unittest.main()
