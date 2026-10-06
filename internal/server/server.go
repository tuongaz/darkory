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
	"github.com/tuongaz/darkory/internal/runnerapi"
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
	// bodyTimeout bounds how long a request body may take to arrive.
	bodyTimeout time.Duration
	// browser bounds how long a browser Session lasts; its cookie lives as long as Lifetime.
	browser auth.BrowserLimits
	// streams and nexts count each Member's open Activity streams and waiting `next` calls.
	streams, nexts *waiting
	// update is the last check for a newer release, for /v1/health; nil until one ran.
	updateStatus atomic.Pointer[update.Status]
	// runner is the Runner beside this server; nil when none is attached, and /v1/runner then
	// answers no_runner.
	runner atomic.Pointer[runnerHolder]
}

// runnerHolder lets the Runner be attached after the Server is made.
type runnerHolder struct{ runnerapi.Runner }

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
	// BodyReadTimeout bounds how long a request body may take to arrive; an Evidence upload also
	// gets time in proportion to its size. Defaults to DefaultBodyReadTimeout.
	BodyReadTimeout time.Duration
	// BrowserSessions bound how long a browser Session lasts, unused and in all. Zero fields take
	// auth.DefaultBrowserLimits'.
	BrowserSessions auth.BrowserLimits
	// MaxWaiting is how many Activity streams, and separately how many waiting `next` calls, one
	// Member may have open on this process at once. Defaults to DefaultMaxWaiting.
	MaxWaiting int
	// Runner is the Runner beside this server, which /v1/runner serves; nil for none, as with
	// serve --agents=off. AttachRunner sets one later.
	Runner runnerapi.Runner
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
	if o.BodyReadTimeout <= 0 {
		o.BodyReadTimeout = DefaultBodyReadTimeout
	}
	if o.BrowserSessions.Idle <= 0 {
		o.BrowserSessions.Idle = auth.DefaultBrowserLimits.Idle
	}
	if o.BrowserSessions.Lifetime <= 0 {
		o.BrowserSessions.Lifetime = auth.DefaultBrowserLimits.Lifetime
	}
	if o.MaxWaiting <= 0 {
		o.MaxWaiting = DefaultMaxWaiting
	}
	s := &Server{
		store:       st,
		core:        core.New(st, o.Clock, o.Wake, o.Log).WithBrowserLimits(o.BrowserSessions),
		auth:        auth.New(st, o.Clock).WithBrowserLimits(o.BrowserSessions),
		wake:        o.Wake,
		log:         o.Log,
		publicURL:   o.PublicURL,
		keepAlive:   o.KeepAlive,
		signIn:      newEmailSignIn(o),
		blobs:       o.Blobs,
		maxEvidence: o.MaxEvidenceSize,
		bodyTimeout: o.BodyReadTimeout,
		browser:     o.BrowserSessions,
		streams:     newWaiting("Activity streams", o.MaxWaiting),
		nexts:       newWaiting("waiting next calls", o.MaxWaiting),
	}
	s.AttachRunner(o.Runner)
	return s
}

// AttachRunner makes r the Runner /v1/runner serves, or none when r is nil. The Runner may need
// the server running before it starts, so it can be attached after.
func (s *Server) AttachRunner(r runnerapi.Runner) {
	if r == nil {
		s.runner.Store(nil)
		return
	}
	s.runner.Store(&runnerHolder{r})
}

// theRunner is the attached Runner, or nil.
func (s *Server) theRunner() runnerapi.Runner {
	if h := s.runner.Load(); h != nil {
		return h.Runner
	}
	return nil
}

// Core returns the domain service the Server runs on.
func (s *Server) Core() *core.Service { return s.core }

// Handler routes /v1 to the API and every other path to the web app, behind guard.
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
	return s.guard(mux)
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
