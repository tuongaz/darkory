package e2e

import (
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
)

// short is the short form the API writes for a UUID (api/openapi.yaml, Ids): written here from the
// spec, as any client would, since the suite drives the binary from outside and imports nothing
// internal. A Session the suite chose as a UUID comes back in this form.
func short(uuid string) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	n, ok := new(big.Int).SetString(strings.ReplaceAll(uuid, "-", ""), 16)
	if !ok || len(uuid) != 36 {
		return uuid
	}
	out := make([]byte, 22)
	base, digit := big.NewInt(58), new(big.Int)
	for i := 21; i >= 0; i-- {
		n.DivMod(n, base, digit)
		out[i] = alphabet[digit.Int64()]
	}
	return string(out)
}

// The suite's encoder agrees with the server's and the web app's on the shared vectors.
func TestShortAgreesWithTheVectors(t *testing.T) {
	b, err := os.ReadFile("../api/shortid-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Pairs []struct{ UUID, Short string } `json:"pairs"`
	}
	if err := json.Unmarshal(b, &v); err != nil || len(v.Pairs) == 0 {
		t.Fatalf("vectors: %v", err)
	}
	for _, p := range v.Pairs {
		if got := short(p.UUID); got != p.Short {
			t.Errorf("short(%s) = %s, want %s", p.UUID, got, p.Short)
		}
	}
}
