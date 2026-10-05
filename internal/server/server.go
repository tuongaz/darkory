// Package server serves the Darkory API under /v1, implementing the interface generated from
// api/openapi.yaml, and the embedded web app at /.
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/update"
	"github.com/tuongaz/darkory/internal/wake"
	"github.com/tuongaz/darkory/web"
)

// Server implements every operation in api/openapi.yaml.
type Server struct {
	store *store.Store
	core  *core.Service
	auth  *auth.Authenticator
	wake  *wake.Notifier
	log   *slog.Logger
	// publicURL is where the Install is reached, for login links; empty to use the request's host.
	publicURL string
	keepAlive time.Duration
	// signIn sends login links by email; nil when the Install has no email set up.
	signIn *emailSignIn
	// blobs keeps Evidence files; nil when the Install has no Evidence store.
	blobs blob.Store
	// maxEvidence bounds one Evidence file, in bytes.
	maxEvidence int64
	// update is the last check for a newer release, for /v1/health; nil until one ran.
	updateStatus atomic.Pointer[update.Status]
}

var _ gen.ServerInterface = (*Server)(nil)

// Options are the Server's settings; the zero value serves with the wall clock.
type Options struct {
	Clock clock.Clock
	Wake  *wake.Notifier
	Log   *slog.Logger
	// PublicURL is the Install's address as browsers reach it, such as https://darkory.example.com.
	// Login links are built on it; when empty, on the address the request came to.
	PublicURL string
	// KeepAlive is how often an idle Activity stream sends a comment. Defaults to 15 s.
	KeepAlive time.Duration
	// Mail, when set, sends login links to Members who ask by email; it needs PublicURL.
	Mail mail.Sender
	// MailPerHour caps the emails this server sends an hour; zero means DefaultMailPerHour.
	MailPerHour int
	// ProxyHops is how many proxies in front append to X-Forwarded-For, to find the client's
	// address for rate limits; zero uses the connection's.
	ProxyHops int
	// Blobs keeps Evidence files: on disk under the data directory by default. Without one,
	// Evidence cannot be attached or downloaded.
	Blobs blob.Store
	// MaxEvidenceSize bounds one Evidence file, in bytes. Defaults to DefaultMaxEvidenceSize.
	MaxEvidenceSize int64
}

// DefaultMaxEvidenceSize is the largest Evidence file an Install takes unless set otherwise.
const DefaultMaxEvidenceSize = 100 << 20

// New returns a Server over st.
func New(st *store.Store, o Options) *Server {
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Wake == nil {
		o.Wake = wake.New()
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.KeepAlive <= 0 {
		o.KeepAlive = 15 * time.Second
	}
	if o.MaxEvidenceSize <= 0 {
		o.MaxEvidenceSize = DefaultMaxEvidenceSize
	}
	return &Server{
		store:       st,
		core:        core.New(st, o.Clock, o.Wake, o.Log),
		auth:        auth.New(st, o.Clock),
		wake:        o.Wake,
		log:         o.Log,
		publicURL:   o.PublicURL,
		keepAlive:   o.KeepAlive,
		signIn:      newEmailSignIn(o),
		blobs:       o.Blobs,
		maxEvidence: o.MaxEvidenceSize,
	}
}

// Core returns the domain service the Server runs on.
func (s *Server) Core() *core.Service { return s.core }

// Handler routes /v1 to the API and every other path to the web app.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	gen.HandlerWithOptions(s, gen.StdHTTPServerOptions{
		BaseRouter:  mux,
		Middlewares: []gen.MiddlewareFunc{s.authenticate},
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
