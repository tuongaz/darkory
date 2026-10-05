package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/server/gen"
)

// Operations not yet built answer 501 with the Error body. Each moves to its area's file
// when it is built.

func (s *Server) AddBlocker(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.BlockerRef, _ gen.AddBlockerParams) {
	s.notImplemented(w, r)
}
func (s *Server) AddNote(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.AddNoteParams) {
	s.notImplemented(w, r)
}
func (s *Server) AttachFeatureEvidence(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.AttachFeatureEvidenceParams) {
	s.notImplemented(w, r)
}
func (s *Server) AttachTaskEvidence(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.AttachTaskEvidenceParams) {
	s.notImplemented(w, r)
}
func (s *Server) DownloadEvidence(w http.ResponseWriter, r *http.Request, _ gen.EvidenceID) {
	s.notImplemented(w, r)
}
func (s *Server) DropFeature(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.DropFeatureParams) {
	s.notImplemented(w, r)
}
func (s *Server) DropTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.DropTaskParams) {
	s.notImplemented(w, r)
}
func (s *Server) GetEvidence(w http.ResponseWriter, r *http.Request, _ gen.EvidenceID) {
	s.notImplemented(w, r)
}
func (s *Server) HandoverTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.HandoverTaskParams) {
	s.notImplemented(w, r)
}
func (s *Server) ListFeatureObservations(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.ListFeatureObservationsParams) {
	s.notImplemented(w, r)
}
func (s *Server) Observe(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.ObserveParams) {
	s.notImplemented(w, r)
}
func (s *Server) PassFeatureOwnership(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.PassFeatureOwnershipParams) {
	s.notImplemented(w, r)
}
func (s *Server) ProposeSkillVersion(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.ProposeSkillVersionParams) {
	s.notImplemented(w, r)
}
func (s *Server) RankFeature(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.RankFeatureParams) {
	s.notImplemented(w, r)
}
func (s *Server) RemoveBlocker(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.BlockerRef, _ gen.RemoveBlockerParams) {
	s.notImplemented(w, r)
}
func (s *Server) RequestEmailSignIn(w http.ResponseWriter, r *http.Request, _ gen.RequestEmailSignInParams) {
	s.notImplemented(w, r)
}
func (s *Server) ShipFeature(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.ShipFeatureParams) {
	s.notImplemented(w, r)
}
func (s *Server) TakeBackTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.TakeBackTaskParams) {
	s.notImplemented(w, r)
}
