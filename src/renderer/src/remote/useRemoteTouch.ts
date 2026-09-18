import { useState, useCallback } from 'react'
import { TouchAction } from 'node-carplay/web'
import { RemoteTouchEvent } from '../../../shared/socketMessages'

// Same normalisation as useCarplayTouch.ts, but sending over a socket
// callback instead of postMessage-ing a Worker - there's no worker on this
// page, just a socket.io connection back to the SBC.
export const useRemoteTouch = (
  send: (touch: RemoteTouchEvent) => void,
  width: number,
  height: number,
) => {
  const [pointerdown, setPointerDown] = useState(false)

  const sendTouchEvent: React.PointerEventHandler<HTMLDivElement> = useCallback(
    e => {
      let action = TouchAction.Up
      if (e.type === 'pointerdown') {
        action = TouchAction.Down
        setPointerDown(true)
      } else if (pointerdown) {
        switch (e.type) {
          case 'pointermove':
            action = TouchAction.Move
            break
          case 'pointerup':
          case 'pointercancel':
          case 'pointerout':
            setPointerDown(false)
            action = TouchAction.Up
            break
        }
      } else {
        return
      }

      const { offsetX: x, offsetY: y } = e.nativeEvent
      send({ x: x / width, y: y / height, action })
    },
    [pointerdown, send, width, height],
  )

  return sendTouchEvent
}
