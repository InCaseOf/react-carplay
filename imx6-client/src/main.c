/* Native i.MX6 CarPlay client - see imx6-native-client.md for the design
 * this implements. Connects to the SBC's /native raw WebSocket endpoint
 * (Socket.ts), decodes video/audio with the board's VPU/ALSA via
 * GStreamer, and reports touchscreen input + mic audio back over the same
 * connection. Not yet built/cross-compiled or run on hardware - see the
 * README in this directory for build status and open questions.
 */
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <libwebsockets.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "touch.h"

/* ---- wire protocol, from imx6-native-client.md ---- */
#define TAG_VIDEO_CHUNK 0x01 /* SBC -> us: raw H.264 Annex-B, one frame */
#define TAG_AUDIO_CHUNK 0x02 /* SBC -> us: u16 decodeType, u16 audioType, S16LE PCM */
#define TAG_MIC_CHUNK 0x03   /* us -> SBC: S16LE PCM, mono, 16kHz */
#define TAG_TOUCH_EVENT 0x04 /* us -> SBC: u8 action, f32 x, f32 y */

#define DEFAULT_WS_HOST "192.168.155.5"
#define DEFAULT_WS_PORT 4000
#define WS_PATH "/native"

#define TOUCH_DEVICE "/dev/input/event0"
#define ALSA_DEVICE "sysdefault:CARD=imx6audiosgtl50"
#define MIC_SAMPLE_RATE 16000

#define MAX_AUDIO_PLAYERS 4
#define RECONNECT_DELAY_MS 2000

/* decodeType -> PCM format. Only decodeType determines the format; the
 * accompanying audioType just distinguishes concurrent logical audio
 * streams (media vs. nav prompt, etc.) - see createAudioPlayerKey in
 * src/renderer/src/components/worker/utils.ts. Values copied verbatim from
 * node_modules/node-carplay/dist/modules/messages/readable.js's
 * decodeTypeMap - keep this in sync if that table ever changes. */
typedef struct {
    int decode_type;
    int frequency;
    int channels;
} DecodeTypeInfo;

static const DecodeTypeInfo DECODE_TYPE_MAP[] = {
    {1, 44100, 2}, {2, 44100, 2}, {3, 8000, 1}, {4, 48000, 2},
    {5, 16000, 1}, {6, 24000, 1}, {7, 16000, 2},
};

static const DecodeTypeInfo *lookup_decode_type(int decode_type) {
    size_t i;
    for (i = 0; i < sizeof(DECODE_TYPE_MAP) / sizeof(DECODE_TYPE_MAP[0]); i++) {
        if (DECODE_TYPE_MAP[i].decode_type == decode_type) return &DECODE_TYPE_MAP[i];
    }
    return NULL;
}

typedef struct {
    int in_use;
    int decode_type;
    int audio_type;
    GstElement *pipeline;
    GstElement *appsrc;
} AudioPlayer;

typedef struct OutFrame OutFrame;
struct OutFrame {
    unsigned char *buf; /* LWS_PRE bytes of padding, then the frame itself */
    size_t len;         /* frame length (tag byte + payload), excludes LWS_PRE */
    OutFrame *next;
};

typedef struct {
    struct lws *wsi;
    struct lws_context *lws_ctx;
    volatile int connected;

    /* Outgoing queue: touch events (touch thread) and mic audio (GStreamer's
     * own streaming thread) both enqueue here; only the lws service thread
     * (main()) ever dequeues, in the LWS_CALLBACK_CLIENT_WRITEABLE handler.
     * lws_callback_on_writable() is documented safe to call cross-thread,
     * which is what wakes the service loop when something is queued. */
    pthread_mutex_t out_mutex;
    OutFrame *out_head;
    OutFrame *out_tail;

    /* Inbound message reassembly - a video frame or audio chunk can span
     * more than one LWS_CALLBACK_CLIENT_RECEIVE call. */
    unsigned char *rx_buf;
    size_t rx_len;
    size_t rx_cap;

    GstElement *video_pipeline;
    GstElement *video_appsrc;

    GstElement *mic_pipeline;

    /* Only touched from the lws service thread (on_audio_chunk runs
     * synchronously inside lws_service()), so no lock needed. */
    AudioPlayer audio_players[MAX_AUDIO_PLAYERS];
} AppContext;

static AppContext g_ctx;

