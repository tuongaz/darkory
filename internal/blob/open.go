package blob

import (
	"context"
	"errors"
)

// Settings choose an Install's Evidence store, independently of its storage and sign-in (ADR
// 0002). Local keeps Evidence on disk.
type Settings struct {
	// Dir is where the disk store keeps Evidence, when S3 is nil.
	Dir string
	// S3, when set, keeps Evidence in an S3-compatible bucket instead.
	S3 *S3Settings
}

// Open returns the Evidence store set names: the S3-compatible bucket, checked to be reachable,
// or the disk store that disk opens in set.Dir. The disk store's constructor is passed in, so
// the choice lives here without tying it to how the disk store is built.
func Open(ctx context.Context, set Settings, disk func(dir string) (Store, error)) (Store, error) {
	if set.S3 != nil {
		st, err := NewS3(*set.S3, nil)
		if err != nil {
			return nil, err
		}
		if err := st.Check(ctx); err != nil {
			return nil, err
		}
		return st, nil
	}
	if disk == nil {
		return nil, errors.New("blob: no disk store to keep Evidence in " + set.Dir)
	}
	return disk(set.Dir)
}
