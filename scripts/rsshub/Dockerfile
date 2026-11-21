# Official release v2026.11.21-8713.53e83fa; keep patches tied to tested source.
FROM diygod/rsshub@sha256:631b4a276c16d77e434e18e2116bc2289a054ccecdbdd668b522bbab71c06d60

COPY patch-routes.mjs /tmp/patch-routes.mjs
RUN node /tmp/patch-routes.mjs /app/dist && rm /tmp/patch-routes.mjs
