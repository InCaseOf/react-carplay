# Native i.MX6 client (design sketch - NOT YET BUILT)

Status: **design only**. Nothing in this document is implemented. See
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

**This is the part that most needs verification against your actual image**
- exact element names differ between NXP's official Yocto BSP
  (`gstreamer1.0-plugins-imx`: `imxvpudec`, `imxg2dvideosink`/`imxeglvivsink`,
  etc.) and the older community `gstreamer-imx` project
  (`imxvpudec_h264`, `imxg2dsink`, ...), and depend on your display stack
  (X11 / Wayland / direct KMS / framebuffer).

**Fastest path to a correct answer: don't guess from scratch.** Take the
exact `gst-launch-1.0` command line currently used for the RTSP pipeline,
keep everything from the decoder element onward exactly as-is (it's already
proven to work on this board/image), and only replace the front
(`rtspsrc ! rtph264depay ! ...`) with an `appsrc` fed by the new WebSocket
client. When we pick this back up, paste that existing command in and we
can write the real pipeline instead of guessing element names.

Illustrative sketch (element names to be confirmed):

```
appsrc name=videosrc format=time is-live=true do-timestamp=true caps="video/x-h264,stream-format=byte-stream,alignment=nal"
  ! h264parse
  ! imxvpudec                 # or imxvpudec_h264 / vpudec - confirm via `gst-inspect-1.0 | grep -i vpu`
  ! imxg2dvideosink           # or imxeglvivsink / waylandsink / kmssink - whatever the current RTSP pipeline's tail already uses
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
in practice usually just one or two at a time:

```
appsrc name=audiosrc format=time is-live=true do-timestamp=true
  caps="audio/x-raw,format=S16LE,rate=<freq>,channels=<channels>,layout=interleaved"
  ! audioconvert ! audioresample ! alsasink device=<confirm output device>
```

Microphone capture (i.MX6 mic → SBC → dongle), resampled to the fixed
16kHz mono `SendAudio` expects:

```
alsasrc device=<confirm mic device>
  ! audioconvert ! audioresample
  ! capsfilter caps="audio/x-raw,format=S16LE,rate=16000,channels=1"
  ! appsink name=micsink emit-signals=true
```
Each buffer pulled from `micsink` becomes one tag-0x03 WebSocket frame.

## Touch input (i.MX6 side)

The dongle protocol (`SendTouch`) only carries a single active point, so
this doesn't need real multitouch handling - track one active touch:

- Open the touchscreen's `/dev/input/eventN` directly (identify the right
  node with `evtest` or `libinput list-devices`).
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

## Open questions before writing real code

1. **Your current working `gst-launch-1.0` RTSP command** - paste it in so
   the decoder/sink tail can be reused verbatim instead of guessed.
2. **`gst-inspect-1.0 | grep -i vpu` / `grep -i g2d` / `grep -i imx`** output,
   to confirm exact element names if the current command doesn't already
   make them obvious.
3. **Touchscreen device node** - `/dev/input/eventN` for the panel, and
   whether it's single-touch or a type-B multitouch protocol.
4. **Mic and speaker ALSA device names** (`aplay -L` / `arecord -L`).
5. **Toolchain** - is there a C/C++ compiler and GStreamer dev headers
   *on* the i.MX6 image itself, or does this need cross-compiling from a
   dev machine/Yocto SDK? Changes how this gets built and iterated on.
6. Confirm: once this is proven, do you want to actually remove
   ffmpeg/MediaMTX from the Pi/i.MX6 setup, or leave them installed-but-idle
   as a fallback?
