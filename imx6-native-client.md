# Native i.MX6 client (design sketch - NOT YET BUILT)

Status: **design only, ready to start building**. User has confirmed this
is still the goal (bidirectional video/audio/touch, per remote-carplay.md's
architecture, just with a hardware-decoding native client instead of a
browser) and will **remove the Safelink ladder-logic program from the
i.MX6** before implementation starts, so the new client has sole ownership
of `imxv4l2sink`/the touchscreen/the sound card - no more coexistence
concerns with whatever Safelink's video object was doing internally.
Nothing in this document is implemented yet. See
[remote-carplay.md](remote-carplay.md) for what *is* shipped (the
browser-based remote viewer, which this is a second, alternative client
for). Read that doc first - this one assumes its relay architecture.

## Why this exists

The browser-based remote viewer decodes video with WebCodecs, in software
(`hardwareAcceleration: 'prefer-software'` in
[lib/utils.ts](src/renderer/src/components/worker/render/lib/utils.ts)).
That's fine on a phone/tablet/laptop. It is very likely **not** fine on the
i.MX6 Solo currently receiving the RTSP/MediaMTX stream: single-core
Cortex-A9 at ~1GHz, no realistic way to run a modern WebCodecs-capable
browser, and software H.264 decode on that CPU would be far too slow even
if it could.

What that board *does* have is a hardware VPU, which is exactly what its
existing `gst-launch` RTSP pipeline already uses to decode cheaply. The plan
is a small native client, in C/C++, that:

- Replaces the RTSP source with a WebSocket connection into the same relay
  `Socket.ts` already runs (video/audio in, touch/mic out) - no ffmpeg, no
  MediaMTX.
- Feeds the received H.264 bytes into the *same* VPU decoder element the
  current pipeline already uses, so decode stays hardware-accelerated and
  cheap.
- Adds the two things RTSP couldn't do: forwards touchscreen input and
  microphone audio back to the SBC.

This also lets the SBC (the one physically holding the CarPlay dongle) get
away with weaker hardware than the browser-viewer approach needs, **if**
it's also set to skip its own local decode/render (see "Headless SBC mode"
below) - the expensive part (decode + GPU composite) moves entirely onto
the i.MX6's VPU.

## Transport: a second, raw WebSocket endpoint

`Socket.ts`'s existing socket.io connection is *not* a plain WebSocket - it
has its own handshake/framing on top (engine.io), which is real extra work
to reimplement in C. Rather than doing that, the plan is a **second**
endpoint on the same port (4000), a raw WebSocket, that a small native
client can talk to with a minimal C WebSocket library (e.g. `libwebsockets`,
or a slim vendored implementation) and no JSON parser at all.

- URL: `ws://<sbc-ip>:4000/native`
- `Socket.ts` would add one `httpServer.on('upgrade', ...)` handler that
  checks the request path: paths under `/socket.io/` are left alone (engine.io's
  own upgrade listener already claims those); `/native` gets handled by a
  separate `ws.Server({ noServer: true })` and its own
  `wss.handleUpgrade(...)` call. Both listeners coexist on the same
  `httpServer`, same pattern already used for the static-file `/request`
  handler alongside engine.io's.
- `ws` itself needs no new dependency - it's already pulled in transitively
  by `socket.io`/`engine.io`.

### Why tagged binary frames instead of JSON

The browser client happily uses JSON envelopes (`{decodeType, audioType,
data}`) for the audio path. A C client on a weak embedded board shouldn't
need a JSON library for something this simple, so every message here is a
single WebSocket frame with a **1-byte type tag** as its first byte:

| Tag  | Name         | Direction         | Payload after the tag byte |
|------|--------------|--------------------|-----------------------------|
| 0x01 | videoChunk   | SBC → i.MX6        | Raw H.264 Annex-B bytes for one frame (same bytes the browser viewer gets over `videoChunk`) |
| 0x02 | audioChunk   | SBC → i.MX6        | 2 bytes `decodeType` (u16 LE) + 2 bytes `audioType` (u16 LE) + raw Int16LE PCM samples |
| 0x03 | micChunk     | i.MX6 → SBC        | Raw Int16LE PCM, mono, 16kHz (same format `SendAudio` already expects - see `WebMicrophone`/`recorder.worklet.ts` in node-carplay) |
| 0x04 | touchEvent   | i.MX6 → SBC        | 1 byte `action` (14=Down, 15=Move, 16=Up - `TouchAction` from `node-carplay/web`) + 4 bytes `x` (f32 LE, 0..1) + 4 bytes `y` (f32 LE, 0..1) |

All four map directly onto the existing relay events in
[socketMessages.ts](src/shared/socketMessages.ts) - `Socket.ts`'s job is
just to also fan `videoChunk`/`audioChunk` out to any connected `/native`
clients, and fan `touchEvent`/`micChunk` from `/native` clients back into
the same broadcast the socket.io side already does. Sketch:

