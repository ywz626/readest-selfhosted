# 构建阶段
FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 关闭 CGO：modernc.org/sqlite 是纯 Go，无需 CGO；保证镜像可移植
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/readest-sync .

# 运行阶段
FROM alpine:3.20
WORKDIR /app
RUN adduser -D -u 10001 appuser
COPY --from=build /out/readest-sync /app/readest-sync
# 运行时数据卷挂载点（sqlite 文件 + 本地文件存储）
VOLUME ["/app/data"]
ENV LISTEN_ADDR=:8080
EXPOSE 8080
# 以非 root 运行
USER appuser
ENTRYPOINT ["/app/readest-sync"]
