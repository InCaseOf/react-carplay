import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { io, Socket as RemoteSocket } from 'socket.io-client'
import { decodeTypeMap, WebMicrophone } from 'node-carplay/web'
import { PcmPlayer } from 'pcm-ringbuf-player'
import { MessageNames, RemoteAudioChunk } from '../../../shared/socketMessages'
import { InitEvent, RenderEvent } from '../components/worker/render/RenderEvents'
import { createAudioPlayerKey } from '../components/worker/utils'
import { AudioPlayerKey } from '../components/worker/types'
import { useRemoteTouch } from './useRemoteTouch'

const width = window.innerWidth
const height = window.innerHeight

// One MessageChannel feeding the same Render.worker.ts the local app uses -
// see remote-carplay.md for why decode/render logic isn't duplicated here.
const videoChannel = new MessageChannel()

function RemoteApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const socketRef = useRef<RemoteSocket | null>(null)
  const audioPlayers = useRef(new Map<AudioPlayerKey, PcmPlayer>())
  const micChannelRef = useRef<MessageChannel | null>(null)
  const startedRef = useRef(false)

  const [connected, setConnected] = useState(false)
  const [started, setStarted] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (canvasRef.current) {
      setCanvasElement(canvasRef.current)
    }
  }, [])

  // Same worker, same InitEvent, same decode/render path the local Electron
  // renderer uses - a remote viewer is just another consumer of it.
  useMemo(() => {
    if (!canvasElement) return
    const worker = new Worker(
      new URL('../components/worker/render/Render.worker.ts', import.meta.url),
      { type: 'module' },
    )
    const canvas = canvasElement.transferControlToOffscreen()
    worker.postMessage(new InitEvent(canvas, videoChannel.port2), [canvas, videoChannel.port2])
    return worker
  }, [canvasElement])

  const getAudioPlayer = useCallback((decodeType: number, audioType: number) => {
    const key = createAudioPlayerKey(decodeType, audioType)
    const existing = audioPlayers.current.get(key)
    if (existing) return existing

    const format = decodeTypeMap[decodeType]
    const player = new PcmPlayer(format.frequency, format.channel)
    audioPlayers.current.set(key, player)
    player.volume(1)
    player.start()
    return player
  }, [])

  // Connects to the socket.io server this page was itself served from (see
  // src/main/Socket.ts) as soon as the page loads - receiving video doesn't
  // need a user gesture, only audio playback/mic capture do (below).
  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on(MessageNames.VideoChunk, (buffer: ArrayBuffer) => {
      videoChannel.port1.postMessage(new RenderEvent(buffer), [buffer])
    })

    socket.on(MessageNames.AudioChunk, (chunk: RemoteAudioChunk) => {
      if (!startedRef.current) return
      const player = getAudioPlayer(chunk.decodeType, chunk.audioType)
      player.feed(new Int16Array(chunk.data))
    })

    return () => {
      socket.disconnect()
      audioPlayers.current.forEach(p => p.stop())
      audioPlayers.current.clear()
    }
  }, [getAudioPlayer])

  // Audio playback and the microphone both need a user gesture before the
  // browser will let them run - this is that gesture. Video already works
  // without it.
  const handleConnectClick = useCallback(async () => {
    startedRef.current = true
    setStarted(true)
    setMicError(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const micChannel = new MessageChannel()
      micChannelRef.current = micChannel
      micChannel.port1.onmessage = ev => {
        if (socketRef.current?.connected) {
          socketRef.current.emit(MessageNames.MicChunk, (ev.data as Int16Array).buffer)
        }
      }
      const mic = new WebMicrophone(stream, micChannel.port2)
      mic.start()
    } catch (err) {
      console.error('Failed to start remote microphone', err)
      setMicError('Microphone unavailable - video/audio will still work, but Siri/voice input will not.')
    }
  }, [])

  const sendTouchEvent = useRemoteTouch(
    touch => socketRef.current?.emit(MessageNames.TouchEvent, touch),
    width,
    height,
  )

  return (
    <div
      style={{ height: '100%', width: '100%', touchAction: 'none', position: 'relative' }}
      onPointerDown={sendTouchEvent}
      onPointerMove={sendTouchEvent}
      onPointerUp={sendTouchEvent}
      onPointerCancel={sendTouchEvent}
      onPointerOut={sendTouchEvent}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {!connected && (
        <Overlay>Connecting to CarPlay host&hellip;</Overlay>
      )}
      {connected && !started && (
        <Overlay>
          <button onClick={handleConnectClick} style={buttonStyle}>
            Tap to enable audio &amp; microphone
          </button>
        </Overlay>
      )}
      {micError && (
        <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, color: '#fff', textAlign: 'center' }}>
          {micError}
        </div>
      )}
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  padding: '16px 24px',
  fontSize: '1.1rem',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer'
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontFamily: 'sans-serif',
        background: 'rgba(0,0,0,0.4)'
      }}
    >
      {children}
    </div>
  )
}

export default React.memo(RemoteApp)
