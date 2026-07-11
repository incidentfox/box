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
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobProcess, TurnHandlingOptions, cli, inference, tts
from livekit.plugins import cartesia, deepgram, openai, silero

AGENT_NAME = "box-codex-voice"
ROOM_PREFIX = "box-voice-"
DEFAULT_CARTESIA_VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"


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


def deepgram_options() -> dict[str, Any]:
    # Deepgram requires utterance_end_ms >= 1000. LiveKit's semantic detector,
    # not this provider hint, controls our 350 ms–1.5 s handoff target.
    return {
        "model": "nova-3",
        "language": "multi",
        "interim_results": True,
        "smart_format": True,
        # Let streaming STT retain a phrase through a short pause. The semantic
        # detector decides when it is a real handoff, not this acoustic hint.
        "endpointing_ms": 500,
        "utterance_end_ms": 1000,
    }


def turn_handling_options() -> TurnHandlingOptions:
    """Use LiveKit's current semantic endpointing API with documented bounds."""
    def number(name: str, default: float) -> float:
        try:
            return float(os.getenv(name, default))
        except ValueError:
            return default

    # The standard 0.5 s lower bound is too eager for a hands-free caller: a
    # natural mid-sentence breath can be that long, and the live transcript
    # showed turns such as "So let's" reaching Codex as completed requests.
    # Keep dynamic semantic endpointing, but bias its default window toward
    # finishing the caller's sentence. Operators can still lower these values
    # explicitly when latency is more important than conversational tolerance.
    minimum = min(2.0, max(0.5, number("VOICE_ADAPTER_MIN_ENDPOINTING_DELAY", 1.2)))
    maximum = min(5.0, max(minimum + 0.5, number("VOICE_ADAPTER_MAX_ENDPOINTING_DELAY", 4.5)))
    return TurnHandlingOptions(
        # v1 is LiveKit's hosted audio+semantic detector. It avoids handing a
        # dangling phrase such as "if we..." to Codex as a completed request.
        turn_detection=inference.TurnDetector(version="v1"),
        endpointing={"mode": "dynamic", "min_delay": minimum, "max_delay": maximum, "alpha": 0.9},
        # Box is deliberately half-duplex while TTS plays. The browser gates
        # its mic, so a live interruption would otherwise be inconsistent.
        interruption={"enabled": False},
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

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        return cls(
            backend_url=os.getenv("BOX_VOICE_BACKEND_URL", "http://127.0.0.1:7321").rstrip("/"),
            auth_token=os.getenv("CC_AUTH_TOKEN", ""),
            cartesia_voice=os.getenv("VOICE_ADAPTER_CARTESIA_VOICE", DEFAULT_CARTESIA_VOICE),
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
                answer = str(response.json().get("text") or "").strip()
        except Exception:
            answer = "I could not reach the Box session just now. Please try that once more."
        if not answer:
            answer = "The Box session finished without a speakable answer. Please ask me to check its text response."
        speech = self.session.say(answer, allow_interruptions=False)
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
        api_key=os.getenv("CARTESIA_API_KEY"), model="sonic-3", voice=runtime.cartesia_voice,
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
        turn_handling=turn_handling_options(),
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
