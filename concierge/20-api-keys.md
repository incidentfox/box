# Concierge prompt — fetch the optional API keys for Box

**Paste everything below into a computer-use agent.** Only do the sections for features you
want — all of these are optional. Box works as a chat app with none of them.

---

You are helping me collect a couple of API keys for a self-hosted app called "Box". Drive the
browser; I'll handle my own logins. Treat every key like a password: copy it **exactly**, show
it to me once, and tell me which `.env` line it goes on. Stop and ask before any paid plan —
free tiers are fine for me.

### A) Claude login (required, but you can't do this part)
Box drives the `claude` CLI, which uses my Claude subscription login — **not** an API key.
Remind me to, on the server: install the CLI (`npm install -g @anthropic-ai/claude-code`),
run `claude` once, and complete the browser login. If I specifically want to use an Anthropic
**API key** instead (pay-per-token), help me create one at
<https://console.anthropic.com> → **API keys** → *Create key*, and tell me to set it as
`ANTHROPIC_API_KEY` in the environment. (Most people should just use the subscription login.)

### B) ElevenLabs — voice input (optional)
1. Go to <https://elevenlabs.io> and help me sign in / sign up (free tier is fine).
2. Open my **profile / account → API key** and reveal it.
3. Give me the key and tell me: *"put this in `.env` as `ELEVENLABS_API_KEY=...`"*.

### C) Deepgram — higher-quality voice (optional, alternative to B)
1. Go to <https://console.deepgram.com>, help me sign in / sign up.
2. Create an API key (**Create a New API Key**), copy it.
3. Give me the key: *"put this in `.env` as `DEEPGRAM_API_KEY=...`"*.

### D) OpenAI — powers the cheap per-session "morning brief" (optional)
1. Go to <https://platform.openai.com/api-keys>, help me sign in.
2. Create a new secret key, copy it.
3. Give me the key: *"put this in `.env` as `OPENAI_API_KEY=...`"*. (This only enables the
   morning-brief summaries; chat works without it.)

At the end, list every key you found and its exact `.env` line, in one block I can copy. Do
not store these keys anywhere except showing them to me.
