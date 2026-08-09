import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { pcm16, VoiceInput, type VoiceState } from "./voice-input";

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  static autoReady = true;
  readonly send = vi.fn();
  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
    if (FakeSocket.autoReady) queueMicrotask(() => this.emit({ kind: "ready" }));
  }

  close() {
    this.onclose?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

class FakeAudioContext {
  static processors: ScriptProcessorNode[] = [];
  sampleRate = 48_000;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(
    () => ({ connect: vi.fn(), disconnect: vi.fn() }) as unknown as MediaStreamAudioSourceNode,
  );
  createScriptProcessor = vi.fn(() => {
    const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null } as unknown as ScriptProcessorNode;
    FakeAudioContext.processors.push(processor);
    return processor;
  });
}

const stream = {
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream;

async function startVoice(): Promise<HTMLButtonElement> {
  const button = screen.getByRole("button", { name: "Hold to talk" }) as HTMLButtonElement;
  Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
  fireEvent.pointerDown(button, { pointerId: 1, isPrimary: true });
  await waitFor(() => expect(FakeSocket.instances[0]?.send).toHaveBeenCalledWith('{"kind":"start"}'));
  return button;
}

function releaseVoice(button: HTMLElement): void {
  fireEvent.pointerUp(button, { pointerId: 1, isPrimary: true });
}


describe("VoiceInput", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    FakeSocket.autoReady = true;
    FakeAudioContext.processors = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeSocket });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
  });

  it("commits only the bridge-final transcript and binds it to the active generation", async () => {
    const onTranscript = vi.fn(async () => true);
    const onVoiceStateChange = vi.fn();
    const onError = vi.fn();
    render(
      <StrictMode>
        <VoiceInput
          paneId="w1:p4"
          showControl
          disabled={false}
          onTranscript={onTranscript}
          onVoiceStateChange={onVoiceStateChange}
          onError={onError}
        />
      </StrictMode>,
    );

    const button = await startVoice();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"start"}'));
    FakeSocket.instances[0].emit({ kind: "voice-state", generation: 1, phase: "listening" });
    FakeSocket.instances[0].emit({ kind: "recording", generation: 1 });
    releaseVoice(button);
    FakeSocket.instances[0].emit({
      kind: "voice-state",
      generation: 1,
      phase: "working",
      caption: { role: "user", text: "Привет", provisional: false },
    });
    FakeSocket.instances[0].emit({ kind: "final", generation: 1, text: "Привет" });

    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"handoff","generation":1}'));
    expect(onTranscript).not.toHaveBeenCalled();
    FakeSocket.instances[0].emit({ kind: "handoff-ready", generation: 1, accepted: true });

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));
    expect(onVoiceStateChange).toHaveBeenCalledWith({
      generation: 1,
      phase: "working",
      caption: { role: "user", text: "Привет", provisional: false },
    });
    await waitFor(() => expect(onVoiceStateChange).toHaveBeenLastCalledWith(null));
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
    expect(onError).not.toHaveBeenCalled();
  });

  it("reconnects a handed-off relay after the mobile socket closes", async () => {
    const onTranscript = vi.fn(async () => true);
    const onError = vi.fn();
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={onTranscript}
        onVoiceStateChange={vi.fn()}
        onError={onError}
      />,
    );

    const button = await startVoice();
    releaseVoice(button);
    FakeSocket.instances[0]?.emit({ kind: "voice-state", generation: 1, phase: "working" });
    FakeSocket.instances[0]?.emit({ kind: "final", generation: 1, text: "Привет" });
    await waitFor(() => expect(FakeSocket.instances[0]?.send).toHaveBeenCalledWith('{"kind":"handoff","generation":1}'));
    FakeSocket.instances[0]?.emit({ kind: "handoff-ready", generation: 1, accepted: true });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));

    FakeSocket.instances[0]?.close();

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(FakeSocket.instances[1]?.send).toHaveBeenCalledWith('{"kind":"resume"}');
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not reconnect a handed-off relay after the composer unmounts", async () => {
    const onTranscript = vi.fn(async () => true);
    const { unmount } = render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={onTranscript}
        onVoiceStateChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = await startVoice();
    releaseVoice(button);
    FakeSocket.instances[0]?.emit({ kind: "voice-state", generation: 1, phase: "working" });
    FakeSocket.instances[0]?.emit({ kind: "final", generation: 1, text: "Привет" });
    await waitFor(() => expect(FakeSocket.instances[0]?.send).toHaveBeenCalledWith('{"kind":"handoff","generation":1}'));
    FakeSocket.instances[0]?.emit({ kind: "handoff-ready", generation: 1, accepted: true });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));

    unmount();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("waits for unlock before reconnecting a handed-off relay", async () => {
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const onTranscript = vi.fn(async () => true);
      render(
        <VoiceInput
          paneId="w1:p4"
          showControl
          disabled={false}
          onTranscript={onTranscript}
          onVoiceStateChange={vi.fn()}
          onError={vi.fn()}
        />,
      );

      const button = await startVoice();
      releaseVoice(button);
      FakeSocket.instances[0]?.emit({ kind: "voice-state", generation: 1, phase: "working" });
      FakeSocket.instances[0]?.emit({ kind: "final", generation: 1, text: "Привет" });
      await waitFor(() => expect(FakeSocket.instances[0]?.send).toHaveBeenCalledWith('{"kind":"handoff","generation":1}'));
      FakeSocket.instances[0]?.emit({ kind: "handoff-ready", generation: 1, accepted: true });
      await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));

      FakeSocket.instances[0]?.close();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(FakeSocket.instances).toHaveLength(1);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
      expect(FakeSocket.instances[1]?.send).toHaveBeenCalledWith('{"kind":"resume"}');
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("offers a manual retry when reconnect resume is rejected", async () => {
    const onTranscript = vi.fn(async () => true);
    const onError = vi.fn();
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={onTranscript}
        onVoiceStateChange={vi.fn()}
        onError={onError}
      />,
    );

    const button = await startVoice();
    releaseVoice(button);
    FakeSocket.instances[0]?.emit({ kind: "voice-state", generation: 1, phase: "working" });
    FakeSocket.instances[0]?.emit({ kind: "final", generation: 1, text: "Привет" });
    await waitFor(() => expect(FakeSocket.instances[0]?.send).toHaveBeenCalledWith('{"kind":"handoff","generation":1}'));
    FakeSocket.instances[0]?.emit({ kind: "handoff-ready", generation: 1, accepted: true });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));

    FakeSocket.instances[0]?.close();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    await waitFor(() => expect(FakeSocket.instances[1]?.send).toHaveBeenCalledWith('{"kind":"resume"}'));
    act(() => FakeSocket.instances[1]?.emit({ kind: "resumed", accepted: false }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Voice reconnect was rejected. Tap Reconnect to retry."));

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect voice" }));
    await waitFor(() => {
      expect(FakeSocket.instances[1]?.send.mock.calls.filter(([message]) => message === '{"kind":"resume"}')).toHaveLength(2);
    });
  });

  it("stops an active voice turn on its second click", async () => {
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onVoiceStateChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = await startVoice();
    releaseVoice(button);
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
  });

  it("drops a microphone callback racing with the stop message", async () => {
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onVoiceStateChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = await startVoice();
    await waitFor(() => expect(FakeAudioContext.processors).toHaveLength(1));
    FakeSocket.instances[0].emit({ kind: "voice-state", generation: 1, phase: "listening" });
    FakeSocket.instances[0].emit({ kind: "recording", generation: 1 });
    releaseVoice(button);
    FakeAudioContext.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4096) },
    } as unknown as AudioProcessingEvent);
    FakeSocket.instances[0].emit({ kind: "voice-state", generation: 1, phase: "idle" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Hold to talk" })).toBeTruthy());

    expect(FakeSocket.instances[0].send.mock.calls.filter(([message]) => message instanceof ArrayBuffer)).toHaveLength(0);
  });

  it("ends only on release in push-to-talk mode", async () => {
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onVoiceStateChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = await startVoice();
    releaseVoice(button);
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
  });

  it("keeps a held PTT control mounted when a provisional caption fills the composer", async () => {
    function ComposerVoiceHarness() {
      const [input, setInput] = useState("");
      const [voice, setVoice] = useState<VoiceState | null>(null);
      return (
        <>
          <output>{input}</output>
          <VoiceInput
            paneId="w1:p4"
            showControl={!input.trim() || voice !== null}
            disabled={false}
            onTranscript={vi.fn(async () => true)}
            onVoiceStateChange={(next) => {
              if (next?.caption?.role === "user") {
                setInput(next.caption.text);
                setVoice({ ...next, caption: undefined });
                return;
              }
              setVoice(next);
            }}
            onError={vi.fn()}
          />
        </>
      );
    }

    render(<ComposerVoiceHarness />);
    const button = await startVoice();
    act(() => {
      FakeSocket.instances[0]?.emit({
        kind: "voice-state",
        generation: 1,
        phase: "listening",
        caption: { role: "user", text: "Привет", provisional: true },
      });
    });
    await waitFor(() => expect(screen.getByText("Привет")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Release to send voice input" })).toBe(button);

    releaseVoice(button);
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
  });

  it("keeps early PCM eligible when push-to-talk ends before the bridge is ready", async () => {
    FakeSocket.autoReady = false;
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onVoiceStateChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Hold to talk" });
    Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(button, { pointerId: 1, isPrimary: true });
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    releaseVoice(button);
    FakeSocket.instances[0].emit({ kind: "ready" });
    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"start"}'));
    FakeSocket.instances[0].emit({ kind: "recording", generation: 1 });
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
  });


  it("keeps the assistant caption until the matching TTS stream drains", async () => {
    const onVoiceStateChange = vi.fn();
    render(
      <VoiceInput
        paneId="w1:p4"
        showControl
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onVoiceStateChange={onVoiceStateChange}
        onError={vi.fn()}
      />,
    );

    await startVoice();
    FakeSocket.instances[0].emit({
      kind: "voice-state",
      generation: 1,
      phase: "speaking",
      caption: { role: "assistant", text: "Ответ", provisional: false },
    });
    expect(onVoiceStateChange).toHaveBeenCalledWith({
      generation: 1,
      phase: "speaking",
      caption: { role: "assistant", text: "Ответ", provisional: false },
    });

    FakeSocket.instances[0].emit({ kind: "tts-end", generation: 1, streamId: "reply-1" });
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith(
      '{"kind":"playback-ended","generation":1,"streamId":"reply-1"}',
    );
  });
  it("downsamples microphone floats to Soniox's 16 kHz signed PCM", () => {
    expect(Array.from(pcm16(new Float32Array([1, -1, 0.5, -0.5]), 8_000))).toEqual([
      32767,
      32767,
      -32767,
      -32767,
      16384,
      16384,
      -16383,
      -16383,
    ]);
  });
});
