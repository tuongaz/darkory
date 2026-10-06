package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

type taskRef struct {
	Task string `json:"task" jsonschema:"the Task's display key, such as WEB-42, or its id"`
}

type featureRef struct {
	Feature string `json:"feature" jsonschema:"the Feature's display key, such as WEB-1, or its id"`
}

type nextIn struct {
	WaitSeconds             *int   `json:"wait_seconds,omitempty" jsonschema:"how long to wait for a takeable Task, 0 to 60 seconds (default 30); 0 returns at once"`
	HeartbeatTimeoutSeconds *int   `json:"heartbeat_timeout_seconds,omitempty" jsonschema:"seconds without a Heartbeat before the Claim lapses; 0 for none; default the token's. This server sends the Heartbeats."`
	ModelLabel              string `json:"model_label,omitempty" jsonschema:"the AI model you run on, recorded on the Claim"`
}

type nextOut struct {
	Claimed bool               `json:"claimed" jsonschema:"whether a Task was claimed; false when the wait ended with nothing takeable"`
	Task    *client.TaskDetail `json:"task,omitempty" jsonschema:"the claimed Task"`
}

type limitIn struct {
	Limit int `json:"limit,omitempty" jsonschema:"at most this many (default 100)"`
}

type claimIn struct {
	Task                    string `json:"task" jsonschema:"the Task's display key, such as WEB-42, or its id"`
	HeartbeatTimeoutSeconds *int   `json:"heartbeat_timeout_seconds,omitempty" jsonschema:"seconds without a Heartbeat before the Claim lapses; 0 for none; default the token's. This server sends the Heartbeats."`
	ModelLabel              string `json:"model_label,omitempty" jsonschema:"the AI model you run on, recorded on the Claim"`
}

type noteIn struct {
	Task string `json:"task" jsonschema:"the Task's display key or id"`
	Note string `json:"note,omitempty" jsonschema:"a Note added to the Task in the same write"`
}

type handoverIn struct {
	Task   string `json:"task" jsonschema:"the Task's display key or id"`
	Skill  string `json:"skill" jsonschema:"the Skill the Task needs next, such as review"`
	Status string `json:"status,omitempty" jsonschema:"the Status to move the Task to, such as In review (workflow lists them); left out, it stays where it is"`
	Note   string `json:"note,omitempty" jsonschema:"a Note for whoever takes it next, added in the same write"`
}

type setStatusIn struct {
	Task   string `json:"task" jsonschema:"the Task's display key or id"`
	Status string `json:"status" jsonschema:"the Status's name or id, of kind backlog, todo or in_progress; workflow lists them"`
}

type addNoteIn struct {
	Task string `json:"task" jsonschema:"the Task's display key or id"`
	Body string `json:"body" jsonschema:"the Note: context for whoever works the Task next"`
}

type observeIn struct {
	Task    string `json:"task" jsonschema:"the Task's display key or id"`
	Outcome string `json:"outcome" jsonschema:"worked or didnt_work"`
	Body    string `json:"body" jsonschema:"what worked or didn't, for the Feature's Retrospective"`
}

type attachIn struct {
	Target      string `json:"target" jsonschema:"the Task or Feature to attach to, by display key or id; a Task is looked for first"`
	Path        string `json:"path" jsonschema:"the local file to attach, under the evidence root; a relative path is taken from it"`
	Filename    string `json:"filename,omitempty" jsonschema:"the name to show and download it as (default: the file's own)"`
	ContentType string `json:"content_type,omitempty" jsonschema:"the file's content type (default: from its extension, else its content)"`
	Feature     bool   `json:"feature,omitempty" jsonschema:"attach to the Feature without looking for a Task first"`
}

