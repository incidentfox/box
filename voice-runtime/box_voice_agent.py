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
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobProcess, cli, inference, tts
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


def turn_timing_options() -> tuple[float, float]:
    """Natural pause window for hands-free speech; stays configurable at deploy time."""
    def number(name: str, default: float) -> float:
        try:
            return float(os.getenv(name, default))
        except ValueError:
            return default

    minimum = min(3.0, max(0.8, number("VOICE_ADAPTER_MIN_ENDPOINTING_DELAY", 1.2)))
    maximum = min(8.0, max(minimum + 0.5, number("VOICE_ADAPTER_MAX_ENDPOINTING_DELAY", 4.5)))
    return minimum, maximum


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
    min_endpointing_delay, max_endpointing_delay = turn_timing_options()
    session = AgentSession(
        stt=deepgram.STT(api_key=os.getenv("DEEPGRAM_API_KEY"), **deepgram_options()),
        tts=tts.FallbackAdapter([primary_tts, fallback_tts], max_retry_per_tts=1),
        vad=ctx.proc.userdata["vad"],
        # Force LiveKit's hosted v1 semantic detector instead of falling back to
        # the compact local model. It judges whether a phrase is complete, so a
        # dangling "if it…" stays open rather than becoming a Codex turn.
        turn_detection=inference.TurnDetector(version="v1"),
        min_endpointing_delay=min_endpointing_delay,
        max_endpointing_delay=max_endpointing_delay,
        allow_interruptions=False,
    )
    await session.start(agent=BoxCodexVoiceAgent(vsid, runtime), room=ctx.room)
    await ctx.connect()


if __name__ == "__main__":
    cli.run_app(server)
