package shortid_test

import (
	"bytes"
	"encoding/json"
	"math/rand/v2"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/tuongaz/darkory/internal/shortid"
)

type vectors struct {
	Pairs []struct {
		UUID  string `json:"uuid"`
		Short string `json:"short"`
	} `json:"pairs"`
	Uppercase struct {
		UUID, Canonical, Short string
	} `json:"uppercase"`
	NotIDs []string `json:"not_ids"`
}

// The vectors the web app's twin reads too.
func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("../../api/shortid-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Pairs) == 0 || len(v.NotIDs) == 0 {
		t.Fatal("no vectors")
	}
	return v
}

func TestVectors(t *testing.T) {
	v := loadVectors(t)
	for _, p := range v.Pairs {
		if got := shortid.Short(p.UUID); got != p.Short {
			t.Errorf("Short(%s) = %s, want %s", p.UUID, got, p.Short)
		}
		if got := shortid.Short(p.Short); got != p.Short {
			t.Errorf("Short(%s) = %s, want it unchanged", p.Short, got)
		}
		for _, in := range []string{p.UUID, p.Short} {
			if got, ok := shortid.Parse(in); !ok || got != p.UUID {
				t.Errorf("Parse(%s) = %s, %v, want %s", in, got, ok, p.UUID)
			}
		}
		if got := shortid.Canonical(p.Short); got != p.UUID {
			t.Errorf("Canonical(%s) = %s, want %s", p.Short, got, p.UUID)
		}
	}
	u := v.Uppercase
	if got := shortid.Canonical(u.UUID); got != u.Canonical {
		t.Errorf("Canonical(%s) = %s, want %s", u.UUID, got, u.Canonical)
	}
	if got := shortid.Short(u.UUID); got != u.Short {
		t.Errorf("Short(%s) = %s, want %s", u.UUID, got, u.Short)
	}
	for _, s := range v.NotIDs {
		if _, ok := shortid.Parse(s); ok {
			t.Errorf("Parse(%q) read an id", s)
		}
		if got := shortid.Short(s); got != s {
			t.Errorf("Short(%q) = %q, want it unchanged", s, got)
		}
		if got := shortid.Canonical(s); got != s {
			t.Errorf("Canonical(%q) = %q, want it unchanged", s, got)
		}
	}
}

func random(r *rand.Rand) (u [16]byte) {
	for i := range u {
		u[i] = byte(r.Uint32())
	}
	// Bias towards the edges: runs of zero and 0xff bytes at either end.
	switch r.IntN(6) {
	case 0:
		clear(u[:r.IntN(16)])
	case 1:
		for i := range r.IntN(16) {
			u[i] = 0xff
		}
	case 2:
		clear(u[16-r.IntN(16):])
	}
	return u
}

// Every 128-bit value round-trips, its short form is 22 characters of the alphabet, and it agrees
// with the uuid package's text.
func TestRoundTripProperty(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 200_000 {
		u := random(r)
		s := shortid.Encode(u)
		if len(s) != shortid.Len || strings.Trim(s, shortid.Alphabet) != "" {
			t.Fatalf("Encode(%x) = %q", u, s)
		}
		back, ok := shortid.Decode(s)
		if !ok || back != u {
			t.Fatalf("Decode(Encode(%x)) = %x, %v", u, back, ok)
		}
		text := uuid.UUID(u).String()
		if got, ok := shortid.Parse(s); !ok || got != text {
			t.Fatalf("Parse(%s) = %s, want %s", s, got, text)
		}
		if got := shortid.Short(text); got != s {
			t.Fatalf("Short(%s) = %s, want %s", text, got, s)
		}
	}
}

// Short ids sort as their UUIDs do, byte for byte, so a list ordered by id keeps its order.
func TestOrderPreservedProperty(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	for range 200_000 {
		a, b := random(r), random(r)
		if r.IntN(4) == 0 { // neighbours: differ only in the last byte or two
			b = a
			b[15] += byte(r.IntN(3)) - 1
			if r.IntN(2) == 0 {
				b[14]++
			}
		}
		want := bytes.Compare(a[:], b[:])
		if got := strings.Compare(shortid.Encode(a), shortid.Encode(b)); got != want {
			t.Fatalf("%x vs %x: short ids compare %d, UUIDs %d", a, b, got, want)
		}
		if got := strings.Compare(uuid.UUID(a).String(), uuid.UUID(b).String()); got != want {
			t.Fatalf("%x vs %x: canonical texts compare %d, bytes %d", a, b, got, want)
		}
	}
}

// UUIDv7 ids made one after another, as store.NewID makes them, stay in creation order when short.
func TestUUIDv7OrderPreserved(t *testing.T) {
	var ids []string
	for range 10_000 {
		ids = append(ids, shortid.Short(uuid.Must(uuid.NewV7()).String()))
	}
	if !slices.IsSorted(ids) {
		t.Fatal("short UUIDv7 ids made in order do not sort in order")
	}
}

func TestDecodeRefusesOverflow(t *testing.T) {
	max := shortid.Encode([16]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	if max != "YcVfxkQb6JRzqk5kF2tNLv" {
		t.Fatalf("the largest id is %s", max)
	}
	for _, s := range []string{"YcVfxkQb6JRzqk5kF2tNLw", "YcVfxkQb6JRzqk5kF2tNMv", "Z111111111111111111111", "zzzzzzzzzzzzzzzzzzzzzz"} {
		if _, ok := shortid.Decode(s); ok {
			t.Errorf("Decode(%s) read a value above 2^128", s)
		}
	}
}

func TestID(t *testing.T) {
	const canonical, short = "0199c2a0-7b3e-7c41-9f12-842120d6a1b2", "1CTuJUrXDEC71Dv55PHKrq"
	type body struct {
		ID    shortid.ID   `json:"id"`
		Maybe *shortid.ID  `json:"maybe,omitempty"`
		Many  []shortid.ID `json:"many"`
	}
	b, err := json.Marshal(body{ID: shortid.Of(canonical), Maybe: shortid.OfPtr(nil), Many: shortid.OfAll([]string{canonical, "chosen-by-a-copy"})})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"` + short + `","many":["` + short + `","chosen-by-a-copy"]}`
	if string(b) != want {
		t.Fatalf("got %s\nwant %s", b, want)
	}
	for _, in := range []string{short, canonical, strings.ToUpper(canonical)} {
		var got body
		if err := json.Unmarshal([]byte(`{"id":"`+in+`","maybe":"`+in+`","many":["`+in+`"]}`), &got); err != nil {
			t.Fatal(err)
		}
		if got.ID != canonical || *got.Maybe != canonical || got.Many[0] != canonical {
			t.Errorf("reading %s: %+v", in, got)
		}
		var p shortid.ID
		if err := p.Bind(in); err != nil || p != canonical {
			t.Errorf("Bind(%s) = %s, %v", in, p, err)
		}
	}
	if s := shortid.ID(canonical).String(); s != short {
		t.Errorf("String() = %s", s)
	}
	var other shortid.ID
	_ = other.Bind("alice")
	if other != "alice" {
		t.Errorf("Bind(alice) = %s", other)
	}
}

func BenchmarkShort(b *testing.B) {
	id := uuid.Must(uuid.NewV7()).String()
	for b.Loop() {
		shortid.Short(id)
	}
}
