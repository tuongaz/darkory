package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// S3Settings name an S3-compatible bucket and how to reach it. An Install sets them with
// DARKORY_EVIDENCE=s3://bucket/prefix and the DARKORY_S3_* variables (docs/build/settings.md).
type S3Settings struct {
	Bucket string
	// Prefix starts every object name, without a trailing slash; empty for none.
	Prefix string
	// Endpoint is the service's URL with its scheme, such as http://127.0.0.1:9000; empty for AWS.
	Endpoint string
	Region   string
	// AccessKey and SecretKey sign every request. SecretKey is never logged.
	AccessKey string
	SecretKey string
	// PathStyle names the bucket in the path (endpoint/bucket/key) rather than the host name, as
	// MinIO and most S3-compatible services need.
	PathStyle bool
}

// String describes the settings without the secret key.
func (s S3Settings) String() string {
	where := "s3://" + s.Bucket
	if s.Prefix != "" {
		where += "/" + s.Prefix
	}
	if s.Endpoint != "" {
		where += " at " + s.Endpoint
	}
	return where
}

// S3 keeps Evidence in an S3-compatible bucket. Each object is written with one PUT of known
// length, streamed from the reader, so a Put that fails leaves nothing behind and an upload is
// never held in memory. One PUT takes up to 5 GiB.
type S3 struct {
	client *s3.Client
	bucket string
	prefix string
}

var _ Store = (*S3)(nil)

// NewS3 returns the Store set reaches. It sends nothing until it is used; call Check to find out
// whether the bucket can be reached.
func NewS3(set S3Settings, httpClient *http.Client) (*S3, error) {
	if set.Bucket == "" {
		return nil, errors.New("blob: S3 needs a bucket")
	}
	if set.AccessKey == "" || set.SecretKey == "" {
		return nil, errors.New("blob: S3 needs an access key and a secret key")
	}
	if set.Region == "" {
		set.Region = "us-east-1"
	}
	creds := aws.Credentials{AccessKeyID: set.AccessKey, SecretAccessKey: set.SecretKey, Source: "darkory"}
	o := s3.Options{
		Region: set.Region,
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return creds, nil
		}),
		UsePathStyle: set.PathStyle,
		// S3-compatible services differ in which checksums they accept; send and check them only
		// where an operation requires one.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	}
	if set.Endpoint != "" {
		if !strings.HasPrefix(set.Endpoint, "http://") && !strings.HasPrefix(set.Endpoint, "https://") {
			return nil, fmt.Errorf("blob: the S3 endpoint %q needs http:// or https://", set.Endpoint)
		}
		o.BaseEndpoint = aws.String(strings.TrimRight(set.Endpoint, "/"))
	}
	if httpClient != nil {
		o.HTTPClient = httpClient
	}
	return &S3{client: s3.New(o), bucket: set.Bucket, prefix: strings.Trim(set.Prefix, "/")}, nil
}

func (s *S3) object(key string) string {
	if s.prefix == "" {
		return key
	}
	return path.Join(s.prefix, key)
}

// Check reports whether the bucket exists and the keys may use it.
func (s *S3) Check(ctx context.Context) error {
	if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)}); err != nil {
		return fmt.Errorf("blob: S3 bucket %s: %w", s.bucket, err)
	}
	return nil
}

// Put stores size bytes read from r under key, streaming them in one PUT.
func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	if size < 0 {
		return fmt.Errorf("blob: put %s: negative size", key)
	}
	in := &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(s.object(key)),
		Body:          &exactly{r: r, left: size},
		ContentLength: aws.Int64(size),
	}
	if contentType != "" {
		in.ContentType = aws.String(contentType)
	}
	// The body is a stream that cannot be read twice, so the payload is not hashed into the
	// signature; over plain http the SDK would otherwise refuse it.
	_, err := s.client.PutObject(ctx, in, s3.WithAPIOptions(v4.SwapComputePayloadSHA256ForUnsignedPayloadMiddleware))
	if err != nil {
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	return nil
}

// Get opens the object stored under key.
func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(s.object(key))})
	if err != nil {
		if missing(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("blob: get %s: %w", key, err)
	}
	return out.Body, nil
}

// Delete removes the object stored under key. S3 answers a delete of a missing object as a
// success, so it asks first.
func (s *S3) Delete(ctx context.Context, key string) error {
	name := aws.String(s.object(key))
	if _, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: name}); err != nil {
		if missing(err) {
			return ErrNotFound
		}
		return fmt.Errorf("blob: delete %s: %w", key, err)
	}
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: name}); err != nil {
		return fmt.Errorf("blob: delete %s: %w", key, err)
	}
	return nil
}

// missing reports whether err says the object does not exist. HEAD replies carry no body, so
// their 404 arrives as NotFound rather than NoSuchKey.
func missing(err error) bool {
	var noKey *types.NoSuchKey
	var notFound *types.NotFound
	if errors.As(err, &noKey) || errors.As(err, &notFound) {
		return true
	}
	var api smithy.APIError
	return errors.As(err, &api) && (api.ErrorCode() == "NoSuchKey" || api.ErrorCode() == "NotFound")
}

// exactly reads left bytes from r and fails when r ends sooner, so a short reader fails the PUT
// rather than sending a body shorter than its declared length.
type exactly struct {
	r    io.Reader
	left int64
}

func (e *exactly) Read(p []byte) (int, error) {
	if e.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > e.left {
		p = p[:e.left]
	}
	n, err := e.r.Read(p)
	e.left -= int64(n)
	switch {
	case e.left == 0:
		return n, io.EOF
	case err == io.EOF:
		return n, io.ErrUnexpectedEOF
	}
	return n, err
}
