FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src

COPY go.mod ./
COPY main.go ./
COPY templates ./templates
COPY static ./static

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/pdns-webui ./main.go

FROM alpine:3.20

WORKDIR /app

RUN adduser -D -H -s /sbin/nologin appuser

COPY --from=builder /out/pdns-webui /app/pdns-webui

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/api/config >/dev/null || exit 1

CMD ["/app/pdns-webui"]
