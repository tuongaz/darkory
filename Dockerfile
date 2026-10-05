# syntax=docker/dockerfile:1
#
# The Darkory server image, built from source:
#
#   docker build --build-arg VERSION=$(git describe --tags --always) -t darkory .
#   docker run -p 7357:7357 -v darkory-data:/data darkory
#
# It holds only the static binary, on distroless (CA certificates and a non-root user, no
# shell). Releases build the same image from goreleaser's binaries with release.Dockerfile.
# The web app is embedded from web/dist as the build context has it; run `make web` first for
# a fresh one.

FROM --platform=$BUILDPLATFORM golang:1.26.8-alpine AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
    -ldflags "-s -w -X github.com/tuongaz/darkory/internal/version.Version=${VERSION}" \
    -o /out/darkory ./cmd/darkory

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/darkory /darkory
USER nonroot:nonroot
# WORKDIR creates /data owned by nonroot, so a new volume mounted there is writable.
WORKDIR /data
VOLUME /data
# DARKORY_CONTAINER tells `darkory update` to point at a newer image instead of replacing itself.
ENV DARKORY_LISTEN=0.0.0.0:7357 DARKORY_DATA=/data DARKORY_CONTAINER=1
EXPOSE 7357
ENTRYPOINT ["/darkory"]
CMD ["serve"]
