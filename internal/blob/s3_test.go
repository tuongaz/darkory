package blob

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"math/rand/v2"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/tuongaz/darkory/internal/dockertest"
)

// S3TestEnv runs the S3 tests against MinIO in Docker when set; S3ImageEnv names another image.
const (
	S3TestEnv  = "DARKORY_TEST_S3"
	S3ImageEnv = "DARKORY_TEST_S3_IMAGE"
)

// minioImage is a MinIO image that can be pulled without signing in; minio/minio is no longer
// published on Docker Hub.
const minioImage = "cgr.dev/chainguard/minio:latest"

const (
	minioUser   = "darkory"
	minioSecret = "darkory-minio-secret"
)

// minio starts MinIO with a bucket and returns settings for it.
func minio(t *testing.T) S3Settings {
	t.Helper()
	image := minioImage
	if v := os.Getenv(S3ImageEnv); v != "" {
		image = v
	}
	c := dockertest.Run(t, S3TestEnv, image, []int{9000},
		map[string]string{"MINIO_ROOT_USER": minioUser, "MINIO_ROOT_PASSWORD": minioSecret}, "server", "/data")
	endpoint := "http://" + c.Addr[0]
	dockertest.WaitHTTP(t, endpoint+"/minio/health/ready")
	set := S3Settings{Bucket: "evidence", Prefix: "install-1", Endpoint: endpoint, AccessKey: minioUser, SecretKey: minioSecret, PathStyle: true}
	st, err := NewS3(set, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.client.CreateBucket(t.Context(), &s3.CreateBucketInput{Bucket: aws.String(set.Bucket)}); err != nil {
		t.Fatal(err)
	}
	return set
}

func TestS3Store(t *testing.T) {
	set := minio(t)
	st, err := NewS3(set, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	if err := st.Check(ctx); err != nil {
		t.Fatal(err)
	}

	t.Run("put get delete", func(t *testing.T) {
		body := []byte("screenshot bytes")
		if err := st.Put(ctx, "org/ev-1", bytes.NewReader(body), int64(len(body)), "image/png"); err != nil {
			t.Fatal(err)
		}
		r, err := st.Get(ctx, "org/ev-1")
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		r.Close()
		if err != nil || !bytes.Equal(got, body) {
			t.Fatalf("got %q, %v", got, err)
		}
		// Kept under the prefix, with its content type.
		head, err := st.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(set.Bucket), Key: aws.String("install-1/org/ev-1")})
		if err != nil {
			t.Fatal(err)
		}
		if aws.ToString(head.ContentType) != "image/png" || aws.ToInt64(head.ContentLength) != int64(len(body)) {
			t.Fatalf("stored as %s, %d bytes", aws.ToString(head.ContentType), aws.ToInt64(head.ContentLength))
		}
		if err := st.Delete(ctx, "org/ev-1"); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Get(ctx, "org/ev-1"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("get after delete: %v", err)
		}
	})

	t.Run("missing", func(t *testing.T) {
		if _, err := st.Get(ctx, "org/nothing"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("get: %v", err)
		}
		if err := st.Delete(ctx, "org/nothing"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("delete: %v", err)
		}
	})

	t.Run("empty", func(t *testing.T) {
		if err := st.Put(ctx, "org/empty", strings.NewReader(""), 0, ""); err != nil {
			t.Fatal(err)
		}
		r, err := st.Get(ctx, "org/empty")
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(r)
		r.Close()
		if len(got) != 0 {
			t.Fatalf("got %d bytes", len(got))
		}
	})

	t.Run("a failed put leaves nothing", func(t *testing.T) {
		for name, tc := range map[string]struct {
			r    io.Reader
			size int64
		}{
			"reader fails":         {io.MultiReader(strings.NewReader(strings.Repeat("x", 1000)), failing{}), 5000},
			"reader ends early":    {strings.NewReader(strings.Repeat("x", 1000)), 5000},
			"large reader fails":   {io.MultiReader(io.LimitReader(newNoise(1), 20<<20), failing{}), 50 << 20},
			"cancelled mid-upload": {io.LimitReader(newNoise(2), 50<<20), 50 << 20},
		} {
			t.Run(name, func(t *testing.T) {
				putCtx := ctx
				if name == "cancelled mid-upload" {
					var cancel context.CancelFunc
					putCtx, cancel = context.WithCancel(ctx)
					tc.r = &cancelAfter{r: tc.r, n: 10 << 20, cancel: cancel}
				}
				key := "org/failed-" + strings.ReplaceAll(name, " ", "-")
				if err := st.Put(putCtx, key, tc.r, tc.size, "text/plain"); err == nil {
					t.Fatal("put succeeded")
				}
				if _, err := st.Get(ctx, key); !errors.Is(err, ErrNotFound) {
					t.Fatalf("get after a failed put: %v", err)
				}
			})
		}
		uploads, err := st.client.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{Bucket: aws.String(set.Bucket)})
		if err != nil {
			t.Fatal(err)
		}
		if len(uploads.Uploads) != 0 {
			t.Fatalf("%d unfinished uploads left behind", len(uploads.Uploads))
		}
	})

	t.Run("50 MB streams without being held in memory", func(t *testing.T) {
		const size = 50 << 20
		src := sha256.New()
		r := io.TeeReader(io.LimitReader(newNoise(3), size), src)

		runtime.GC()
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		base := ms.HeapAlloc
		var peak atomic.Uint64
		stop := make(chan struct{})
		var wg sync.WaitGroup
		wg.Go(func() {
			var ms runtime.MemStats
			for {
				runtime.ReadMemStats(&ms)
				if ms.HeapAlloc > peak.Load() {
					peak.Store(ms.HeapAlloc)
				}
				select {
				case <-stop:
					return
				case <-time.After(5 * time.Millisecond):
				}
			}
		})
		err := st.Put(ctx, "org/large", r, size, "application/octet-stream")
		close(stop)
		wg.Wait()
		if err != nil {
			t.Fatal(err)
		}
		grew := int64(peak.Load()) - int64(base)
		if grew > 16<<20 {
			t.Fatalf("the heap grew by %d MiB while putting 50 MiB", grew>>20)
		}
		t.Logf("the heap grew by at most %d KiB while putting 50 MiB", grew>>10)

		got, err := st.Get(ctx, "org/large")
		if err != nil {
			t.Fatal(err)
		}
		defer got.Close()
		dst := sha256.New()
		n, err := io.Copy(dst, got)
		if err != nil || n != size || !bytes.Equal(dst.Sum(nil), src.Sum(nil)) {
			t.Fatalf("read back %d bytes, %v; same content: %v", n, err, bytes.Equal(dst.Sum(nil), src.Sum(nil)))
		}
	})

	t.Run("wrong secret", func(t *testing.T) {
		bad := set
		bad.SecretKey = "not-the-secret-key"
		st, err := NewS3(bad, nil)
		if err != nil {
			t.Fatal(err)
		}
		err = st.Put(ctx, "org/denied", strings.NewReader("x"), 1, "")
		if err == nil {
			t.Fatal("put with a wrong secret succeeded")
		}
		if strings.Contains(err.Error(), bad.SecretKey) {
			t.Fatalf("the error shows the secret: %v", err)
		}
		if err := st.Check(ctx); err == nil {
			t.Fatal("check with a wrong secret succeeded")
		}
	})
}

