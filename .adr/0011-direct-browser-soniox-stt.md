# 0011 — Voice input streams directly from the browser with a temporary Soniox key

Status: **Accepted** (2026-08-09)

## Context

Collie sends replies to a live agent pane through Herdr; it does not own an OMP request channel. A
voice feature must therefore turn one utterance into the same guarded pane reply as typed text. It
must not expose a long-lived Soniox credential or persist microphone audio.

Soniox's official Web SDK captures a browser microphone and streams it to its STT WebSocket. Soniox
requires a backend to mint a temporary key for that untrusted client; keys can be restricted to one
`transcribe_websocket` stream and bounded session duration.

Sources:

- [Soniox Web SDK](https://soniox.com/docs/sdk/web-SDK.mdx)
- [Temporary API keys](https://soniox.com/docs/guides/temporary-api-keys.mdx)
- [Manual finalization](https://soniox.com/docs/stt/rt/manual-finalization.mdx)

## Decision

The browser calls `POST /api/voice/stt-key`, which has Collie's existing **write** gate. The bridge
uses `SONIOX_API_KEY` only to mint a one-use `transcribe_websocket` key: it expires after 60 seconds
and can run for at most two minutes. The browser receives only that temporary key and connects
directly to `wss://stt-rt.soniox.com` under a narrow CSP allow-list.

`VoiceInput` uses `@soniox/client` with `stt-rt-v5` and a Russian language hint. Holding the
microphone control shows partial text locally. Releasing it calls the SDK's graceful `stop()`, waits
for final tokens, then sends the final text through `sendGuardedReply` to the currently open pane.
The normal reply audit and the target OMP session journal therefore contain the final transcript;
Collie stores neither raw audio nor interim tokens.

## Consequences

- The server never proxies audio, so it owns no media framing, WebSocket relay, or audio retention.
- Voice input obeys the same prompt-safety check as typing: no blind Enter reaches a TUI dialog.
- A missing `SONIOX_API_KEY` produces a local 503; text replies remain available.
- This change does **not** speak OMP replies. Collie currently receives terminal snapshots, not a
  semantic assistant-token stream; deriving TTS from snapshot diffs would replay or omit text. Add
  Soniox TTS only with a real OMP streaming event source.
