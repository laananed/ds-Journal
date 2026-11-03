#!/bin/sh
# Certbot deploy hook: reload only this proxy after this domain is renewed.
set -eu
case " ${RENEWED_DOMAINS:-} " in
    *" api.freirenlikesleep.cyou "*)
        if systemctl --quiet is-active seekjournal-proxy.service; then
            systemctl reload seekjournal-proxy.service
        fi
        ;;
esac
