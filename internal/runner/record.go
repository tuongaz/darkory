package runner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// The runner is a client of the record (plan invariant 9): everything it reads or writes goes
// through /v1 as an agent Member, in a Session it chose. Record is that surface, so the runner's
// rules are written against it and a test can stand in for the Install.

// Workspace is a place a session works in, a git repository for now (CONTEXT.md).
type Workspace struct {
	ID   string
	Name string
	// Kind is git.
	Kind string
	// Path is the repository on this machine.
	Path string
	// Mode is plain (the runner merges) or pull_request (GitHub merges, through pull requests).
	Mode string
	// DefaultBranch is where Ship lands, main unless the Workspace says otherwise.
	DefaultBranch string
}

// Workspace modes.
const (
	ModePlain       = "plain"
	ModePullRequest = "pull_request"
)

// maxShifts is the most Shifts the runner runs for one agent at once.
const maxShifts = 8

// AgentSettings say how the runner starts an agent Member's sessions (D12).
type AgentSettings struct {
	// Command and Args are the command template; empty is Claude Code (DefaultCommand, DefaultArgs).
	Command string
	Args    []string
	// Model is the agent's model, {model} in the template and the Claim's model label.
	Model string
	// Env is added to the session's environment.
	Env map[string]string
	// Unattended runs Claude Code with its permission checks skipped (D7).
	Unattended bool
	// Paused agents take no new work.
	Paused bool
	// ProgressFile is the file another command writes as it works, a template like Command;
	// empty for Claude Code, whose transcript the runner finds itself.
	ProgressFile string
	// Shifts is how many Shifts the runner runs for the agent at once, 1 to 8.
	Shifts int
}

// ParentInfo is what the runner reads of a Subtask's Parent: the whole the Subtask is part of.
type ParentInfo struct {
	ID, Key, Title, Description, OwnerID string
	// Owner is the Owner's name.
	Owner string
	// Open: the Parent has not ended.
	Open bool
	// Done are the keys of its Subtasks that ended Done with work to merge: worked ones and
	// Acceptances.
	Done []string
}

// Record is the part of /v1 the runner uses, as one Member in one Session.
type Record interface {
	// Me is the Member the token belongs to.
	Me(ctx context.Context) (*client.Me, error)
	// Agent reads an agent Member's settings; ok is false when the Member has none.
	Agent(ctx context.Context, member string) (s AgentSettings, ok bool, err error)
	// Next waits up to wait for a takeable Task and claims it; nil when none came.
	Next(ctx context.Context, wait, timeout time.Duration, model string) (*client.TaskDetail, error)
	// Claim claims a named Task.
	Claim(ctx context.Context, task string, timeout time.Duration, model string) (*client.TaskDetail, error)
	Task(ctx context.Context, ref string) (*client.TaskDetail, error)
	// Parent reads the Parent of the Task d; nil when it has none.
	Parent(ctx context.Context, d *client.TaskDetail) (*ParentInfo, error)
	// Workspaces are the Workspaces task names, or its Project's default when it names none.
	Workspaces(ctx context.Context, task *client.TaskDetail) ([]Workspace, error)
	// AllWorkspaces are the Install's Workspaces.
	AllWorkspaces(ctx context.Context) ([]Workspace, error)
	Skill(ctx context.Context, ref string) (*client.SkillDetail, error)
	Skills(ctx context.Context) ([]client.Skill, error)
	// Workflows reads a Project's Workflows: every Workflow, Step and Connector.
	Workflows(ctx context.Context, project string) (*client.Workflows, error)
	Members(ctx context.Context) ([]client.Member, error)
	Heartbeat(ctx context.Context, task string) (client.HeartbeatStatus, error)
	Release(ctx context.Context, task, note string) error
	// Advance ends the Claim on task along the Connector named outcome out of its Step.
	Advance(ctx context.Context, task, outcome, note string) error
	Note(ctx context.Context, task, body string) error
	// Nudged records that the Runner nudged the agent holding task, nudge 1 or 2.
	Nudged(ctx context.Context, task string, nudge int) error
	File(ctx context.Context, body client.FileTaskBody) (*client.Task, error)
	// Attach attaches content to task as Evidence of kind, under the Claim claim when it is not
	// empty: a Shift's log names its own Claim, ended or not, and is taken whoever holds the Task
	// now. Without a Claim it is refused not_holder while another Member holds the Task.
	Attach(ctx context.Context, task, filename string, kind client.EvidenceKind, claim string, content []byte) error
	// SetPullRequest records on task the pull request its branch lands through, as GitHub has it.
	SetPullRequest(ctx context.Context, task string, pr client.PullRequest) error
	// Activity reads one connection of the Activity stream from after, calling each for every
	// entry, and returns the last sequence number seen.
	Activity(ctx context.Context, after int64, each func(client.Activity)) (int64, error)
	// LastSeq is the sequence number of the latest Activity entry.
	LastSeq(ctx context.Context) (int64, error)
	// CloseSession ends the Session, and any Claim still bound to it.
	CloseSession(ctx context.Context) error
	// Session is the Session id the Record acts in.
	Session() string
}