```ts
// Socket.ts, sketch - not implemented
const nativeClients = new Set<WebSocket>()

wss.on('connection', (ws) => {
  nativeClients.add(ws)
  ws.on('close', () => nativeClients.delete(ws))
  ws.on('message', (data: Buffer) => {
    const tag = data.readUInt8(0)
    if (tag === 0x03) socket_broadcastToOwner(MessageNames.MicChunk, data.subarray(1))
    if (tag === 0x04) socket_broadcastToOwner(MessageNames.TouchEvent, parseTouch(data))
  })
})

// wherever videoChunk/audioChunk are already broadcast to socket.io peers,
// also write a tagged frame to every socket in nativeClients.
```

## GStreamer pipeline sketch (i.MX6 side)

**Confirmed live via SSH on the actual board (2026-09-21)** - this is the
official NXP `gstreamer1.0-plugins-imx` naming (generic `vpudec`, not the
codec-specific `imxvpudec_h264` from the older community `gstreamer-imx`
project). Actually-installed elements relevant here:

- Decoder: **`vpudec`** ("IMX VPU-based video decoder" - generic, negotiates
  codec from caps, so `video/x-h264` input just works).
- Encoders also present (`vpuenc_h264` etc.) - not needed for this direction
  but confirms the same VPU plugin family throughout.
