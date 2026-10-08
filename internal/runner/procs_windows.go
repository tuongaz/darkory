//go:build windows

package runner

import (
	"context"
	"errors"
)

// descendants is not read on Windows: a session there shows progress by its file alone.
func descendants(context.Context, int) ([]proc, error) {
	return nil, errors.New("the processes of a session are not read on Windows")
}
