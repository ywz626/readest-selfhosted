package main

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"readestsync/internal/auth"
	"readestsync/internal/middleware"
	"readestsync/internal/ratelimit"
	"readestsync/internal/store"
	"readestsync/internal/storage"
	"readestsync/internal/sync"
	"readestsync/internal/proxy"
)

func main() {
	cfg := LoadConfig()

	authSvc := auth.NewService(cfg.AuthCode, cfg.JWTSecret)

	// Brute-force protection for the shared static login code: lock a device
	// (or IP) for 15 minutes after 3 consecutive failures.
	loginLimiter := ratelimit.NewLoginLimiter(3, 15*time.Minute, time.Hour)
	backends := store.Backends{
		MetadataBackend: cfg.MetadataBackend,
		MetadataDSN:     cfg.MetadataDSN,
		StorageKind:     cfg.StorageKind,
		LocalRoot:       cfg.LocalRoot,
		S3Endpoint:      cfg.S3Endpoint,
		S3Bucket:        cfg.S3Bucket,
		S3AccessKey:     cfg.S3AccessKey,
		S3SecretKey:     cfg.S3SecretKey,
		S3Region:        cfg.S3Region,
		S3UsePathStyle:  cfg.S3UsePathStyle,
	}
	ms, err := store.NewMetadataStore(backends)
	if err != nil {
		panic(err)
	}
	fs, err := store.NewFileStore(backends)
	if err != nil {
		panic(err)
	}

	syncH := sync.NewSyncHandler(ms)
	replicaH := sync.NewReplicaHandler(ms)
	storageH := storage.NewStorageHandler(ms, fs, cfg.QuotaBytes)

	r := chi.NewRouter()

	// Public: login (with brute-force / device-lock protection)
	r.Post("/api/auth", func(w http.ResponseWriter, r *http.Request) {
		auth.LoginHandler(authSvc, loginLimiter, w, r)
	})

	// Protected routes (require Bearer JWT)
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return middleware.RequireAuth(authSvc, next)
		})

		r.Get("/api/sync", syncH.ServeHTTP)
		r.Post("/api/sync", syncH.ServeHTTP)
		r.Get("/api/sync/replicas", replicaH.Get)
		r.Post("/api/sync/replicas", replicaH.Post)
		r.Get("/api/sync/replica-keys", replicaH.KeysGet)
		r.Post("/api/sync/replica-keys", replicaH.KeysPost)
		r.Delete("/api/sync/replica-keys", replicaH.KeysDelete)
		r.Post("/api/storage/upload", storageH.Upload)
		r.Get("/api/storage/download", storageH.Download)
		r.Post("/api/storage/download", storageH.DownloadBatch)
		r.Get("/api/storage/list", storageH.List)
		r.Delete("/api/storage/delete", storageH.Delete)
		r.Get("/api/storage/stats", storageH.Stats)
		r.Delete("/api/storage/purge", storageH.Purge)
		r.Put("/api/storage/blob/*", storageH.BlobPut)
		r.Get("/api/storage/blob/*", storageH.BlobGet)
		r.Post("/api/deepl/translate", proxy.DeepLTranslate)
		r.Post("/api/yandex-translate", proxy.YandexTranslate)
		r.HandleFunc("/api/tts/edge", proxy.EdgeTTS)
		r.Get("/api/metadata/search", proxy.MetadataSearch)
	})

	_ = http.ListenAndServe(cfg.ListenAddr, r)
}
