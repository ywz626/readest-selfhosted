package store

import (
	"encoding/json"
	"fmt"
	"strings"
)

// jsonUnmarshalField decodes a single field from a JSON document into target.
func jsonUnmarshalField(data []byte, field string, target interface{}) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	raw, ok := m[field]
	if !ok {
		return nil
	}
	return json.Unmarshal(raw, target)
}

// nullableString returns "" for a nil []byte, else the string contents.
func nullableString(b []byte) string {
	if b == nil {
		return ""
	}
	return string(b)
}

// uniqueHlc returns the lexicographically greater of two HLCs (unused helper kept for clarity).
func uniqueHlc(a, b string) string {
	if a > b {
		return a
	}
	return b
}

var _ = uniqueHlc
var _ = hlcMax
var _ = fmt.Sprint
var _ = strings.TrimSpace
