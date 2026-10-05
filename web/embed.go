// Package web serves the web app, built into dist/app and embedded in the binary (ADR 0006,
// ADR 0007). dist/app is build output and not committed; the committed dist/index.html is a
// placeholder, served when the binary was built without node.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// Handler serves the built web app, or the placeholder when it was not built. A path that names
// no file and has no extension gets index.html, so the app's own routes load when opened directly.
// A directory is not listed.
func Handler() http.Handler {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	if _, err := fs.Stat(root, "app/index.html"); err == nil {
		if root, err = fs.Sub(root, "app"); err != nil {
			panic(err)
		}
	}
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			files.ServeHTTP(w, r)
			return
		}
		info, err := fs.Stat(root, name)
		if err == nil && info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}
			http.ServeFileFS(w, r, root, "index.html")
			return
		}
		files.ServeHTTP(w, r)
	})
}
