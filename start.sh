#!/bin/bash
# Starts the app server plus the userspace tailscaled that fronts it with HTTPS.
# Everything here runs as ubuntu — no root anywhere.
set -u
H=/home/ubuntu

pgrep -f "userspace-networking --statedir=$H/ts" >/dev/null || \
  /usr/sbin/tailscaled --tun=userspace-networking --statedir=$H/ts \
    --socket=$H/ts/sock --port=0 >> $H/ts/tsd.log 2>&1 &

pgrep -f "node server/server.js" >/dev/null || \
  ( cd $H/whats_this && MODEL=${MODEL:-gemma3:12b} PORT=8080 \
    setsid node server/server.js >> $H/whats_this/server.log 2>&1 < /dev/null & )

# serve config is persisted in the state dir; re-assert it in case it was cleared
sleep 5
tailscale --socket=$H/ts/sock serve --bg --https=443 http://127.0.0.1:8080 >/dev/null 2>&1
