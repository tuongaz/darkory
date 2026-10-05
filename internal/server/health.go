package server

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/update"
	"github.com/tuongaz/darkory/internal/version"
)

// GetHealth reports that the Install is up, how humans sign in to it, and whether a newer release
// exists. It needs no credential.
func (s *Server) GetHealth(w http.ResponseWriter, r *http.Request) {
	h := gen.Health{Status: gen.HealthStatusOk, Version: version.Version, SignIn: []gen.SignInMode{gen.SignInPrintedLink}}
	if s.emailSignIn {
		h.SignIn = append(h.SignIn, gen.SignInEmail)
	}
	if st := s.updateStatus.Load(); st != nil && st.Latest != "" {
		available, latest := st.Available(), st.Latest
		h.UpdateAvailable, h.LatestVersion = &available, &latest
	}
	writeJSON(w, http.StatusOK, h)
}

// updateCheckTimeout bounds one check for a newer release. Nothing waits on it, so it is longer
// than the CLI's one second.
const updateCheckTimeout = 10 * time.Second

// WatchForUpdates asks for the newest release now and once a day until ctx ends, so /v1/health
// can say whether one is available. It does nothing for a development build, or when
// DARKORY_NO_UPDATE_CHECK is set.
func (s *Server) WatchForUpdates(ctx context.Context) {
	if update.Disabled(os.Getenv) || update.IsDevBuild(version.Version) {
		return
	}
	checker := update.NewChecker(version.Version)
	checker.Timeout = updateCheckTimeout
	for {
		st, err := checker.Check(ctx)
		if err != nil && ctx.Err() == nil {
			s.log.Info("could not check for a newer release", "err", err)
		}
		s.setUpdate(st)
		t := time.NewTimer(update.CheckInterval)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

func (s *Server) setUpdate(st update.Status) { s.updateStatus.Store(&st) }
