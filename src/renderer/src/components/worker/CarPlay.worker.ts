import CarplayWeb, {
  CarplayMessage,
  DongleConfig,
  SendAudio,
  SendCommand,
  SendTouch,
  TouchAction,
  findDevice,
} from 'node-carplay/web'
import { AudioPlayerKey, Command, KeyCommand } from "./types";
import { RenderEvent } from './render/RenderEvents'
import { RingBuffer } from 'ringbuf.js'
import { createAudioPlayerKey } from './utils'
import { io, Socket as RemoteSocket } from 'socket.io-client'
import { MessageNames } from '../../../../shared/socketMessages'

let carplayWeb: CarplayWeb | null = null
let videoPort: MessagePort | null = null
let microphonePort: MessagePort | null = null
let config: Partial<DongleConfig> | null = null
const audioBuffers: Record<AudioPlayerKey, RingBuffer<Int16Array>> = {}
const pendingAudio: Record<AudioPlayerKey, Int16Array[]> = {}

// The already-running socket.io server in src/main/Socket.ts (see
// remote-carplay.md) also acts as a relay for anyone viewing this CarPlay
// session remotely over the LAN. This worker connects to it as an ordinary
// client, same as the local renderer does for settings - just over
// websocket-only, since XMLHttpRequest (engine.io's polling fallback) isn't
// available inside a Worker.
const REMOTE_SOCKET_URL = 'http://localhost:4000'
let remoteSocket: RemoteSocket | null = null

const getRemoteSocket = (): RemoteSocket => {
  if (remoteSocket) return remoteSocket

  remoteSocket = io(REMOTE_SOCKET_URL, { transports: ['websocket'] })

  remoteSocket.on(
    MessageNames.TouchEvent,
    (payload: { x: number; y: number; action: TouchAction }) => {
      sendTouch(payload.x, payload.y, payload.action)
    },
  )

  remoteSocket.on(MessageNames.MicChunk, (payload: ArrayBuffer) => {
    if (carplayWeb) {
      carplayWeb.dongleDriver.send(new SendAudio(new Int16Array(payload)))
    }
  })

  return remoteSocket
}

const sendTouch = (x: number, y: number, action: TouchAction) => {
  if (config && carplayWeb) {
    carplayWeb.dongleDriver.send(new SendTouch(x, y, action))
  }
}

const handleMessage = (message: CarplayMessage) => {
  const { type, message: payload } = message
  if (type === 'video' && videoPort) {
    // payload.data is a Buffer view starting 20 bytes into a larger
    // underlying buffer (see VideoData in node-carplay). Buffer.slice()
    // (unlike a plain TypedArray's) returns another view over that *same*
    // underlying buffer rather than copying, so `new Uint8Array(payload.data)`
    // - the same idiom Render.worker.ts already uses to unwrap this same
    // message - is what actually copies just the frame bytes into their own
    // buffer, starting at offset 0. A real copy is also required here since
    // remoteSocket.emit() only reads the bytes once they flush to the
    // transport, which can happen after the postMessage transfer below has
    // already detached the original buffer.
    if (remoteSocket?.connected) {
      remoteSocket.emit(MessageNames.VideoChunk, new Uint8Array(payload.data).buffer)
    }
    videoPort.postMessage(new RenderEvent(payload.data), [payload.data.buffer])
  } else if (type === 'audio' && payload.data) {
    const { decodeType, audioType } = payload
    if (remoteSocket?.connected) {
      // payload.data here is a genuine Int16Array view (AudioData in
      // node-carplay slices it directly from the raw buffer, 12 bytes in),
      // so new Int16Array(payload.data) copies just the sample elements
      // into their own buffer, same idiom as the video path above. The
      // remote client reconstructs this as an Int16Array.
      remoteSocket.emit(MessageNames.AudioChunk, {
        decodeType,
        audioType,
        data: new Int16Array(payload.data).buffer,
      })
    }
    const audioKey = createAudioPlayerKey(decodeType, audioType)
    if (audioBuffers[audioKey]) {
      audioBuffers[audioKey].push(payload.data)
    } else {
      if (!pendingAudio[audioKey]) {
        pendingAudio[audioKey] = []
      }
      pendingAudio[audioKey].push(payload.data)
      payload.data = undefined

      const getPlayerMessage = {
        type: 'getAudioPlayer',
        message: {
          ...payload,
        },
      }
      postMessage(getPlayerMessage)
    }
  } else {
    postMessage(message)
  }
}

onmessage = async (event: MessageEvent<Command>) => {
  switch (event.data.type) {
    case 'initialise':
      if (carplayWeb) return
      videoPort = event.data.payload.videoPort
      microphonePort = event.data.payload.microphonePort
      microphonePort.onmessage = ev => {
        if (carplayWeb) {
          const data = new SendAudio(ev.data)
          carplayWeb.dongleDriver.send(data)
        }
      }
      break
    case 'audioPlayer':
      const { sab, decodeType, audioType } = event.data.payload
      const audioKey = createAudioPlayerKey(decodeType, audioType)
      audioBuffers[audioKey] = new RingBuffer(sab, Int16Array)
      if (pendingAudio[audioKey]) {
        pendingAudio[audioKey].forEach(buf => {
          audioBuffers[audioKey].push(buf)
        })
        pendingAudio[audioKey] = []
      }
      break
    case 'start':
      if (carplayWeb) return
      config = event.data.payload.config
      const device = await findDevice()
      if (device) {
        carplayWeb = new CarplayWeb(config)
        carplayWeb.onmessage = handleMessage
        carplayWeb.start(device)
        getRemoteSocket()
      }
      break
    case 'touch':
      sendTouch(event.data.payload.x, event.data.payload.y, event.data.payload.action)
      break
    case 'stop':
      await carplayWeb?.stop()
      carplayWeb = null
      break
    case 'frame':
      if (carplayWeb) {
        const data = new SendCommand('frame')
        carplayWeb.dongleDriver.send(data)
      }
      break
    case 'keyCommand':
      const command: KeyCommand = event.data.command
      const data = new SendCommand(command)
      if (carplayWeb) {
        carplayWeb.dongleDriver.send(data)
      }
  }
}

export {}
