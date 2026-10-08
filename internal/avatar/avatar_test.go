package avatar

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func encode(t *testing.T, kind string, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			// The left third red, the middle green, the right blue: a centred crop keeps green.
			c := color.NRGBA{R: 255, A: 255}
			if x >= w/3 {
				c = color.NRGBA{G: 255, A: 255}
			}
			if x >= 2*w/3 {
				c = color.NRGBA{B: 255, A: 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	var err error
	switch kind {
	case "png":
		err = png.Encode(&buf, img)
	case "jpeg":
		err = jpeg.Encode(&buf, img, nil)
	case "gif":
		err = gif.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decode(t *testing.T, b []byte) image.Image {
	t.Helper()
	if typ, _ := Sniff(b); typ != "image/png" {
		t.Fatalf("an avatar is written as PNG, got %s", typ)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestSquareCropsTheMiddleAndScalesDown(t *testing.T) {
	for _, kind := range []string{"png", "jpeg", "gif"} {
		t.Run(kind, func(t *testing.T) {
			out, err := Square(bytes.NewReader(encode(t, kind, 1200, 400)))
			if err != nil {
				t.Fatal(err)
			}
			img := decode(t, out)
			if b := img.Bounds(); b.Dx() != Side || b.Dy() != Side {
				t.Fatalf("got %v, want %dx%d", b, Side, Side)
			}
			// The middle 400x400 of a 1200-wide image is all green.
			r, g, bl, _ := img.At(Side/2, Side/2).RGBA()
			if g < 0xc000 || r > 0x4000 || bl > 0x4000 {
				t.Fatalf("the middle is %v %v %v, want green", r, g, bl)
			}
		})
	}
}

func TestSquareKeepsASmallImageItsSize(t *testing.T) {
	out, err := Square(bytes.NewReader(encode(t, "png", 64, 100)))
	if err != nil {
		t.Fatal(err)
	}
	if b := decode(t, out).Bounds(); b.Dx() != 64 || b.Dy() != 64 {
		t.Fatalf("got %v, want 64x64", b)
	}
}

func TestSquareTakesWebP(t *testing.T) {
	// A 1x1 lossless WebP.
	webp := []byte("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00")
	if typ, ok := Sniff(webp); !ok || typ != "image/webp" {
		t.Fatalf("sniffed %s %v", typ, ok)
	}
	out, err := Square(bytes.NewReader(webp))
	if err != nil {
		t.Fatal(err)
	}
	if b := decode(t, out).Bounds(); b.Dx() != 1 || b.Dy() != 1 {
		t.Fatalf("got %v, want 1x1", b)
	}
}

func TestSquareRefuses(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	html := []byte(`<!DOCTYPE html><html><script>alert(1)</script></html>`)
	for name, b := range map[string][]byte{"svg": svg, "html": html, "text": []byte("hello"), "empty": nil} {
		if _, err := Square(bytes.NewReader(b)); !errors.Is(err, ErrNotImage) {
			t.Errorf("%s: got %v, want ErrNotImage", name, err)
		}
	}
	// A PNG header that says 20000x20000: refused before anything is decoded.
	var hdr bytes.Buffer
	if err := png.Encode(&hdr, image.NewGray(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	bomb := hdr.Bytes()
	bomb[16], bomb[17], bomb[18], bomb[19] = 0, 0, 0x4e, 0x20
	bomb[20], bomb[21], bomb[22], bomb[23] = 0, 0, 0x4e, 0x20
	binary.BigEndian.PutUint32(bomb[29:33], crc32.ChecksumIEEE(bomb[12:29]))
	if _, err := Square(bytes.NewReader(bomb)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("a huge canvas: got %v, want ErrTooLarge", err)
	}
	big := append(encode(t, "png", 10, 10), make([]byte, MaxBytes)...)
	if _, err := Square(bytes.NewReader(big)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("over 2 MiB: got %v, want ErrTooLarge", err)
	}
}
