from box_voice_agent import DEFAULT_CARTESIA_VOICE, RuntimeConfig, deepgram_options, is_manual_turn_commit, safe_vsid, text_from_message, turn_handling_options, vsid_from_room


class FakeMessage:
    text_content = "  hello there  "


def test_voice_room_id_is_strict_and_safe():
    assert vsid_from_room("box-voice-hello_world") == "hello_world"
    assert vsid_from_room("other-room") == ""
    assert safe_vsid("bad / session") == "badsession"


def test_text_and_default_voice_are_available(monkeypatch):
    monkeypatch.delenv("VOICE_ADAPTER_CARTESIA_VOICE", raising=False)
    assert text_from_message(FakeMessage()) == "hello there"
    assert RuntimeConfig.from_env().cartesia_voice == DEFAULT_CARTESIA_VOICE


def test_deepgram_utterance_end_satisfies_provider_minimum():
    assert deepgram_options()["utterance_end_ms"] >= 1000
    assert deepgram_options()["endpointing_ms"] >= 500


def test_turn_handling_uses_livekit_semantic_detector_and_conservative_dynamic_bounds(monkeypatch):
    monkeypatch.delenv("VOICE_ADAPTER_MIN_ENDPOINTING_DELAY", raising=False)
    monkeypatch.delenv("VOICE_ADAPTER_MAX_ENDPOINTING_DELAY", raising=False)
    monkeypatch.setenv("LIVEKIT_API_KEY", "test-key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "test-secret")
    options = turn_handling_options()
    assert options["turn_detection"].model == "turn-detector-v1"
    assert options["endpointing"] == {"mode": "dynamic", "min_delay": 1.2, "max_delay": 4.5, "alpha": 0.9}
    assert options["interruption"]["enabled"] is False


def test_manual_turn_commit_requires_the_caller_and_control_topic():
    payload = b'{"type":"commit_turn"}'
    assert is_manual_turn_commit(payload, "box.voice.control", "caller-session")
    assert not is_manual_turn_commit(payload, "box.voice.control", "agent-session")
    assert not is_manual_turn_commit(payload, "wrong.topic", "caller-session")
    assert not is_manual_turn_commit(b"commit", "box.voice.control", "caller-session")
