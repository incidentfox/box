"""Persistent LiveKit media worker for Box's Codex voice adapter.

LiveKit owns media, VAD, turn detection, WebRTC reconnects, and TTS.  Box remains
the authority for Codex sessions, tools, permissions, and the voice safety prompt.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
from livekit import rtc
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobProcess, TurnHandlingOptions, cli, inference, tts
from livekit.plugins import cartesia, deepgram, openai, silero

AGENT_NAME = "box-codex-voice"
ROOM_PREFIX = "box-voice-"
DEFAULT_CARTESIA_VOICE = "a5136bf9-224c-4d76-b823-52bd5efcffcc"  # Jameson, en-US
DEFAULT_CARTESIA_MODEL = "sonic-3.5"
VOB_TEST_SOURCE = "box-vob-test"
VOB_PRODUCTION_LLM_MODEL = "google/gemma-4-31b-it"
VOB_PRODUCTION_STT_MODEL = "deepgram/flux-general-en"
VOB_PRODUCTION_TTS_MODEL = "cartesia/sonic-3.5"
VOB_PRODUCTION_CARTESIA_VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
VOB_TRANSCRIPT_TOPIC = "box-vob-transcript"


def safe_vsid(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:80]


def vsid_from_room(room_name: str) -> str:
    if not str(room_name).startswith(ROOM_PREFIX):
        return ""
    return safe_vsid(str(room_name)[len(ROOM_PREFIX) :])


def job_metadata(ctx: JobContext) -> dict[str, Any]:
    """Decode the small, opaque metadata attached to an explicit room dispatch."""
    try:
        value = json.loads(str(getattr(ctx.job, "metadata", "") or "{}"))
    except (TypeError, json.JSONDecodeError):
        value = {}
    return value if isinstance(value, dict) else {}


def vob_test_id_from_context(ctx: JobContext, metadata: dict[str, Any] | None = None) -> str:
    metadata = metadata or job_metadata(ctx)
    if str(metadata.get("mode", "")).strip() == "vob-test":
        return safe_vsid(metadata.get("testId", ""))
    try:
        room_metadata = json.loads(str(getattr(ctx.room, "metadata", "") or "{}"))
    except (TypeError, json.JSONDecodeError):
        room_metadata = {}
    if isinstance(room_metadata, dict) and str(room_metadata.get("source", "")).strip() == VOB_TEST_SOURCE:
        return safe_vsid(room_metadata.get("testId", ""))
    return ""


async def fetch_vob_test_config(runtime: "RuntimeConfig", test_id: str) -> dict[str, Any]:
    if not test_id:
        raise RuntimeError("VOB test room is missing its test id")
    headers = {"Authorization": f"Bearer {runtime.auth_token}"}
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(f"{runtime.backend_url}/api/voice/vob-test/config/{test_id}", headers=headers)
        response.raise_for_status()
        body = response.json()
    if not isinstance(body, dict) or not body.get("instructions"):
        raise RuntimeError("VOB test configuration is empty or expired")
    return body


async def publish_vob_event(room: rtc.Room, payload: dict[str, Any]) -> None:
    """Send small live status/transcript events alongside the audio track."""
    try:
        room.local_participant.publish_data(
            json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            reliable=True,
            topic=VOB_TRANSCRIPT_TOPIC,
        )
    except Exception:
        # Audio must continue even if a late monitor disconnects or data delivery
        # is unavailable in a particular LiveKit deployment.
        return


def created_at_ms(value: Any) -> int | None:
    if hasattr(value, "timestamp") and callable(value.timestamp):
        value = value.timestamp()
    try:
        if value is None:
            return None
        number = float(value)
        # LiveKit versions have emitted both epoch seconds and epoch
        # milliseconds here. Preserve an already-millisecond timestamp.
        return int(number if abs(number) >= 100_000_000_000 else number * 1000)
    except (TypeError, ValueError):
        return None


def wire_vob_transcripts(session: AgentSession, room: rtc.Room) -> None:
    """Mirror the agent session's real-time turns to read-only console monitors."""
    def emit(role: str, text: Any, final: bool = True, item_id: Any = None, created_at: Any = None) -> None:
        value = str(text or "").strip()
        if not value:
            return
        payload = {
            "type": "transcript",
            "role": role,
            "text": value,
            "final": bool(final),
            "itemId": str(item_id or ""),
        }
        if created_at is not None:
            created_ms = created_at_ms(created_at)
            if created_ms is not None:
                payload["createdAtMs"] = created_ms
        asyncio.create_task(publish_vob_event(room, payload))

    def on_user(event: Any) -> None:
        emit("user", getattr(event, "transcript", ""), getattr(event, "is_final", True), getattr(event, "item_id", ""), getattr(event, "created_at", None))

    def on_item(event: Any) -> None:
        item = getattr(event, "item", None)
        if str(getattr(item, "role", "assistant") or "assistant") != "assistant":
            return
        # The production VOB prompt uses a JSON envelope so the caller can
        # carry structured completion state. That envelope is an internal
        # control protocol, not caller-facing transcript text.
        emit("assistant", vob_spoken_text(text_from_message(item)), True, getattr(item, "id", ""), getattr(event, "created_at", None))

    session.on("user_input_transcribed", on_user)
    session.on("conversation_item_added", on_item)


