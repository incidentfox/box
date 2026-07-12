from box_voice_agent import DEFAULT_CARTESIA_MODEL, DEFAULT_CARTESIA_VOICE, RuntimeConfig, deepgram_options, is_manual_turn_commit, safe_vsid, speakable_text, text_from_message, turn_handling_options, vsid_from_room


class FakeMessage:
    text_content = "  hello there  "


def test_voice_room_id_is_strict_and_safe():
    assert vsid_from_room("box-voice-hello_world") == "hello_world"
    assert vsid_from_room("other-room") == ""
    assert safe_vsid("bad / session") == "badsession"


def test_text_and_default_voice_are_available(monkeypatch):
    monkeypatch.delenv("VOICE_ADAPTER_CARTESIA_VOICE", raising=False)
    monkeypatch.delenv("VOICE_ADAPTER_CARTESIA_MODEL", raising=False)
    assert text_from_message(FakeMessage()) == "hello there"
    assert RuntimeConfig.from_env().cartesia_voice == DEFAULT_CARTESIA_VOICE
    assert RuntimeConfig.from_env().cartesia_model == DEFAULT_CARTESIA_MODEL


def test_deepgram_utterance_end_satisfies_provider_minimum():
    assert deepgram_options()["utterance_end_ms"] >= 1000
    assert deepgram_options()["endpointing_ms"] >= 500


def test_turn_handling_commits_only_on_deepgram_finalized_speech():
    options = turn_handling_options()
    assert options["turn_detection"] == "stt"
    assert options["endpointing"] == {"mode": "fixed", "min_delay": 0.15, "max_delay": 0.15}
    assert options["interruption"]["enabled"] is False


def test_speakable_text_removes_markdown_ellipses_and_joined_chunks():
    raw = "## Status\n- First point...Next point. [Details](https://example.test/a)\n```sh\nrm -rf /\n```"
    assert speakable_text(raw) == "Status First point. Next point. Details I put the code details in the session."


def test_manual_turn_commit_requires_the_caller_and_control_topic():
    payload = b'{"type":"commit_turn"}'
    assert is_manual_turn_commit(payload, "box.voice.control", "caller-session")
    assert not is_manual_turn_commit(payload, "box.voice.control", "agent-session")
    assert not is_manual_turn_commit(payload, "wrong.topic", "caller-session")
    assert not is_manual_turn_commit(b"commit", "box.voice.control", "caller-session")
