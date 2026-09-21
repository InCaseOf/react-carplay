#include "touch.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

typedef struct {
    char device_path[256];
    touch_event_cb cb;
    void *user_data;
} TouchThreadArgs;

static int read_abs_range(int fd, unsigned code, int32_t *out_min, int32_t *out_max) {
    struct input_absinfo info;
    if (ioctl(fd, EVIOCGABS(code), &info) < 0) {
        return -1;
    }
    *out_min = info.minimum;
    *out_max = info.maximum;
    return 0;
}

static void *touch_thread_main(void *arg) {
    TouchThreadArgs *args = (TouchThreadArgs *)arg;
    int fd = open(args->device_path, O_RDONLY);
    if (fd < 0) {
        fprintf(stderr, "touch: failed to open %s: %s\n", args->device_path, strerror(errno));
        free(args);
        return NULL;
    }

    int32_t min_x = 0, max_x = 1, min_y = 0, max_y = 1;
    if (read_abs_range(fd, ABS_X, &min_x, &max_x) < 0 ||
        read_abs_range(fd, ABS_Y, &min_y, &max_y) < 0) {
        fprintf(stderr, "touch: EVIOCGABS failed on %s: %s\n", args->device_path, strerror(errno));
        close(fd);
        free(args);
        return NULL;
    }

    /* Pending state for the point currently being reported, flushed on
     * every SYN_REPORT (one full touch sample per report). */
    int32_t raw_x = min_x, raw_y = min_y;
    int is_down = 0;      /* current known BTN_TOUCH state */
    int saw_pos_update = 0;
    int saw_down_edge = 0;
    int saw_up_edge = 0;

    struct input_event ev;
    while (read(fd, &ev, sizeof(ev)) == (ssize_t)sizeof(ev)) {
        switch (ev.type) {
            case EV_ABS:
                if (ev.code == ABS_X) {
                    raw_x = ev.value;
                    saw_pos_update = 1;
                } else if (ev.code == ABS_Y) {
                    raw_y = ev.value;
                    saw_pos_update = 1;
                }
                break;
            case EV_KEY:
                if (ev.code == BTN_TOUCH) {
                    if (ev.value && !is_down) saw_down_edge = 1;
                    if (!ev.value && is_down) saw_up_edge = 1;
                    is_down = ev.value ? 1 : 0;
                }
                break;
            case EV_SYN:
                if (ev.code != SYN_REPORT) break;

                if (saw_down_edge) {
                    float x = (float)(raw_x - min_x) / (float)(max_x - min_x);
                    float y = (float)(raw_y - min_y) / (float)(max_y - min_y);
                    args->cb(TOUCH_ACTION_DOWN, x, y, args->user_data);
                } else if (saw_up_edge) {
                    float x = (float)(raw_x - min_x) / (float)(max_x - min_x);
                    float y = (float)(raw_y - min_y) / (float)(max_y - min_y);
                    args->cb(TOUCH_ACTION_UP, x, y, args->user_data);
                } else if (is_down && saw_pos_update) {
                    float x = (float)(raw_x - min_x) / (float)(max_x - min_x);
                    float y = (float)(raw_y - min_y) / (float)(max_y - min_y);
                    args->cb(TOUCH_ACTION_MOVE, x, y, args->user_data);
                }

                saw_pos_update = 0;
                saw_down_edge = 0;
                saw_up_edge = 0;
                break;
            default:
                break;
        }
    }

    fprintf(stderr, "touch: read() on %s ended: %s\n", args->device_path, strerror(errno));
    close(fd);
    free(args);
    return NULL;
}

int touch_thread_start(const char *device_path, touch_event_cb cb, void *user_data) {
    TouchThreadArgs *args = calloc(1, sizeof(TouchThreadArgs));
    if (!args) return -1;
    snprintf(args->device_path, sizeof(args->device_path), "%s", device_path);
    args->cb = cb;
    args->user_data = user_data;

    pthread_t thread;
    if (pthread_create(&thread, NULL, touch_thread_main, args) != 0) {
        free(args);
        return -1;
    }
    pthread_detach(thread);
    return 0;
}
