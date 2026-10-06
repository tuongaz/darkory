// Package remote is how the CLI and the MCP server reach an Install: settings, a generated client
// that sends the token, the Session id and a fresh Idempotency-Key on every write, retrying once
// with the same key when the network fails, and the Error a refused request carries (plan
// invariant 9: only /v1, only through client/).
package remote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/version"
)

// DefaultURL is a Local Install on its default listen address.
const DefaultURL = "http://127.0.0.1:7357"

// The settings a CLI or MCP process reads from its environment.
const (
	EnvURL     = "DARKORY_URL"
	EnvToken   = "DARKORY_TOKEN"
	EnvSession = "DARKORY_SESSION"
	// EnvInsecure, set to anything but empty, 0 or false, lets the token go over plain http to a
	// host other than this machine (--insecure).
	EnvInsecure = "DARKORY_INSECURE"
)

// Settings say which Install to reach and as whom.
type Settings struct {
	// URL is the Install's base URL, such as http://127.0.0.1:7357.
	URL string
	// Token is the Member's bearer token, dk_….
	Token string
	// Session is the id this running copy chose (ADR 0008).
	Session string
	// OneOff is true when Session was made up for this process because none was set.
	OneOff bool
	// Insecure lets URL be plain http to a host other than this machine (CheckURL).
	Insecure bool
	// HTTPClient sends the requests; nil means one with no timeout, since `next` and the
	// Activity stream hold requests open.
	HTTPClient *http.Client
}

// FromEnv reads the settings from getenv, leaving Session empty when DARKORY_SESSION is unset.
func FromEnv(getenv func(string) string) Settings {
	s := Settings{URL: getenv(EnvURL), Token: getenv(EnvToken), Session: getenv(EnvSession),
		Insecure: !slices.Contains([]string{"", "0", "false"}, getenv(EnvInsecure))}
	if s.URL == "" {
		s.URL = DefaultURL
	}
	return s
}

// CheckURL refuses a URL that would send the token in clear text across a network: plain http
// to a host other than this machine (localhost or a loopback address), unless Insecure says the
// network is trusted (security review L10).
func (s Settings) CheckURL() error {
	u, err := url.Parse(s.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("the Install's URL %q is not an http:// or https:// URL", s.URL)
	}
	if u.Scheme == "https" || s.Insecure || Loopback(u.Hostname()) {
		return nil
	}
	return fmt.Errorf("refusing to send the token in clear text to %s: use https://, "+
		"or pass --insecure (DARKORY_INSECURE=1) if the network to it is trusted", u.Host)
}

// Loopback reports whether host names this machine: localhost or a loopback address.
func Loopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// NewSessionID returns a fresh Session id, a UUIDv7.
func NewSessionID() string { return uuid.Must(uuid.NewV7()).String() }

// Conn is a generated client bound to one Member and Session.
type Conn struct {
	*client.ClientWithResponses
	Settings Settings
}

// Dial returns a Conn for s. It sends nothing until the first call.
func Dial(s Settings) (*Conn, error) {
	if err := s.CheckURL(); err != nil {
		return nil, err
	}
	s.URL = strings.TrimRight(s.URL, "/")
	hc := s.HTTPClient
	if hc == nil {
		hc = &http.Client{}
	}
	c, err := client.NewClientWithResponses(s.URL,
		client.WithHTTPClient(retryOnce{hc}),
		client.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
			if s.Token != "" {
				req.Header.Set("Authorization", "Bearer "+s.Token)
			}
			if s.Session != "" {
				req.Header.Set("Darkory-Session", s.Session)
			}
			if isWrite(req) && req.Header.Get("Idempotency-Key") == "" {
				req.Header.Set("Idempotency-Key", uuid.Must(uuid.NewV7()).String())
			}
			req.Header.Set("User-Agent", "darkory/"+version.Version)
			return nil
		}))
	if err != nil {
		return nil, err
	}
	return &Conn{ClientWithResponses: c, Settings: s}, nil
}

func isWrite(req *http.Request) bool {
	switch req.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	return true
}

// retryOnce sends a request again, once, when the network fails before a response arrives. A
// write is resent with the Idempotency-Key it first carried, so a reply lost on the way back
// returns the first result instead of writing twice; reads are safe to repeat.
type retryOnce struct{ hc *http.Client }

func (d retryOnce) Do(req *http.Request) (*http.Response, error) {
	res, err := d.hc.Do(req)
	if err == nil || req.Context().Err() != nil {
		return res, err
	}
	if isWrite(req) && req.Header.Get("Idempotency-Key") == "" {
		return res, err
	}
	again := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return res, err
		}
		body, gerr := req.GetBody()
		if gerr != nil {
			return res, err
		}
		again.Body = body
	}
	return d.hc.Do(again)
}

// Error is a request the Install answered with its Error body, or one that never got an answer.
type Error struct {
	// Status is the HTTP status, or 0 when no response arrived.
	Status int
	// Code is the stable reason, such as already_claimed; empty when no response arrived or the
	// body was not an Error.
	Code    client.ErrorCode
	Message string
	Details map[string]any
	// Err is the network failure, when no response arrived.
	Err error
}

func (e *Error) Error() string {
	switch {
	case e.Err != nil:
		return e.Message + ": " + e.Err.Error()
	case e.Code != "":
		return string(e.Code) + ": " + e.Message
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// Refused reports whether the Install refused the request on a rule of the record — someone
// holds the Task, the caller is not its holder or lacks the authority, a cycle, a stale
// proposal — rather than failing to carry it out.
func (e *Error) Refused() bool {
	switch e.Code {
	case client.ErrorCodeForbidden, client.ErrorCodeConflict, client.ErrorCodeAlreadyClaimed,
		client.ErrorCodeNotTakeable, client.ErrorCodeNotHolder, client.ErrorCodeEnded,
		client.ErrorCodeTasksOpen, client.ErrorCodeCycle, client.ErrorCodeProposalStale,
		client.ErrorCodeStatusInUse, client.ErrorCodeUseComplete, client.ErrorCodeUseDrop:
		return true
	}
	return false
}

// CodeOf returns err's Error code, or "" when err is not an Error.
func CodeOf(err error) client.ErrorCode {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// Response is what every generated client call returns.
type Response interface {
	StatusCode() int
	GetBody() []byte
}

// Check turns a generated client call's result into an error unless the response came back with
// one of the statuses in ok. res is nil when err is set.
func Check(res Response, err error, ok ...int) error {
	if err != nil {
		var e *Error
		if errors.As(err, &e) {
			return e
		}
		return &Error{Message: "no answer from the Install", Err: err}
	}
	if slices.Contains(ok, res.StatusCode()) {
		return nil
	}
	return ErrorFrom(res.StatusCode(), res.GetBody())
}

// ErrorFrom reads an Error body answered with status.
func ErrorFrom(status int, body []byte) *Error {
	var b client.Error
	if json.Unmarshal(body, &b) == nil && b.Code != "" {
		e := &Error{Status: status, Code: b.Code, Message: b.Message}
		if b.Details != nil {
			e.Details = *b.Details
		}
		return e
	}
	msg := strings.TrimSpace(string(body))
	if len(msg) > 200 {
		msg = msg[:200] + "…"
	}
	if msg == "" {
		msg = http.StatusText(status)
	}
	return &Error{Status: status, Message: fmt.Sprintf("HTTP %d: %s", status, msg)}
}