def text_from_message(message: Any) -> str:
    # ChatMessage exposes these as properties in current LiveKit Agents, but
    # older adapters returned callables. Support both so transcript packets
    # always contain the generated text rather than a Python method repr.
    value = getattr(message, "raw_text_content", "")
    if callable(value):
        value = value()
    if not value:
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


def vob_spoken_text(value: Any) -> str:
    """Extract the caller-facing ``say`` field from a VOB JSON response.

    Real VOB calls use a strict JSON response because the operator consumes the
    action and completion fields. The role-play room uses that same prompt, but
    its media pipeline must only send the human-facing ``say`` value to TTS and
    transcripts. Be tolerant of fenced JSON and a small amount of provider
    prefix/suffix noise so one malformed stream cannot make the voice read a
    control payload verbatim.
    """
    text = str(value or "").replace("\r", "").strip()
    if not text:
        return ""

    candidates: list[str] = [text]
    fenced = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
    if fenced:
        candidates.insert(0, fenced.group(1).strip())
    else:
        # Some providers stream the opening fence before the first chunk and
        # omit it from the final chunk. Keep the complete response parseable.
        unfenced = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
        if unfenced != text:
            candidates.insert(0, unfenced)

    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except (TypeError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict) and "say" in payload:
            return speakable_text(payload.get("say"))

    # A model/provider may add a short preamble around an otherwise valid JSON
    # object. Decode from each opening brace without accepting arbitrary JSON
    # fields as speech.
    for match in re.finditer(r"\{", text):
        try:
            payload, _ = decoder.raw_decode(text[match.start() :])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and "say" in payload:
            return speakable_text(payload.get("say"))

    return speakable_text(text)


async def collect_text(stream: AsyncIterable[Any]) -> str:
    parts: list[str] = []
    async for chunk in stream:
        # TimedString is a str subclass, so this preserves its visible text
        # while intentionally discarding alignment metadata after JSON unwrap.
        parts.append(str(chunk))
    return "".join(parts)


async def one_text(text: str) -> AsyncIterator[str]:
    if text:
        yield text


