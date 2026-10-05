package remote

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// failing fails every request, recording what it was sent.
type failing struct {
	mu     sync.Mutex
	bodies []string
	keys   []string
}

func (f *failing) RoundTrip(req *http.Request) (*http.Response, error) {
	var b []byte
	if req.Body != nil {
		b, _ = io.ReadAll(req.Body)
	}
	f.mu.Lock()
	f.bodies = append(f.bodies, string(b))
	f.keys = append(f.keys, req.Header.Get("Idempotency-Key"))
	f.mu.Unlock()
	return nil, errors.New("network down")
}

// A request that never got an answer is sent once more: a write with the same Idempotency-Key
// and body, a read as it was. A write without a key, or one whose context ended, is not.
func TestRetryOnce(t *testing.T) {
	for _, tc := range []struct {
		name     string
		method   string
		key      string
		body     string
		canceled bool
		sends    int
	}{
		{"read", http.MethodGet, "", "", false, 2},
		{"write with a key", http.MethodPost, "k1", `{"title":"x"}`, false, 2},
		{"write without a key", http.MethodPost, "", `{"title":"x"}`, false, 1},
		{"canceled", http.MethodPost, "k1", `{}`, true, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &failing{}
			d := retryOnce{&http.Client{Transport: f}}
			ctx, cancel := context.WithCancel(t.Context())
			if tc.canceled {
				cancel()
			} else {
				defer cancel()
			}
			var body io.Reader
			if tc.body != "" {
				body = bytes.NewReader([]byte(tc.body))
			}
			req, _ := http.NewRequestWithContext(ctx, tc.method, "http://127.0.0.1:1/v1/tasks", body)
			if tc.key != "" {
				req.Header.Set("Idempotency-Key", tc.key)
			}
			if _, err := d.Do(req); err == nil {
				t.Fatal("no error")
			}
			if len(f.bodies) != tc.sends && !tc.canceled {
				t.Fatalf("sent %d times, want %d", len(f.bodies), tc.sends)
			}
			for i := range f.bodies {
				if f.bodies[i] != tc.body || f.keys[i] != tc.key {
					t.Fatalf("send %d: body %q key %q", i, f.bodies[i], f.keys[i])
				}
			}
		})
	}
}

// Dial's client sets a fresh Idempotency-Key on every write and none on reads.
func TestDialSetsCredentialsAndKeys(t *testing.T) {
	f := &failing{}
	c, err := Dial(Settings{URL: "http://127.0.0.1:1/", Token: "dk_x", Session: "s1", HTTPClient: &http.Client{Transport: f}})
	if err != nil {
		t.Fatal(err)
	}
	c.GetMeWithResponse(t.Context())
	c.LogoutWithResponse(t.Context(), nil)
	c.LogoutWithResponse(t.Context(), nil)
	if len(f.keys) != 6 || f.keys[0] != "" || f.keys[2] == "" || f.keys[2] != f.keys[3] || f.keys[4] == f.keys[2] {
		t.Fatalf("keys %q", f.keys)
	}
}

func TestErrorFrom(t *testing.T) {
	e := ErrorFrom(409, []byte(`{"code":"already_claimed","message":"held by bob","details":{"holder":"bob"}}`))
	if e.Code != "already_claimed" || !e.Refused() || e.Details["holder"] != "bob" || e.Error() != "already_claimed: held by bob" {
		t.Fatalf("%+v", e)
	}
	e = ErrorFrom(502, []byte("<html>bad gateway</html>"))
	if e.Code != "" || e.Refused() || !strings.Contains(e.Error(), "HTTP 502") {
		t.Fatalf("%+v", e)
	}
	if err := Check(nil, errors.New("dial tcp: refused")); CodeOf(err) != "" || !strings.Contains(err.Error(), "no answer from the Install") {
		t.Fatalf("%v", err)
	}
}
