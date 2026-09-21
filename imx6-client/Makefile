# Cross-compile with an NXP Yocto SDK: source that SDK's
# environment-setup-* script first, which exports CC/CXX/PKG_CONFIG_PATH/
# PKG_CONFIG_SYSROOT_DIR for the target - this Makefile just uses whatever
# it finds in the environment, falling back to a native build for
# quick local syntax checking (won't produce a binary that runs on the
# i.MX6 - vpudec/imxv4l2sink aren't real on a dev machine).
CC ?= gcc
PKG_CONFIG ?= pkg-config

PKGS := gstreamer-1.0 gstreamer-app-1.0 libwebsockets
CFLAGS += -Wall -Wextra -O2 $(shell $(PKG_CONFIG) --cflags $(PKGS))
LDLIBS += $(shell $(PKG_CONFIG) --libs $(PKGS)) -lpthread

SRCS := src/main.c src/touch.c
OBJS := $(SRCS:.c=.o)
BIN := carplay-imx6-client

.PHONY: all clean
all: $(BIN)

$(BIN): $(OBJS)
	$(CC) -o $@ $(OBJS) $(LDLIBS)

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJS) $(BIN)
