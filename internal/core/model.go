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
	// AvatarFileID is the file shown in place of the Member's initials; nil for none.
	AvatarFileID *string
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
	Member   Member
	Projects []Project
	Skills   []Skill
	Reports  []Member
}

// Project is a body of work with the Members who do it (ADR 0015): its own key, Workflow,
// Labels, Rank and default Workspace.
type Project struct {
	ID   string
	Key  string
	Name string
	// DefaultWorkspaceID is the Workspace a Task filed in the Project names when it names none.
	DefaultWorkspaceID *string
	// AutoComplete and Acceptance are what a Task filed in the Project takes when its filer does
	// not say.
	AutoComplete bool
	Acceptance   bool
	CreatedAt    time.Time
}

type ProjectDetail struct {
	Project Project
	Members []Member
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

// Step is a place in a Project's Workflow (ADR 0016), carrying at most one Skill: a Task at it is
// taken by a Member with that Skill. A Step without one is a hold.
type Step struct {
	ID      string
	Name    string
	SkillID *string
	// Position is its place in the Workflow, 1 first.
	Position int64
	// X and Y are where the canvas draws it, in pixels.
	X, Y int64
}

// Connector is a named way out of a Step: into another Step, or into Done when ToStepID is nil.
type Connector struct {
	ID         string
	FromStepID string
	ToStepID   *string
	Name       string
	// Position is its place among the Connectors out of its Step, 1 first.
	Position int64
}

// Workflow is a Project's Steps, in order, and the Connectors between them.
type Workflow struct {
	ProjectID  string
	Steps      []Step
	Connectors []Connector
}

// WorkflowDetail is a Workflow with what is happening at each of its Steps now.
type WorkflowDetail struct {
	Workflow
	// Facts are each Step's, in the order of Steps.
	Facts []StepFacts
}

// StepFacts are the live facts of one Step.
type StepFacts struct {
	StepID string
	// Tasks counts the open Tasks at the Step; Working those of them with a live Claim.
	Tasks, Working int
	// Takers are the active Members who could take a Task at the Step by its Skill: the
	// Project's Members holding it, or for skill-review the Organisation's.
	Takers []Taker
	// MedianMS is the median time Tasks spent at the Step before leaving it over the last 30
	// days; nil when none left it.
	MedianMS *int64
}

// Taker is a Member who holds a Step's Skill.
type Taker struct {
	MemberID string
	Name     string
	// Kind is human or agent.
	Kind string
}

// Label is a named, coloured mark carried by Tasks: a Project's own, or the Organisation's for
// every Project (ProjectID nil).
type Label struct {
	ID        string
	ProjectID *string
	Name      string
	// Color is #rrggbb.
	Color     string
	CreatedAt time.Time
}

type Task struct {
	ID        string
	Key       string
	ProjectID string
	// ParentID is the Parent of a Subtask; nil for a Task with no Parent.
	ParentID    *string
	Kind        string
	Title       string
	Description string
	State       string
	// StepID is the Step the Task is at; nil on a Parent, a Task aimed at a Member, and an ended
	// Task. StepSince is when it reached it.
	StepID    *string
	StepSince *time.Time
	// SkillID is the Skill of its Step, read with it: the Skill that takes it. Nil at a hold and
	// wherever StepID is nil.
	SkillID   *string
	AimedAtID *string
	OwnerID   string
	// Rank is the Task's place in its Project's Rank, 1 first; nil on a Subtask, which sorts by
	// its Parent's.
	Rank *int64
	// Labels are the ids of the Labels it carries, by name.
	Labels []string
	// Breakdown: filed with Break down on. AutoComplete and Acceptance are a Parent's.
	Breakdown               bool
	AutoComplete            bool
	Acceptance              bool
	FromRetrospectiveTaskID *string
	Claim                   *Claim
	Blocked                 bool
	// OpenBlockers are the open Tasks blocking this one.
	OpenBlockers []TaskBrief
	// WorkspaceIDs are the Workspaces the Task names, in the order named.
	WorkspaceIDs []string
	// SubtaskCounts counts a Parent's Subtasks; nil on a Task with none.
	SubtaskCounts *SubtaskCounts
	// FiledBy is nil for the Subtasks Darkory files itself: Breakdown, Acceptance, Retrospective.
	FiledBy *string
	// WaitingSince is when it was filed or last reached a Step: `next` gives a tie to the Task
	// that has waited longest.
	WaitingSince time.Time
	CreatedAt    time.Time
	EndedAt      *time.Time
}

// SubtaskCounts counts a Parent's Subtasks by state; Working counts the open ones with a live
// Claim.
type SubtaskCounts struct {
	Open, Working, Done, Dropped int
}

// TaskBrief names a Task by its id, display key and title.
type TaskBrief struct {
	ID    string
	Key   string
	Title string
}

type Claim struct {
	ID       string
	TaskID   string
	HolderID string
	// SessionID is the id the Session making the Claim chose.
	SessionID string
	// SkillID is the Skill of the Step the Task was taken at; nil for a Task aimed at a Member.
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
	// Parent is a Subtask's Parent; nil for a Task with no Parent.
	Parent *TaskBrief
	// Subtasks are a Parent's, in the order they were filed.
	Subtasks []Task
	// Step is the Step the Task is at, and Connectors the ways out of it, in order.
	Step       *Step
	Connectors []Connector
	// Labels are the Labels it carries, by name.
	Labels []Label
	// Workspaces are the Workspaces the Task names, in the order of Task.WorkspaceIDs.
	Workspaces   []Workspace
	Claims       []Claim
	Notes        []Note
	Evidence     []Evidence
	Blockers     []Task
	Blocking     []Task
	Observations []Observation
	// Proposals are the latest Skill proposal written on the Task for each Skill, pending or
	// decided, oldest first.
	Proposals []SkillProposal
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
	TaskID      string
	Filename    string
	ContentType string
	Size        int64
	SHA256      string
	AttachedBy  string
	CreatedAt   time.Time
	// BlobKey is where the Evidence store keeps the file; it is not shown.
	BlobKey string
}

// File is bytes an Organisation keeps, referenced by id: a Member's avatar, or any file a later
// feature keeps. The bytes are in the file store under BlobKey; this is what describes them.
type File struct {
	ID   string
	Name string
	// ContentType is what the server found by reading the bytes, never what the uploader said.
	ContentType string
	Size        int64
	SHA256      string
	// Purpose is what the file was uploaded as: FileGeneral or FileAvatar.
	Purpose   string
	CreatedBy string
	CreatedAt time.Time
	// DeletedAt is when the file was deleted; its bytes are gone and only this record stays.
	DeletedAt *time.Time
	// BlobKey is where the file store keeps the bytes; it is not shown.
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
	// EndedAt is when the Session ended, however it ended; nil while it is open.
	EndedAt *time.Time
}

// SessionPage is a page of a Member's Sessions, with how many are open and how many have ended.
type SessionPage struct {
	Page[Session]
	Open, Ended int
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
	Projects     []Project
	Skills       []Skill
	Session      Session
	// Organisations are the Organisations the sign-in identity reaches, for a switcher; nil on
	// Local, which holds exactly one.
	Organisations []Organisation
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

// ProjectSeen is how far a Member has seen a Project's Activity; both fields are nil until they
// first set it.
type ProjectSeen struct {
	// Seq is the seq of the newest Activity entry the Member has seen in the Project.
	Seq *int64
	// At is when the Member last moved it forward.
	At *time.Time
}

// View is a saved set of filters, sort and display for a list, kept by one Member for themselves.
type View struct {
	ID string
	// Entity is the list it is of: EntityTasks.
	Entity string
	// ProjectID is the Project whose list it is; nil for a list across Projects.
	ProjectID *string
	Name      string
	Filters   []string
	// Sort and Display are as the client wrote them; nil when it wrote none.
	Sort      *string
	Display   map[string]any
	CreatedAt time.Time
	UpdatedAt time.Time
}
