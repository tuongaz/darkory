package blob

import "context"

// Settings choose an Install's Evidence store, independently of its storage and sign-in (ADR
// 0002). Local keeps Evidence on disk.
type Settings struct {
	// Dir is where the disk store keeps Evidence, when S3 is nil.
	Dir string
	// S3, when set, keeps Evidence in an S3-compatible bucket instead.
	S3 *S3Settings
}

// Open returns the Evidence store set names: the S3-compatible bucket, checked to be reachable,
// or the disk store in set.Dir, opened by disk, or by NewDisk when disk is nil.
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
		disk = func(dir string) (Store, error) {
			d, err := NewDisk(dir)
			if err != nil {
				return nil, err
			}
			return d, nil
		}
	}
	return disk(set.Dir)
}
