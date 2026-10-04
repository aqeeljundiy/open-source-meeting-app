#!/bin/sh
# Virtual screen + audio device for the bots, then the app.
set -e
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &

# PulseAudio as root in a container: give it a runtime dir and a null sink
# so Chrome sees a speaker and a microphone (Meet greys out joining without them).
export XDG_RUNTIME_DIR=/tmp/runtime-root
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio -D --exit-idle-time=-1 --disallow-exit --log-target=stderr \
  --load="module-null-sink sink_name=bot sink_properties=device.description=Bot" \
  --load="module-virtual-source source_name=botmic master=bot.monitor" 2>/tmp/pulse.log || true
sleep 1
if pactl info >/dev/null 2>&1; then
  echo "audio: pulseaudio ok ($(pactl list short sinks | wc -l) sink, $(pactl list short sources | wc -l) sources)"
else
  echo "audio: pulseaudio NOT running"; tail -5 /tmp/pulse.log
fi
exec node server.mjs
