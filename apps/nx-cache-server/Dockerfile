FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

# wget ships in busybox; used by the compose healthcheck.
# The server runs directly on Node and has no runtime dependencies. Remove the
# package-manager toolchain from the final image, including npm's bundled tar,
# so it cannot add an unused vulnerability surface to the published artifact.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The canonical publisher intentionally creates its temporary source checkout
# with a private umask.  Make the runtime user the owner so that checkout mode
# cannot make the application unreadable once the image switches to `node`.
COPY --chown=node:node server.js /app/server.js

USER node
EXPOSE 3000
CMD ["node", "/app/server.js"]
