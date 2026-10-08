// Package avatar makes an uploaded image into a Member's avatar: a square PNG of at most Side
// pixels a side, cut from the middle of the image and scaled down, in pure Go.
//
// Re-encoding is the point as much as the size: the PNG written holds only pixels, so whatever
// else the upload carried (EXIF with a location, a second file appended to a polyglot, an
// animation's other frames) is not kept, and what a browser receives is an image Darkory wrote.
package avatar

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/gif" // decoders, registered for image.Decode
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	// Side is the largest side of an avatar, in pixels.
	Side = 256
	// MaxBytes bounds an image uploaded as an avatar.
	MaxBytes = 2 << 20
	// maxPixels bounds the image an upload decodes to, so a small file cannot claim a huge
	// canvas (a decompression bomb): 40 megapixels, as a 2 MiB photo is at most a few.
	maxPixels = 40_000_000
	// maxSide bounds either side, for the same reason.
	maxSide = 12_000
)

// Types are the types an avatar is accepted as, by what the bytes are.
var Types = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// ErrNotImage refuses an upload that is not a PNG, JPEG, GIF or WebP image, by its bytes.
var ErrNotImage = errors.New("an avatar is a PNG, JPEG, WebP or GIF image")

// ErrTooLarge refuses an upload over MaxBytes, or one whose image is too many pixels.
var ErrTooLarge = errors.New("the image is too large for an avatar")

// Sniff returns the type of an image by its first bytes, and whether it may be an avatar. SVG
// and HTML, which can carry script, never may.
func Sniff(head []byte) (string, bool) {
	t := http.DetectContentType(head)
	return t, Types[t]
}

// Square reads an image of at most MaxBytes and returns it as a PNG avatar: the largest square
// in its middle, scaled down to Side pixels a side when larger. A GIF keeps its first frame.
func Square(r io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, MaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxBytes {
		return nil, ErrTooLarge
	}
	if _, ok := Sniff(raw); !ok {
		return nil, ErrNotImage
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotImage, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxSide || cfg.Height > maxSide || cfg.Width*cfg.Height > maxPixels {
		return nil, ErrTooLarge
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotImage, err)
	}
	b := img.Bounds()
	side := min(b.Dx(), b.Dy())
	crop := image.Rect(0, 0, side, side).Add(image.Pt(b.Min.X+(b.Dx()-side)/2, b.Min.Y+(b.Dy()-side)/2))
	out := min(side, Side)
	dst := image.NewNRGBA(image.Rect(0, 0, out, out))
	if out == side {
		draw.Draw(dst, dst.Bounds(), img, crop.Min, draw.Src)
	} else {
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, crop, xdraw.Src, nil)
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, dst); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
