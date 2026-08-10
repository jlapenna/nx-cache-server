FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# wget ships in busybox; used by the compose healthcheck.
# The server runs directly on Node and has no runtime dependencies. Remove the
# package-manager toolchain from the final image, including npm's bundled tar,
# so it cannot add an unused vulnerability surface to the published artifact.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server.js /app/server.js

USER node
EXPOSE 3000
CMD ["node", "/app/server.js"]
