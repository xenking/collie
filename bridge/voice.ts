import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";

const STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const TTS_URL = "wss://tts-rt.soniox.com/tts-websocket";
const STT_SAMPLE_RATE = 16_000;
const SAMPLE_RATE = 24_000;
const TTS_SPEED = 1.015;
const STT_FINAL_SILENCE = Buffer.alloc((STT_SAMPLE_RATE * 2) / 5);
const STT_FINALIZATION_TIMEOUT_MS = 5_000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_GRACE_MS = 60_000;

export type VoiceSocketData = {
  paneId: string;
  session?: string;
  sessionFile: string;
  device: string | null;
};

type VoiceSocket = ServerWebSocket<VoiceSocketData>;
type TurnConfig = Pick<Config, "sonioxApiKey" | "sonioxTtsVoice">;
type TurnAudit = Pick<AuditLog, "record">;
type TurnSocket = Pick<VoiceSocket, "data" | "send">;

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
    sample_rate: STT_SAMPLE_RATE,
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
  if (!raw || typeof raw !== "object") return { final: "", partial: "", finished: false };
  if ("error_message" in raw && typeof raw.error_message === "string") {
    return { final: "", partial: "", finished: false, error: raw.error_message };
  }
  let final = "";
  let partial = "";
  let finished = "finished" in raw && raw.finished === true;
  if ("tokens" in raw && Array.isArray(raw.tokens)) {
    for (const token of raw.tokens) {
      if (!token || typeof token !== "object" || !("text" in token) || typeof token.text !== "string") continue;
      // Soniox's manual-finalization marker completes the turn; it is protocol, never user text.
      if ("is_final" in token && token.is_final === true && token.text === "<fin>") {
        finished = true;
        continue;
      }
      if ("is_final" in token && token.is_final === true) final += token.text;
      else partial += token.text;
    }
  }
  return { final, partial, finished };
}

/** The bridge and localhost daemon share the daemon's owner-only token; constant-time once sized. */
export function voiceTokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function connect(url: string): Promise<WebSocket> {
  const deferred = Promise.withResolvers<WebSocket>();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const settle = (complete: () => void): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    complete();
  };
  const ws = new WebSocket(url);
  timeout = setTimeout(() => {
    settle(() => deferred.reject(new Error("Soniox WebSocket connection timed out")));
    ws.close();
  }, WEBSOCKET_CONNECT_TIMEOUT_MS);
  ws.addEventListener("open", () => settle(() => deferred.resolve(ws)), { once: true });
  ws.addEventListener("error", () => settle(() => deferred.reject(new Error("Soniox WebSocket connection failed"))), { once: true });
  return deferred.promise;
}

function send(ws: TurnSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

export type VoicePhase = "idle" | "listening" | "finalizing" | "working" | "speaking";

type SttTurn = {
  generation: number;
  finalText: string;
  finalizing: boolean;
};

type TtsTurn = {
  generation: number;
  streamId: string;
  text: string;
};

type TtsResponse = {
  stream_id?: unknown;
  audio?: unknown;
  terminated?: unknown;
  error_message?: unknown;
};

function ttsResponse(raw: unknown): TtsResponse | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    stream_id: "stream_id" in raw ? raw.stream_id : undefined,
    audio: "audio" in raw ? raw.audio : undefined,
    terminated: "terminated" in raw ? raw.terminated : undefined,
    error_message: "error_message" in raw ? raw.error_message : undefined,
  };
}

/**
 * The authoritative lifecycle for one browser relay and one OMP session.
 *
 * Generation changes before cancellation so a late provider callback can never revive interrupted
 * audio. STT/TTS sockets deliberately outlive individual PTT and reply turns; Soniox stream IDs do not.
 */
