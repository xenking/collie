import { describe, expect, test } from "bun:test";

import { sttConfig, sttUpdate, ttsConfig, voiceTokenMatches } from "./voice.ts";

describe("Soniox proxy contracts", () => {
  test("accepts only final STT tokens for OMP submission", () => {
    expect(sttUpdate({
      tokens: [
        { text: "При", is_final: true },
        { text: "вет", is_final: false },
      ],
      finished: true,
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
});
