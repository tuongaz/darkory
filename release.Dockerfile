# The release image, which goreleaser builds from the binaries it has already made
# (dockers_v2 in .goreleaser.yaml puts each at $TARGETPLATFORM/darkory). Dockerfile builds the
# same image from source; keep the two final stages alike.
FROM gcr.io/distroless/static-debian12:nonroot
ARG TARGETPLATFORM
COPY $TARGETPLATFORM/darkory /darkory
USER nonroot:nonroot
# WORKDIR creates /data owned by nonroot, so a new volume mounted there is writable.
WORKDIR /data
VOLUME /data
# DARKORY_CONTAINER tells `darkory update` to point at a newer image instead of replacing itself.
ENV DARKORY_LISTEN=0.0.0.0:7357 DARKORY_DATA=/data DARKORY_CONTAINER=1
EXPOSE 7357
ENTRYPOINT ["/darkory"]
CMD ["serve"]
