/* Reads the i.MX6 touchscreen (evdev) and reports normalized touch events.
 * See imx6-native-client.md, "Touch input (i.MX6 side)": confirmed device
 * is /dev/input/event0 (EETI eGalax), single-touch (EV_ABS + BTN_TOUCH, no
 * EV_MSC / ABS_MT_*). If a board turns out to be a type-B multitouch panel
 * instead, only touch.c needs to change - this header's contract (one
 * active point, normalized 0..1 coordinates) stays the same. */
#ifndef IMX6_CLIENT_TOUCH_H
#define IMX6_CLIENT_TOUCH_H

#include <stdint.h>

/* Matches TouchAction from node-carplay/web. */
#define TOUCH_ACTION_DOWN 14
#define TOUCH_ACTION_MOVE 15
#define TOUCH_ACTION_UP 16

/* action: one of TOUCH_ACTION_*. x, y: normalized 0..1, per the panel's own
 * ABS_X/ABS_Y min/max (read via EVIOCGABS), not an assumed resolution. */
typedef void (*touch_event_cb)(uint8_t action, float x, float y, void *user_data);

/* Opens device_path, spawns a background thread that blocks on read() and
 * invokes cb for every touch down/move/up. Returns 0 on success, -1 on
 * failure to open or query the device (errno set). The thread runs until
 * the process exits - there is no touch_thread_stop, matching this being a
 * single long-lived client process. */
int touch_thread_start(const char *device_path, touch_event_cb cb, void *user_data);

#endif
