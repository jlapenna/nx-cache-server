FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

# wget ships in busybox; used by the compose healthcheck.
# The server runs directly on Node and has no runtime dependencies. Remove the
# package-manager toolchain from the final image, including npm's bundled tar,
# so it cannot add an unused vulnerability surface to the published artifact.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The canonical publisher intentionally creates its temporary source checkout
# with a private umask.  Make the runtime user the owner so that checkout mode
# cannot make the application unreadable once the image switches to `node`.
COPY --chown=node:node server.js /app/server.js
# The live integrity canary ships beside the server it tests, so a deployment
# can run the canary at exactly the published server revision instead of
# keeping its own copy. It is not run inside the container (the image has no
# curl); deployments extract it from the image with `docker cp`. A host will
# execute it, so it is root-owned and read-only: the runtime user cannot
# alter it even if the container is compromised.
COPY --chown=root:root --chmod=0555 canary.sh /app/canary.sh

USER node
EXPOSE 3000
CMD ["node", "/app/server.js"]