static void enqueue_out(AppContext *ctx, uint8_t tag, const uint8_t *payload, size_t payload_len) {
    size_t total = 1 + payload_len;
    unsigned char *buf = malloc(LWS_PRE + total);
    if (!buf) return;
    buf[LWS_PRE] = tag;
    if (payload_len) memcpy(buf + LWS_PRE + 1, payload, payload_len);

    OutFrame *frame = malloc(sizeof(OutFrame));
    if (!frame) {
        free(buf);
        return;
    }
    frame->buf = buf;
    frame->len = total;
    frame->next = NULL;

    pthread_mutex_lock(&ctx->out_mutex);
    if (ctx->out_tail) {
        ctx->out_tail->next = frame;
        ctx->out_tail = frame;
    } else {
        ctx->out_head = ctx->out_tail = frame;
    }
    pthread_mutex_unlock(&ctx->out_mutex);

    if (ctx->wsi) lws_callback_on_writable(ctx->wsi);
}

static void on_touch_event(uint8_t action, float x, float y, void *user_data) {
    AppContext *ctx = (AppContext *)user_data;
    unsigned char payload[9];
    payload[0] = action;
    /* Assumes a little-endian target, true for the i.MX6's default ARM
     * (and every other) mode this project targets. */
    memcpy(payload + 1, &x, sizeof(float));
    memcpy(payload + 5, &y, sizeof(float));
    enqueue_out(ctx, TAG_TOUCH_EVENT, payload, sizeof(payload));
}

static GstFlowReturn on_new_mic_sample(GstElement *sink, gpointer user_data) {
    AppContext *ctx = (AppContext *)user_data;
    GstSample *sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
    if (!sample) return GST_FLOW_ERROR;

    GstBuffer *buf = gst_sample_get_buffer(sample);
    GstMapInfo map;
    if (buf && gst_buffer_map(buf, &map, GST_MAP_READ)) {
        enqueue_out(ctx, TAG_MIC_CHUNK, map.data, map.size);
        gst_buffer_unmap(buf, &map);
    }
    gst_sample_unref(sample);
    return GST_FLOW_OK;
}

/* Pipelines built and driven programmatically (appsrc/appsink), not
 * gst-launch text - see imx6-native-client.md's "GStreamer pipeline
 * sketch" for why each element was chosen (vpudec/imxv4l2sink confirmed by
 * live SSH recon against the actual board). */
static int start_video_pipeline(AppContext *ctx) {
    GError *err = NULL;
    ctx->video_pipeline = gst_parse_launch(
        "appsrc name=videosrc format=time is-live=true do-timestamp=true "
        "caps=video/x-h264,stream-format=byte-stream,alignment=nal "
        "! h264parse ! vpudec ! imxv4l2sink sync=false",
        &err);
    if (err) {
        fprintf(stderr, "video pipeline: %s\n", err->message);
        g_error_free(err);
        return -1;
    }
    ctx->video_appsrc = gst_bin_get_by_name(GST_BIN(ctx->video_pipeline), "videosrc");
    gst_element_set_state(ctx->video_pipeline, GST_STATE_PLAYING);
    return 0;
}

static int start_mic_pipeline(AppContext *ctx) {
    GError *err = NULL;
    char desc[512];
    snprintf(desc, sizeof(desc),
              "alsasrc device=%s ! audioconvert ! audioresample "
              "! capsfilter caps=audio/x-raw,format=S16LE,rate=%d,channels=1 "
              "! appsink name=micsink emit-signals=true sync=false",
              ALSA_DEVICE, MIC_SAMPLE_RATE);
    ctx->mic_pipeline = gst_parse_launch(desc, &err);
    if (err) {
        fprintf(stderr, "mic pipeline: %s\n", err->message);
        g_error_free(err);
        return -1;
    }
    GstElement *appsink = gst_bin_get_by_name(GST_BIN(ctx->mic_pipeline), "micsink");
    g_signal_connect(appsink, "new-sample", G_CALLBACK(on_new_mic_sample), ctx);
    gst_object_unref(appsink);
    gst_element_set_state(ctx->mic_pipeline, GST_STATE_PLAYING);
    return 0;
}

static void stop_audio_player(AudioPlayer *player) {
    if (!player->in_use) return;
    gst_element_set_state(player->pipeline, GST_STATE_NULL);
    gst_object_unref(player->appsrc);
    gst_object_unref(player->pipeline);
    memset(player, 0, sizeof(*player));
}

