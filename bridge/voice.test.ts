import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, jest, test } from "bun:test";

import type { Config } from "./config.ts";
import { sttConfig, sttUpdate, ttsConfig, TurnController, VoiceBroker, voiceTokenMatches } from "./voice.ts";

class FakeSonioxSocket extends EventTarget {
  static connections: FakeSonioxSocket[] = [];

  readonly sent: unknown[] = [];
  readonly sentOnce = Promise.withResolvers<void>();

  constructor(readonly url: string) {
    super();
    FakeSonioxSocket.connections.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.sentOnce.resolve();
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  message(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

function relay() {
  const messages: string[] = [];
  const binary: unknown[] = [];
  return {
    data: { paneId: "pane", session: "session", sessionFile: "/session", device: null },
    messages,
    binary,
    send(message: unknown): number {
      if (typeof message === "string") messages.push(message);
      else binary.push(message);
      return 0;
    },
  };
}

function streamId(socket: FakeSonioxSocket, index = 0): string {
  const configs = socket.sent.filter((message) => typeof message === "string" && message.includes("\"stream_id\""));
  const config = configs.at(index);
  if (typeof config !== "string") throw new Error("missing TTS configuration");
  const match = /"stream_id":"([^"]+)"/.exec(config);
  if (!match?.[1]) throw new Error("missing TTS stream ID");
  return match[1];
}


describe("Soniox proxy contracts", () => {
  test("preserves final words but treats Soniox's <fin> marker as turn completion", () => {
    expect(sttUpdate({
      tokens: [
        { text: "При", is_final: true },
        { text: "вет", is_final: false },
        { text: "<fin>", is_final: true },
      ],
    })).toEqual({ final: "При", partial: "вет", finished: true });
  });

  test("pins Russian mono STT and 1.5% faster Russian PCM TTS", () => {
    expect(sttConfig("key")).toMatchObject({
      api_key: "key",
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
      language_hints: ["ru"],
    });
    expect(ttsConfig("key", "Adrian", "stream")).toMatchObject({
      api_key: "key",
      language: "ru",
      voice: "Adrian",
      audio_format: "pcm_s16le",
      sample_rate: 24_000,
      speed: 1.015,
      stream_id: "stream",
    });
  });

  test("rejects a missing, mismatched, or differently-sized local relay token", () => {
    expect(voiceTokenMatches("same", "same")).toBe(true);
    expect(voiceTokenMatches(null, "same")).toBe(false);
    expect(voiceTokenMatches("other", "same")).toBe(false);
    expect(voiceTokenMatches("short", "longer")).toBe(false);
  });

  test("accepts over a minute of raw audio before finalization", async () => {
    const nativeWebSocket = globalThis.WebSocket;
    let controller: TurnController | null = null;
    FakeSonioxSocket.connections = [];
    Reflect.set(globalThis, "WebSocket", FakeSonioxSocket);
    try {
      controller = new TurnController(
        { sonioxApiKey: "key", sonioxTtsVoice: "voice" },
        { record() {} },
        relay(),
      );
      await controller.start();
      const stt = FakeSonioxSocket.connections[0];
      if (!stt) throw new Error("missing STT socket");

      const oneSecond = new Uint8Array(16_000 * 2);
      for (let second = 0; second < 61; second += 1) controller.audio(oneSecond);

      expect(stt.sent.filter((message) => message instanceof Uint8Array)).toHaveLength(61);
      controller.end();
      expect(stt.sent).toContain(JSON.stringify({ type: "finalize" }));
    } finally {
      controller?.close();
      Reflect.set(globalThis, "WebSocket", nativeWebSocket);
    }
  });

  test("queues remote replies until browser playback ends", async () => {
    const nativeWebSocket = globalThis.WebSocket;
    let controller: TurnController | null = null;
    FakeSonioxSocket.connections = [];
    Reflect.set(globalThis, "WebSocket", FakeSonioxSocket);
    try {
      const browser = relay();
      controller = new TurnController(
        { sonioxApiKey: "key", sonioxTtsVoice: "voice" },
        { record() {} },
        browser,
      );

      await controller.start();
      const stt = FakeSonioxSocket.connections[0];
      expect(stt?.url).toContain("transcribe-websocket");
      controller.end();
      expect(stt?.sent).toContain(JSON.stringify({ type: "finalize" }));
      stt?.message({ tokens: [{ text: "Привет", is_final: true }, { text: "<fin>", is_final: true }] });
      expect(browser.messages).toContain(JSON.stringify({ kind: "final", generation: 1, text: "Привет" }));

      controller.handoff(1);
      expect(controller.speak("Ответ")).toBe(true);
      const tts = FakeSonioxSocket.connections[1];
      expect(tts?.url).toContain("tts-websocket");
      if (!tts) throw new Error("missing TTS socket");
      await tts.sentOnce.promise;
      const id = streamId(tts);
      tts.message({ stream_id: id, audio: Buffer.from([1, 0]).toString("base64") });
      expect(browser.binary).toHaveLength(1);
      expect(controller.speak("Следующий ответ")).toBe(true);
      tts.message({ stream_id: id, terminated: true });
      expect(browser.messages).toContain(JSON.stringify({ kind: "tts-end", generation: 1, streamId: id }));

      controller.playbackEnded(1, id);
      expect(browser.messages).toContain(JSON.stringify({ kind: "voice-state", generation: 1, phase: "idle" }));
      await Promise.resolve();
      const nextId = streamId(tts, -1);
      expect(nextId).not.toBe(id);
      tts.message({ stream_id: nextId, terminated: true });
      controller.playbackEnded(1, nextId);
      await controller.start();
      expect(FakeSonioxSocket.connections).toHaveLength(2);
    } finally {
      controller?.close();
      Reflect.set(globalThis, "WebSocket", nativeWebSocket);
    }
  });

  test("returns a remote turn to idle when OMP has no speech", async () => {
    const nativeWebSocket = globalThis.WebSocket;
    let controller: TurnController | null = null;
    FakeSonioxSocket.connections = [];
    Reflect.set(globalThis, "WebSocket", FakeSonioxSocket);
    try {
      const browser = relay();
      controller = new TurnController(
        { sonioxApiKey: "key", sonioxTtsVoice: "voice" },
        { record() {} },
        browser,
      );
      await controller.start();
      const stt = FakeSonioxSocket.connections[0];
      controller.end();
      stt?.message({ tokens: [{ text: "Привет", is_final: true }, { text: "<fin>", is_final: true }] });
      controller.handoff(1);

      controller.release();

      expect(browser.messages).toContain(JSON.stringify({ kind: "voice-state", generation: 1, phase: "idle" }));
      expect(controller.speak("Поздний ответ")).toBe(false);
    } finally {
      controller?.close();
      Reflect.set(globalThis, "WebSocket", nativeWebSocket);
    }
  });

  test("sends final silence and frees a stalled STT finalization", async () => {
    const nativeWebSocket = globalThis.WebSocket;
    const clock = jest.useFakeTimers();
    let controller: TurnController | null = null;
    FakeSonioxSocket.connections = [];
    Reflect.set(globalThis, "WebSocket", FakeSonioxSocket);
    try {
      const browser = relay();
      controller = new TurnController(
        { sonioxApiKey: "key", sonioxTtsVoice: "voice" },
        { record() {} },
        browser,
      );

      await controller.start();
      const stt = FakeSonioxSocket.connections[0];
      if (!stt) throw new Error("missing STT socket");
      controller.end();

      const finalize = stt.sent.indexOf(JSON.stringify({ type: "finalize" }));
      expect(finalize).toBeGreaterThan(0);
      const silence = stt.sent[finalize - 1];
      expect(silence).toBeInstanceOf(Uint8Array);
      if (!(silence instanceof Uint8Array)) throw new Error("missing final silence");
      expect(silence.byteLength).toBe(6_400);

      clock.advanceTimersByTime(5_000);
      expect(browser.messages).toContain(JSON.stringify({ kind: "voice-state", generation: 1, phase: "idle" }));
      expect(browser.messages).toContain(JSON.stringify({ kind: "error", message: "Speech recognition did not finish" }));
    } finally {
      controller?.close();
      clock.useRealTimers();
      Reflect.set(globalThis, "WebSocket", nativeWebSocket);
    }
  });

  test("cancels an interrupted Soniox stream and drops its stale audio", async () => {
    const nativeWebSocket = globalThis.WebSocket;
    let controller: TurnController | null = null;
    FakeSonioxSocket.connections = [];
    Reflect.set(globalThis, "WebSocket", FakeSonioxSocket);
    try {
      const browser = relay();
      controller = new TurnController(
        { sonioxApiKey: "key", sonioxTtsVoice: "voice" },
        { record() {} },
        browser,
      );

      await controller.start();
      const stt = FakeSonioxSocket.connections[0];
      controller.end();
      stt?.message({ tokens: [{ text: "Привет", is_final: true }, { text: "<fin>", is_final: true }] });
      controller.handoff(1);
      controller.speak("Ответ");
      const tts = FakeSonioxSocket.connections[1];
      if (!tts) throw new Error("missing TTS socket");
      await tts.sentOnce.promise;
      const id = streamId(tts);

      await controller.start();
      expect(tts.sent).toContain(JSON.stringify({ stream_id: id, cancel: true }));
      const binaryBefore = browser.binary.length;
      tts.message({ stream_id: id, audio: Buffer.from([2, 0]).toString("base64") });
      expect(browser.binary).toHaveLength(binaryBefore);
    } finally {
      controller?.close();
      Reflect.set(globalThis, "WebSocket", nativeWebSocket);
    }
  });
});

describe("VoiceBroker remote lease", () => {
  test("queues remote replies while a handed-off browser reconnects", async () => {
    const nativeFetch = globalThis.fetch;
    const nativeWebSocket = globalThis.WebSocket;
    const tokenFile = join(tmpdir(), `collie-voice-${crypto.randomUUID()}.token`);
    const remoteEvents: Array<{ kind: string }> = [];
    FakeSonioxSocket.connections = [];
    await writeFile(tokenFile, "token", { mode: 0o600 });
    Reflect.set(globalThis, "WebSocket", FakeSonioxSocket);
    Reflect.set(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      remoteEvents.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    try {
      const firstBrowser = relay();
      const broker = new VoiceBroker({
        sonioxApiKey: "key",
        sonioxTtsVoice: "voice",
        voiceControlUrl: "http://127.0.0.1:49371/speech",
        voiceControlTokenFile: tokenFile,
      } as Config, { record() {} } as never);

      await broker.open(firstBrowser as never);
      await broker.message(firstBrowser as never, JSON.stringify({ kind: "start" }));
      const stt = FakeSonioxSocket.connections[0];
      await broker.message(firstBrowser as never, JSON.stringify({ kind: "end" }));
      stt?.message({ tokens: [{ text: "Привет", is_final: true }, { text: "<fin>", is_final: true }] });
      await broker.message(firstBrowser as never, JSON.stringify({ kind: "handoff", generation: 1 }));
      broker.close(firstBrowser as never);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(remoteEvents.map(event => event.kind)).toEqual(["remote-start"]);
      expect(broker.speak("/session", "Ответ")).toBe(true);

      const reconnectedBrowser = relay();
      await broker.open(reconnectedBrowser as never);
      await broker.message(reconnectedBrowser as never, JSON.stringify({ kind: "resume" }));
      const tts = FakeSonioxSocket.connections[1];
      if (!tts) throw new Error("missing TTS socket");
      await tts.sentOnce.promise;
      const id = streamId(tts);
      tts.message({ stream_id: id, audio: Buffer.from([1, 0]).toString("base64") });

      expect(reconnectedBrowser.messages).toContain(JSON.stringify({ kind: "resumed", accepted: true }));
      expect(reconnectedBrowser.binary).toHaveLength(1);
      expect(remoteEvents.map(event => event.kind)).toEqual(["remote-start"]);

      broker.release("/session");
      broker.close(reconnectedBrowser as never);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(remoteEvents.map(event => event.kind)).toEqual(["remote-start", "remote-release"]);
    } finally {
      Reflect.set(globalThis, "fetch", nativeFetch);
      Reflect.set(globalThis, "WebSocket", nativeWebSocket);
      await rm(tokenFile, { force: true });
    }
  });

  test("keeps remote ownership during the reconnect grace", async () => {
    const nativeFetch = globalThis.fetch;
    const tokenFile = join(tmpdir(), `collie-voice-${crypto.randomUUID()}.token`);
    const remoteEvents: Array<{ kind: string }> = [];
    await writeFile(tokenFile, "token", { mode: 0o600 });
    Reflect.set(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      remoteEvents.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    try {
      const browser = relay();
      const broker = new VoiceBroker({
        sonioxApiKey: "key",
        sonioxTtsVoice: "voice",
        voiceControlUrl: "http://127.0.0.1:49371/speech",
        voiceControlTokenFile: tokenFile,
      } as Config, { record() {} } as never);

      await broker.open(browser as never);
      await broker.message(browser as never, JSON.stringify({ kind: "resume" }));

      expect(browser.messages).toContain(JSON.stringify({ kind: "resumed", accepted: true }));

      broker.close(browser as never);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(remoteEvents.map(event => event.kind)).toEqual(["remote-start"]);
    } finally {
      Reflect.set(globalThis, "fetch", nativeFetch);
      await rm(tokenFile, { force: true });
    }
  });
});
