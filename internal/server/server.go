// Package server serves the Darkory API under /v1, implementing the interface generated from
// api/openapi.yaml, and the embedded web app at /.
package server

import (
	"encoding/json"
	"net/http"

	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/version"
	"github.com/tuongaz/darkory/web"
)

// Server implements every operation in api/openapi.yaml.
type Server struct {
	store *store.Store
}

var _ gen.ServerInterface = (*Server)(nil)

// New returns a Server over st.
func New(st *store.Store) *Server {
	return &Server{store: st}
}

// Handler routes /v1 to the API and every other path to the web app.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	gen.HandlerWithOptions(s, gen.StdHTTPServerOptions{
		BaseRouter: mux,
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeError(w, http.StatusBadRequest, gen.ErrorCodeInvalid, err.Error())
		},
	})
	// Anything under /v1 that matched no operation, including a known path with the wrong method.
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, gen.ErrorCodeNotFound, "no operation "+r.Method+" "+r.URL.Path)
	})
	mux.Handle("/", web.Handler())
	return mux
}

// GetHealth reports that the Install is up. It needs no credential.
func (s *Server) GetHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, gen.Health{Status: gen.HealthStatusOk, Version: version.Version})
}

func (s *Server) notImplemented(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, gen.ErrorCodeNotImplemented, r.Method+" "+r.URL.Path+" is not built yet")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code gen.ErrorCode, message string) {
	writeJSON(w, status, gen.Error{Code: code, Message: message})
}
