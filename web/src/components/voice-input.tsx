import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject, PointerEvent } from "react";
import { Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { VoiceButtonMode } from "@/hooks/use-display-prefs";

export type VoicePhase = "idle" | "listening" | "finalizing" | "working" | "speaking";

export type VoiceState = {
  generation: number;
  phase: VoicePhase;
  caption?: { role: "user" | "assistant"; text: string; provisional: boolean };
};

type VoiceInputProps = {
  paneId: string;
  session?: string;
  mode: VoiceButtonMode;
  disabled: boolean;
  onTranscript: (text: string) => Promise<boolean>;
  onVoiceStateChange: (state: VoiceState | null) => void;
  onError: (message: string) => void;
};

type Capture = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
};

type VoiceMessage =
  | { kind: "ready" }
  | { kind: "recording"; generation: number }
  | { kind: "voice-state"; generation: number; phase: VoicePhase; caption?: VoiceState["caption"] }
  | { kind: "clear"; generation: number }
  | { kind: "final"; generation: number; text: string }
  | { kind: "tts"; generation: number; streamId: string; sampleRate: number }
  | { kind: "tts-end"; generation: number; streamId: string }
  | { kind: "handoff-ready"; generation: number; accepted: boolean }
  | { kind: "error"; message: string };

type State = "idle" | "connecting" | "recording" | "stopping" | "sending";

function isVoicePhase(value: unknown): value is VoicePhase {
  return value === "idle" || value === "listening" || value === "finalizing" || value === "working" || value === "speaking";
}

function parseVoiceMessage(raw: unknown): VoiceMessage | null {
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return null;
  const generation = "generation" in raw && typeof raw.generation === "number" ? raw.generation : null;
  switch (raw.kind) {
    case "ready":
      return { kind: "ready" };
    case "recording":
      return generation === null ? null : { kind: "recording", generation };
    case "clear":
      return generation === null ? null : { kind: "clear", generation };
    case "final":
      return generation === null || !("text" in raw) || typeof raw.text !== "string"
        ? null
        : { kind: "final", generation, text: raw.text };
    case "tts":
      return generation === null || !("streamId" in raw) || typeof raw.streamId !== "string" ||
          !("sampleRate" in raw) || typeof raw.sampleRate !== "number"
        ? null
        : { kind: "tts", generation, streamId: raw.streamId, sampleRate: raw.sampleRate };
    case "tts-end":
      return generation === null || !("streamId" in raw) || typeof raw.streamId !== "string"
        ? null
        : { kind: "tts-end", generation, streamId: raw.streamId };
    case "handoff-ready":
      return generation === null || !("accepted" in raw) || typeof raw.accepted !== "boolean"
        ? null
        : { kind: "handoff-ready", generation, accepted: raw.accepted };
    case "error":
      return !("message" in raw) || typeof raw.message !== "string" ? null : { kind: "error", message: raw.message };
    case "voice-state": {
      if (generation === null || !("phase" in raw) || !isVoicePhase(raw.phase)) return null;
      if (!("caption" in raw)) return { kind: "voice-state", generation, phase: raw.phase };
      const caption = raw.caption;
      if (
        !caption ||
        typeof caption !== "object" ||
        !("role" in caption) ||
        (caption.role !== "user" && caption.role !== "assistant") ||
        !("text" in caption) ||
        typeof caption.text !== "string" ||
        !("provisional" in caption) ||
        typeof caption.provisional !== "boolean"
      ) return null;
      return { kind: "voice-state", generation, phase: raw.phase, caption: { role: caption.role, text: caption.text, provisional: caption.provisional } };
    }
    default:
      return null;
  }
}

const STT_SAMPLE_RATE = 16_000;

/** Convert microphone floats to the exact mono PCM format the bridge accepts. */
export function pcm16(input: Float32Array, inputRate: number): Int16Array<ArrayBuffer> {
  const output = new Int16Array(new ArrayBuffer(Math.round((input.length * STT_SAMPLE_RATE) / inputRate) * 2));
  for (let i = 0; i < output.length; i++) {
    const from = Math.floor((i * inputRate) / STT_SAMPLE_RATE);
    const to = Math.min(input.length, Math.floor(((i + 1) * inputRate) / STT_SAMPLE_RATE));
    let total = 0;
    for (let j = from; j < Math.max(from + 1, to); j++) total += input[j] ?? 0;
    output[i] = Math.round((Math.max(-1, Math.min(1, total / Math.max(1, to - from))) * 0x7fff));
  }
  return output;
}

function newDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type Handoff = { generation: number; resolve: (accepted: boolean) => void };

/** Small queued PCM player: no encoded-audio MIME assumptions, no buffering dependency. */
class PcmPlayer {
  #context: AudioContext | null = null;
  #sources = new Set<AudioBufferSourceNode>();
  #nextStart = 0;
  #onDrained: (() => void) | null = null;

  async prepare(): Promise<void> {
    if (!this.#context) this.#context = new AudioContext();
    await this.#context.resume();
  }

  append(bytes: ArrayBuffer, sampleRate: number): void {
    const context = this.#context;
    if (!context) return;
    const samples = new Int16Array(bytes);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      this.#sources.delete(source);
      source.disconnect();
      this.#drain();
    };
    const start = Math.max(context.currentTime + 0.04, this.#nextStart);
    this.#nextStart = start + buffer.duration;
    this.#sources.add(source);
    source.start(start);
  }

  finish(onDrained: () => void): void {
    this.#onDrained = onDrained;
    this.#drain();
  }

  stop(): void {
    this.#onDrained = null;
    const sources = [...this.#sources];
    this.#sources.clear();
    for (const source of sources) source.stop();
    this.#nextStart = 0;
  }

  dispose(): void {
    this.stop();
    void this.#context?.close();
    this.#context = null;
  }

  #drain(): void {
    if (this.#sources.size !== 0) return;
    const onDrained = this.#onDrained;
    this.#onDrained = null;
    onDrained?.();
  }
}

function websocketUrl(paneId: string, session?: string): string {
  const url = new URL("/api/voice/media", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("pane", paneId);
  if (session) url.searchParams.set("session", session);
  return url.toString();
}

/**
 * Russian voice input over the bridge proxy. The browser has microphone access; only the server has
 * SONIOX_API_KEY, and the final text takes Collie's existing guarded reply route into OMP.
 */
export function VoiceInput({
  paneId,
  session,
  mode,
  disabled,
  onTranscript,
  onVoiceStateChange,
  onError,
}: VoiceInputProps) {
  const socketRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef<Promise<WebSocket> | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const playerRef = useRef(new PcmPlayer());
  const wantsRecordingRef = useRef(false);
  const sttReadyRef = useRef(false);
  const bufferedAudioRef = useRef<ArrayBuffer[]>([]);
  const captureFailedRef = useRef(false);
  const disposedRef = useRef(false);
  const handedOffRef = useRef(false);
  const handoffRef = useRef<Handoff | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceRef = useRef<VoiceState | null>(null);
  const showOverlayRef = useRef(true);
  const nextAudioRef = useRef<{ generation: number; streamId: string; sampleRate: number } | null>(null);
  const callbacksRef = useRef({ onTranscript, onVoiceStateChange, onError });
  callbacksRef.current = { onTranscript, onVoiceStateChange, onError };
  const [state, setState] = useState<State>("idle");

  useEffect(
    () => {
      disposedRef.current = false;
      return () => {
        wantsRecordingRef.current = false;
        sttReadyRef.current = false;
        bufferedAudioRef.current = [];
        settleHandoff(false);
        releaseRemote();
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        stopCapture(captureRef);
        playerRef.current.dispose();
        socketRef.current?.close();
        publishVoice(null);
      };
    },
    [],
  );

  function releaseRemote(): void {
    const socket = socketRef.current;
    if (!handedOffRef.current && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: "release" }));
    }
  }

  function publishVoice(next: VoiceState | null): void {
    voiceRef.current = next;
    callbacksRef.current.onVoiceStateChange(showOverlayRef.current ? next : null);
  }

  function hideVoiceOverlay(): void {
    showOverlayRef.current = false;
    callbacksRef.current.onVoiceStateChange(null);
  }

