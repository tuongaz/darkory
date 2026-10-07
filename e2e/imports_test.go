package e2e

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The end-to-end tests reach Darkory only as its users do: the binary, MCP over stdio and the
// generated client. Nothing here may import an internal package, which Go would allow since the
// package sits inside the module, and neither may the bots the tests run (tools/bots), nor the
// fake agent the runner's tests start (tools/fakeagent).
func TestImportsNothingInternal(t *testing.T) {
	var files []string
	for _, pattern := range []string{"*.go", "../tools/bots/*.go", "../tools/bots/bot/*.go", "../tools/fakeagent/*.go"} {
		found, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, found...)
	}
	if len(files) < 10 {
		t.Fatalf("found only %d files to check: %v", len(files), files)
	}
	for _, name := range files {
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(token.NewFileSet(), name, src, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			if strings.HasPrefix(path, "github.com/tuongaz/darkory/") && strings.Contains(path+"/", "/internal/") {
				t.Errorf("%s imports %s", name, path)
			}
		}
	}
}