def final_text_to_speak(answer: Any, spoken_progress: Any) -> str:
    """Suppress a final event that merely repeats the progress already spoken.

    Codex can emit its complete final answer as both the first streamed text event
    and the terminal event.  The media bridge must not make the caller hear that
    same answer twice. It also removes a matching progress prefix from a longer
    final answer, while preserving any genuinely new suffix.
    """
    final = speakable_text(answer)
    raw_progress = str(spoken_progress or "").rstrip()
    progress = speakable_text(spoken_progress)
    normalize = lambda text: re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    final_normalized = normalize(final)
    progress_normalized = normalize(progress)
    if final and progress and final_normalized == progress_normalized:
        return ""
    # Codex commonly emits a concise status as one message, then repeats that
    # status verbatim before appending its actual answer.  Speak only the new
    # suffix; otherwise the caller hears the same thought twice in succession.
    progress_words = re.findall(r"[a-z0-9]+", progress.lower())
    if raw_progress.endswith(("…", "...")) and progress_words:
        progress_words = progress_words[:-1]
        progress_normalized = " ".join(progress_words)
    final_words = list(re.finditer(r"[a-z0-9]+", final.lower()))
    if progress_words and len(final_words) > len(progress_words) and final_normalized.startswith(progress_normalized + " "):
        return final[final_words[len(progress_words) - 1].end() :].lstrip(" ,;:-.")
    return final


def voice_bool(value: str | None, default: bool = False) -> bool:
    if value is None or not str(value).strip():
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def deepgram_options() -> dict[str, Any]:
    # Deepgram requires utterance_end_ms >= 1000. It is the sole turn commit
    # signal in this adapter, while VAD remains activity-only.
    return {
        "model": "nova-3",
        # This assistant is English-only. Avoid multilingual language detection on
        # every stream; it adds work and has no benefit for the owner's calls.
        "language": "en-US",
        "interim_results": True,
        "smart_format": True,
        # Disable Deepgram speech_final endpointing. It was firing on 300 ms
        # in-sentence pauses (the worker logged STT end-of-speech while VAD still
        # heard speech), creating fragmented turns and apparent stop/start cycles.
        # UtteranceEnd is now the one predictable commit signal: one second of
        # silence, followed by LiveKit's 50 ms handoff below.
        "endpointing_ms": 0,
        "utterance_end_ms": 1000,
    }


def vob_production_stt_options() -> dict[str, Any]:
    """The test room's STT must match the deployed Rise4 LiveKit caller."""
    return {"model": VOB_PRODUCTION_STT_MODEL, "language": "en"}


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
        endpointing={"mode": "fixed", "min_delay": 0.05, "max_delay": 0.05},
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
    tts_provider: str
    cartesia_voice: str
    cartesia_model: str
    allow_interruptions: bool

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        return cls(
            backend_url=os.getenv("BOX_VOICE_BACKEND_URL", "http://127.0.0.1:7321").rstrip("/"),
            auth_token=os.getenv("CC_AUTH_TOKEN", ""),
            # Deepgram is already warm for STT and its measured TTS first byte is
            # substantially faster than OpenAI. Cartesia remains opt-in because an
            # exhausted account must not add a failed recovery cycle to every reply.
            tts_provider=os.getenv("VOICE_ADAPTER_TTS_PROVIDER", "deepgram").strip().lower(),
            cartesia_voice=os.getenv("VOICE_ADAPTER_CARTESIA_VOICE", DEFAULT_CARTESIA_VOICE),
            cartesia_model=os.getenv("VOICE_ADAPTER_CARTESIA_MODEL", DEFAULT_CARTESIA_MODEL),
            allow_interruptions=voice_bool(os.getenv("VOICE_ASSISTANT_INTERRUPT_RESPONSE")),
        )


