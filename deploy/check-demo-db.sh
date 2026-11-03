#!/bin/sh
# Refuse startup unless this service process reaches the intended demo DB.
set -eu
result=$(psql -X -w -d seekjournal_demo -Atqc "SELECT current_database() || '|' || current_user || '|' || CASE WHEN inet_server_addr() IS NULL THEN 'socket' ELSE 'tcp' END || '|' || version_num FROM alembic_version")
if [ "$result" != 'seekjournal_demo|Fern|socket|c01a7e421b50' ]; then
    echo 'Demo database identity or migration version mismatch; refusing startup.' >&2
    exit 1
fi
