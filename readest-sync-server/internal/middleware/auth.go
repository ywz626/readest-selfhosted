package middleware

import (
	"context"
	"net/http"
	"strings"

	"readestsync/internal/auth"
)

type ctxKey struct{}

var userKey ctxKey = struct{}{}

func RequireAuth(svc *auth.Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("Authorization")
		if !strings.HasPrefix(raw, "Bearer ") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"missing token","code":"AUTH"}`))
			return
		}
		claims, err := svc.VerifyToken(strings.TrimPrefix(raw, "Bearer "))
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"invalid token","code":"AUTH"}`))
			return
		}
		ctx := context.WithValue(r.Context(), userKey, claims.Subject)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func UserID(r *http.Request) string {
	if v, ok := r.Context().Value(userKey).(string); ok {
		return v
	}
	return ""
}