class BoxCodexVoiceAgent(Agent):
    def __init__(self, vsid: str, runtime: RuntimeConfig) -> None:
        super().__init__(instructions="You are only the media bridge for Box's persistent Codex session.")
        self.vsid = safe_vsid(vsid)
        self.runtime = runtime
        self._adapter_turn: asyncio.Task[None] | None = None
        self._speech: Any | None = None

    def _interrupt_playback(self) -> None:
        """Stop the actual LiveKit speech handle, not just its awaiting task."""
        speech = self._speech
        self._speech = None
        if speech is None or speech.done():
            return
        try:
            speech.interrupt(force=True)
        except RuntimeError:
            pass

    async def _say(self, text: str) -> bool:
        speech = None
        try:
            speech = self.session.say(text, allow_interruptions=self.runtime.allow_interruptions)
            self._speech = speech
            await speech.wait_for_playout()
            return True
        except asyncio.CancelledError:
            if speech is not None and not speech.done():
                speech.interrupt(force=True)
            raise
        except RuntimeError:
            return False
        finally:
            if self._speech is speech:
                self._speech = None

    async def on_user_turn_completed(self, _turn_ctx: Any, new_message: Any) -> None:
        transcript = text_from_message(new_message)
        if not transcript or not self.vsid:
            return
        # Do not await a long Codex tool turn here.  LiveKit must remain free to
        # recognize a real caller barge-in.  A replacement request tells Box to
        # interrupt the active CLI process, queue this instruction on the same
        # persisted Codex thread, and continue from there.
        interrupt = self._adapter_turn is not None and not self._adapter_turn.done()
        if interrupt:
            # Cancelling the coroutine waiting on speech does not cancel the
            # SpeechHandle. Without this explicit interruption, orphaned audio
            # keeps playing and every later response queues behind it.
            self._interrupt_playback()
            self._adapter_turn.cancel()
        self._adapter_turn = asyncio.create_task(self._run_adapter_turn(transcript, interrupt=interrupt))

    async def _run_adapter_turn(self, transcript: str, *, interrupt: bool) -> None:
        headers = {"Authorization": f"Bearer {self.runtime.auth_token}"}
        payload = {
            "vsid": self.vsid,
            "text": transcript,
            "stt_model": "livekit:deepgram/nova-3",
            # Server-side state is authoritative, but retaining this marker makes
            # the caller-visible interruption explicit in diagnostics.
            "interrupt": interrupt,
        }
        spoken_progress: list[str] = []
        try:
            async with httpx.AsyncClient(timeout=190) as client:
                async with client.stream("POST", f"{self.runtime.backend_url}/api/voice/adapter/stream", headers=headers, json=payload) as response:
                    response.raise_for_status()
                    event = ""
                    data_lines: list[str] = []
                    answer = ""
                    async for line in response.aiter_lines():
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            data_lines.append(line[5:].strip())
                        elif not line and data_lines:
                            try:
                                body = json.loads("\n".join(data_lines))
                            except json.JSONDecodeError:
                                body = {}
                            if event == "progress":
                                progress = speakable_text(body.get("text"))
                                if progress and not any(final_text_to_speak(progress, prior) == "" for prior in spoken_progress):
                                    if not await self._say(progress):
                                        return
                                    spoken_progress.append(progress)
                            elif event == "final":
                                answer = speakable_text(body.get("text"))
                            elif event == "error":
                                raise RuntimeError(str(body.get("error") or "adapter stream failed"))
                            event = ""
                            data_lines = []
        except asyncio.CancelledError:
            # The user started another complete utterance.  Its replacement task
            # owns the reply; never speak a misleading network-error apology.
            return
        except Exception:
            answer = "I could not reach the Box session just now. Please try that once more."
        if not answer:
            answer = "The Box session finished without a speakable answer. Please ask me to check its text response."
        if any(final_text_to_speak(answer, progress) == "" for progress in spoken_progress):
            return
        answer = speakable_text(answer)
        if not answer:
            return
        await self._say(answer)


class VobProductionAgent(Agent):
    """The production VOB caller contract, isolated in an owner test room."""

    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)

    async def tts_node(self, text: AsyncIterable[str], model_settings: Any) -> Any:
        """Speak only the JSON envelope's human-facing ``say`` field."""
        spoken = vob_spoken_text(await collect_text(text))
        return Agent.default.tts_node(self, one_text(spoken), model_settings)

    async def transcription_node(self, text: AsyncIterable[Any], model_settings: Any) -> AsyncIterable[str]:
        """Mirror the same human-facing text in LiveKit/UI transcripts."""
        spoken = vob_spoken_text(await collect_text(text))
        return one_text(spoken)


