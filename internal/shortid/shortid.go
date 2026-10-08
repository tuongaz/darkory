// Package shortid writes Darkory's ids in their short form at the API's boundary.
//
// Every id is a UUID, kept in storage as its canonical 36-character text. People see it as 22
// characters of base58 (the Bitcoin alphabet), the UUID's 128 bits as one number, left-padded
// with '1' (the alphabet's zero) to a fixed width. The alphabet is in ASCII order and the width is
// fixed, so short ids sort as their UUIDs do, and UUIDv7 ids still sort by creation time. Both
// forms name the same id, and either is read wherever an id is (ADR 0017).
package shortid

import (
	"encoding/hex"
	"math/bits"
)

// Alphabet is base58's Bitcoin alphabet, in ASCII order: '1' is zero.
const Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// Len is the length of a short id: 58^22 is the first power of 58 above 2^128.
const Len = 22

// UUIDLen is the length of a UUID's canonical text.
const UUIDLen = 36

// digit maps a byte to its value in Alphabet, or -1.
var digit = func() (d [256]int8) {
	for i := range d {
		d[i] = -1
	}
	for i := range len(Alphabet) {
		d[Alphabet[i]] = int8(i)
	}
	return d
}()

// Encode writes 16 bytes as a short id.
func Encode(u [16]byte) string {
	hi := uint64(u[0])<<56 | uint64(u[1])<<48 | uint64(u[2])<<40 | uint64(u[3])<<32 |
		uint64(u[4])<<24 | uint64(u[5])<<16 | uint64(u[6])<<8 | uint64(u[7])
	lo := uint64(u[8])<<56 | uint64(u[9])<<48 | uint64(u[10])<<40 | uint64(u[11])<<32 |
		uint64(u[12])<<24 | uint64(u[13])<<16 | uint64(u[14])<<8 | uint64(u[15])
	var out [Len]byte
	for i := Len - 1; i >= 0; i-- {
		var r uint64
		hi, r = bits.Div64(0, hi, 58)
		lo, r = bits.Div64(r, lo, 58)
		out[i] = Alphabet[r]
	}
	return string(out[:])
}

// Decode reads a short id's 16 bytes. It reports false for anything that is not 22 characters of
// the alphabet naming a number below 2^128.
func Decode(s string) ([16]byte, bool) {
	var u [16]byte
	if len(s) != Len {
		return u, false
	}
	var hi, lo uint64
	for i := range Len {
		d := digit[s[i]]
		if d < 0 {
			return u, false
		}
		// (hi, lo) = (hi, lo) * 58 + d, refusing a carry out of the top.
		carryHi, newHi := bits.Mul64(hi, 58)
		if carryHi != 0 {
			return u, false
		}
		carryLo, newLo := bits.Mul64(lo, 58)
		newLo, c := bits.Add64(newLo, uint64(d), 0)
		newHi, c2 := bits.Add64(newHi, carryLo, c)
		if c2 != 0 {
			return u, false
		}
		hi, lo = newHi, newLo
	}
	for i := range 8 {
		u[i] = byte(hi >> (56 - 8*i))
		u[8+i] = byte(lo >> (56 - 8*i))
	}
	return u, true
}

// parseUUID reads a UUID's canonical text, in either case.
func parseUUID(s string) ([16]byte, bool) {
	var u [16]byte
	if len(s) != UUIDLen || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return u, false
	}
	var h [32]byte
	n := 0
	for i := range UUIDLen {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		h[n] = s[i]
		n++
	}
	if _, err := hex.Decode(u[:], h[:]); err != nil {
		return u, false
	}
	return u, true
}

// formatUUID writes 16 bytes as a UUID's canonical text, in lower case, as storage keeps it.
func formatUUID(u [16]byte) string {
	var b [UUIDLen]byte
	hex.Encode(b[0:8], u[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], u[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], u[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], u[8:10])
	b[23] = '-'
	hex.Encode(b[24:], u[10:])
	return string(b[:])
}

// Parse reads an id in either form, short or a UUID's canonical text, and returns the canonical
// text storage keeps. It reports false for anything else.
func Parse(s string) (string, bool) {
	switch len(s) {
	case Len:
		if u, ok := Decode(s); ok {
			return formatUUID(u), true
		}
	case UUIDLen:
		if u, ok := parseUUID(s); ok {
			return formatUUID(u), true
		}
	}
	return "", false
}

// Canonical is the canonical text of an id given in either form, or s unchanged when it is not
// an id: a name, a key, or an id a client chose that is not a UUID.
func Canonical(s string) string {
	if c, ok := Parse(s); ok {
		return c
	}
	return s
}

// Short is the short form of an id given in either form, or s unchanged when it is not an id.
func Short(s string) string {
	switch len(s) {
	case UUIDLen:
		if u, ok := parseUUID(s); ok {
			return Encode(u)
		}
	case Len:
		if u, ok := Decode(s); ok {
			return Encode(u) // already short; Decode accepts only what Encode writes
		}
	}
	return s
}

// IsUUID reports whether s is a UUID's canonical text, in either case.
func IsUUID(s string) bool {
	_, ok := parseUUID(s)
	return ok
}

// IsShort reports whether s is a short id.
func IsShort(s string) bool {
	_, ok := Decode(s)
	return ok
}
