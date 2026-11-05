#!/bin/sh
# Start the Test Hub. Stop with Ctrl+C.
cd "$(dirname "$0")"
exec node server.js
