# Phase 6 local-voice acceptance fixtures

## `whisper-plan-my-day-16k.wav`

| Field          | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Phrase         | `plan my day`                                                      |
| Format         | RIFF WAVE, PCM signed 16-bit little-endian, mono, 16 kHz           |
| Duration       | ~1.47 s                                                            |
| Approx. size   | ~46 KiB                                                            |
| SHA-256        | `09d36ecbb7c00737df3eb862321c312948a0741ad29aa32085685deb1ca96aa3` |
| Generator      | eSpeak NG 1.51 (`espeak-ng -v en-us -s 140`) + ffmpeg resample     |
| Provenance     | Fully synthetic TTS. No human recording. No model weights.         |
| Redistribution | Synthetic computer speech; safe to commit as a tiny test asset.    |

### Reproduce

```bash
espeak-ng -v en-us -s 140 -w /tmp/junban-spoken-raw.wav "plan my day"
ffmpeg -y -i /tmp/junban-spoken-raw.wav -ac 1 -ar 16000 -sample_fmt s16 \
  tests/acceptance/fixtures/whisper-plan-my-day-16k.wav
sha256sum tests/acceptance/fixtures/whisper-plan-my-day-16k.wav
```

This fixture is acceptance-only. It is not served from production `public/`
or shipped as a baseline/model asset. The Playwright acceptance harness
injects the bytes at runtime.
