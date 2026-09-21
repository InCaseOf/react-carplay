# Native i.MX6 CarPlay client

First-draft implementation of the design in
[../imx6-native-client.md](../imx6-native-client.md). **Not yet built or run
on the actual board** - written this session without a toolchain/SBC access,
so treat it as a strong starting point to compile, fix, and test against
real hardware, not a finished client.

## What it does

Connects to the SBC's `/native` WebSocket endpoint (added to
[../src/main/Socket.ts](../src/main/Socket.ts)), and:

- Feeds received H.264 video chunks into `vpudec ! imxv4l2sink` (hardware
  decode).
- Feeds received PCM audio chunks into a per-`(decodeType, audioType)`
  `alsasink` pipeline, using the exact `decodeType -> {frequency, channels}`
  table from `node-carplay`'s `decodeTypeMap` (see `DECODE_TYPE_MAP` in
  `src/main.c` - keep it in sync if that table ever changes upstream).
- Captures the board's mic via `alsasrc` and sends 16kHz mono PCM back.
- Reads `/dev/input/event0` (the confirmed EETI eGalax touchscreen) and
  sends normalized touch down/move/up events back.

See the protocol table in `imx6-native-client.md` - `src/main.c`'s
`TAG_*` constants mirror it exactly.

## Building

Requires an NXP Yocto SDK matching this board's BSP (confirmed over SSH:
no `gcc` on the board itself, so this can't be built in place). Source the
SDK's `environment-setup-*` script first, which points `CC`/`pkg-config`
at the target sysroot, then:

```bash
make
```

This also needs `libwebsockets` available in that sysroot (for the raw
WebSocket client - see "Why tagged binary frames instead of JSON" in the
design doc for why libwebsockets/no-JSON was chosen over reimplementing
socket.io's engine.io framing). If it's not already in the SDK's sysroot,
it'll need to be added via the board's Yocto layer or vendored and
statically linked.

## Known gaps / next steps

- **Never compiled.** No cross-toolchain was available this session -
  expect real build errors, especially around exact `libwebsockets`
  API-version differences (this targets the modern `lws_client_connect_via_info`
  API; older SDKs may ship an older libwebsockets with a different
  connect API).
- **Never run against the board.** In particular:
  - Which of the three `gst-launch` variants in the design doc
    (plain / `sync=false` / positioned `overlay-*` + `device=/dev/video17`)
    is the real production configuration is still unconfirmed - this client
    currently hardcodes the middle one (`sync=false`, sink defaults/fullscreen).
  - Whether the touchscreen is truly single-touch (vs. type-B multitouch)
    was never checked with `evtest` - `src/touch.c` assumes single-touch.
- **No reconnect backoff tuning** - it retries every `RECONNECT_DELAY_MS`
  (2s) forever; fine for a first test, probably wants jitter/backoff for
  production.
- **Audio player eviction is naive** - if more than `MAX_AUDIO_PLAYERS` (4)
  concurrent audio streams show up, it evicts slot 0 rather than the
  actual least-recently-used one. Unlikely to matter in practice (CarPlay
  rarely has more than 1-2 concurrent audio streams) but worth knowing.
- Headless SBC mode (letting the SBC skip its own local render so it can
  use weaker hardware) is a separate change on the SBC side, not part of
  this client - see "Headless SBC mode" in the design doc.