func TestOpenChoosesTheStore(t *testing.T) {
	var opened string
	disk := func(dir string) (Store, error) { opened = dir; return nil, nil }
	if _, err := Open(t.Context(), Settings{Dir: "/data/evidence"}, disk); err != nil || opened != "/data/evidence" {
		t.Fatalf("opened %q, %v", opened, err)
	}
	opened = ""
	set := &S3Settings{Bucket: "b", Endpoint: "http://127.0.0.1:1", AccessKey: "a", SecretKey: "topsecret"}
	if _, err := Open(t.Context(), Settings{Dir: "/data/evidence", S3: set}, disk); err == nil || opened != "" {
		t.Fatalf("an unreachable bucket opened (disk %q): %v", opened, err)
	}
	if _, err := NewS3(S3Settings{Bucket: "b", Endpoint: "minio:9000", AccessKey: "a", SecretKey: "s"}, nil); err == nil {
		t.Fatal("an endpoint without a scheme was accepted")
	}
	if _, err := NewS3(S3Settings{Bucket: "b"}, nil); err == nil {
		t.Fatal("no keys was accepted")
	}
	if s := set.String(); s != "s3://b at http://127.0.0.1:1" {
		t.Fatalf("String is %q", s)
	}
}

type failing struct{}

func (failing) Read([]byte) (int, error) { return 0, errors.New("disk read error") }

// noise is an endless stream of pseudo-random bytes, made as it is read.
type noise struct{ r *rand.ChaCha8 }

func newNoise(seed byte) *noise {
	var s [32]byte
	s[0] = seed
	return &noise{rand.NewChaCha8(s)}
}

func (n *noise) Read(p []byte) (int, error) { return n.r.Read(p) }

// cancelAfter cancels its context once n bytes have been read.
type cancelAfter struct {
	r      io.Reader
	n      int64
	cancel context.CancelFunc
}

func (c *cancelAfter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if c.n -= int64(n); c.n <= 0 {
		c.cancel()
	}
	return n, err
}
