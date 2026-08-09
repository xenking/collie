import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject, PointerEvent } from "react";
import { Mic, Square } from "lucide-react";

import { Button } from "@/components/ui/button";

type VoiceInputProps = {
  paneId: string;
  session?: string;
  disabled: boolean;
  onTranscript: (text: string) => Promise<boolean>;
  onTranscriptChange: (text: string | null) => void;
  onError: (message: string) => void;
};

type State = "idle" | "connecting" | "recording" | "stopping" | "sending";
type Capture = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
};

type VoiceMessage =
  | { kind: "ready" | "recording" | "tts-end" }
  | { kind: "transcript" | "final"; text: string }
  | { kind: "error"; message: string }
  | { kind: "tts"; sampleRate: number };

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

/** Small queued PCM player: no encoded-audio MIME assumptions, no buffering dependency. */
class PcmPlayer {
  #context: AudioContext | null = null;
  #sources = new Set<AudioBufferSourceNode>();
  #nextStart = 0;

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
    };
    const start = Math.max(context.currentTime + 0.04, this.#nextStart);
    this.#nextStart = start + buffer.duration;
    this.#sources.add(source);
    source.start(start);
  }

  stop(): void {
    for (const source of this.#sources) source.stop();
    this.#sources.clear();
    this.#nextStart = 0;
  }

  dispose(): void {
    this.stop();
    void this.#context?.close();
    this.#context = null;
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
 * Russian push-to-talk over the bridge proxy. The browser has microphone access; only the server has
 * SONIOX_API_KEY, and the final text takes Collie's existing guarded reply route into OMP.
 */
export function VoiceInput({ paneId, session, disabled, onTranscript, onTranscriptChange, onError }: VoiceInputProps) {
  const socketRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef<Promise<WebSocket> | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const playerRef = useRef(new PcmPlayer());
  const wantsRecordingRef = useRef(false);
  const disposedRef = useRef(false);
  const handedOffRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacksRef = useRef({ onTranscript, onTranscriptChange, onError });
  callbacksRef.current = { onTranscript, onTranscriptChange, onError };
  const [state, setState] = useState<State>("idle");

  useEffect(
    () => {
      disposedRef.current = false;
      return () => {
        disposedRef.current = true;
        wantsRecordingRef.current = false;
        releaseRemote();
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        stopCapture(captureRef);
        playerRef.current.dispose();
        socketRef.current?.close();
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

  function reportError(message: string) {
    if (disposedRef.current) return;
    wantsRecordingRef.current = false;
    releaseRemote();
    stopCapture(captureRef);
    setState("idle");
    callbacksRef.current.onTranscriptChange(null);
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
        playerRef.current.append(event.data, 24_000);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: VoiceMessage;
      try {
        message = JSON.parse(event.data) as VoiceMessage;
      } catch {
        return;
      }
      switch (message.kind) {
        case "ready":
          if (heartbeatRef.current) clearInterval(heartbeatRef.current);
          heartbeatRef.current = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "keepalive" }));
          }, 15_000);
          deferred.resolve(socket);
          return;
        case "recording":
          if (wantsRecordingRef.current) void beginCapture(socket);
          else socket.send(JSON.stringify({ kind: "end" }));
          return;
        case "transcript":
          callbacksRef.current.onTranscriptChange(message.text);
          return;
        case "final":
          void submitFinal(socket, message.text);
          return;
        case "tts":
        case "tts-end":
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
      if (!disposedRef.current && wantsRecordingRef.current) reportError("Voice connection closed");
    };
    return deferred.promise;
  }

  async function beginCapture(socket: WebSocket): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!wantsRecordingRef.current || socket.readyState !== WebSocket.OPEN) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN || !wantsRecordingRef.current) return;
        socket.send(pcm16(event.inputBuffer.getChannelData(0), context.sampleRate).buffer);
      };
      source.connect(processor);
      processor.connect(context.destination); // ScriptProcessor must be connected to receive callbacks.
      captureRef.current = { stream, context, source, processor };
      setState("recording");
    } catch (error) {
      reportError(error instanceof Error ? error.message : "Microphone is unavailable");
    }
  }

  async function submitFinal(socket: WebSocket, text: string): Promise<void> {
    stopCapture(captureRef);
    const transcript = text.trim();
    if (!transcript) {
      reportError("No speech was recognised");
      return;
    }
    setState("sending");
    // Claim remote output ownership before the normal reply can make OMP emit a fast final event.
    handedOffRef.current = true;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "handoff" }));
    let accepted = false;
    try {
      accepted = await callbacksRef.current.onTranscript(transcript);
    } finally {
      if (!accepted) {
        handedOffRef.current = false;
        releaseRemote();
      }
      wantsRecordingRef.current = false;
      if (!disposedRef.current) {
        setState("idle");
        callbacksRef.current.onTranscriptChange(null);
      }
    }
  }

  async function start(): Promise<void> {
    if (disabled || wantsRecordingRef.current) return;
    wantsRecordingRef.current = true;
    handedOffRef.current = false;
    callbacksRef.current.onTranscriptChange("");
    setState("connecting");
    playerRef.current.stop(); // speaking is interrupted as soon as the user starts a new turn.
    try {
      await playerRef.current.prepare(); // must happen in this gesture for mobile audio playback.
      const socket = await connect();
      if (!wantsRecordingRef.current) {
        releaseRemote();
        if (!disposedRef.current) {
          setState("idle");
          callbacksRef.current.onTranscriptChange(null);
        }
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

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    void start();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    void start();
  }

  function handleKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    stop();
  }

  function handleClick(): void {
    // Fallback for browsers that deliver a click but lose the matching pointerup.
    if (wantsRecordingRef.current) stop();
  }

  return (
    <Button
      type="button"
      variant={state === "idle" ? "ghost" : "destructive"}
      size="icon"
      className="rounded-full text-muted-foreground"
      disabled={disabled}
      aria-label={state === "idle" ? "Hold to talk" : "Release to send voice input"}
      aria-pressed={state !== "idle"}
      onPointerDown={handlePointerDown}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={handleClick}
    >
      {state === "idle" ? <Mic className="size-4" /> : <Square className="size-3" />}
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