export class TurnController {
  #generation = 0;
  #phase: VoicePhase = "idle";
  #stt: WebSocket | null = null;
  #tts: WebSocket | null = null;
  #openingStt: Promise<WebSocket> | null = null;
  #openingTts: Promise<WebSocket> | null = null;
  #sttTurn: SttTurn | null = null;
  #pendingStart: number | null = null;
  #pendingEnd: number | null = null;
  #speech: TtsTurn | null = null;
  #awaitingPlayback: TtsTurn | null = null;
  #queuedSpeech: string[] = [];
  #sttFinalizationTimeout: ReturnType<typeof setTimeout> | null = null;
  #sttFinalizationTimedOut = false;
  #ttsKeepalive: ReturnType<typeof setInterval> | null = null;
  #handedOff = false;
  #closed = false;
  readonly #socketData: VoiceSocketData;
  private ws: TurnSocket | null;

  constructor(
    private readonly cfg: TurnConfig,
    private readonly audit: TurnAudit,
    ws: TurnSocket,
  ) {
    this.ws = ws;
    this.#socketData = ws.data;
  }

  owns(ws: VoiceSocket): boolean {
    return this.ws === ws;
  }

  get detached(): boolean {
    return this.ws === null;
  }

  attach(ws: VoiceSocket): boolean {
    if (this.#closed || !this.#handedOff || this.ws !== null) return false;
    this.ws = ws;
    return true;
  }

  detach(ws: VoiceSocket): boolean {
    if (!this.owns(ws) || !this.#handedOff) return false;
    this.ws = null;
    this.#pauseSpeechForReconnect();
    return true;
  }

  get handedOff(): boolean {
    return this.#handedOff;
  }

  close(): void {
    this.#closed = true;
    this.#clearSttFinalizationTimeout();
    if (this.#ttsKeepalive) clearInterval(this.#ttsKeepalive);
    this.#ttsKeepalive = null;
    this.#stt?.close();
    this.#tts?.close();
    this.#stt = null;
    this.#tts = null;
    this.ws = null;
  }

  async start(): Promise<void> {
    if (this.#closed) return;
    const prior = this.#sttTurn;
    const generation = ++this.#generation;
    this.#cancelSpeech();
    this.#awaitingPlayback = null;
    this.#handedOff = false;
    this.#phase = "listening";
    this.#pendingStart = generation;
    this.#pendingEnd = null;
    this.#send({ kind: "clear", generation });
    this.#state();

    if (prior) {
      this.#finalizeStt(prior);
      return;
    }
    await this.#beginPendingStt();
  }

  end(): void {
    const generation = this.#generation;
    const turn = this.#sttTurn;
    if (!turn) {
      if (this.#pendingStart === generation) {
        this.#pendingEnd = generation;
        this.#phase = "finalizing";
        this.#state();
      }
      return;
    }
    if (turn.generation !== generation || turn.finalizing || this.#phase !== "listening") return;
    this.#phase = "finalizing";
    this.#state();
    this.#finalizeStt(turn);
  }

  audio(data: Uint8Array): void {
    const turn = this.#sttTurn;
    if (!turn || turn.generation !== this.#generation || this.#phase !== "listening") {
      this.#send({ kind: "error", message: "Microphone stream is not ready" });
      return;
    }
    try {
      this.#stt?.send(data);
    } catch {
      this.#onSttClose(this.#stt);
    }
  }

  handoff(generation: unknown): boolean {
    if (generation !== this.#generation || this.#phase !== "working") return false;
    this.#handedOff = true;
    return true;
  }

  /** A replacement browser socket resumes a completed remote handoff and any queued speech. */
  resume(): boolean {
    if (this.#closed || this.ws === null || (this.#phase !== "idle" && this.#phase !== "working")) return false;
    this.#handedOff = true;
    this.#resumeQueuedSpeech();
    return true;
  }

  release(): void {
    this.#handedOff = false;
    this.#queuedSpeech = [];
    if (this.#phase !== "working") return;
    this.#phase = "idle";
    this.#state();
  }

  speak(text: string): boolean {
    if (this.#closed || !this.#handedOff || !text.trim()) return false;
    if (this.ws === null) {
      this.#queuedSpeech.push(text);
      return true;
    }
    if (this.#speech || this.#awaitingPlayback) {
      this.#queuedSpeech.push(text);
      return true;
    }
    if (this.#phase !== "working" && this.#phase !== "idle") return false;
    const speech = { generation: this.#generation, streamId: crypto.randomUUID(), text };
    this.#speech = speech;
    void this.#beginSpeech(speech, text);
    return true;
  }

  playbackEnded(generation: unknown, streamId: unknown): void {
    const speech = this.#awaitingPlayback;
    if (
      !speech ||
      streamId !== speech.streamId ||
      generation !== speech.generation ||
      this.#phase !== "speaking"
    ) {
      return;
    }
    this.#awaitingPlayback = null;
    this.#phase = "idle";
    this.#state();
    this.#resumeQueuedSpeech();
  }

  #resumeQueuedSpeech(): void {
    if (this.ws === null || this.#speech || this.#awaitingPlayback) return;
    const next = this.#queuedSpeech.shift();
    if (next) this.speak(next);
  }

  #pauseSpeechForReconnect(): void {
    const activeSpeech = this.#speech;
    const replay = activeSpeech ?? this.#awaitingPlayback;
    this.#speech = null;
    this.#awaitingPlayback = null;
    if (replay) this.#queuedSpeech.unshift(replay.text);
    if (activeSpeech) {
      try {
        this.#tts?.send(JSON.stringify({ stream_id: activeSpeech.streamId, cancel: true }));
      } catch {
        this.#onTtsClose(this.#tts);
      }
    }
    if (this.#phase === "speaking") this.#phase = "idle";
  }

  #send(message: Record<string, unknown>): void {
    if (this.ws) send(this.ws, message);
  }

  #sendBinary(bytes: Uint8Array): void {
    this.ws?.send(bytes);
  }

  #state(caption?: { role: "user" | "assistant"; text: string; provisional: boolean }): void {
    this.#send({ kind: "voice-state", generation: this.#generation, phase: this.#phase, ...(caption ? { caption } : {}) });
  }

  #isCurrent(generation: number): boolean {
    return !this.#closed && generation === this.#generation;
  }

  async #beginPendingStt(): Promise<void> {
    const generation = this.#pendingStart;
    if (generation === null || this.#sttTurn || !this.#isCurrent(generation)) return;
    let stt: WebSocket;
    try {
      stt = await this.#ensureStt();
    } catch (error) {
      if (this.#isCurrent(generation)) this.#fail("Could not start speech recognition", error);
      return;
    }
    if (this.#stt !== stt || this.#sttTurn || this.#pendingStart !== generation || !this.#isCurrent(generation)) return;

    const turn = { generation, finalText: "", finalizing: false };
    this.#sttTurn = turn;
    this.#pendingStart = null;
    this.#send({ kind: "recording", generation });
    if (this.#pendingEnd === generation) this.#finalizeStt(turn);
  }

  async #ensureStt(): Promise<WebSocket> {
    if (this.#stt) return this.#stt;
    if (this.#openingStt) return this.#openingStt;
    const opening = connect(STT_URL);
    this.#openingStt = opening;
    try {
      const stt = await opening;
      if (this.#closed) {
        stt.close();
        throw new Error("voice relay is closed");
      }
      this.#stt = stt;
      stt.addEventListener("message", (event) => this.#onSttMessage(stt, event));
      stt.addEventListener("close", () => this.#onSttClose(stt));
      stt.send(JSON.stringify(sttConfig(this.cfg.sonioxApiKey)));
      return stt;
    } finally {
      if (this.#openingStt === opening) this.#openingStt = null;
    }
  }

  #finalizeStt(turn: SttTurn): void {
    if (turn.finalizing) return;
    turn.finalizing = true;
    const stt = this.#stt;
    try {
      stt?.send(STT_FINAL_SILENCE);
      stt?.send(JSON.stringify({ type: "finalize" }));
      this.#scheduleSttFinalizationTimeout(turn);
    } catch {
      stt?.close();
      this.#onSttClose(stt);
    }
  }

  #clearSttFinalizationTimeout(): void {
    if (this.#sttFinalizationTimeout) clearTimeout(this.#sttFinalizationTimeout);
    this.#sttFinalizationTimeout = null;
  }

  #scheduleSttFinalizationTimeout(turn: SttTurn): void {
    this.#clearSttFinalizationTimeout();
    this.#sttFinalizationTimedOut = false;
    this.#sttFinalizationTimeout = setTimeout(() => {
      this.#sttFinalizationTimeout = null;
      if (this.#sttTurn !== turn) return;
      this.#sttFinalizationTimedOut = true;
      const stt = this.#stt;
      stt?.close();
      this.#onSttClose(stt);
    }, STT_FINALIZATION_TIMEOUT_MS);
  }

  #onSttMessage(stt: WebSocket, event: MessageEvent): void {
    if (this.#stt !== stt || typeof event.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    const turn = this.#sttTurn;
    if (!turn) return;
    const update = sttUpdate(raw);
    if (update.error) {
      this.#clearSttFinalizationTimeout();
      this.#sttTurn = null;
      stt.close();
      if (this.#isCurrent(turn.generation)) this.#fail(update.error);
      return;
    }
    turn.finalText += update.final;
    const caption = `${turn.finalText}${update.partial}`;
    if (this.#isCurrent(turn.generation)) {
      this.#state(caption ? { role: "user", text: caption, provisional: true } : undefined);
    }
    if (!update.finished) return;

    this.#clearSttFinalizationTimeout();
    this.#sttTurn = null;
    if (this.#isCurrent(turn.generation)) {
      const text = turn.finalText.trim();
      this.audit.record({
        action: "voice.transcript",
        paneId: this.#socketData.paneId,
        session: this.#socketData.session,
        device: this.#socketData.device,
        detail: { text, length: text.length },
      });
      this.#phase = text ? "working" : "idle";
      this.#state(text ? { role: "user", text, provisional: false } : undefined);
      this.#send({ kind: "final", generation: turn.generation, text });
    }
    void this.#beginPendingStt();
  }

  #onSttClose(stt: WebSocket | null): void {
    if (!stt || this.#stt !== stt) return;
    this.#clearSttFinalizationTimeout();
    const timedOut = this.#sttFinalizationTimedOut;
    this.#sttFinalizationTimedOut = false;
    this.#stt = null;
    const turn = this.#sttTurn;
    this.#sttTurn = null;
    if (turn && this.#isCurrent(turn.generation)) {
      this.#fail(timedOut ? "Speech recognition did not finish" : "Speech recognition connection closed");
    }
    void this.#beginPendingStt();
  }

  async #beginSpeech(speech: TtsTurn, text: string): Promise<void> {
    let tts: WebSocket;
    try {
      tts = await this.#ensureTts();
    } catch (error) {
      if (this.#speech === speech && this.#isCurrent(speech.generation)) {
        this.#speech = null;
        this.#fail("Could not start speech playback", error);
      }
      return;
    }
    if (this.#tts !== tts || this.#speech !== speech || !this.#isCurrent(speech.generation)) return;
    try {
      tts.send(JSON.stringify(ttsConfig(this.cfg.sonioxApiKey, this.cfg.sonioxTtsVoice, speech.streamId)));
      tts.send(JSON.stringify({ text, text_end: true, stream_id: speech.streamId }));
      if (!this.#ttsKeepalive) {
        this.#ttsKeepalive = setInterval(() => {
          try {
            this.#tts?.send(JSON.stringify({ keep_alive: true }));
          } catch {
            this.#onTtsClose(this.#tts);
          }
        }, 20_000);
      }
      this.#phase = "speaking";
      this.#state({ role: "assistant", text, provisional: false });
    } catch (error) {
      if (this.#speech === speech && this.#isCurrent(speech.generation)) {
        this.#speech = null;
        this.#fail("Could not start speech playback", error);
      }
    }
  }

  async #ensureTts(): Promise<WebSocket> {
    if (this.#tts) return this.#tts;
    if (this.#openingTts) return this.#openingTts;
    const opening = connect(TTS_URL);
    this.#openingTts = opening;
    try {
      const tts = await opening;
      if (this.#closed) {
        tts.close();
        throw new Error("voice relay is closed");
      }
      this.#tts = tts;
      tts.addEventListener("message", (event) => this.#onTtsMessage(tts, event));
      tts.addEventListener("close", () => this.#onTtsClose(tts));
      return tts;
    } finally {
      if (this.#openingTts === opening) this.#openingTts = null;
    }
  }

  #onTtsMessage(tts: WebSocket, event: MessageEvent): void {
    if (this.#tts !== tts || typeof event.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    const response = ttsResponse(raw);
    if (!response) return;
    const streamId = typeof response.stream_id === "string" ? response.stream_id : null;
    if (!streamId) return;
    const speech = this.#speech;
    if (response.terminated === true) {
      if (!speech || speech.streamId !== streamId) return;
      this.#speech = null;
      if (!this.#isCurrent(speech.generation) || this.#phase !== "speaking") return;
      this.#awaitingPlayback = speech;
      this.#send({ kind: "tts-end", generation: speech.generation, streamId });
      return;
    }
    if (!speech || speech.streamId !== streamId || !this.#isCurrent(speech.generation)) return;
    if (typeof response.error_message === "string") {
      this.#speech = null;
      this.#fail(response.error_message);
      return;
    }
    if (typeof response.audio !== "string") return;
    this.#send({ kind: "tts", generation: speech.generation, streamId, sampleRate: SAMPLE_RATE });
    this.#sendBinary(Buffer.from(response.audio, "base64"));
  }

  #onTtsClose(tts: WebSocket | null): void {
    if (!tts || this.#tts !== tts) return;
    this.#tts = null;
    if (this.#ttsKeepalive) clearInterval(this.#ttsKeepalive);
    this.#ttsKeepalive = null;
    const speech = this.#speech;
    this.#speech = null;
    if (speech && this.#isCurrent(speech.generation)) this.#fail("Speech playback connection closed");
  }

  #cancelSpeech(): void {
    this.#queuedSpeech = [];
    this.#awaitingPlayback = null;
    const speech = this.#speech;
    if (!speech) return;
    this.#speech = null;
    try {
      this.#tts?.send(JSON.stringify({ stream_id: speech.streamId, cancel: true }));
    } catch {
      this.#onTtsClose(this.#tts);
    }
  }

  #fail(message: string, error?: unknown): void {
    this.#queuedSpeech = [];
    this.#phase = "idle";
    this.#state();
    this.#send({ kind: "error", message });
    if (error) console.warn(`[voice] ${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Owns one browser relay per OMP session. The session file is resolved by server.ts, never supplied
 * by a browser; that keeps OMP's on-disk layout out of the wire protocol.
 */
export class VoiceBroker {
  #relays = new Map<string, TurnController>();
  #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cfg: Config,
    private readonly audit: AuditLog,
  ) {}

  async open(ws: VoiceSocket): Promise<void> {
    const session = ws.data.sessionFile;
    const prior = this.#relays.get(session);
    if (prior?.attach(ws)) {
      this.#clearReconnectExpiry(session);
      this.#recordConnect(ws);
      send(ws, { kind: "ready" });
      return;
    }
    this.#clearReconnectExpiry(session);
    if (prior) {
      prior.close();
      this.#relays.delete(session);
    }
    try {
      await this.#setRemote(session, "remote-start");
    } catch (error) {
      send(ws, { kind: "error", message: "Laptop voice relay is unavailable" });
      ws.close(1011, "voice relay unavailable");
      console.warn(`[voice] couldn't activate laptop relay: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#relays.set(session, new TurnController(this.cfg, this.audit, ws));
    this.#recordConnect(ws);
    send(ws, { kind: "ready" });
  }

  close(ws: VoiceSocket): void {
    const session = ws.data.sessionFile;
    const relay = this.#relays.get(session);
    if (!relay || !relay.owns(ws)) return;
    if (relay.detach(ws)) {
      this.#scheduleReconnectExpiry(session, relay);
      return;
    }
    this.#releaseRelay(session, relay);
  }

  async message(ws: VoiceSocket, message: string | Uint8Array): Promise<void> {
    const relay = this.#relays.get(ws.data.sessionFile);
    if (!relay || !relay.owns(ws)) return;
    if (typeof message !== "string") return relay.audio(message);
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return send(ws, { kind: "error", message: "Invalid voice message" });
    }
    if (!raw || typeof raw !== "object") return send(ws, { kind: "error", message: "Invalid voice message" });
    const kind = "kind" in raw ? raw.kind : undefined;
    const generation = "generation" in raw ? raw.generation : undefined;
    const streamId = "streamId" in raw ? raw.streamId : undefined;
    switch (kind) {
      case "start":
        return relay.start();
      case "end":
        return relay.end();
      case "release":
        relay.release();
        await this.#setRemote(ws.data.sessionFile, "remote-release").catch(() => undefined);
        return;
      case "handoff":
        send(ws, { kind: "handoff-ready", generation, accepted: relay.handoff(generation) });
        return;
      case "resume":
        send(ws, { kind: "resumed", accepted: relay.resume() });
        return;
      case "playback-ended":
        return relay.playbackEnded(generation, streamId);
      case "keepalive":
        return;
      default:
        return send(ws, { kind: "error", message: "Unknown voice message" });
    }
  }

  /** Receives a final-only OMP extension event from the local daemon, never from a browser. */
  speak(sessionFile: string, text: string): boolean {
    return this.#relays.get(sessionFile)?.speak(text) ?? false;
  }

  /** Releases a browser turn when OMP has no speech to play. */
  release(sessionFile: string): boolean {
    const relay = this.#relays.get(sessionFile);
    if (!relay) return false;
    relay.release();
    if (relay.detached) this.#releaseRelay(sessionFile, relay);
    return true;
  }

  #recordConnect(ws: VoiceSocket): void {
    this.audit.record({
      action: "voice.connect",
      paneId: ws.data.paneId,
      session: ws.data.session,
      device: ws.data.device,
      detail: {},
    });
  }

  #clearReconnectExpiry(session: string): void {
    const timer = this.#reconnectTimers.get(session);
    if (timer) clearTimeout(timer);
    this.#reconnectTimers.delete(session);
  }

  #scheduleReconnectExpiry(session: string, relay: TurnController): void {
    if (this.#reconnectTimers.has(session)) return;
    this.#reconnectTimers.set(session, setTimeout(() => {
      this.#reconnectTimers.delete(session);
      if (this.#relays.get(session) === relay && relay.detached) this.#releaseRelay(session, relay);
    }, RECONNECT_GRACE_MS));
  }

  #releaseRelay(session: string, relay: TurnController): void {
    this.#clearReconnectExpiry(session);
    if (this.#relays.get(session) !== relay) return;
    void this.#setRemote(session, "remote-release").catch(() => undefined);
    relay.close();
    this.#relays.delete(session);
  }

  async #setRemote(session: string, kind: "remote-start" | "remote-release"): Promise<void> {
    const token = (await readFile(this.cfg.voiceControlTokenFile, "utf8")).trim();
    if (!token) throw new Error("voice control token is empty");
    const response = await fetch(this.cfg.voiceControlUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-omp-voice-token": token },
      body: JSON.stringify({
        kind,
        session,
        ...(kind === "remote-start" ? { relayUrl: `http://127.0.0.1:${this.cfg.port}/api/voice/omp` } : {}),
      }),
    });
    if (!response.ok) throw new Error(`voice control returned ${response.status}: ${(await response.text()).trim()}`);
  }
}
