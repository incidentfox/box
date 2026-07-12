"""Persistent LiveKit media worker for Box's Codex voice adapter.

LiveKit owns media, VAD, turn detection, WebRTC reconnects, and TTS.  Box remains
the authority for Codex sessions, tools, permissions, and the voice safety prompt.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobProcess, TurnHandlingOptions, cli, tts
from livekit.plugins import cartesia, deepgram, openai, silero

AGENT_NAME = "box-codex-voice"
ROOM_PREFIX = "box-voice-"
DEFAULT_CARTESIA_VOICE = "a5136bf9-224c-4d76-b823-52bd5efcffcc"  # Jameson, en-US
DEFAULT_CARTESIA_MODEL = "sonic-3.5"


def safe_vsid(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:80]


def vsid_from_room(room_name: str) -> str:
    if not str(room_name).startswith(ROOM_PREFIX):
        return ""
    return safe_vsid(str(room_name)[len(ROOM_PREFIX) :])


def text_from_message(message: Any) -> str:
    value = getattr(message, "text_content", "")
    if callable(value):
        value = value()
    return str(value or "").strip()


def speakable_text(value: Any) -> str:
    """Turn a CLI response into plain prose before it reaches a literal TTS engine."""
    text = str(value or "").replace("\r", "").strip()
    # Never have the voice attempt to read a code block or a raw Markdown link.
    text = re.sub(r"```[\s\S]*?```", " I put the code details in the session. ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", "that link", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", text)
    text = re.sub(r"(?m)^\s*(?:[-*+]\s+|\d+[.)]\s+)", "", text)
    text = re.sub(r"(?:\*\*|__|~~|`)", "", text)
    # Codex's streamed chunks can be joined without a separating space. Ellipses
    # and Markdown punctuation are the common source of literal "dot" read-outs.
    text = re.sub(r"(?:\.\.\.|…)+", ". ", text)
    text = re.sub(r"([.!?])(?=[A-Z])", r"\1 ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def voice_bool(value: str | None, default: bool = False) -> bool:
    if value is None or not str(value).strip():
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def deepgram_options() -> dict[str, Any]:
    # Deepgram requires utterance_end_ms >= 1000. It is the sole turn commit
    # signal in this adapter, while VAD remains activity-only.
    return {
        "model": "nova-3",
        "language": "multi",
        "interim_results": True,
        "smart_format": True,
        # Finalize words promptly, then let UtteranceEnd decide that the caller
        # really stopped. This avoids a VAD breath becoming an agent handoff.
        "endpointing_ms": 500,
        "utterance_end_ms": 1000,
    }


def turn_handling_options(*, allow_interruptions: bool = False) -> TurnHandlingOptions:
    """Commit on Deepgram's own finalized utterance event, never VAD silence."""
    return TurnHandlingOptions(
        # The hosted detector starts an inference request from a VAD pause. In
        # the live call it repeatedly committed *before* Nova-3's final
        # transcript arrived. Use Deepgram UtteranceEnd as the single commit
        # authority. Silero still supplies speech activity to LiveKit, but it
        # cannot end a user turn on its own in this mode.
        turn_detection="stt",
        # Deepgram waits one second of silence before UtteranceEnd. Do not add
        # a second human-noticeable delay after that provider signal.
        endpointing={"mode": "fixed", "min_delay": 0.15, "max_delay": 0.15},
        # Adaptive interruption is enabled only when the browser has also been
        # told to keep its microphone open during TTS. It rejects short
        # backchannels better than raw VAD while letting a real barge-in stop
        # an in-flight spoken response.
        interruption={"enabled": allow_interruptions, "mode": "adaptive"} if allow_interruptions else {"enabled": False},
        preemptive_generation={"enabled": False},
    )


def is_manual_turn_commit(data: bytes, topic: str, participant_identity: str) -> bool:
    """Accept only the caller's explicit, reliable End-turn control packet."""
    return (
        topic == "box.voice.control"
        and participant_identity.startswith("caller-")
        and data == b'{"type":"commit_turn"}'
    )


