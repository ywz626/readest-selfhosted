package auth

import "testing"

func TestIssueAndVerify(t *testing.T) {
	svc := NewService("secret123", "topsecret")
	tok, err := svc.IssueToken("owner")
	if err != nil {
		t.Fatal(err)
	}
	claims, err := svc.VerifyToken(tok)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "owner" {
		t.Fatalf("sub=%s", claims.Subject)
	}
	if claims.Plan != "pro" {
		t.Fatalf("plan=%s", claims.Plan)
	}
}

func TestCheckCode(t *testing.T) {
	svc := NewService("secret123", "topsecret")
	if !svc.CheckCode("secret123") {
		t.Fatal("valid code rejected")
	}
	if svc.CheckCode("wrong") {
		t.Fatal("invalid code accepted")
	}
}
