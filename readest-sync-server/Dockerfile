# 构建阶段
FROM golang:1.25-alpine AS build
WORKDIR /src

ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY

ARG APK_MIRROR=mirrors.tuna.tsinghua.edu.cn
RUN sed -i "s|dl-cdn.alpinelinux.org|${APK_MIRROR}|g" /etc/apk/repositories \
 && apk add --no-cache git

COPY go.mod go.sum ./
RUN go env -w GOPROXY=https://goproxy.cn,direct \
 && go env -w GOSUMDB=off
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/readest-sync .


FROM alpine:3.24
WORKDIR /app
RUN adduser -D -u 10001 appuser
COPY --from=build /out/readest-sync /app/readest-sync
# 运行时数据卷挂载点（sqlite 文件 + 本地文件存储）
RUN mkdir -p /app/data && chown -R appuser:appuser /app/data
VOLUME ["/app/data"]
ENV LISTEN_ADDR=:8080
EXPOSE 8080
# 以非 root 运行
USER appuser
ENTRYPOINT ["/app/readest-sync"]
