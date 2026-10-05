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

func (s *Server) AddTeamMember(w http.ResponseWriter, r *http.Request, _ gen.TeamRef, _ gen.MemberRef, _ gen.AddTeamMemberParams) {
	s.notImplemented(w, r)
}

func (s *Server) AttachFeatureEvidence(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.AttachFeatureEvidenceParams) {
	s.notImplemented(w, r)
}

func (s *Server) AttachTaskEvidence(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.AttachTaskEvidenceParams) {
	s.notImplemented(w, r)
}

func (s *Server) ClaimTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.ClaimTaskParams) {
	s.notImplemented(w, r)
}

func (s *Server) ClearManager(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.ClearManagerParams) {
	s.notImplemented(w, r)
}

func (s *Server) CloseSession(w http.ResponseWriter, r *http.Request, _ gen.SessionID, _ gen.CloseSessionParams) {
	s.notImplemented(w, r)
}

func (s *Server) CompleteTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.CompleteTaskParams) {
	s.notImplemented(w, r)
}

func (s *Server) CreateMember(w http.ResponseWriter, r *http.Request, _ gen.CreateMemberParams) {
	s.notImplemented(w, r)
}

func (s *Server) CreateSkill(w http.ResponseWriter, r *http.Request, _ gen.CreateSkillParams) {
	s.notImplemented(w, r)
}

func (s *Server) CreateTeam(w http.ResponseWriter, r *http.Request, _ gen.CreateTeamParams) {
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

func (s *Server) FileFeature(w http.ResponseWriter, r *http.Request, _ gen.FileFeatureParams) {
	s.notImplemented(w, r)
}

func (s *Server) FileTask(w http.ResponseWriter, r *http.Request, _ gen.FileTaskParams) {
	s.notImplemented(w, r)
}

func (s *Server) GetEvidence(w http.ResponseWriter, r *http.Request, _ gen.EvidenceID) {
	s.notImplemented(w, r)
}

func (s *Server) GetFeature(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef) {
	s.notImplemented(w, r)
}

func (s *Server) GetMe(w http.ResponseWriter, r *http.Request) { s.notImplemented(w, r) }

func (s *Server) GetMember(w http.ResponseWriter, r *http.Request, _ gen.MemberRef) {
	s.notImplemented(w, r)
}

func (s *Server) GetSkill(w http.ResponseWriter, r *http.Request, _ gen.SkillRef) {
	s.notImplemented(w, r)
}

func (s *Server) GetTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef) {
	s.notImplemented(w, r)
}

func (s *Server) GetTeam(w http.ResponseWriter, r *http.Request, _ gen.TeamRef) {
	s.notImplemented(w, r)
}

func (s *Server) GrantSkill(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.SkillRef, _ gen.GrantSkillParams) {
	s.notImplemented(w, r)
}

func (s *Server) HandoverTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.HandoverTaskParams) {
	s.notImplemented(w, r)
}

func (s *Server) Heartbeat(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.HeartbeatParams) {
	s.notImplemented(w, r)
}

func (s *Server) IssueLoginLink(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.IssueLoginLinkParams) {
	s.notImplemented(w, r)
}

func (s *Server) IssueToken(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.IssueTokenParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListActivity(w http.ResponseWriter, r *http.Request, _ gen.ListActivityParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListFeatureObservations(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.ListFeatureObservationsParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListFeatures(w http.ResponseWriter, r *http.Request, _ gen.ListFeaturesParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListMembers(w http.ResponseWriter, r *http.Request, _ gen.ListMembersParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListSkillVersions(w http.ResponseWriter, r *http.Request, _ gen.SkillRef) {
	s.notImplemented(w, r)
}

func (s *Server) ListSkills(w http.ResponseWriter, r *http.Request, _ gen.ListSkillsParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListTakeableTasks(w http.ResponseWriter, r *http.Request, _ gen.ListTakeableTasksParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListTasks(w http.ResponseWriter, r *http.Request, _ gen.ListTasksParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListTeams(w http.ResponseWriter, r *http.Request) { s.notImplemented(w, r) }

func (s *Server) ListTokens(w http.ResponseWriter, r *http.Request, _ gen.MemberRef) {
	s.notImplemented(w, r)
}

func (s *Server) Logout(w http.ResponseWriter, r *http.Request, _ gen.LogoutParams) {
	s.notImplemented(w, r)
}

func (s *Server) NextTask(w http.ResponseWriter, r *http.Request, _ gen.NextTaskParams) {
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

func (s *Server) RedeemLoginLink(w http.ResponseWriter, r *http.Request, _ gen.LoginCode) {
	s.notImplemented(w, r)
}

func (s *Server) ReleaseTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.ReleaseTaskParams) {
	s.notImplemented(w, r)
}

func (s *Server) RemoveBlocker(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.BlockerRef, _ gen.RemoveBlockerParams) {
	s.notImplemented(w, r)
}

func (s *Server) RemoveTeamMember(w http.ResponseWriter, r *http.Request, _ gen.TeamRef, _ gen.MemberRef, _ gen.RemoveTeamMemberParams) {
	s.notImplemented(w, r)
}

func (s *Server) RequestEmailSignIn(w http.ResponseWriter, r *http.Request, _ gen.RequestEmailSignInParams) {
	s.notImplemented(w, r)
}

func (s *Server) RevokeSkill(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.SkillRef, _ gen.RevokeSkillParams) {
	s.notImplemented(w, r)
}

func (s *Server) RevokeToken(w http.ResponseWriter, r *http.Request, _ gen.TokenID, _ gen.RevokeTokenParams) {
	s.notImplemented(w, r)
}

func (s *Server) SetManager(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.SetManagerParams) {
	s.notImplemented(w, r)
}

func (s *Server) ShipFeature(w http.ResponseWriter, r *http.Request, _ gen.FeatureRef, _ gen.ShipFeatureParams) {
	s.notImplemented(w, r)
}

func (s *Server) StreamActivity(w http.ResponseWriter, r *http.Request, _ gen.StreamActivityParams) {
	s.notImplemented(w, r)
}

func (s *Server) TakeBackTask(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.TakeBackTaskParams) {
	s.notImplemented(w, r)
}

func (s *Server) UpdateMember(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.UpdateMemberParams) {
	s.notImplemented(w, r)
}