// Dial returns a Record acting as the Member token belongs to, in Session session.
func Dial(url, token, session string, hc *http.Client) (Record, error) {
	c, err := remote.Dial(remote.Settings{URL: url, Token: token, Session: session, HTTPClient: hc})
	if err != nil {
		return nil, err
	}
	return &conn{c: c}, nil
}

// conn is a Record over the generated client.
type conn struct{ c *remote.Conn }

func (r *conn) Session() string { return r.c.Settings.Session }

func ptr[T any](v T) *T { return &v }

func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func secs(d time.Duration) int { return int((d + time.Second - 1) / time.Second) }

func (r *conn) Me(ctx context.Context) (*client.Me, error) {
	res, err := r.c.GetMeWithResponse(ctx)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200, nil
}

func (r *conn) Agent(ctx context.Context, member string) (AgentSettings, bool, error) {
	res, err := r.c.GetMemberWithResponse(ctx, member)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return AgentSettings{}, false, err
	}
	a := res.JSON200.Member.Agent
	if res.JSON200.Member.Kind != client.Agent || a == nil {
		return AgentSettings{}, false, nil
	}
	set := AgentSettings{Command: a.Command, Args: a.Args, Model: a.Model, Env: a.Env, Unattended: a.Unattended, Paused: a.Paused,
		Shifts: min(max(a.Shifts, 1), maxShifts)}
	if a.ProgressFile != nil {
		set.ProgressFile = *a.ProgressFile
	}
	return set, true, nil
}

func (r *conn) Next(ctx context.Context, wait, timeout time.Duration, model string) (*client.TaskDetail, error) {
	body := client.NextTaskBody{WaitSeconds: ptr(secs(wait)), HeartbeatTimeoutSeconds: ptr(secs(timeout)), ModelLabel: opt(model)}
	res, err := r.c.NextTaskWithResponse(ctx, &client.NextTaskParams{}, body)
	if err := remote.Check(res, err, http.StatusOK, http.StatusNoContent); err != nil {
		return nil, err
	}
	if res.StatusCode() == http.StatusNoContent {
		return nil, nil
	}
	return res.JSON200, nil
}

func (r *conn) Claim(ctx context.Context, task string, timeout time.Duration, model string) (*client.TaskDetail, error) {
	body := client.ClaimTaskBody{HeartbeatTimeoutSeconds: ptr(secs(timeout)), ModelLabel: opt(model)}
	res, err := r.c.ClaimTaskWithResponse(ctx, task, &client.ClaimTaskParams{}, body)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200, nil
}

func (r *conn) Task(ctx context.Context, ref string) (*client.TaskDetail, error) {
	res, err := r.c.GetTaskWithResponse(ctx, ref)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200, nil
}

