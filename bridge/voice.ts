import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";

const STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const TTS_URL = "wss://tts-rt.soniox.com/tts-websocket";
const SAMPLE_RATE = 24_000;
const TTS_SPEED = 1.015;

export type VoiceSocketData = {
  paneId: string;
  session?: string;
  sessionFile: string;
  device: string | null;
};

type VoiceSocket = ServerWebSocket<VoiceSocketData>;

type Relay = {
  ws: VoiceSocket;
  stt: WebSocket | null;
  tts: WebSocket | null;
  finalText: string;
  handedOff: boolean;
};

type SttUpdate = {
  final: string;
  partial: string;
  finished: boolean;
  error?: string;
};

/** The only STT configuration the proxy accepts: mono Russian PCM from the Collie browser. */
export function sttConfig(apiKey: string): Record<string, unknown> {
  return {
    api_key: apiKey,
    model: "stt-rt-v5",
    audio_format: "pcm_s16le",
    sample_rate: 16_000,
    num_channels: 1,
    language_hints: ["ru"],
  };
}

/** TTS runs server-side too; speed is deliberately fixed to the requested +1.5%. */
export function ttsConfig(apiKey: string, voice: string, streamId: string): Record<string, unknown> {
  return {
    api_key: apiKey,
    model: "tts-rt-v1",
    language: "ru",
    voice,
    audio_format: "pcm_s16le",
    sample_rate: SAMPLE_RATE,
    speed: TTS_SPEED,
    stream_id: streamId,
  };
}

/** Collapse only provider-final STT tokens. Partial text is display-only and never submitted. */
export function sttUpdate(raw: unknown): SttUpdate {
  if (typeof raw !== "object" || raw === null) return { final: "", partial: "", finished: false };
  const value = raw as { tokens?: unknown; finished?: unknown; error_message?: unknown };
  if (typeof value.error_message === "string") {
    return { final: "", partial: "", finished: false, error: value.error_message };
  }
  let final = "";
  let partial = "";
  if (Array.isArray(value.tokens)) {
    for (const token of value.tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as { text?: unknown; is_final?: unknown };
      if (typeof t.text !== "string") continue;
      if (t.is_final === true) final += t.text;
      else partial += t.text;
    }
  }
  return { final, partial, finished: value.finished === true };
}

/** The bridge and localhost daemon share the daemon's owner-only token; constant-time once sized. */
export function voiceTokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function connect(url: string): Promise<WebSocket> {
  const deferred = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => deferred.resolve(ws), { once: true });
  ws.addEventListener("error", () => deferred.reject(new Error("Soniox WebSocket connection failed")), { once: true });
  return deferred.promise;
}

