import { ExtraConfig } from "./Globals";
import { Server } from 'socket.io'
import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'
import { Stream } from "socketmost/dist/modules/Messages";
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFile } from 'fs'
import { extname, join, normalize } from 'path'
import { MessageNames, RemoteAudioChunk, RemoteTouchEvent } from "../shared/socketMessages";

export { MessageNames }

// Raw WebSocket endpoint for the native i.MX6 client (no socket.io/engine.io
// framing, no JSON) - see imx6-native-client.md. Every frame is tagged with
// a 1-byte type as its first byte.
const NATIVE_WS_PATH = '/native'
const NativeTag = {
  VideoChunk: 0x01,
  AudioChunk: 0x02,
  MicChunk: 0x03,
  TouchEvent: 0x04
} as const

// Static assets for the remote viewer page (built alongside the main
// renderer, see electron.vite.config.ts). Served from the same port as the
// socket.io server so a single port needs to be reachable on the LAN.
const REMOTE_CLIENT_DIR = join(__dirname, '../renderer')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
}

export class Socket extends EventEmitter {
  config: ExtraConfig
  io: Server
  saveSettings: (settings: ExtraConfig) => void
  // Native i.MX6 clients connected to /native - see broadcastToNative.
  private nativeClients = new Set<WebSocket>()
  constructor(config: ExtraConfig, saveSettings: (settings: ExtraConfig) => void) {
    super()
    this.config = config
    this.saveSettings = saveSettings

    // A plain http server backs socket.io so the same port (4000) can also
    // serve the remote viewer page to any browser on the LAN. Engine.io
    // registers its own 'request' listener that only handles paths under
    // /socket.io/, so this listener and that one coexist safely.
    const httpServer = createServer(this.handleHttpRequest)

    this.io = new Server(httpServer, {
      cors: {
        origin: '*'
      }
    })

    // Same coexistence pattern as the http 'request' listener above:
    // engine.io already registered its own 'upgrade' listener for
    // /socket.io/ paths, so this one only acts on /native and otherwise
    // leaves the socket alone for that other listener to handle.
    const nativeWss = new WebSocketServer({ noServer: true })
    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url !== NATIVE_WS_PATH) return
      nativeWss.handleUpgrade(req, socket, head, (ws) => {
        this.nativeClients.add(ws)
        ws.on('close', () => this.nativeClients.delete(ws))
        ws.on('message', (data: Buffer) => this.handleNativeMessage(data))
      })
    })

    this.io.on(MessageNames.Connection, (socket) => {
      this.sendSettings()

      socket.on(MessageNames.GetSettings, () => {
        this.sendSettings()
      })

      socket.on(MessageNames.SaveSettings, (settings: ExtraConfig) => {
        this.saveSettings(settings)
      })

      socket.on(MessageNames.Stream, (stream: Stream) => {
        this.emit(MessageNames.Stream, stream)
      })

      // Relay CarPlay video/audio out to any remote viewers, and touch/mic
      // input back from remote viewers to whichever socket owns the dongle
      // (the local renderer's CarPlay.worker.ts). Broadcasting to "every
      // other" socket keeps the server itself dumb about who's who - it
      // works whether there's one remote viewer or several.
      socket.on(MessageNames.VideoChunk, (chunk: ArrayBuffer) => {
        socket.broadcast.emit(MessageNames.VideoChunk, chunk)
        this.broadcastToNative(NativeTag.VideoChunk, Buffer.from(chunk))
      })

      socket.on(MessageNames.AudioChunk, (chunk: RemoteAudioChunk) => {
        socket.broadcast.emit(MessageNames.AudioChunk, chunk)
        const header = Buffer.alloc(4)
        header.writeUInt16LE(chunk.decodeType, 0)
        header.writeUInt16LE(chunk.audioType, 2)
        this.broadcastToNative(NativeTag.AudioChunk, Buffer.concat([header, Buffer.from(chunk.data)]))
      })

      socket.on(MessageNames.TouchEvent, (touch: unknown) => {
        socket.broadcast.emit(MessageNames.TouchEvent, touch)
      })

      socket.on(MessageNames.MicChunk, (chunk: ArrayBuffer) => {
        socket.broadcast.emit(MessageNames.MicChunk, chunk)
      })
    })

    httpServer.listen(4000)
  }

  private handleHttpRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || req.url.startsWith('/socket.io')) {
      // Not ours - let engine.io's own request listener handle (or ignore) it.
      return
    }

    const urlPath = req.url.split('?')[0]
    const relativePath = urlPath === '/' ? 'remote.html' : urlPath.replace(/^\/+/, '')
    const filePath = join(REMOTE_CLIENT_DIR, normalize(relativePath))

    // Guard against path traversal escaping the renderer output directory.
    if (!filePath.startsWith(REMOTE_CLIENT_DIR)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found. Build the app (npm run build) to serve the remote viewer page.')
        return
      }
      const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': contentType,
        // The remote page uses SharedArrayBuffer (via ringbuf.js, for audio
        // playback) same as the main app does - browsers only expose that
        // API in a cross-origin-isolated context. Everything this server
        // serves is same-origin, so 'require-corp' is safe here.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      })
      res.end(data)
    })
  }

  // A tagged frame arriving from a native i.MX6 client: either its mic
  // uplink or a touch event. Both get fed into the same broadcast the
  // socket.io side already uses, so CarPlay.worker.ts (the socket that
  // actually owns the dongle) handles them identically regardless of
  // whether they came from a browser remote viewer or a native client.
  private handleNativeMessage(data: Buffer) {
    const tag = data.readUInt8(0)
    if (tag === NativeTag.MicChunk) {
      this.io.emit(MessageNames.MicChunk, new Uint8Array(data.subarray(1)).buffer)
    } else if (tag === NativeTag.TouchEvent) {
      const touch: RemoteTouchEvent = {
        action: data.readUInt8(1),
        x: data.readFloatLE(2),
        y: data.readFloatLE(6)
      }
      this.io.emit(MessageNames.TouchEvent, touch)
    }
  }

  private broadcastToNative(tag: number, payload: Buffer) {
    if (this.nativeClients.size === 0) return
    const frame = Buffer.concat([Buffer.from([tag]), payload])
    this.nativeClients.forEach((client) => {
      // 1 === WebSocket.OPEN
      if (client.readyState === 1) client.send(frame)
    })
  }

  sendSettings() {
    this.io.emit('settings', this.config)
  }

  sendReverse(reverse: boolean) {
    this.io.emit('reverse', reverse)
  }

  sendLights(lights: boolean) {
    this.io.emit('lights', lights)
  }
}
