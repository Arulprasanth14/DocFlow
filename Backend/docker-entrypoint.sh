#!/bin/bash
# docker-entrypoint.sh — runs DB migrations then starts the app

set -e

echo "==> Running Alembic migrations..."
alembic upgrade head

echo "==> Starting DocFlow Backend..."
exec "$@"