@dataclass(frozen=True)
class RuntimeConfig:
    backend_url: str
    auth_token: str
    cartesia_voice: str
    cartesia_model: str
    allow_interruptions: bool

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        return cls(
            backend_url=os.getenv("BOX_VOICE_BACKEND_URL", "http://127.0.0.1:7321").rstrip("/"),
            auth_token=os.getenv("CC_AUTH_TOKEN", ""),
            cartesia_voice=os.getenv("VOICE_ADAPTER_CARTESIA_VOICE", DEFAULT_CARTESIA_VOICE),
            cartesia_model=os.getenv("VOICE_ADAPTER_CARTESIA_MODEL", DEFAULT_CARTESIA_MODEL),
            allow_interruptions=voice_bool(os.getenv("VOICE_ASSISTANT_INTERRUPT_RESPONSE")),
        )


class BoxCodexVoiceAgent(Agent):
    def __init__(self, vsid: str, runtime: RuntimeConfig) -> None:
        super().__init__(instructions="You are only the media bridge for Box's persistent Codex session.")
        self.vsid = safe_vsid(vsid)
        self.runtime = runtime

    async def on_user_turn_completed(self, _turn_ctx: Any, new_message: Any) -> None:
        transcript = text_from_message(new_message)
        if not transcript or not self.vsid:
            return
        headers = {"Authorization": f"Bearer {self.runtime.auth_token}"}
        payload = {"vsid": self.vsid, "text": transcript, "stt_model": "livekit:deepgram/nova-3"}
        try:
            async with httpx.AsyncClient(timeout=190) as client:
                response = await client.post(f"{self.runtime.backend_url}/api/voice/adapter/text", headers=headers, json=payload)
                response.raise_for_status()
                answer = speakable_text(response.json().get("text"))
        except Exception:
            answer = "I could not reach the Box session just now. Please try that once more."
        if not answer:
            answer = "The Box session finished without a speakable answer. Please ask me to check its text response."
        speech = self.session.say(answer, allow_interruptions=self.runtime.allow_interruptions)
        await speech.wait_for_playout()


server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load(min_silence_duration=0.8, activation_threshold=0.5)


server.setup_fnc = prewarm


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    runtime = RuntimeConfig.from_env()
    if not runtime.auth_token:
        raise RuntimeError("CC_AUTH_TOKEN is required for the local Box voice bridge")
    vsid = vsid_from_room(ctx.room.name)
    if not vsid:
        try:
            vsid = safe_vsid(json.loads(ctx.job.metadata or "{}").get("vsid", ""))
        except json.JSONDecodeError:
            pass
    if not vsid:
        raise RuntimeError("voice room is missing its session id")

    primary_tts = cartesia.TTS(
        api_key=os.getenv("CARTESIA_API_KEY"), model=runtime.cartesia_model, voice=runtime.cartesia_voice,
        language="en", sample_rate=24000,
    )
    fallback_tts = openai.TTS(
        api_key=os.getenv("OPENAI_API_KEY"), model=os.getenv("VOICE_ADAPTER_TTS_MODEL", "gpt-4o-mini-tts"),
        voice=os.getenv("VOICE_ADAPTER_TTS_VOICE", "marin"),
        instructions="Speak naturally, concise and calm for a hands-free phone conversation.",
    )
    session = AgentSession(
        stt=deepgram.STT(api_key=os.getenv("DEEPGRAM_API_KEY"), **deepgram_options()),
        tts=tts.FallbackAdapter([primary_tts, fallback_tts], max_retry_per_tts=1),
        vad=ctx.proc.userdata["vad"],
        turn_handling=turn_handling_options(allow_interruptions=runtime.allow_interruptions),
    )
    # Semantic endpointing is the normal path. This packet makes the visible
    # End turn button real: it flushes Deepgram and commits the buffered turn
    # immediately when a caller chooses not to wait for the detector.
    @ctx.room.on("data_received")
    def on_data_packet(packet: Any) -> None:
        participant = getattr(packet, "participant", None)
        if not is_manual_turn_commit(
            bytes(getattr(packet, "data", b"")),
            str(getattr(packet, "topic", "")),
            str(getattr(participant, "identity", "")),
        ):
            return
        try:
            session.commit_user_turn(transcript_timeout=2.0, stt_flush_duration=0.25)
        except RuntimeError:
            # A late tap after call teardown has no side effects.
            return
    await session.start(agent=BoxCodexVoiceAgent(vsid, runtime), room=ctx.room)
    await ctx.connect()


if __name__ == "__main__":
    cli.run_app(server)
