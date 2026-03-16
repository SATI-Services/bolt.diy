#!/bin/bash
set -e
cd /home/bolt.diy

# Generate wrangler bindings from .env.local
bindings=$(./bindings.sh)

# Start wrangler with bindings
exec ./node_modules/.bin/wrangler pages dev ./build/client $bindings --ip 0.0.0.0 --port 5173
