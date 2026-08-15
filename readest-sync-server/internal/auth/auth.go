package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	jwt.RegisteredClaims
	Plan string `json:"plan"`
}

type Service struct {
	jwtSecret []byte
	authCode  string
}

func NewService(authCode, jwtSecret string) *Service {
	return &Service{authCode: authCode, jwtSecret: []byte(jwtSecret)}
}

func (s *Service) CheckCode(code string) bool { return code == s.authCode }

// tokenTTL bounds how long a leaked JWT stays valid. The client re-logins
// with the persisted login code via AuthContext.refresh once the token has
// expired, so users are not forced back to the login screen. Changing
// AUTH_CODE (or JWT_SECRET) remains the revocation mechanism.
const tokenTTL = 10 * 365 * 24 * time.Hour

func (s *Service) IssueToken(sub string) (string, error) {
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(tokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Plan: "pro",
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

func (s *Service) VerifyToken(token string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing alg")
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}