static AudioPlayer *get_or_create_audio_player(AppContext *ctx, int decode_type, int audio_type) {
    int i, free_slot = -1;
    for (i = 0; i < MAX_AUDIO_PLAYERS; i++) {
        AudioPlayer *p = &ctx->audio_players[i];
        if (p->in_use && p->decode_type == decode_type && p->audio_type == audio_type) return p;
        if (!p->in_use && free_slot < 0) free_slot = i;
    }

    const DecodeTypeInfo *fmt = lookup_decode_type(decode_type);
    if (!fmt) {
        fprintf(stderr, "audio: unknown decodeType %d\n", decode_type);
        return NULL;
    }

    if (free_slot < 0) {
        /* All MAX_AUDIO_PLAYERS slots busy - evict the oldest (slot 0).
         * imx6-native-client.md notes usually only one or two streams are
         * active at once, so this should be rare in practice. */
        fprintf(stderr, "audio: player table full, evicting slot 0\n");
        stop_audio_player(&ctx->audio_players[0]);
        free_slot = 0;
    }

    AudioPlayer *player = &ctx->audio_players[free_slot];
    GError *err = NULL;
    char desc[512];
    snprintf(desc, sizeof(desc),
              "appsrc name=audiosrc format=time is-live=true do-timestamp=true "
              "caps=audio/x-raw,format=S16LE,rate=%d,channels=%d,layout=interleaved "
              "! audioconvert ! audioresample ! alsasink device=%s",
              fmt->frequency, fmt->channels, ALSA_DEVICE);
    player->pipeline = gst_parse_launch(desc, &err);
    if (err) {
        fprintf(stderr, "audio pipeline: %s\n", err->message);
        g_error_free(err);
        return NULL;
    }
    player->appsrc = gst_bin_get_by_name(GST_BIN(player->pipeline), "audiosrc");
    player->decode_type = decode_type;
    player->audio_type = audio_type;
    player->in_use = 1;
    gst_element_set_state(player->pipeline, GST_STATE_PLAYING);
    return player;
}

static void on_video_chunk(AppContext *ctx, const uint8_t *data, size_t len) {
    if (!ctx->video_appsrc || len == 0) return;
    GstBuffer *buf = gst_buffer_new_allocate(NULL, len, NULL);
    gst_buffer_fill(buf, 0, data, len);
    gst_app_src_push_buffer(GST_APP_SRC(ctx->video_appsrc), buf); /* takes ownership of buf */
}

static void on_audio_chunk(AppContext *ctx, const uint8_t *data, size_t len) {
    if (len < 4) return;
    int decode_type = data[0] | (data[1] << 8);
    int audio_type = data[2] | (data[3] << 8);
    const uint8_t *pcm = data + 4;
    size_t pcm_len = len - 4;

    AudioPlayer *player = get_or_create_audio_player(ctx, decode_type, audio_type);
    if (!player || pcm_len == 0) return;

    GstBuffer *buf = gst_buffer_new_allocate(NULL, pcm_len, NULL);
    gst_buffer_fill(buf, 0, pcm, pcm_len);
    gst_app_src_push_buffer(GST_APP_SRC(player->appsrc), buf);
}

static void rx_buf_ensure(AppContext *ctx, size_t needed) {
    if (ctx->rx_cap >= needed) return;
    size_t new_cap = ctx->rx_cap ? ctx->rx_cap * 2 : 65536;
    while (new_cap < needed) new_cap *= 2;
    ctx->rx_buf = realloc(ctx->rx_buf, new_cap);
    ctx->rx_cap = new_cap;
}