  function settleHandoff(accepted: boolean, generation?: number): void {
    const handoff = handoffRef.current;
    if (!handoff || (generation !== undefined && handoff.generation !== generation)) return;
    handoffRef.current = null;
    handoff.resolve(accepted);
  }

  function reportError(message: string) {
    if (disposedRef.current) return;
    wantsRecordingRef.current = false;
    sttReadyRef.current = false;
    bufferedAudioRef.current = [];
    nextAudioRef.current = null;
    settleHandoff(false);
    releaseRemote();
    stopCapture(captureRef);
    playerRef.current.stop();
    publishVoice(null);
    setState("idle");
    callbacksRef.current.onError(message);
  }

  function connect(): Promise<WebSocket> {
    if (socketRef.current?.readyState === WebSocket.OPEN) return Promise.resolve(socketRef.current);
    if (connectingRef.current) return connectingRef.current;
    const deferred = newDeferred<WebSocket>();
    const socket = new WebSocket(websocketUrl(paneId, session));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    connectingRef.current = deferred.promise;
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const audio = nextAudioRef.current;
        const voice = voiceRef.current;
        nextAudioRef.current = null;
        if (audio && voice?.generation === audio.generation && voice.phase === "speaking") {
          playerRef.current.append(event.data, audio.sampleRate);
        }
        return;
      }
      if (typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const message = parseVoiceMessage(raw);
      if (!message) return;
      switch (message.kind) {
        case "ready":
          if (heartbeatRef.current) clearInterval(heartbeatRef.current);
          heartbeatRef.current = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "keepalive" }));
          }, 15_000);
          deferred.resolve(socket);
          return;
        case "recording": {
          if (message.generation !== voiceRef.current?.generation) return;
          sttReadyRef.current = true;
          const buffered = bufferedAudioRef.current;
          bufferedAudioRef.current = [];
          for (const audio of buffered) socket.send(audio);
          if (!wantsRecordingRef.current) socket.send(JSON.stringify({ kind: "end" }));
          return;
        }
        case "voice-state": {
          if (message.generation < (voiceRef.current?.generation ?? 0)) return;
          nextAudioRef.current = null;
          if (message.phase === "idle") {
            publishVoice(null);
            if (!wantsRecordingRef.current) setState("idle");
          } else {
            publishVoice({
              generation: message.generation,
              phase: message.phase,
              ...(message.caption ? { caption: message.caption } : {}),
            });
          }
          return;
        }
        case "clear":
          if (message.generation < (voiceRef.current?.generation ?? 0)) return;
          nextAudioRef.current = null;
          playerRef.current.stop();
          publishVoice(null);
          return;
        case "final":
          if (message.generation === voiceRef.current?.generation) {
            void submitFinal(socket, message.text, message.generation);
          }
          return;
        case "handoff-ready":
          settleHandoff(message.accepted, message.generation);
          return;
        case "tts":
          if (message.generation === voiceRef.current?.generation && voiceRef.current.phase === "speaking") {
            nextAudioRef.current = message;
          }
          return;
        case "tts-end":
          if (message.generation !== voiceRef.current?.generation || voiceRef.current.phase !== "speaking") return;
          playerRef.current.finish(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ kind: "playback-ended", generation: message.generation, streamId: message.streamId }));
            }
          });
          return;
        case "error":
          reportError(message.message);
      }
    };
    socket.onerror = () => deferred.reject(new Error("Voice connection failed"));
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      connectingRef.current = null;
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      settleHandoff(false);
      if (!disposedRef.current && (wantsRecordingRef.current || voiceRef.current?.phase === "working" || voiceRef.current?.phase === "speaking")) {
        reportError("Voice connection closed");
      }
    };
    return deferred.promise;
  }

  async function beginCapture(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!wantsRecordingRef.current || disposedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!wantsRecordingRef.current) return;
        const audio = pcm16(event.inputBuffer.getChannelData(0), context.sampleRate).buffer;
        const socket = socketRef.current;
        if (sttReadyRef.current && socket?.readyState === WebSocket.OPEN) socket.send(audio);
        else bufferedAudioRef.current.push(audio);
      };
      source.connect(processor);
      processor.connect(context.destination); // ScriptProcessor must be connected to receive callbacks.
      captureRef.current = { stream, context, source, processor };
      setState("recording");
    } catch (error) {
      captureFailedRef.current = true;
      reportError(error instanceof Error ? error.message : "Microphone is unavailable");
    }
  }

  async function submitFinal(socket: WebSocket, text: string, generation: number): Promise<void> {
    sttReadyRef.current = false;
    bufferedAudioRef.current = [];
    const transcript = text.trim();
    if (!transcript) {
      reportError("No speech was recognised");
      return;
    }
    setState("sending");
    const handoff = newDeferred<boolean>();
    handoffRef.current = { generation, resolve: handoff.resolve };
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "handoff", generation }));
    else settleHandoff(false, generation);
    if (!await handoff.promise) {
      reportError("Voice handoff was rejected");
      return;
    }
    handedOffRef.current = true;
    let accepted = false;
    try {
      accepted = await callbacksRef.current.onTranscript(transcript);
      if (accepted) hideVoiceOverlay();
    } finally {
      if (!accepted) {
        handedOffRef.current = false;
        releaseRemote();
      }
      wantsRecordingRef.current = false;
      if (!disposedRef.current) setState("idle");
    }
  }

  async function start(): Promise<void> {
    if (disabled || wantsRecordingRef.current || state !== "idle") return;
    settleHandoff(false);
    wantsRecordingRef.current = true;
    sttReadyRef.current = false;
    bufferedAudioRef.current = [];
    nextAudioRef.current = null;
    captureFailedRef.current = false;
    handedOffRef.current = false;
    showOverlayRef.current = true;
    publishVoice(null);
    setState("connecting");
    playerRef.current.stop(); // speaking is interrupted as soon as the user starts a new turn.
    void beginCapture(); // start in this gesture; STT readiness only controls the buffered PCM flush.
    try {
      await playerRef.current.prepare(); // must happen in this gesture for mobile audio playback.
      const socket = await connect();
      if (disposedRef.current || captureFailedRef.current) {
        releaseRemote();
        return;
      }
      socket.send(JSON.stringify({ kind: "start" }));
    } catch (error) {
      reportError(error instanceof Error ? error.message : "Voice input failed");
    }
  }

  function stop(): void {
    if (!wantsRecordingRef.current || state === "stopping" || state === "sending") return;
    wantsRecordingRef.current = false;
    stopCapture(captureRef);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "end" }));
    setState(socket ? "stopping" : "idle");
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (mode !== "push-to-talk" || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    void start();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (mode !== "push-to-talk" || event.repeat || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    void start();
  }

  function handleKeyUp(event: KeyboardEvent<HTMLButtonElement>): void {
    if (mode !== "push-to-talk" || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    stop();
  }

  function handleClick(): void {
    if (mode === "push-to-talk") {
      if (wantsRecordingRef.current) stop();
    } else if (wantsRecordingRef.current) {
      stop();
    } else {
      void start();
    }
  }

  return (
    <Button
      type="button"
      variant={state === "idle" ? "ghost" : "destructive"}
      size="icon"
      className={`rounded-full ${state === "idle" ? "text-muted-foreground" : "text-destructive-foreground"}`}
      disabled={disabled}
      aria-label={
        state === "idle"
          ? mode === "push-to-talk"
            ? "Hold to talk"
            : "Start voice input"
          : mode === "push-to-talk"
            ? "Release to send voice input"
            : "Stop and send voice input"
      }
      aria-pressed={state !== "idle"}
      onPointerDown={handlePointerDown}
      onPointerUp={mode === "push-to-talk" ? stop : undefined}
      onPointerCancel={mode === "push-to-talk" ? stop : undefined}
      onPointerLeave={mode === "push-to-talk" ? stop : undefined}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={handleClick}
    >
      {state === "idle" ? <Mic className="size-4" /> : <span aria-hidden="true" className="size-3 rounded-[1px] bg-current" />}
    </Button>
  );
}

function stopCapture(ref: MutableRefObject<Capture | null>): void {
  const capture = ref.current;
  if (!capture) return;
  ref.current = null;
  capture.processor.disconnect();
  capture.source.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  void capture.context.close();
}
