FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src

COPY go.mod ./
COPY main.go ./
COPY templates ./templates
COPY static ./static

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/pdns-webui ./main.go

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/pdns-webui /pdns-webui

EXPOSE 8080

ENTRYPOINT ["/pdns-webui"]
