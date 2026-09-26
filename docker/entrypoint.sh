#!/bin/sh
# Fly's machine API socket mints the OIDC identity token used for Anthropic workload identity
# federation, and only its owner (root) may connect to it. Grant the app's group access to that one
# socket, then drop to the unprivileged app user for the actual server.
set -eu
if [ -S /.fly/api ]; then
  chgrp bun /.fly/api
  chmod g+rw /.fly/api
fi
exec su-exec bun "$@"