server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    # VAD only supplies activity to the STT turn handler. A shorter floor makes
    # activity clear promptly without making VAD itself a competing turn commit.
    proc.userdata["vad"] = silero.VAD.load(min_silence_duration=0.45, activation_threshold=0.5)


server.setup_fnc = prewarm


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    runtime = RuntimeConfig.from_env()
    if not runtime.auth_token:
        raise RuntimeError("CC_AUTH_TOKEN is required for the local Box voice bridge")
    metadata = job_metadata(ctx)
    vob_test_id = vob_test_id_from_context(ctx, metadata)
    if vob_test_id:
        config = await fetch_vob_test_config(runtime, vob_test_id)
        # The settings are retained in the config for an auditable UI snapshot,
        # but the worker pins the room to production media. This prevents a
        # stale/client-forged dropdown value from silently testing a different
        # agent than the one that calls payers.
        vob_llm = inference.LLM(model=VOB_PRODUCTION_LLM_MODEL)
        vob_stt = inference.STT(**vob_production_stt_options())
        vob_tts = inference.TTS(
            model=VOB_PRODUCTION_TTS_MODEL,
            voice=VOB_PRODUCTION_CARTESIA_VOICE,
            language="en",
            sample_rate=24000,
        )
        session = AgentSession(
            stt=vob_stt,
            llm=vob_llm,
            tts=vob_tts,
            vad=ctx.proc.userdata["vad"],
            turn_handling=turn_handling_options(allow_interruptions=True),
        )
        wire_vob_transcripts(session, ctx.room)
        await session.start(agent=VobProductionAgent(str(config["instructions"])), room=ctx.room)
        await ctx.connect()
        await publish_vob_event(ctx.room, {"type": "status", "status": "agent_ready"})
        await session.generate_reply()
        return

    vsid = vsid_from_room(ctx.room.name)
    if not vsid:
        vsid = safe_vsid(metadata.get("vsid", ""))
    if not vsid:
        raise RuntimeError("voice room is missing its session id")

    openai_tts = openai.TTS(
        api_key=os.getenv("OPENAI_API_KEY"), model=os.getenv("VOICE_ADAPTER_TTS_MODEL", "gpt-4o-mini-tts"),
        voice=os.getenv("VOICE_ADAPTER_TTS_VOICE", "marin"),
        instructions="Speak naturally, concise and calm for a hands-free phone conversation.",
    )
    if runtime.tts_provider == "cartesia" and os.getenv("CARTESIA_API_KEY"):
        cartesia_tts = cartesia.TTS(
            api_key=os.getenv("CARTESIA_API_KEY"), model=runtime.cartesia_model, voice=runtime.cartesia_voice,
            language="en", sample_rate=24000,
        )
        session_tts = tts.FallbackAdapter([cartesia_tts, openai_tts], max_retry_per_tts=1)
    elif runtime.tts_provider == "openai":
        session_tts = openai_tts
    else:
        deepgram_tts = deepgram.TTS(
            api_key=os.getenv("DEEPGRAM_API_KEY"),
            model=os.getenv("VOICE_ADAPTER_DEEPGRAM_TTS_MODEL", "aura-2-thalia-en"),
            encoding="linear16",
            sample_rate=24000,
        )
        session_tts = tts.FallbackAdapter([deepgram_tts, openai_tts], max_retry_per_tts=1)
    session = AgentSession(
        stt=deepgram.STT(api_key=os.getenv("DEEPGRAM_API_KEY"), **deepgram_options()),
        tts=session_tts,
        vad=ctx.proc.userdata["vad"],
        turn_handling=turn_handling_options(allow_interruptions=runtime.allow_interruptions),
    )
    wire_vob_transcripts(session, ctx.room)
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