static int ws_callback(struct lws *wsi, enum lws_callback_reasons reason, void *user,
                        void *in, size_t len) {
    AppContext *ctx = &g_ctx;
    (void)user;

    switch (reason) {
        case LWS_CALLBACK_CLIENT_ESTABLISHED:
            fprintf(stderr, "ws: connected\n");
            ctx->connected = 1;
            ctx->wsi = wsi;
            /* Anything queued while disconnected (touch/mic frames) needs
             * an explicit nudge now - lws doesn't guarantee a WRITEABLE
             * callback just because a connection newly became ready. */
            pthread_mutex_lock(&ctx->out_mutex);
            if (ctx->out_head) lws_callback_on_writable(wsi);
            pthread_mutex_unlock(&ctx->out_mutex);
            break;

        case LWS_CALLBACK_CLIENT_RECEIVE:
            rx_buf_ensure(ctx, ctx->rx_len + len);
            memcpy(ctx->rx_buf + ctx->rx_len, in, len);
            ctx->rx_len += len;
            if (lws_is_final_fragment(wsi)) {
                if (ctx->rx_len >= 1) {
                    uint8_t tag = ctx->rx_buf[0];
                    const uint8_t *payload = ctx->rx_buf + 1;
                    size_t payload_len = ctx->rx_len - 1;
                    if (tag == TAG_VIDEO_CHUNK) {
                        on_video_chunk(ctx, payload, payload_len);
                    } else if (tag == TAG_AUDIO_CHUNK) {
                        on_audio_chunk(ctx, payload, payload_len);
                    }
                }
                ctx->rx_len = 0;
            }
            break;

        case LWS_CALLBACK_CLIENT_WRITEABLE: {
            pthread_mutex_lock(&ctx->out_mutex);
            OutFrame *frame = ctx->out_head;
            if (frame) {
                ctx->out_head = frame->next;
                if (!ctx->out_head) ctx->out_tail = NULL;
            }
            pthread_mutex_unlock(&ctx->out_mutex);

            if (frame) {
                lws_write(wsi, frame->buf + LWS_PRE, frame->len, LWS_WRITE_BINARY);
                free(frame->buf);
                free(frame);

                pthread_mutex_lock(&ctx->out_mutex);
                int more = ctx->out_head != NULL;
                pthread_mutex_unlock(&ctx->out_mutex);
                if (more) lws_callback_on_writable(wsi);
            }
            break;
        }

        case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
            fprintf(stderr, "ws: connection error: %s\n", in ? (char *)in : "?");
            ctx->connected = 0;
            ctx->wsi = NULL;
            break;

        case LWS_CALLBACK_CLIENT_CLOSED:
            fprintf(stderr, "ws: closed\n");
            ctx->connected = 0;
            ctx->wsi = NULL;
            break;

        default:
            break;
    }
    return 0;
}

static struct lws_protocols protocols[] = {
    {"carplay-native", ws_callback, 0, 0},
    {NULL, NULL, 0, 0} /* LWS_PROTOCOL_LIST_TERM */
};

int main(int argc, char **argv) {
    const char *host = argc > 1 ? argv[1] : DEFAULT_WS_HOST;
    int port = argc > 2 ? atoi(argv[2]) : DEFAULT_WS_PORT;

    memset(&g_ctx, 0, sizeof(g_ctx));
    pthread_mutex_init(&g_ctx.out_mutex, NULL);

    gst_init(&argc, &argv);
    if (start_video_pipeline(&g_ctx) != 0) return 1;
    if (start_mic_pipeline(&g_ctx) != 0) return 1;

    if (touch_thread_start(TOUCH_DEVICE, on_touch_event, &g_ctx) != 0) {
        fprintf(stderr, "touch: failed to start (%s) - continuing without touch input\n",
                TOUCH_DEVICE);
    }

    struct lws_context_creation_info info;
    memset(&info, 0, sizeof(info));
    info.port = CONTEXT_PORT_NO_LISTEN;
    info.protocols = protocols;
    info.gid = -1;
    info.uid = -1;
    g_ctx.lws_ctx = lws_create_context(&info);
    if (!g_ctx.lws_ctx) {
        fprintf(stderr, "ws: lws_create_context failed\n");
        return 1;
    }

    for (;;) {
        if (!g_ctx.connected && !g_ctx.wsi) {
            struct lws_client_connect_info ccinfo;
            memset(&ccinfo, 0, sizeof(ccinfo));
            ccinfo.context = g_ctx.lws_ctx;
            ccinfo.address = host;
            ccinfo.port = port;
            ccinfo.path = WS_PATH;
            ccinfo.host = host;
            ccinfo.origin = host;
            ccinfo.protocol = protocols[0].name;
            fprintf(stderr, "ws: connecting to ws://%s:%d%s\n", host, port, WS_PATH);
            g_ctx.wsi = lws_client_connect_via_info(&ccinfo);
            if (!g_ctx.wsi) {
                lws_service(g_ctx.lws_ctx, RECONNECT_DELAY_MS);
                continue;
            }
        }
        lws_service(g_ctx.lws_ctx, 50);
    }

    /* Unreachable in normal operation - this client runs until killed. */
    lws_context_destroy(g_ctx.lws_ctx);
    return 0;
}
