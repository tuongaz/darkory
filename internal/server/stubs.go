package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/server/gen"
)

// Operations not yet built answer 501 with the Error body. Each moves to its area's file
// when it is built.

func (s *Server) RequestEmailSignIn(w http.ResponseWriter, r *http.Request, _ gen.RequestEmailSignInParams) {
	s.notImplemented(w, r)
}