type fileTaskIn struct {
	Feature     string   `json:"feature,omitempty" jsonschema:"the Feature the Task belongs to; may be left out when blocks is given"`
	Title       string   `json:"title" jsonschema:"the Task's title"`
	Description string   `json:"description,omitempty" jsonschema:"the Task's description"`
	Skill       string   `json:"skill,omitempty" jsonschema:"the Skill the Task needs; give this or aimed_at"`
	AimedAt     string   `json:"aimed_at,omitempty" jsonschema:"the Member the Task is aimed at by name; give this or skill"`
	Blocks      string   `json:"blocks,omitempty" jsonschema:"a Task the new one blocks: a question or Escalation, filed on that Task's Feature"`
	Status      string   `json:"status,omitempty" jsonschema:"the Status it starts in, such as Backlog, where next does not offer it; default the first todo Status"`
	Workspaces  []string `json:"workspaces,omitempty" jsonschema:"the Workspaces the Task names, by name or id, where a session works it; default its Team's default Workspace"`
}

type blockIn struct {
	Task    string `json:"task" jsonschema:"the blocked Task's display key or id"`
	Blocker string `json:"blocker" jsonschema:"the blocking Task's display key or id"`
}

type done struct {
	OK bool `json:"ok"`
}

type listTasksIn struct {
	Feature string `json:"feature,omitempty" jsonschema:"only this Feature's Tasks"`
	Team    string `json:"team,omitempty" jsonschema:"only this Team's Tasks, by key such as WEB"`
	State   string `json:"state,omitempty" jsonschema:"only Tasks in this state: open, done or dropped"`
	Status  string `json:"status,omitempty" jsonschema:"only Tasks in this Status, by name or id"`
	Skill   string `json:"skill,omitempty" jsonschema:"only Tasks that need this Skill now"`
	AimedAt string `json:"aimed_at,omitempty" jsonschema:"only Tasks aimed at this Member"`
	Holder  string `json:"holder,omitempty" jsonschema:"only Tasks this Member holds"`
	Mine    bool   `json:"mine,omitempty" jsonschema:"only Tasks you hold"`
	Limit   int    `json:"limit,omitempty" jsonschema:"at most this many (default 100)"`
	Cursor  string `json:"cursor,omitempty" jsonschema:"the next_cursor of a previous page"`
}

// taskListOut is a page of Tasks with the Statuses their status_id names, so the list reads
// without a second call.
type taskListOut struct {
	Items      []client.Task   `json:"items"`
	NextCursor *string         `json:"next_cursor,omitempty" jsonschema:"pass as cursor for the next page; absent on the last"`
	Statuses   []client.Status `json:"statuses" jsonschema:"the Organisation's Statuses, in order"`
}

type observationsIn struct {
	Feature string `json:"feature" jsonschema:"the Feature's display key or id"`
	All     bool   `json:"all,omitempty" jsonschema:"every Observation, reviewed by a Retrospective or not; by default only those not yet reviewed"`
}

type proposalIn struct {
	Task     string `json:"task,omitempty" jsonschema:"the Task whose latest Skill proposal to read, by display key or id; give this or proposal"`
	Proposal string `json:"proposal,omitempty" jsonschema:"the proposal's id; give this or task"`
}

type proposeIn struct {
	Task           string `json:"task" jsonschema:"the Retrospective Task you hold"`
	Skill          string `json:"skill" jsonschema:"the company Skill"`
	BasedOnVersion int64  `json:"based_on_version" jsonschema:"the version the proposal is written against, which must be current"`
	Body           string `json:"body" jsonschema:"the proposed text of the Skill"`
}

type skillIn struct {
	Skill string `json:"skill" jsonschema:"the Skill's name or id"`
}

type empty struct{}

type activityIn struct {
	After  *int64 `json:"after,omitempty" jsonschema:"the entries after this sequence number, oldest first; pass the last_seq of the previous page. 0 reads from the start"`
	Before *int64 `json:"before,omitempty" jsonschema:"the entries just before this sequence number; pass the first_seq of a page to read the one before it"`
	Limit  int    `json:"limit,omitempty" jsonschema:"at most this many (default 100)"`
}

func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func check(res remote.Response, err error, ok ...int) error { return remote.Check(res, err, ok...) }

