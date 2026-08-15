package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	ListenAddr      string
	AuthCode        string
	JWTSecret       string
	MetadataBackend string // "sqlite" | "postgres"
	MetadataDSN     string // sqlite file path or postgres URL
	StorageKind     string // "local" | "s3"
	LocalRoot       string
	S3Endpoint      string
	S3Bucket        string
	S3AccessKey     string
	S3SecretKey     string
	S3Region        string
	S3UsePathStyle  bool // MinIO needs true
	QuotaBytes      int64
}

func LoadConfig() Config {
	_ = godotenv.Load() // optional .env, ignored if missing
	get := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return def
	}
	cfg := Config{
		ListenAddr:      get("LISTEN_ADDR", ":8080"),
		AuthCode:        os.Getenv("AUTH_CODE"),
		JWTSecret:       get("JWT_SECRET", ""),
		MetadataBackend: get("METADATA_BACKEND", "sqlite"),
		MetadataDSN:     get("METADATA_DSN", "file:./data/readest.db"),
		StorageKind:     get("STORAGE_KIND", "local"),
		LocalRoot:       get("LOCAL_ROOT", "./data/files"),
		S3Endpoint:      get("S3_ENDPOINT", ""),
		S3Bucket:        get("S3_BUCKET", ""),
		S3AccessKey:     get("S3_ACCESS_KEY", ""),
		S3SecretKey:     get("S3_SECRET_KEY", ""),
		S3Region:        get("S3_REGION", "us-east-1"),
		S3UsePathStyle:  get("S3_USE_PATH_STYLE", "false") == "true",
		QuotaBytes:      getInt64("QUOTA_BYTES", 1<<60),
	}
	if cfg.JWTSecret == "" {
		cfg.JWTSecret = randomHex(32) // generated at startup; warning: tokens invalid after restart
	}
	if cfg.AuthCode == "" {
		// Never fall back to a well-known default code: generate an ephemeral
		// one and print it so a deployment without AUTH_CODE still starts, but
		// the code is only exposed to whoever can read the logs.
		cfg.AuthCode = randomHex(16)
		log.Printf("AUTH_CODE not set; generated ephemeral login code: %s", cfg.AuthCode)
	}
	return cfg
}

func getInt64(key string, def int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	var n int64
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return def
	}
	return n
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "insecure-fallback-secret-change-me"
	}
	return hex.EncodeToString(b)
}