- Sinks/converters available: `waylandsink`, `overlaysink` ("IMX Video
  (video compositor) Sink"), `imxv4l2sink`, `v4l2sink`,
  `imxcompositor_g2d`/`imxcompositor_ipu`, `imxvideoconvert_g2d`/`_ipu`.
  `waylandsink` being present means this image is very likely running a
  Wayland compositor (e.g. Weston) for display, not X11/plain framebuffer.
- **Confirmed - the actual working RTSP test commands (from the user, not
  found by our filesystem search - it wasn't running as a persistent
  service, just invoked ad hoc for testing):**
  ```bash
  gst-launch-1.0 rtspsrc location=rtsp://192.168.155.5:8554/live latency=50 ! decodebin ! imxv4l2sink
  # or, to help latency:
  gst-launch-1.0 rtspsrc location=rtsp://192.168.155.5:8554/live latency=50 ! decodebin ! imxv4l2sink sync=false
  # or, positioned in a specific screen region:
  gst-launch-1.0 rtspsrc location=rtsp://192.168.155.5:8554/live latency=50 ! decodebin ! imxv4l2sink sync=false \
    overlay-left=241 overlay-top=161 overlay-width=640 overlay-height=480 device=/dev/video17
  ```
  So the real sink is **`imxv4l2sink`**, not `waylandsink`/`overlaysink` as
  guessed below originally. `decodebin` autoplugs down to `vpudec` (the
  only installed H.264 decoder), confirming `vpudec` is right to call
  explicitly in the new client instead of using `decodebin`'s generic
  autoplugging - explicit is simpler to drive from C. `sync=false` matters
  for us too: our frames are arriving live off a WebSocket with no
  meaningful clock reference, same reason it's used here for the RTSP
  case. `latency=50` is an `rtspsrc`-only jitter-buffer property - not
  applicable once `rtspsrc` is replaced by `appsrc`.
  **Not yet confirmed: which of the three (plain / `sync=false` / the
  positioned `overlay-*` + `device=/dev/video17` variant) is what actually
  runs in normal operation** vs. which were just test variants - matters
  for whether the new client should hardcode those specific overlay
  coordinates/device or just use sink defaults (likely fullscreen).

Real pipeline, adapted for our `appsrc` source instead of `rtspsrc`:

```
appsrc name=videosrc format=time is-live=true do-timestamp=true caps="video/x-h264,stream-format=byte-stream,alignment=nal"
  ! h264parse
  ! vpudec
  ! imxv4l2sink sync=false   # add overlay-left/top/width/height + device=/dev/video17 if that positioned variant turns out to be the real one
```

Built and driven programmatically (not `gst-launch` text), so the app can
push buffers into `videosrc` as they arrive over the WebSocket:

```c
// pseudocode
GstBuffer *buf = gst_buffer_new_wrapped(memcpy_of(frame_bytes), frame_len);
gst_app_src_push_buffer(GST_APP_SRC(videosrc), buf);
```

Audio playback (CarPlay → i.MX6 speaker), one `appsrc` per active
`decodeType`/`audioType` pair (mirrors `PcmPlayer` in the browser client) -
in practice usually just one or two at a time. **Confirmed:** single sound
card `sysdefault:CARD=imx6audiosgtl50` (imx6-audio-sgtl5000) handles both
directions:

```
appsrc name=audiosrc format=time is-live=true do-timestamp=true
  caps="audio/x-raw,format=S16LE,rate=<freq>,channels=<channels>,layout=interleaved"
  ! audioconvert ! audioresample ! alsasink device=sysdefault:CARD=imx6audiosgtl50
```

Microphone capture (i.MX6 mic → SBC → dongle), resampled to the fixed
16kHz mono `SendAudio` expects - same card, capture side:

```
alsasrc device=sysdefault:CARD=imx6audiosgtl50
  ! audioconvert ! audioresample
  ! capsfilter caps="audio/x-raw,format=S16LE,rate=16000,channels=1"
  ! appsink name=micsink emit-signals=true
```
Each buffer pulled from `micsink` becomes one tag-0x03 WebSocket frame.

## Touch input (i.MX6 side)

**Confirmed:** `EETI eGalax Touch Screen #0`, handlers `mouse0 event0` - so
the device node is `/dev/input/event0`. `EV=b` (SYN + KEY + ABS bits only,
no `EV_MSC`) - consistent with a classic single-touch eGalax device
(`BTN_TOUCH` + `ABS_X`/`ABS_Y`), not a type-B multitouch protocol, though
worth a quick `evtest /dev/input/event0` to see the actual `ABS_MT_*`
capability bits before assuming, since eGalax also makes multitouch
controllers.

The dongle protocol (`SendTouch`) only carries a single active point
anyway, so this doesn't need real multitouch handling regardless - track
one active touch:

- Open `/dev/input/event0` directly.
- Read `struct input_event` records (`EV_ABS` for `ABS_X`/`ABS_Y`, `EV_KEY`
  for `BTN_TOUCH`, `EV_SYN`/`SYN_REPORT` to flush a batch).
- Normalise using the axis min/max from `EVIOCGABS` (`ioctl`), not assumed
  screen resolution.
- On `BTN_TOUCH` down/up and on `SYN_REPORT` while down, emit a tag-0x04
  frame with the corresponding action.
- If the panel turns out to be a "type B" multitouch device
  (`ABS_MT_POSITION_X/Y`, tracking IDs, slots) rather than single-touch,
  the same idea applies - just track slot 0 / the first active tracking ID
  and ignore the rest.

## Headless SBC mode (separate, smaller change - not sketched in detail yet)

For the "allow weaker hardware on the dongle side" benefit to actually
materialise, the SBC also needs to stop doing its *own* local decode/render
- otherwise it pays that cost regardless of what the i.MX6 does. That's a
much smaller change than anything above: `Carplay.tsx` would skip creating
`Render.worker.ts`/the canvas entirely behind a config flag (e.g.
`ExtraConfig.remoteOnly`), while `CarPlay.worker.ts`'s relay of
`payload.data` to the socket (already built, see `remote-carplay.md`)
carries on unchanged either way. Worth doing once the i.MX6 client above is
working and proven, not before.

## Open questions - status after live SSH recon (2026-09-21)

1. ~~Your current working `gst-launch-1.0` RTSP command~~ - **done**, see
   above: `rtspsrc ! decodebin ! imxv4l2sink`, three variants. Still open:
   which variant (plain / `sync=false` / positioned `overlay-*` +
   `device=/dev/video17`) is the real one in normal use.
2. ~~`gst-inspect-1.0` output~~ - **done**, see above: `vpudec`,
   `waylandsink`/`overlaysink`/`imxv4l2sink`, `imxcompositor_g2d/_ipu`.
3. ~~Touchscreen device node~~ - **done**: `/dev/input/event0`, EETI
   eGalax, looks single-touch (worth a quick `evtest` sanity check).
4. ~~Mic/speaker ALSA device names~~ - **done**: `sysdefault:CARD=imx6audiosgtl50`
   for both.
5. **Toolchain - confirmed missing on-device.** `gcc` not found on the
   board (`command not found`); `gst-launch-1.0` itself is present at
   `/usr/bin/gst-launch-1.0`. This means the C/C++ client will need to be
   **cross-compiled** from a dev machine (NXP Yocto SDK / toolchain
   matching this board's BSP version) rather than built in place - worth
   confirming what SDK/toolchain is available to you before writing code,
   since that dictates the build setup as much as the pipeline itself.
6. **Still open**: once this is proven, remove ffmpeg/MediaMTX entirely,
   or leave them installed-but-idle as a fallback?

Also noted this session, for the Pi side (not blocking, just useful
context for later): the deployed app there is a built AppImage
(`/home/pi/Desktop/Carplay.AppImage`, autostarted via
`/etc/xdg/autostart/carplay.desktop`), not run from a source checkout via
`npm`/`electron-vite dev` - `node`/`npm` aren't even on the Pi's `PATH`.
There are a few source-looking directories on the Pi worth sorting out
which (if any) is the real checkout before touching anything there:
`/home/pi/r2q/carplay`, `/home/pi/react-carplay_org`, config at
`/home/pi/.config/react-carplay`.