func (r *conn) Parent(ctx context.Context, d *client.TaskDetail) (*ParentInfo, error) {
	if d.Parent == nil {
		return nil, nil
	}
	res, err := r.c.GetTaskWithResponse(ctx, d.Parent.ID)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	t := res.JSON200.Task
	p := &ParentInfo{ID: t.ID, Key: t.Key, Title: t.Title, Description: t.Description, OwnerID: t.OwnerID, Open: t.State == client.TaskStateOpen}
	for _, sub := range res.JSON200.Subtasks {
		if sub.State == client.TaskStateDone && merged(sub.Kind) {
			p.Done = append(p.Done, sub.Key)
		}
	}
	m, err := r.c.GetMemberWithResponse(ctx, p.OwnerID)
	if err := remote.Check(m, err, http.StatusOK); err != nil {
		return nil, err
	}
	p.Owner = m.JSON200.Member.Name
	return p, nil
}

func workspace(w client.Workspace) Workspace {
	return Workspace{ID: w.ID, Name: w.Name, Kind: string(w.Kind), Path: w.Path, Mode: string(w.Mode), DefaultBranch: w.DefaultBranch}
}

func (r *conn) Workspaces(_ context.Context, task *client.TaskDetail) ([]Workspace, error) {
	out := make([]Workspace, len(task.Workspaces))
	for i, w := range task.Workspaces {
		out[i] = workspace(w)
	}
	return out, nil
}

func (r *conn) AllWorkspaces(ctx context.Context) ([]Workspace, error) {
	res, err := r.c.ListWorkspacesWithResponse(ctx)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	out := make([]Workspace, len(res.JSON200.Items))
	for i, w := range res.JSON200.Items {
		out[i] = workspace(w)
	}
	return out, nil
}

func (r *conn) Skill(ctx context.Context, ref string) (*client.SkillDetail, error) {
	res, err := r.c.GetSkillWithResponse(ctx, ref)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200, nil
}

func (r *conn) Skills(ctx context.Context) ([]client.Skill, error) {
	res, err := r.c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200.Items, nil
}

func (r *conn) Workflows(ctx context.Context, project string) (*client.Workflows, error) {
	res, err := r.c.GetWorkflowWithResponse(ctx, project)
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200, nil
}

func (r *conn) Members(ctx context.Context) ([]client.Member, error) {
	res, err := r.c.ListMembersWithResponse(ctx, &client.ListMembersParams{})
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200.Items, nil
}

func (r *conn) Heartbeat(ctx context.Context, task string) (client.HeartbeatStatus, error) {
	res, err := r.c.HeartbeatWithResponse(ctx, task, &client.HeartbeatParams{})
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return "", err
	}
	return res.JSON200.Status, nil
}

func (r *conn) Release(ctx context.Context, task, note string) error {
	res, err := r.c.ReleaseTaskWithResponse(ctx, task, &client.ReleaseTaskParams{}, client.ReleaseTaskBody{Note: opt(note)})
	return remote.Check(res, err, http.StatusOK)
}

func (r *conn) Advance(ctx context.Context, task, outcome, note string) error {
	res, err := r.c.AdvanceTaskWithResponse(ctx, task, &client.AdvanceTaskParams{}, client.AdvanceTaskBody{Outcome: opt(outcome), Note: opt(note)})
	return remote.Check(res, err, http.StatusOK)
}

func (r *conn) Note(ctx context.Context, task, body string) error {
	res, err := r.c.AddNoteWithResponse(ctx, task, &client.AddNoteParams{}, client.AddNoteBody{Body: body})
	return remote.Check(res, err, http.StatusCreated)
}

func (r *conn) Nudged(ctx context.Context, task string, nudge int) error {
	res, err := r.c.RecordNudgeWithResponse(ctx, task, &client.RecordNudgeParams{}, client.RecordNudgeBody{Nudge: nudge})
	return remote.Check(res, err, http.StatusNoContent)
}