function send(ws: VoiceSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

/**
 * Owns one browser relay per OMP session. The session file is resolved by server.ts, never supplied
 * by a browser; that keeps OMP's on-disk layout out of the wire protocol.
 */
export class VoiceBroker {
  #relays = new Map<string, Relay>();

  constructor(
    private readonly cfg: Config,
    private readonly audit: AuditLog,
  ) {}

  async open(ws: VoiceSocket): Promise<void> {
    const prior = this.#relays.get(ws.data.sessionFile);
    if (prior) prior.ws.close(4000, "replaced by a newer Collie voice client");
    try {
      await this.#setRemote(ws.data.sessionFile, "remote-start");
    } catch (error) {
      send(ws, { kind: "error", message: "Laptop voice relay is unavailable" });
      ws.close(1011, "voice relay unavailable");
      console.warn(`[voice] couldn't activate laptop relay: ${(error as Error).message}`);
      return;
    }
    this.#relays.set(ws.data.sessionFile, { ws, stt: null, tts: null, finalText: "", handedOff: false });
    this.audit.record({
      action: "voice.connect",
      paneId: ws.data.paneId,
      session: ws.data.session,
      device: ws.data.device,
      detail: {},
    });
    send(ws, { kind: "ready" });
  }

  close(ws: VoiceSocket): void {
    const relay = this.#relays.get(ws.data.sessionFile);
    if (!relay || relay.ws !== ws) return;
    if (!relay.handedOff) void this.#setRemote(ws.data.sessionFile, "remote-release").catch(() => undefined);
    relay.stt?.close();
    relay.tts?.close();
    this.#relays.delete(ws.data.sessionFile);
    // A hand-off belongs to the browser turn until its final extension `speak` event: a sleeping page
    // must not make the daemon resume laptop output. Unhanded mic/STT failures release immediately.
  }

  async message(ws: VoiceSocket, message: string | Uint8Array): Promise<void> {
    const relay = this.#relays.get(ws.data.sessionFile);
    if (!relay || relay.ws !== ws) return;
    if (typeof message !== "string") {
      if (!relay.stt) return send(ws, { kind: "error", message: "Microphone stream is not ready" });
      relay.stt.send(message);
      return;
    }
    let event: { kind?: unknown };
    try {
      event = JSON.parse(message) as { kind?: unknown };
    } catch {
      return send(ws, { kind: "error", message: "Invalid voice message" });
    }
    switch (event.kind) {
      case "start":
        await this.#startStt(relay);
        return;
      case "end":
        relay.stt?.send(new Uint8Array());
        return;
      case "release":
        await this.#setRemote(ws.data.sessionFile, "remote-release").catch(() => undefined);
        return;
      case "handoff":
        relay.handedOff = true;
        return;
      case "keepalive":
        return;
      default:
        return send(ws, { kind: "error", message: "Unknown voice message" });
    }
  }
  /** Receives a final-only OMP extension event from the local daemon, never from a browser. */
  speak(sessionFile: string, text: string): boolean {
    const relay = this.#relays.get(sessionFile);
    if (!relay) return false;
    void this.#startTts(relay, text);
    return true;
  }

  async #startStt(relay: Relay): Promise<void> {
    if (relay.stt) return;
    this.#stopTts(relay);
    relay.finalText = "";
    try {
      const stt = await connect(STT_URL);
      relay.stt = stt;
      stt.addEventListener("message", (event) => {
        if (relay.stt !== stt || typeof event.data !== "string") return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        const update = sttUpdate(raw);
        if (update.error) {
          relay.stt = null;
          send(relay.ws, { kind: "error", message: update.error });
          return;
        }
        relay.finalText += update.final;
        send(relay.ws, { kind: "transcript", text: `${relay.finalText}${update.partial}` });
        if (update.finished) {
          relay.stt = null;
          const text = relay.finalText.trim();
          this.audit.record({
            action: "voice.transcript",
            paneId: relay.ws.data.paneId,
            session: relay.ws.data.session,
            device: relay.ws.data.device,
            // The complete transcript is the normal OMP input recorded in the agent journal; audit is
            // intentionally only a bounded action trail, like every other Collie terminal write.
            detail: { text, length: text.length },
          });
          send(relay.ws, { kind: "final", text });
        }
      });
      stt.addEventListener("close", () => {
        if (relay.stt === stt) relay.stt = null;
      });
      stt.send(JSON.stringify(sttConfig(this.cfg.sonioxApiKey)));
      send(relay.ws, { kind: "recording" });
    } catch (error) {
      send(relay.ws, { kind: "error", message: "Could not start speech recognition" });
      console.warn(`[voice] couldn't start Soniox STT: ${(error as Error).message}`);
    }
  }

  async #startTts(relay: Relay, text: string): Promise<void> {
    this.#stopTts(relay);
    const streamId = crypto.randomUUID();
    try {
      const tts = await connect(TTS_URL);
      relay.tts = tts;
      tts.addEventListener("message", (event) => {
        if (relay.tts !== tts || typeof event.data !== "string") return;
        let response: { audio?: unknown; terminated?: unknown; error_message?: unknown };
        try {
          response = JSON.parse(event.data) as typeof response;
        } catch {
          return;
        }
        if (typeof response.error_message === "string") {
          send(relay.ws, { kind: "error", message: response.error_message });
          return;
        }
        if (typeof response.audio === "string") {
          send(relay.ws, { kind: "tts", sampleRate: SAMPLE_RATE });
          relay.ws.send(Buffer.from(response.audio, "base64"));
        }
        if (response.terminated === true) {
          relay.tts = null;
          send(relay.ws, { kind: "tts-end" });
          tts.close();
        }
      });
      tts.addEventListener("close", () => {
        if (relay.tts === tts) relay.tts = null;
      });
      tts.send(JSON.stringify(ttsConfig(this.cfg.sonioxApiKey, this.cfg.sonioxTtsVoice, streamId)));
      tts.send(JSON.stringify({ text, text_end: true, stream_id: streamId }));
    } catch (error) {
      send(relay.ws, { kind: "error", message: "Could not start speech playback" });
      console.warn(`[voice] couldn't start Soniox TTS: ${(error as Error).message}`);
    }
  }

  #stopTts(relay: Relay): void {
    relay.tts?.close();
    relay.tts = null;
  }

  async #setRemote(session: string, kind: "remote-start" | "remote-release"): Promise<void> {
    const token = (await readFile(this.cfg.voiceControlTokenFile, "utf8")).trim();
    if (!token) throw new Error("voice control token is empty");
    const response = await fetch(this.cfg.voiceControlUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-omp-voice-token": token },
      body: JSON.stringify({ kind, session }),
    });
    if (!response.ok) throw new Error(`voice control returned ${response.status}: ${(await response.text()).trim()}`);
  }
}
