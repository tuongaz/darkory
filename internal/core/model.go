package core

import "time"

// The records the operations return. They mirror the API's schemas; the server converts them.

type Organisation struct {
	ID        string
	Name      string
	CreatedAt time.Time
}

type Member struct {
	ID        string
	Name      string
	Kind      string
	Email     *string
	Admin     bool
	ManagerID *string
	CreatedAt time.Time
	// DeactivatedAt is when an admin deactivated the Member; nil while active.
	DeactivatedAt *time.Time
	// Agent is how the Runner starts the Member's sessions; nil for humans and for agents it
	// does not start.
	Agent *AgentSettings
}

// AgentSettings are how the Runner starts an agent's sessions (ADR 0013). Command and each of
// Args are templates: the Runner replaces {session_id}, {model}, {prompt_file}, {mcp_config},
// {workspace} and {task}.
type AgentSettings struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Model   string            `json:"model"`
	Env     map[string]string `json:"env"`
	// Unattended: the session runs with the agent's permission checks skipped.
	Unattended bool `json:"unattended"`
	// Paused: the Runner starts no new session for the agent.
	Paused bool `json:"paused"`
	// ProgressFile is the file whose modified time shows progress, for a command other than
	// Claude Code; empty for none.
	ProgressFile string `json:"progress_file,omitempty"`
}

type MemberDetail struct {
	Member  Member
	Teams   []Team
	Skills  []Skill
	Reports []Member
}

type Team struct {
	ID   string
	Key  string
	Name string
	// DefaultWorkspaceID is the Workspace a Task filed in the Team names when it names none.
	DefaultWorkspaceID *string
	// ShipWhenDone is what a Feature filed in the Team takes when its filer does not say.
	ShipWhenDone bool
	CreatedAt    time.Time
}

// Workspace is a place a session works in, named on the Install (ADR 0013). A git Workspace is
// a repository at Path on the machine that runs the Install.
type Workspace struct {
	ID   string
	Name string
	// Kind is git.
	Kind string
	Path string
	// Mode is plain or pull_request.
	Mode          string
	DefaultBranch string
	CreatedAt     time.Time
}

type TeamDetail struct {
	Team    Team
	Members []Member
}

type Skill struct {
	ID             string
	Name           string
	Kind           string
	BaseSkillID    *string
	Builtin        bool
	CurrentVersion int64
	CreatedAt      time.Time
}

type SkillVersion struct {
	SkillID     string
	Version     int64
	Body        string
	ProposalID  *string
	PublishedBy *string
	PublishedAt time.Time
}

type SkillDetail struct {
	Skill   Skill
	Current SkillVersion
}

type Feature struct {
	ID                      string
	Key                     string
	TeamID                  string
	Title                   string
	Description             string
	OwnerID                 string
	State                   string
	Rank                    int64
	FromRetrospectiveTaskID *string
	// Quick: filed with its one Task and no Break down; it has no Retrospective (ADR 0014).
	Quick bool
	// ShipWhenDone: it ships itself when its last open Task is completed.
	ShipWhenDone bool
	FiledBy      string
	CreatedAt    time.Time
	EndedAt      *time.Time
	TaskCounts   TaskCounts
}

// TaskCounts counts a Feature's Tasks by state; Claimed counts the open ones with a live Claim.
type TaskCounts struct {
	Open, Claimed, Done, Dropped int
}

type FeatureDetail struct {
	Feature  Feature
	Tasks    []Task
	Evidence []Evidence
}

type Task struct {
	ID          string
	Key         string
	FeatureID   string
	Kind        string
	Title       string
	Description string
	State       string
	// StatusID is the Task's Status, one of its Organisation's (ADR 0012).
	StatusID  string
	SkillID   *string
	AimedAtID *string
	Claim     *Claim
	Blocked   bool
	// OpenBlockers are the open Tasks blocking this one.
	OpenBlockers []TaskBrief
	// WorkspaceIDs are the Workspaces the Task names, in the order named.
	WorkspaceIDs []string
	FiledBy      string
	WaitingSince time.Time
	CreatedAt    time.Time
	EndedAt      *time.Time
}