func (r *conn) File(ctx context.Context, body client.FileTaskBody) (*client.Task, error) {
	res, err := r.c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, body)
	if err := remote.Check(res, err, http.StatusCreated); err != nil {
		return nil, err
	}
	return &res.JSON201.Task, nil
}

func (r *conn) Attach(ctx context.Context, task, filename string, kind client.EvidenceKind, claim string, content []byte) error {
	params := &client.AttachTaskEvidenceParams{Filename: filename, Kind: &kind, Claim: opt(claim)}
	// A *bytes.Reader lets a retry resend the body.
	res, err := r.c.AttachTaskEvidenceWithBodyWithResponse(ctx, task, params, contentType(filename, content), bytes.NewReader(content))
	return remote.Check(res, err, http.StatusCreated)
}

func (r *conn) SetPullRequest(ctx context.Context, task string, pr client.PullRequest) error {
	res, err := r.c.SetTaskPullRequestWithResponse(ctx, task, &client.SetTaskPullRequestParams{},
		client.SetTaskPullRequestBody{Number: pr.Number, URL: pr.URL, State: pr.State})
	return remote.Check(res, err, http.StatusOK)
}

// contentType is plain text for the runner's logs and records, whatever escapes they carry.
func contentType(filename string, content []byte) string {
	if strings.HasSuffix(filename, ".log") || strings.HasSuffix(filename, ".txt") {
		return "text/plain; charset=utf-8"
	}
	return remote.ContentType(filename, content)
}

// latestSeq is past every sequence number, so `before` it reads the latest page.
const latestSeq = 9007199254740991

func (r *conn) LastSeq(ctx context.Context) (int64, error) {
	res, err := r.c.ListActivityWithResponse(ctx, &client.ListActivityParams{Before: ptr(int64(latestSeq)), Limit: ptr(1)})
	if err := remote.Check(res, err, http.StatusOK); err != nil {
		return 0, err
	}
	return res.JSON200.LastSeq, nil
}

func (r *conn) Activity(ctx context.Context, after int64, each func(client.Activity)) (int64, error) {
	res, err := r.c.ClientInterface.StreamActivity(ctx, &client.StreamActivityParams{After: &after})
	if err != nil {
		return after, remote.Check(nil, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		return after, remote.ErrorFrom(res.StatusCode, b)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var data bytes.Buffer
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if data.Len() > 0 {
				var a client.Activity
				if err := json.Unmarshal(data.Bytes(), &a); err != nil {
					return after, fmt.Errorf("an Activity event that is not an Activity: %w", err)
				}
				each(a)
				after = max(after, a.Seq)
			}
			data.Reset()
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := sc.Err(); err != nil {
		return after, err
	}
	return after, io.ErrUnexpectedEOF
}

func (r *conn) CloseSession(ctx context.Context) error {
	res, err := r.c.CloseSessionWithResponse(ctx, r.Session(), &client.CloseSessionParams{})
	return remote.Check(res, err, http.StatusOK)
}

// refusedBy reports whether err is the record refusing with one of codes.
func refusedBy(err error, codes ...client.ErrorCode) bool {
	code := remote.CodeOf(err)
	for _, c := range codes {
		if code == c {
			return true
		}
	}
	return false
}

// stopped says whether err means the Install no longer accepts this agent: its token was revoked,
// its Session closed or its Member deactivated.
func stopped(err error) bool {
	return refusedBy(err, client.ErrorCodeUnauthenticated, client.ErrorCodeSessionRequired)
}

// answered reports whether the Install answered err (as opposed to the network failing).
func answered(err error) bool {
	var e *remote.Error
	return errors.As(err, &e) && e.Status != 0
}

// itoa is strconv.Itoa, for messages.
func itoa(n int) string { return strconv.Itoa(n) }
