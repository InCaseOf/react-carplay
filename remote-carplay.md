# Remote CarPlay viewing over the LAN

This extends react-carplay so a CarPlay session running on the SBC (with the
dongle physically attached) can be viewed and interacted with from another
browser on the same LAN - video, CarPlay audio playback, touch input, and
microphone uplink (for Siri/calls), not just a one-way video feed.

This exists because the dongle only speaks WebUSB, which only works from the
Chromium context that's physically attached to it. There is no way to move
the dongle connection itself to a separate machine; instead, the existing
Electron renderer keeps owning the dongle, and now also relays it out.

## How it works

The socket.io server that was already running in `src/main/Socket.ts` (for
settings sync and CAN bus signals) is the relay. It now does three things:

1. **Same job as before** - settings sync, `reverse`/`lights` signals.
2. **Serves the remote viewer page** - a small second page
   (`src/renderer/remote.html` / `src/renderer/src/remote/`), built by the
   same `electron-vite build` as the main app, served as static files from
   the same port so there's only one port (`4000`) to open on the LAN.
3. **Relays four new event types** between whichever socket owns the dongle
   (the local renderer's `CarPlay.worker.ts`) and any remote viewers:
   `videoChunk`, `audioChunk` (SBC → viewer), `touchEvent`, `micChunk`
   (viewer → SBC). The server doesn't interpret these, it just broadcasts
   each one to every *other* connected socket - see `MessageNames` in
   `src/shared/socketMessages.ts`.

```
Remote browser (LAN)                      SBC: Electron renderer
─────────────────────                     ────────────────────────────────
http://<sbc-ip>:4000/  ◄── same port ──►  src/main/Socket.ts (relay + static)
  RemoteApp.tsx                                       ▲
  - Render.worker.ts decodes/draws video              │ socket.io
    (identical worker to the local app)                │
  - PcmPlayer (pcm-ringbuf-player) plays audio          │
  - pointer events → touchEvent                         │
  - WebMicrophone → micChunk                            ▼
                                           CarPlay.worker.ts (owns dongleDriver)
                                             - taps the same payload.data that
                                               already fed the local render
                                               path, copies it out to the
                                               relay
                                             - touchEvent/micChunk in →
                                               dongleDriver.send(...), same
                                               calls the local UI already uses
```

Nothing about the local experience changes - this is additive. The SBC still
renders CarPlay on its own screen exactly as before; the remote viewer is
just another consumer of the same video/audio, and another source of
touch/mic input.

### Why so little new code

The remote viewer page reuses the exact same building blocks the local app
already has, rather than reimplementing video decode or audio playback:

- **Video**: `Render.worker.ts` (WebCodecs `VideoDecoder` + WebGL) is loaded
  as a Worker exactly like `Carplay.tsx` already does - the remote page just
  feeds it frames arriving over the socket instead of over USB.
- **Audio playback**: `pcm-ringbuf-player`'s `PcmPlayer`, the same package
  `useCarplayAudio.ts` already uses.
- **Microphone uplink**: `WebMicrophone` from `node-carplay/web`, the same
  class `useCarplayAudio.ts` already uses to capture and PCM-encode mic
  input.
- **Touch**: the same normalise-to-0..1 logic as `useCarplayTouch.ts`
  (`useRemoteTouch.ts` is a copy parameterised to emit over a socket instead
  of posting to a Worker, to avoid changing the existing hook's signature).

No new npm dependencies were needed - `socket.io-client`, `pcm-ringbuf-player`
and `node-carplay` were already dependencies.

## Using it

1. `npm run build` (the remote page is built as a second Vite entry
   alongside the main app - see `electron.vite.config.ts`).
2. Run the app as usual on the SBC.
3. From any browser on the same LAN, go to `http://<sbc-ip>:4000/`.
4. Tap the "enable audio & microphone" prompt once (browsers require a user
   gesture before they'll create an `AudioContext` or ask for the
   microphone - video works immediately without it).

There's no discovery/QR-code UI yet for finding `<sbc-ip>` from inside the
app itself - for now, find it the usual way (`hostname -I` on the Pi, or
your router's client list).

## Known limitations / things to verify on real hardware

This was implemented and build-verified (`electron-vite build` succeeds,
producing both `out/renderer/index.html` and `out/renderer/remote.html`,
with `CarPlay.worker.js` correctly bundling `socket.io-client`) but **not
runtime-tested against a physical dongle** - this sandbox has no USB
hardware, no Electron GUI, and no LAN to test across. Specifically unverified:

- **`socket.io-client` inside a Web Worker.** `CarPlay.worker.ts` connects
  with `transports: ['websocket']` specifically because a Worker has no
  `XMLHttpRequest` (engine.io's polling fallback needs it), but `WebSocket`
  itself is available in Workers per spec. This should work but hasn't been
  exercised against a running server from inside an actual Worker.
- **Cross-origin isolation for the remote page.** `PcmPlayer` needs
  `SharedArrayBuffer`, which browsers only expose in a cross-origin-isolated
  context. The static file server in `Socket.ts` sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on every response for this
  reason (mirroring what `src/main/index.ts` already does for the main
  Electron window) - not yet confirmed against a real browser tab.
- **End-to-end latency** over a real LAN hasn't been measured - the video
  path adds one extra copy (`new Uint8Array(payload.data)`) per frame on the
  SBC side to avoid corrupting the transferred buffer that already feeds the
  local renderer, which should be cheap relative to network/decode time but
  hasn't been profiled.
- **Multiple simultaneous remote viewers.** The relay broadcasts to "every
  other" socket, so it works with any number of viewers, but touch/mic input
  from more than one viewer at once would race (last-write-wins on the
  dongle) - fine for the "one person driving" use case, not arbitrated
  beyond that.
- **Dev mode (`npm run dev`).** The static file server only serves the
  *built* `out/renderer/` directory. In `electron-vite dev`, the renderer is
  served by Vite's own dev server instead, so the remote page won't be
  reachable via port 4000 until you run a real `npm run build`. Socket.io
  itself (settings sync, relay) still works in dev mode either way.

## Files touched

- `src/main/Socket.ts` - http server + static file serving + relay events.
- `src/shared/socketMessages.ts` - **new.** Event names and payload types
  shared between the main process, the CarPlay worker, and the remote page,
  kept dependency-free so neither bundle pulls in the other side's
  Node/browser-only code.
- `src/renderer/src/components/worker/CarPlay.worker.ts` - connects to the
  relay, taps video/audio out, routes touch/mic in.
- `src/renderer/remote.html`,
  `src/renderer/src/remote/{main.tsx,RemoteApp.tsx,useRemoteTouch.ts}` -
  **new.** The remote viewer page itself.
- `electron.vite.config.ts` - added `remote.html` as a second build entry.
