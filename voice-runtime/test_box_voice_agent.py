from box_voice_agent import DEFAULT_CARTESIA_VOICE, RuntimeConfig, deepgram_options, safe_vsid, text_from_message, turn_timing_options, vsid_from_room


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


def test_turn_timing_defaults_allow_a_natural_pause(monkeypatch):
    monkeypatch.delenv("VOICE_ADAPTER_MIN_ENDPOINTING_DELAY", raising=False)
    monkeypatch.delenv("VOICE_ADAPTER_MAX_ENDPOINTING_DELAY", raising=False)
    assert turn_timing_options() == (0.65, 3.0)