func (s *Server) addTools() {
	c := s.conn
	tool(s, "next", "Wait for a Task you can take and claim it: the first in Rank order across your Teams. "+
		"Holds the call for up to wait_seconds (default 30, at most 60); claimed is false when nothing became takeable. "+
		"This server keeps the Claim alive with Heartbeats while it runs.",
		func(ctx context.Context, in nextIn) (nextOut, error) {
			res, err := c.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{
				WaitSeconds: in.WaitSeconds, HeartbeatTimeoutSeconds: in.HeartbeatTimeoutSeconds, ModelLabel: opt(in.ModelLabel)})
			if err := check(res, err, http.StatusOK, http.StatusNoContent); err != nil {
				return nextOut{}, err
			}
			if res.StatusCode() == http.StatusNoContent {
				return nextOut{}, nil
			}
			s.keeper.Track(res.JSON200.Task)
			return nextOut{Claimed: true, Task: res.JSON200}, nil
		})
	tool(s, "takeable", "List the Tasks you can take now, in the order next would offer them.",
		func(ctx context.Context, in limitIn) (client.TaskList, error) {
			params := &client.ListTakeableTasksParams{}
			if in.Limit > 0 {
				params.Limit = &in.Limit
			}
			res, err := c.ListTakeableTasksWithResponse(ctx, params)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.TaskList{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "claim", "Claim a named Task. Refused with already_claimed when someone holds it (stop, do not retry) and not_takeable when it is not yours to take.",
		func(ctx context.Context, in claimIn) (client.TaskDetail, error) {
			res, err := c.ClaimTaskWithResponse(ctx, in.Task, &client.ClaimTaskParams{},
				client.ClaimTaskBody{HeartbeatTimeoutSeconds: in.HeartbeatTimeoutSeconds, ModelLabel: opt(in.ModelLabel)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.TaskDetail{}, err
			}
			s.keeper.Track(res.JSON200.Task)
			return *res.JSON200, nil
		})
	tool(s, "heartbeat", "Tell Darkory you are still working a Task. This server already does so for its Claims; the reply says ok, lapsed, taken_back or ended.",
		func(ctx context.Context, in taskRef) (client.HeartbeatReply, error) {
			res, err := c.HeartbeatWithResponse(ctx, in.Task, &client.HeartbeatParams{})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.HeartbeatReply{}, err
			}
			if res.JSON200.Status != client.HeartbeatStatusOk {
				s.keeper.Forget(in.Task)
			}
			return *res.JSON200, nil
		})
	tool(s, "release", "Give up your Claim on a Task; it goes back needing the same Skill. Add a Note saying why.",
		func(ctx context.Context, in noteIn) (client.Task, error) {
			res, err := c.ReleaseTaskWithResponse(ctx, in.Task, &client.ReleaseTaskParams{}, client.ReleaseTaskBody{Note: opt(in.Note)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			s.keeper.Forget(res.JSON200.ID)
			return *res.JSON200, nil
		})
	tool(s, "handover", "End your Claim and set the Skill the Task needs next, such as review. Hand over rather than skipping review. "+
		"Name a status, such as In review, to move the Task there.",
		func(ctx context.Context, in handoverIn) (client.Task, error) {
			res, err := c.HandoverTaskWithResponse(ctx, in.Task, &client.HandoverTaskParams{},
				client.HandoverTaskBody{Skill: in.Skill, Note: opt(in.Note), Status: opt(in.Status)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			s.keeper.Forget(res.JSON200.ID)
			return *res.JSON200, nil
		})
	tool(s, "complete", "Complete a Task you hold, when no further Skill is needed.",
		func(ctx context.Context, in noteIn) (client.Task, error) {
			res, err := c.CompleteTaskWithResponse(ctx, in.Task, &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: opt(in.Note)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			s.keeper.Forget(res.JSON200.ID)
			return *res.JSON200, nil
		})
	tool(s, "note", "Add a Note to a Task's running log, so context survives a Handover.",
		func(ctx context.Context, in addNoteIn) (client.Note, error) {
			res, err := c.AddNoteWithResponse(ctx, in.Task, &client.AddNoteParams{}, client.AddNoteBody{Body: in.Body})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.Note{}, err
			}
			return *res.JSON201, nil
		})
	tool(s, "observe", "Record an Observation on a Task: what worked or didn't. It feeds the Feature's Retrospective.",
		func(ctx context.Context, in observeIn) (client.Observation, error) {
			res, err := c.ObserveWithResponse(ctx, in.Task, &client.ObserveParams{},
				client.ObserveBody{Outcome: client.ObservationOutcome(in.Outcome), Body: in.Body})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.Observation{}, err
			}
			return *res.JSON201, nil
		}, enum("outcome", "worked", "didnt_work"))
	tool(s, "attach_evidence", "Attach a local file as Evidence (a report, log or screenshot) to a Task, or to a Feature. "+
		"Every Member of the Organisation can read what is attached. "+s.evidence.describe(),
		func(ctx context.Context, in attachIn) (client.Evidence, error) {
			real, content, err := s.evidence.read(in.Path)
			if err != nil {
				return client.Evidence{}, err
			}
			name := in.Filename
			if name == "" {
				name = filepath.Base(real)
			}
			ct := in.ContentType
			if ct == "" {
				ct = remote.ContentType(name, content)
			}
			ev, _, err := c.Attach(ctx, in.Target, name, ct, content, in.Feature)
			return ev, err
		})
	tool(s, "file_task", "File a Task needing a Skill or aimed at a Member. With blocks, file a question that blocks a Task instead of guessing: aim it up your Reporting line or at the Feature owner.",
		func(ctx context.Context, in fileTaskIn) (client.TaskDetail, error) {
			body := client.FileTaskBody{Feature: opt(in.Feature), Title: in.Title, Description: opt(in.Description), Skill: opt(in.Skill),
				AimedAt: opt(in.AimedAt), Blocks: opt(in.Blocks), Status: opt(in.Status)}
			if len(in.Workspaces) > 0 {
				body.Workspaces = &in.Workspaces
			}
			res, err := c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, body)
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.TaskDetail{}, err
			}
			return *res.JSON201, nil
		})
	tool(s, "block", "Let one Task block another: the blocked Task is not takeable until the blocker ends.",
		func(ctx context.Context, in blockIn) (done, error) {
			res, err := c.AddBlockerWithResponse(ctx, in.Task, in.Blocker, &client.AddBlockerParams{})
			if err := check(res, err, http.StatusNoContent); err != nil {
				return done{}, err
			}
			return done{OK: true}, nil
		})
	tool(s, "unblock", "Stop one Task blocking another.",
		func(ctx context.Context, in blockIn) (done, error) {
			res, err := c.RemoveBlockerWithResponse(ctx, in.Task, in.Blocker, &client.RemoveBlockerParams{})
			if err := check(res, err, http.StatusNoContent); err != nil {
				return done{}, err
			}
			return done{OK: true}, nil
		})
	tool(s, "show_task", "Read a Task with its Feature, Workspaces, Claims, Notes, Evidence, blockers and Observations.",
		func(ctx context.Context, in taskRef) (client.TaskDetail, error) {
			res, err := c.GetTaskWithResponse(ctx, in.Task)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.TaskDetail{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "list_tasks", "List Tasks by Feature Rank, filtered, with the Organisation's Statuses to read each Task's status_id by.",
		func(ctx context.Context, in listTasksIn) (taskListOut, error) {
			params := &client.ListTasksParams{Feature: opt(in.Feature), Team: opt(in.Team), Skill: opt(in.Skill),
				AimedAt: opt(in.AimedAt), Holder: opt(in.Holder), Status: opt(in.Status), Cursor: opt(in.Cursor)}
			if in.State != "" {
				st := client.TaskState(in.State)
				params.State = &st
			}
			if in.Limit > 0 {
				params.Limit = &in.Limit
			}
			if in.Mine {
				me, err := c.GetMeWithResponse(ctx)
				if err := check(me, err, http.StatusOK); err != nil {
					return taskListOut{}, err
				}
				params.Holder = &me.JSON200.Member.ID
			}
			res, err := c.ListTasksWithResponse(ctx, params)
			if err := check(res, err, http.StatusOK); err != nil {
				return taskListOut{}, err
			}
			ss, err := c.ListStatusesWithResponse(ctx)
			if err := check(ss, err, http.StatusOK); err != nil {
				return taskListOut{}, err
			}
			return taskListOut{Items: res.JSON200.Items, NextCursor: res.JSON200.NextCursor, Statuses: ss.JSON200.Items}, nil
		}, enum("state", "open", "done", "dropped"))
	tool(s, "set_status", "Move a Task to another Status of kind backlog, todo or in_progress: one you hold, or one of your Team's or Feature's. "+
		"A Task reaches done and dropped Statuses only by complete and drop; naming one is refused with use_complete or use_drop.",
		func(ctx context.Context, in setStatusIn) (client.Task, error) {
			res, err := c.SetTaskStatusWithResponse(ctx, in.Task, &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: in.Status})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "workflow", "List the Organisation's Statuses in order, with their kinds: backlog (never offered by next), todo, in_progress, done and dropped.",
		func(ctx context.Context, _ empty) (client.StatusList, error) {
			res, err := c.ListStatusesWithResponse(ctx)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.StatusList{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "feature_show", "Read a Feature with its Tasks and Evidence.",
		func(ctx context.Context, in featureRef) (client.FeatureDetail, error) {
			res, err := c.GetFeatureWithResponse(ctx, in.Feature)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.FeatureDetail{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "observations", "List the Observations recorded on a Feature's Tasks, oldest first: what a Retrospective reads.",
		func(ctx context.Context, in observationsIn) (client.ObservationList, error) {
			params := &client.ListFeatureObservationsParams{}
			if in.All {
				// The contract's reviewed=true means every Observation.
				all := true
				params.Reviewed = &all
			}
			res, err := c.ListFeatureObservationsWithResponse(ctx, in.Feature, params)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.ObservationList{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "skill_show", "Read a Skill and its current version's text: how this company does that work.",
		func(ctx context.Context, in skillIn) (client.SkillDetail, error) {
			res, err := c.GetSkillWithResponse(ctx, in.Skill)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.SkillDetail{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "propose_skill_version", "From a Retrospective Task you hold, propose a new version of a company Skill, written against its current version; then hand the Task over to skill-review.",
		func(ctx context.Context, in proposeIn) (client.SkillProposal, error) {
			res, err := c.ProposeSkillVersionWithResponse(ctx, in.Task, &client.ProposeSkillVersionParams{},
				client.ProposeSkillVersionBody{Skill: in.Skill, BasedOnVersion: in.BasedOnVersion, Body: in.Body})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.SkillProposal{}, err
			}
			return *res.JSON201, nil
		})
	tool(s, "show_proposal", "Read a proposed Skill version: the latest one written on a Task (as a skill-review holder reads the proposal it reviews), or one by id.",
		func(ctx context.Context, in proposalIn) (client.SkillProposal, error) {
			if (in.Task == "") == (in.Proposal == "") {
				return client.SkillProposal{}, errors.New("give task or proposal")
			}
			if in.Proposal != "" {
				res, err := c.GetSkillProposalWithResponse(ctx, in.Proposal)
				if err := check(res, err, http.StatusOK); err != nil {
					return client.SkillProposal{}, err
				}
				return *res.JSON200, nil
			}
			res, err := c.GetTaskWithResponse(ctx, in.Task)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.SkillProposal{}, err
			}
			if res.JSON200.Proposal == nil {
				return client.SkillProposal{}, fmt.Errorf("no Skill proposal has been written on %s", res.JSON200.Task.Key)
			}
			return *res.JSON200.Proposal, nil
		})
	tool(s, "me", "Who you are: your Member, Organisation, Teams, Skills and this Session.",
		func(ctx context.Context, _ empty) (client.Me, error) {
			res, err := c.GetMeWithResponse(ctx)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Me{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "activity", "Read Activity, the trail of every change: the latest page by default, or after or before a sequence number.",
		func(ctx context.Context, in activityIn) (client.ActivityPage, error) {
			if in.After != nil && in.Before != nil {
				return client.ActivityPage{}, errors.New("give after or before, not both")
			}
			params := &client.ListActivityParams{After: in.After, Before: in.Before}
			if in.After == nil && in.Before == nil {
				latest := int64(9007199254740991)
				params.Before = &latest
			}
			if in.Limit > 0 {
				params.Limit = &in.Limit
			}
			res, err := c.ListActivityWithResponse(ctx, params)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.ActivityPage{}, err
			}
			return *res.JSON200, nil
		})
}