// Status is where a Task is in its workflow, from the list its Organisation defines and orders.
// Darkory's rules read Kind, never Name.
type Status struct {
	ID   string
	Name string
	// Kind is backlog, todo, in_progress, done or dropped.
	Kind string
	// Position is its place in the list, 1 first.
	Position int64
}

// TaskBrief names a Task by its id and display key.
type TaskBrief struct {
	ID  string
	Key string
}

type Claim struct {
	ID       string
	TaskID   string
	HolderID string
	// SessionID is the id the Session making the Claim chose.
	SessionID    string
	SkillID      *string
	SkillVersion *int64
	ModelLabel   *string
	// Timeout is zero when the Claim never lapses on its own.
	Timeout   time.Duration
	StartedAt time.Time
	ExpiresAt *time.Time
	EndedAt   *time.Time
	HowEnded  *string
}

type TaskDetail struct {
	Task Task
	// Status is the Task's Status.
	Status  Status
	Feature Feature
	// Workspaces are the Workspaces the Task names, in the order of Task.WorkspaceIDs.
	Workspaces   []Workspace
	Claims       []Claim
	Notes        []Note
	Evidence     []Evidence
	Blockers     []Task
	Blocking     []Task
	Observations []Observation
	// Proposal is the latest Skill proposal written on the Task.
	Proposal *SkillProposal
}

type SkillProposal struct {
	ID               string
	SkillID          string
	TaskID           string
	BasedOnVersion   int64
	Body             string
	AuthorID         string
	State            string
	PublishedVersion *int64
	CreatedAt        time.Time
	DecidedAt        *time.Time
}

type Note struct {
	ID        string
	TaskID    string
	AuthorID  string
	SkillID   *string
	Body      string
	CreatedAt time.Time
}

type Observation struct {
	ID               string
	TaskID           string
	FeatureID        string
	AuthorID         string
	SkillID          *string
	Outcome          string
	Body             string
	CreatedAt        time.Time
	ReviewedByTaskID *string
	ReviewedAt       *time.Time
}

type Evidence struct {
	ID          string
	FeatureID   string
	TaskID      *string
	Filename    string
	ContentType string
	Size        int64
	SHA256      string
	AttachedBy  string
	CreatedAt   time.Time
	// BlobKey is where the Evidence store keeps the file; it is not shown.
	BlobKey string
}

type Activity struct {
	Seq     int64
	At      time.Time
	ActorID *string
	Kind    string
	// SubjectType is the kind of record SubjectID names: the part of Kind before the dot.
	SubjectType string
	SubjectID   string
	Payload     map[string]any
}

type ActivityPage struct {
	Items   []Activity
	LastSeq int64
	// FirstSeq is the first entry's number; zero when the page is empty.
	FirstSeq int64
}

type Token struct {
	ID             string
	MemberID       string
	Name           string
	Prefix         string
	DefaultTimeout time.Duration
	CreatedAt      time.Time
	LastUsedAt     *time.Time
	RevokedAt      *time.Time
}

type IssuedToken struct {
	Token  Token
	Secret string
}

type Session struct {
	// ID is the id the running copy chose.
	ID         string
	MemberID   string
	Kind       string
	TokenID    *string
	StartedAt  time.Time
	LastSeenAt time.Time
	// ExpiresAt is when an open browser Session expires unless used; nil for token Sessions.
	ExpiresAt *time.Time
	ClosedAt  *time.Time
}

type ClosedSession struct {
	Session     Session
	ClaimsEnded int
}

type LoginLink struct {
	// Code goes in the link's URL; the server builds the URL from it.
	Code      string
	ExpiresAt time.Time
}

type Me struct {
	Organisation Organisation
	Member       Member
	Teams        []Team
	Skills       []Skill
	Session      Session
}

// Page is a list with an opaque cursor to the next page; NextCursor is empty on the last page.
type Page[T any] struct {
	Items      []T
	NextCursor string
}

// HeartbeatReply says what became of the caller's Claim.
type HeartbeatReply struct {
	// Status is ok, lapsed, taken_back or ended.
	Status    string
	ExpiresAt *time.Time
}
