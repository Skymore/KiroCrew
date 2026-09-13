"""POST /api/chat/slots/{slot}/queue/{queue_id}/steer — steer a queued message
into the running turn without interrupting it.

Covers:
- ``queue_take_by_id`` / ``queue_restore``: the take-then-put-back the route rests
  on, including a put-back into a queue that moved under the await
- the three steer outcomes and what each does to the queue, the placeholder row,
  the ``queue_pop`` broadcast and the SEL record
- the admission re-check the drain also performs: an entry whose containment
  changed since it was queued is DROPPED, loudly, never steered
- 404 for a drained entry, 409 for an automation entry (audited, left in place)
- the entry's attachment lists ride onto the steer row
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from chat_test_helpers import _make_state

from kiro_crew.dashboard import session_control as sc
from kiro_crew.dashboard.chat import api_chat_slot_queue_steer
from kiro_crew.dashboard.chat_delivery import (
    STEER_REQUEUED,
    STEER_STEERED,
    STEER_UNAVAILABLE,
    steer_into_running_turn,
)
from kiro_crew.dashboard.chat_utils import SYNTHETIC_RECOVERY_KIND
from kiro_crew.dashboard.state import _ChatSlot

STEER = "kiro_crew.dashboard.chat_handlers.steer_into_running_turn"


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    """Run in the shipped (enabled) session-control state without reading config."""
    monkeypatch.setattr(sc, "session_control_enabled", lambda: True)


@pytest.fixture(autouse=True)
def _inline_audit(monkeypatch):
    """Route every SEL write (the route's own and session_control's drop audit)
    inline to one mock: assertable, and no executor thread outlives the test.
    The handler module binds ``sel`` by name at import, so it is patched there."""
    fake = MagicMock()
    monkeypatch.setattr("kiro_crew.dashboard.chat_handlers.sel", lambda: fake)
    monkeypatch.setattr(sc, "sel", lambda: fake)
    monkeypatch.setattr(sc, "_sel_off_loop", lambda write, what: write())
    return fake


class TestQueueTakeRestore:
    def test_take_returns_the_entry_with_its_neighbours_and_removes_it(self):
        slot = _ChatSlot("s1")
        a = slot.queue_append("first")
        qid = slot.queue_append("second", meta={"sendId": "abc"})
        c = slot.queue_append("third")
        taken = slot.queue_take_by_id(qid)
        assert taken is not None
        assert taken.index == 1 and taken.prev_id == a and taken.next_id == c
        assert taken.entry["id"] == qid and taken.entry["meta"] == {"sendId": "abc"}
        assert [q["content"] for q in slot._queue] == ["first", "third"]

    def test_take_at_the_ends_has_no_neighbour_on_that_side(self):
        slot = _ChatSlot("s1")
        a = slot.queue_append("only")
        b = slot.queue_append("last")
        first = slot.queue_take_by_id(a)
        assert first is not None and first.prev_id is None and first.next_id == b
        last = slot.queue_take_by_id(b)
        assert last is not None and last.prev_id is None and last.next_id is None

    def test_take_unknown_id(self):
        slot = _ChatSlot("s1")
        slot.queue_append("only")
        assert slot.queue_take_by_id("nope") is None
        assert len(slot._queue) == 1

    def test_restore_puts_the_same_entry_back_where_it_was(self):
        slot = _ChatSlot("s1")
        slot.queue_append("first")
        qid = slot.queue_append("second")
        slot.queue_append("third")
        taken = slot.queue_take_by_id(qid)
        assert taken is not None
        slot.queue_restore(taken)
        assert [q["content"] for q in slot._queue] == ["first", "second", "third"]
        assert slot._queue[1] is taken.entry  # identity, not a rebuilt copy

    def test_restore_keeps_its_place_when_an_earlier_entry_was_cancelled(self):
        """Index 1 is taken and index 0 is cancelled meanwhile. Restoring by the
        captured number lands the entry behind its former follower; restoring by
        neighbour keeps it ahead."""
        slot = _ChatSlot("s1")
        a = slot.queue_append("first")
        qid = slot.queue_append("second")
        slot.queue_append("third")
        taken = slot.queue_take_by_id(qid)
        assert taken is not None
        slot.queue_remove_by_id(a)
        slot.queue_restore(taken)
        assert [q["content"] for q in slot._queue] == ["second", "third"]

    def test_restore_falls_back_to_the_predecessor_then_the_index(self):
        slot = _ChatSlot("s1")
        slot.queue_append("first")
        qid = slot.queue_append("second")
        c = slot.queue_append("third")
        taken = slot.queue_take_by_id(qid)
        assert taken is not None
        # The follower drained; a new entry was appended behind. "Same place" is
        # now right after the predecessor, ahead of the newcomer.
        slot.queue_remove_by_id(c)
        slot.queue_append("fourth")
        slot.queue_restore(taken)
        assert [q["content"] for q in slot._queue] == ["first", "second", "fourth"]
        # Both anchors gone: clamp the original index into whatever is left.
        taken2 = slot.queue_take_by_id(qid)
        assert taken2 is not None
        slot._queue.clear()
        slot.queue_restore(taken2)
        assert [q["content"] for q in slot._queue] == ["second"]


def _make_app(state):
    app = web.Application()
    app["state"] = state
    app.router.add_post("/api/chat/slots/{slot}/queue/{queue_id}/steer", api_chat_slot_queue_steer)
    return app


def _queued(state, slot, content, **kw):
    """A user entry the way the composer queues one: admission stamp included."""
    meta = sc.containment_meta(state, slot)
    meta.update(kw.pop("meta", {}))
    qid = slot.queue_append(content, meta=meta, **kw)
    slot.append("queued", content, json.dumps({"queue_id": qid}))
    return qid


def _steer_audits(fake):
    return [
        c
        for c in fake.log_tool_invocation.call_args_list
        if c.kwargs.get("tool_name") == "queue_steer"
    ]


class TestQueueSteerEndpoint:
    @pytest.mark.asyncio
    async def test_steered_retires_the_card_and_broadcasts_pop(self, tmp_path, _inline_audit):
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        _queued(state, slot, "first")
        qid = _queued(
            state,
            slot,
            "act on this now",
            meta={"sendId": "send-42", "files": ["/tmp/My Report.pdf"]},
        )
        steer = AsyncMock(return_value=STEER_STEERED)
        with patch(STEER, steer):
            async with TestClient(TestServer(_make_app(state))) as client:
                resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                assert resp.status == 200
                assert await resp.json() == {"ok": True, "steered": True}
        # The entry was OFF the queue when the steer was awaited, and stays off.
        assert [q["content"] for q in slot._queue] == ["first"]
        steer.assert_awaited_once()
        args, kwargs = steer.await_args
        assert args[1] is slot and args[2] == "act on this now"
        assert kwargs["send_id"] == "send-42"
        # The entry's attachment lists travel with it, reduced by attachment_meta.
        assert kwargs["attachments"] == {"files": ["/tmp/My Report.pdf"]}
        # Placeholder row gone; clients told by the same frame the drain uses.
        assert not any(
            m["role"] == "queued" and json.loads(m["cls"]).get("queue_id") == qid
            for m in slot.messages
        )
        state.broadcast_ws.assert_any_call(
            "queue_pop", {"slot": "chat-1", "content": "", "queue_id": qid}
        )
        (audit,) = _steer_audits(_inline_audit)
        assert audit.kwargs["outcome"] == "allowed"
        assert audit.kwargs["metadata"]["result"] == STEER_STEERED

    @pytest.mark.asyncio
    async def test_requeued_retires_only_the_old_placeholder(self, tmp_path):
        """The turn ended mid-await and its teardown requeued the text as a NEW
        entry; this route must not put the OLD entry back beside it."""
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        qid = _queued(state, slot, "late")

        async def requeue(state_, slot_, message, *, send_id=None, attachments=None):
            slot_.queue_append(message)  # what the teardown does
            return STEER_REQUEUED

        with patch(STEER, requeue):
            async with TestClient(TestServer(_make_app(state))) as client:
                resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                assert resp.status == 200
                assert await resp.json() == {"ok": True, "queued": True}
        assert [q["content"] for q in slot._queue] == ["late"]
        assert slot._queue[0]["id"] != qid
        state.broadcast_ws.assert_any_call(
            "queue_pop", {"slot": "chat-1", "content": "", "queue_id": qid}
        )

    @pytest.mark.asyncio
    async def test_unavailable_puts_the_same_entry_back_in_place(self, tmp_path, _inline_audit):
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        _queued(state, slot, "first")
        qid = _queued(state, slot, "second", meta={"sendId": "s2"})
        _queued(state, slot, "third")
        with patch(STEER, AsyncMock(return_value=STEER_UNAVAILABLE)):
            async with TestClient(TestServer(_make_app(state))) as client:
                resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                assert resp.status == 200
                assert await resp.json() == {
                    "ok": True,
                    "steered": False,
                    "queued": True,
                    "queue_id": qid,
                }
        # Same id, same meta, same position — the card never moved.
        assert [q["content"] for q in slot._queue] == ["first", "second", "third"]
        assert slot._queue[1]["id"] == qid and slot._queue[1]["meta"]["sendId"] == "s2"
        assert any(
            m["role"] == "queued" and json.loads(m["cls"]).get("queue_id") == qid
            for m in slot.messages
        )
        state.broadcast_ws.assert_not_called()
        (audit,) = _steer_audits(_inline_audit)
        assert audit.kwargs["outcome"] == "noop"

    @pytest.mark.asyncio
    async def test_unavailable_restores_in_place_when_the_queue_moved_under_the_await(
        self, tmp_path
    ):
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        a = _queued(state, slot, "first")
        qid = _queued(state, slot, "second")
        _queued(state, slot, "third")

        async def cancel_first_then_refuse(
            state_, slot_, message, *, send_id=None, attachments=None
        ):
            slot_.queue_remove_by_id(a)  # another client cancels the front card
            return STEER_UNAVAILABLE

        with patch(STEER, cancel_first_then_refuse):
            async with TestClient(TestServer(_make_app(state))) as client:
                resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                assert resp.status == 200
        # Still ahead of "third", not behind it.
        assert [q["content"] for q in slot._queue] == ["second", "third"]

    @pytest.mark.asyncio
    async def test_containment_change_since_admission_drops_loudly(self, tmp_path, _inline_audit):
        """Admitted unlinked, linked before the steer: the drain's gate, applied
        here. The entry is dropped (never steered), the card retracted, the
        transcript says why, and the SEL records a denial."""
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        qid = _queued(state, slot, "exfil me")
        slot.linked_session_key = "C0LINKED|1700000000.000100"
        steer = AsyncMock(return_value=STEER_STEERED)
        with patch(STEER, steer):
            async with TestClient(TestServer(_make_app(state))) as client:
                resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                assert resp.status == 409
                assert (await resp.json())["code"] == "queue_containment_changed"
        steer.assert_not_awaited()
        assert slot._queue == []
        assert not any(m["role"] == "queued" for m in slot.messages)
        notices = [m for m in slot.messages if m.get("role") == "notice"]
        assert notices and "linked to a channel" in notices[-1]["content"]
        state.broadcast_ws.assert_any_call(
            "queue_pop", {"slot": "chat-1", "content": "", "queue_id": qid}
        )
        denied = [
            c
            for c in _inline_audit.log_tool_invocation.call_args_list
            if c.kwargs.get("outcome") == "denied"
        ]
        assert denied and "linked" in denied[-1].kwargs["metadata"]["newly_held"]

    @pytest.mark.asyncio
    async def test_gone_entry_is_404_and_sends_nothing(self, tmp_path):
        state = _make_state(tmp_path)
        slot = state.get_or_create_slot("chat-1")
        slot.queue_append("keep")
        steer = AsyncMock(return_value=STEER_STEERED)
        with patch(STEER, steer):
            async with TestClient(TestServer(_make_app(state))) as client:
                resp = await client.post("/api/chat/slots/chat-1/queue/drained/steer")
                assert resp.status == 404
                assert (await resp.json())["code"] == "queue_item_not_found"
        steer.assert_not_awaited()
        assert len(slot._queue) == 1

    @pytest.mark.asyncio
    async def test_unknown_slot_is_404(self, tmp_path):
        state = _make_state(tmp_path)
        async with TestClient(TestServer(_make_app(state))) as client:
            resp = await client.post("/api/chat/slots/nope/queue/x/steer")
            assert resp.status == 404
            assert (await resp.json())["code"] == "slot_not_found"

    @pytest.mark.asyncio
    async def test_app_token_is_403_before_the_take_and_audited(self, tmp_path, _inline_audit):
        """Steering is human-only, like the composer's steer branch: an app that
        owns the slot clears the cross-app check but must still be refused, and
        refused BEFORE the entry moves."""
        state = _make_state(tmp_path)
        slot = state.get_or_create_slot("chat-1")
        slot._app = "someapp"
        qid = _queued(state, slot, "app text")
        steer = AsyncMock(return_value=STEER_STEERED)

        @web.middleware
        async def as_app(request, handler):
            request["app"] = "someapp"
            return await handler(request)

        app = _make_app(state)
        app.middlewares.append(as_app)
        with patch(STEER, steer):
            async with TestClient(TestServer(app)) as client:
                resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                assert resp.status == 403
                assert (await resp.json())["code"] == "app_steer_forbidden"
        steer.assert_not_awaited()
        assert [q["id"] for q in slot._queue] == [qid]
        (audit,) = _steer_audits(_inline_audit)
        assert audit.kwargs["outcome"] == "denied"
        assert audit.kwargs["metadata"]["reason"] == "app_forbidden"

    @pytest.mark.asyncio
    async def test_automation_entry_is_409_audited_and_left_in_place(self, tmp_path, _inline_audit):
        state = _make_state(tmp_path)
        slot = state.get_or_create_slot("chat-1")
        slot.queue_append("user text")
        rid = slot.queue_insert(0, "[recovery] continue", kind=SYNTHETIC_RECOVERY_KIND)
        cid = slot.queue_insert(1, "retry payload", on_consumed=lambda ok: None)
        steer = AsyncMock(return_value=STEER_STEERED)
        with patch(STEER, steer):
            async with TestClient(TestServer(_make_app(state))) as client:
                for qid in (rid, cid):
                    resp = await client.post(f"/api/chat/slots/chat-1/queue/{qid}/steer")
                    assert resp.status == 409
                    assert (await resp.json())["code"] == "not_steerable"
        steer.assert_not_awaited()
        assert [q["id"] for q in slot._queue] == [rid, cid, slot._queue[2]["id"]]
        assert slot._queue[2]["content"] == "user text"
        # A refusal is a permission decision and leaves the same trace an allow does.
        audits = _steer_audits(_inline_audit)
        assert [a.kwargs["outcome"] for a in audits] == ["denied", "denied"]
        assert all(a.kwargs["metadata"]["reason"] == "not_steerable" for a in audits)


class TestSteerRowCarriesAttachments:
    @pytest.mark.asyncio
    async def test_attachment_lists_land_on_the_row_and_the_echo(self, tmp_path):
        """`steer_into_running_turn` unions the send's attachment lists onto the
        persisted steer row and the `steer_push` payload, so `[attached_file N]`
        markers resolve against the list instead of the marker text. The ledger
        entry is consumed with the row."""
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        client = MagicMock()
        client.supports_steer = True
        client.steer = AsyncMock(return_value=True)
        slot._acp_client = client
        outcome = await steer_into_running_turn(
            state,
            slot,
            "look at [attached_file 1] /tmp/My Report.pdf",
            attachments={"files": ["/tmp/My Report.pdf"], "dirs": [], "bogus": ["x"]},
        )
        assert outcome == STEER_STEERED
        row = [m for m in slot.messages if m.get("role") == "user"][-1]
        assert row["meta"]["files"] == ["/tmp/My Report.pdf"]
        assert "dirs" not in row["meta"] and "bogus" not in row["meta"]
        push = [c for c in state.broadcast_ws.call_args_list if c.args[0] == "steer_push"][-1]
        assert push.args[1]["files"] == ["/tmp/My Report.pdf"]
        assert "dirs" not in push.args[1]
        assert slot._steer_attachments == {}

    @pytest.mark.asyncio
    async def test_no_attachments_keeps_the_prior_shapes(self, tmp_path):
        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        client = MagicMock()
        client.supports_steer = True
        client.steer = AsyncMock(return_value=True)
        slot._acp_client = client
        assert await steer_into_running_turn(state, slot, "plain") == STEER_STEERED
        row = [m for m in slot.messages if m.get("role") == "user"][-1]
        assert set(row["meta"]) <= {"steer", "steerState", "mid", "ts"}
        push = [c for c in state.broadcast_ws.call_args_list if c.args[0] == "steer_push"][-1]
        assert set(push.args[1]) <= {"slot", "content", "ts", "steerState", "mid"}

    def test_requeue_carries_the_lists_onto_the_replacement_entry(self, tmp_path):
        """A steer the teardown degrades to a queue card keeps its attachment
        lists: the requeue moves them from the ledger onto the entry's meta, in
        lockstep with the delivery id and the send id."""
        from kiro_crew.dashboard import chat_runner as cr

        state = _make_state(tmp_path)
        state.broadcast_ws = MagicMock()
        slot = state.get_or_create_slot("chat-1")
        msg = "see [attached_file 1] /tmp/My Report.pdf"
        slot._pending_steers = [msg]
        slot._steer_delivery_ids[msg] = "d1"
        slot._steer_send_ids[msg] = "s1"
        slot._steer_attachments[msg] = {"files": ["/tmp/My Report.pdf"]}
        cr._requeue_unconsumed_steers(state, slot)
        (entry,) = slot._queue
        assert entry["content"] == msg
        assert entry["meta"]["files"] == ["/tmp/My Report.pdf"]
        assert entry["meta"]["sendId"] == "s1" and entry["meta"]["steer_delivery_id"] == "d1"
        assert msg not in slot._steer_attachments
        assert msg not in slot._steer_send_ids and msg not in slot._steer_delivery_ids

    @pytest.mark.asyncio
    async def test_unavailable_unwind_drops_the_ledger_entry(self, tmp_path):
        state = _make_state(tmp_path)
        slot = state.get_or_create_slot("chat-1")
        client = MagicMock()
        client.supports_steer = True
        client.steer = AsyncMock(return_value=False)  # backend refused the write
        slot._acp_client = client
        outcome = await steer_into_running_turn(
            state, slot, "x [attached_file 1] /tmp/a b", attachments={"files": ["/tmp/a b"]}
        )
        assert outcome == STEER_UNAVAILABLE
        assert slot._steer_attachments == {} and slot._steer_send_ids == {}
