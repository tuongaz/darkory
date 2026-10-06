package runner

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// TokenDir is where `darkory init` keeps the agents' tokens, one <member>.token file each, for the
// runner that `darkory serve` and `darkory agents` start.
func TokenDir(data string) string { return filepath.Join(data, "agents") }

// ReadTokens reads every <name>.token in dir; none is no error. A file that is not a token is.
func ReadTokens(dir string) ([]Token, error) {
	found, err := filepath.Glob(filepath.Join(dir, "*.token"))
	if err != nil {
		return nil, err
	}
	slices.Sort(found)
	var out []Token
	for _, path := range found {
		b, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		secret := strings.TrimSpace(string(b))
		if !strings.HasPrefix(secret, "dk_") || strings.ContainsAny(secret, " \t\n") {
			return nil, fmt.Errorf("%s does not hold a Darkory token", path)
		}
		out = append(out, Token{Name: strings.TrimSuffix(filepath.Base(path), ".token"), Secret: secret})
	}
	return out, nil
}
