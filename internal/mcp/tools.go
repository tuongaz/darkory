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

type advanceIn struct {
	Task    string `json:"task" jsonschema:"the Task's display key or id"`
	Outcome string `json:"outcome,omitempty" jsonschema:"the outcome to advance along, one of those show_task lists under connectors, such as pass or needs changes; may be left out when the Step has only one"`
	Note    string `json:"note,omitempty" jsonschema:"a Note for whoever takes it next, added in the same write"`
}

type moveIn struct {
	Task string `json:"task" jsonschema:"the Task's display key or id"`
	Step string `json:"step" jsonschema:"the Step of its Project's Workflow to move it to, by name or id; workflow lists them"`
	Note string `json:"note,omitempty" jsonschema:"why it moves, added as a Note before the move"`
}

type labelsIn struct {
	Task   string   `json:"task" jsonschema:"the Task's display key or id"`
	Labels []string `json:"labels" jsonschema:"every Label the Task is to carry, by name or id: its Project's or the Organisation's; empty for none"`
}

type projectRef struct {
	Project string `json:"project" jsonschema:"the Project's key, such as WEB, or its id"`
}

type addNoteIn struct {
	Task string `json:"task" jsonschema:"the Task's display key or id"`
	Body string `json:"body" jsonschema:"the Note: context for whoever works the Task next"`
}

type observeIn struct {
	Task    string `json:"task" jsonschema:"the Task's display key or id"`
	Outcome string `json:"outcome" jsonschema:"worked or didnt_work"`
	Body    string `json:"body" jsonschema:"what worked or didn't, for the Retrospective of the Task's Parent"`
}

type attachIn struct {
	Target      string `json:"target" jsonschema:"the Task to attach to, by display key or id; a Parent's Evidence is about the whole"`
	Path        string `json:"path" jsonschema:"the local file to attach, under the evidence root; a relative path is taken from it"`
	Filename    string `json:"filename,omitempty" jsonschema:"the name to show and download it as (default: the file's own)"`
	ContentType string `json:"content_type,omitempty" jsonschema:"the file's content type (default: from its extension, else its content)"`
}

type fileTaskIn struct {
	Project      string   `json:"project,omitempty" jsonschema:"the Project the Task belongs to, by key such as WEB; may be left out with parent or blocks"`
	Parent       string   `json:"parent,omitempty" jsonschema:"the Task the new one is a Subtask of; filing one under the Task you hold ends your Claim (a split)"`
	Title        string   `json:"title" jsonschema:"the Task's title"`
	Description  string   `json:"description,omitempty" jsonschema:"the Task's description"`
	Step         string   `json:"step,omitempty" jsonschema:"the Step it starts at, by name or id, such as Backlog; default the Project's first work Step"`
	Aim          string   `json:"aim,omitempty" jsonschema:"the Member the Task is aimed at by name, who takes it whatever its Step"`
	Blocks       string   `json:"blocks,omitempty" jsonschema:"a Task the new one blocks: a question or Escalation, filed beside that Task under its Parent"`
	Breakdown    bool     `json:"breakdown,omitempty" jsonschema:"file it with Break down: a Breakdown Subtask at the Step carrying breakdown files its other Subtasks"`
	Labels       []string `json:"labels,omitempty" jsonschema:"the Labels it carries, by name or id"`
	BlockedBy    []string `json:"blocked_by,omitempty" jsonschema:"Tasks that block the new one from its first moment, so nobody can take it before they end"`
	Owner        string   `json:"owner,omitempty" jsonschema:"its Owner (default you; a Subtask's is its Parent's)"`
	AutoComplete *bool    `json:"auto_complete,omitempty" jsonschema:"it completes itself when its last Subtask ends Done; default the Project's"`
	Acceptance   *bool    `json:"acceptance,omitempty" jsonschema:"it has an Acceptance before it is done; default the Project's"`
	Workspaces   []string `json:"workspaces,omitempty" jsonschema:"the Workspaces the Task names, by name or id, where a session works it; default its Parent's, else its Project's"`
	Note         string   `json:"note,omitempty" jsonschema:"with parent, when filing ends your Claim on the Parent: a Note for whoever works its Subtasks"`
}

type blockIn struct {
	Task    string `json:"task" jsonschema:"the blocked Task's display key or id"`
	Blocker string `json:"blocker" jsonschema:"the blocking Task's display key or id"`
}

type done struct {
	OK bool `json:"ok"`
}

type listTasksIn struct {
	Project string   `json:"project,omitempty" jsonschema:"only this Project's Tasks, by key such as WEB"`
	Parent  string   `json:"parent,omitempty" jsonschema:"only this Parent's Subtasks"`
	State   string   `json:"state,omitempty" jsonschema:"only Tasks in this state: open, done or dropped"`
	Step    string   `json:"step,omitempty" jsonschema:"only Tasks at this Step: its id, or its name with project"`
	AimedAt string   `json:"aimed_at,omitempty" jsonschema:"only Tasks aimed at this Member"`
	Holder  string   `json:"holder,omitempty" jsonschema:"only Tasks this Member holds"`
	Mine    bool     `json:"mine,omitempty" jsonschema:"only Tasks you hold"`
	Filter  []string `json:"filter,omitempty" jsonschema:"only Tasks matching every one of these field:op:values tokens, such as holder:is:none, skill:is:<id>, top:is:true or filed_at:last:7d; references are ids, each value percent-encoded"`
	Limit   int      `json:"limit,omitempty" jsonschema:"at most this many (default 100)"`
	Cursor  string   `json:"cursor,omitempty" jsonschema:"the next_cursor of a previous page"`
}

// stepOut is a Step of a listed Task's Workflow, with the outcomes out of it.
type stepOut struct {
	ID        string   `json:"id"`
	ProjectID string   `json:"project_id"`
	Name      string   `json:"name"`
	SkillID   *string  `json:"skill_id,omitempty" jsonschema:"the Skill that takes a Task at it; absent on a hold"`
	Outcomes  []string `json:"outcomes" jsonschema:"the outcomes a holder advances along, in order"`
}

// taskListOut is a page of Tasks with the Steps their step_id names and the Parents their
// parent_id names, so the list reads without a second call.
type taskListOut struct {
	Items      []client.Task      `json:"items"`
	NextCursor *string            `json:"next_cursor,omitempty" jsonschema:"pass as cursor for the next page; absent on the last"`
	Steps      []stepOut          `json:"steps" jsonschema:"the Steps of the listed Tasks' Workflows, by Project, in order"`
	Parents    []client.TaskBrief `json:"parents" jsonschema:"the Parents of the listed Subtasks"`
}

type observationsIn struct {
	Task string `json:"task" jsonschema:"the Task's display key or id; for a Parent, its Subtasks' Observations too"`
	All  bool   `json:"all,omitempty" jsonschema:"every Observation, reviewed by a Retrospective or not; by default only those not yet reviewed"`
}

type proposalIn struct {
	Task     string `json:"task,omitempty" jsonschema:"the Task whose Skill proposals to read, the latest for each Skill, by display key or id; give this or proposal"`
	Proposal string `json:"proposal,omitempty" jsonschema:"the proposal's id; give this or task"`
}

type proposeIn struct {
	Task           string `json:"task" jsonschema:"the Retrospective Task you hold"`
	Skill          string `json:"skill" jsonschema:"the company Skill"`
	BasedOnVersion int64  `json:"based_on_version" jsonschema:"the version the proposal is written against, which must be current"`
	Body           string `json:"body" jsonschema:"the proposed text of the Skill"`
}

type proposalsOut struct {
	Proposals []client.SkillProposal `json:"proposals" jsonschema:"the proposals, oldest first"`
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
	tool(s, "next", "Wait for a Task you can take and claim it: the first in Rank order across your Projects. "+
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
	tool(s, "release", "Give up your Claim on a Task; it stays at its Step for the next Member with the Skill. Add a Note saying why.",
		func(ctx context.Context, in noteIn) (client.Task, error) {
			res, err := c.ReleaseTaskWithResponse(ctx, in.Task, &client.ReleaseTaskParams{}, client.ReleaseTaskBody{Note: opt(in.Note)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			s.keeper.Forget(res.JSON200.ID)
			return *res.JSON200, nil
		})
	tool(s, "advance", "End your work on a Task you hold along one of its Step's outcomes (show_task lists them under connectors): "+
		"it goes to the next Step for whoever has that Step's Skill, or into Done. Advance rather than skipping review. "+
		"Refused with no_connector, the outcomes in details, when the Step has no such outcome.",
		func(ctx context.Context, in advanceIn) (client.Task, error) {
			res, err := c.AdvanceTaskWithResponse(ctx, in.Task, &client.AdvanceTaskParams{},
				client.AdvanceTaskBody{Outcome: opt(in.Outcome), Note: opt(in.Note)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			s.keeper.Forget(res.JSON200.ID)
			return *res.JSON200, nil
		})
	tool(s, "move_step", "Move a Task to another Step of its Workflow by hand: out of a hold such as Backlog, or anywhere a person decides. "+
		"A Task someone holds moves only for its Owner or someone above the holder, and their Claim ends.",
		func(ctx context.Context, in moveIn) (client.Task, error) {
			res, err := c.MoveTaskWithResponse(ctx, in.Task, &client.MoveTaskParams{}, client.MoveTaskBody{Step: in.Step, Note: opt(in.Note)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			if res.JSON200.Claim == nil {
				s.keeper.Forget(res.JSON200.ID)
			}
			return *res.JSON200, nil
		})
	tool(s, "complete", "Complete a Task you hold whose Step has one way into Done, or a Parent you own once its Subtasks have ended. "+
		"Refused with use_advance, the outcomes in details, where the Step has other ways out: advance instead.",
		func(ctx context.Context, in noteIn) (client.Task, error) {
			res, err := c.CompleteTaskWithResponse(ctx, in.Task, &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: opt(in.Note)})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			s.keeper.Forget(res.JSON200.ID)
			return *res.JSON200, nil
		})
	tool(s, "note", "Add a Note to a Task's running log, so context survives its next Step.",
		func(ctx context.Context, in addNoteIn) (client.Note, error) {
			res, err := c.AddNoteWithResponse(ctx, in.Task, &client.AddNoteParams{}, client.AddNoteBody{Body: in.Body})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.Note{}, err
			}
			return *res.JSON201, nil
		})
	tool(s, "observe", "Record an Observation on a Task: what worked or didn't. It feeds the Retrospective of the Task's Parent.",
		func(ctx context.Context, in observeIn) (client.Observation, error) {
			res, err := c.ObserveWithResponse(ctx, in.Task, &client.ObserveParams{},
				client.ObserveBody{Outcome: client.ObservationOutcome(in.Outcome), Body: in.Body})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.Observation{}, err
			}
			return *res.JSON201, nil
		}, enum("outcome", "worked", "didnt_work"))
	tool(s, "attach_evidence", "Attach a local file as Evidence (a report, log or screenshot) to a Task. "+
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
			ev, _, err := c.Attach(ctx, in.Target, name, ct, content)
			return ev, err
		})
	tool(s, "file_task", "File a Task in a Project; with parent, a Subtask of that Task (filing one under the Task you hold splits it, ending your Claim); "+
		"with blocks, a question that blocks a Task instead of guessing: aim it up your Reporting line or at the Task's Owner.",
		func(ctx context.Context, in fileTaskIn) (client.TaskDetail, error) {
			body := client.FileTaskBody{Project: opt(in.Project), Parent: opt(in.Parent), Title: in.Title, Description: opt(in.Description),
				Step: opt(in.Step), Aim: opt(in.Aim), Blocks: opt(in.Blocks), Owner: opt(in.Owner), AutoComplete: in.AutoComplete,
				Acceptance: in.Acceptance, Note: opt(in.Note)}
			if in.Breakdown {
				body.Breakdown = &in.Breakdown
			}
			if len(in.BlockedBy) > 0 {
				body.BlockedBy = &in.BlockedBy
			}
			if len(in.Labels) > 0 {
				body.Labels = &in.Labels
			}
			if len(in.Workspaces) > 0 {
				body.Workspaces = &in.Workspaces
			}
			res, err := c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, body)
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.TaskDetail{}, err
			}
			if in.Parent != "" {
				// Filing under a Task the caller held ended that Claim.
				if p, err := c.GetTaskWithResponse(ctx, in.Parent); check(p, err, http.StatusOK) == nil && p.JSON200.Task.Claim == nil {
					s.keeper.Forget(p.JSON200.Task.ID)
				}
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
	tool(s, "show_task", "Read a Task with its Parent, its Subtasks, the Step it is at and the outcomes out of it (connectors: advance along one by name), "+
		"its Labels, Workspaces, Claims, Notes, Evidence, blockers, Observations and Skill proposals.",
		func(ctx context.Context, in taskRef) (client.TaskDetail, error) {
			res, err := c.GetTaskWithResponse(ctx, in.Task)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.TaskDetail{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "list_tasks", "List Tasks by Project and Rank, filtered, with the Steps their step_id names (each with its outcomes) and the Parents their parent_id names.",
		func(ctx context.Context, in listTasksIn) (taskListOut, error) {
			params := &client.ListTasksParams{Project: opt(in.Project), Parent: opt(in.Parent), Step: opt(in.Step),
				AimedAt: opt(in.AimedAt), Holder: opt(in.Holder), Cursor: opt(in.Cursor)}
			if len(in.Filter) > 0 {
				params.Filter = &in.Filter
			}
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
			out := taskListOut{Items: res.JSON200.Items, NextCursor: res.JSON200.NextCursor, Steps: []stepOut{}, Parents: []client.TaskBrief{}}
			projects, parents := map[string]bool{}, map[string]bool{}
			for _, t := range out.Items {
				if !projects[t.ProjectID] {
					projects[t.ProjectID] = true
					wf, err := c.GetWorkflowWithResponse(ctx, t.ProjectID)
					if err := check(wf, err, http.StatusOK); err != nil {
						return taskListOut{}, err
					}
					out.Steps = append(out.Steps, stepsOf(*wf.JSON200)...)
				}
				if t.ParentID != nil && !parents[*t.ParentID] {
					parents[*t.ParentID] = true
					p, err := c.GetTaskWithResponse(ctx, *t.ParentID)
					if err := check(p, err, http.StatusOK); err != nil {
						return taskListOut{}, err
					}
					out.Parents = append(out.Parents, client.TaskBrief{ID: p.JSON200.Task.ID, Key: p.JSON200.Task.Key, Title: p.JSON200.Task.Title})
				}
			}
			return out, nil
		}, enum("state", "open", "done", "dropped"))
	tool(s, "workflow", "Read a Project's Workflow: its Steps in order, the Skill each carries (none on a hold), the Connectors out of each "+
		"(the outcomes; to_step_id absent means into Done), and what is at each Step now.",
		func(ctx context.Context, in projectRef) (client.Workflows, error) {
			res, err := c.GetWorkflowWithResponse(ctx, in.Project)
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Workflows{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "set_labels", "Set the Labels a Task carries, replacing its others: its Project's or the Organisation's, by name or id.",
		func(ctx context.Context, in labelsIn) (client.Task, error) {
			labels := in.Labels
			if labels == nil {
				labels = []string{}
			}
			res, err := c.SetTaskLabelsWithResponse(ctx, in.Task, &client.SetTaskLabelsParams{}, client.SetTaskLabelsBody{Labels: labels})
			if err := check(res, err, http.StatusOK); err != nil {
				return client.Task{}, err
			}
			return *res.JSON200, nil
		})
	tool(s, "observations", "List the Observations recorded on a Task and, for a Parent, on its Subtasks, oldest first: what a Retrospective reads.",
		func(ctx context.Context, in observationsIn) (client.ObservationList, error) {
			params := &client.ListTaskObservationsParams{}
			if in.All {
				// The contract's reviewed=true means every Observation.
				all := true
				params.Reviewed = &all
			}
			res, err := c.ListTaskObservationsWithResponse(ctx, in.Task, params)
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
	tool(s, "propose_skill_version", "From a Retrospective Task you hold, propose a new version of a company Skill, written against its current version "+
		"(one pending proposal per Skill; another for the same Skill replaces it); then advance the Task to the Step carrying skill-review.",
		func(ctx context.Context, in proposeIn) (client.SkillProposal, error) {
			res, err := c.ProposeSkillVersionWithResponse(ctx, in.Task, &client.ProposeSkillVersionParams{},
				client.ProposeSkillVersionBody{Skill: in.Skill, BasedOnVersion: in.BasedOnVersion, Body: in.Body})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.SkillProposal{}, err
			}
			return *res.JSON201, nil
		})
	tool(s, "show_proposal", "Read proposed Skill versions: those written on a Task, the latest for each Skill (as a skill-review holder reads what it reviews), or one by id.",
		func(ctx context.Context, in proposalIn) (proposalsOut, error) {
			if (in.Task == "") == (in.Proposal == "") {
				return proposalsOut{}, errors.New("give task or proposal")
			}
			if in.Proposal != "" {
				res, err := c.GetSkillProposalWithResponse(ctx, in.Proposal)
				if err := check(res, err, http.StatusOK); err != nil {
					return proposalsOut{}, err
				}
				return proposalsOut{Proposals: []client.SkillProposal{*res.JSON200}}, nil
			}
			res, err := c.GetTaskWithResponse(ctx, in.Task)
			if err := check(res, err, http.StatusOK); err != nil {
				return proposalsOut{}, err
			}
			if len(res.JSON200.Proposals) == 0 {
				return proposalsOut{}, fmt.Errorf("no Skill proposal has been written on %s", res.JSON200.Task.Key)
			}
			return proposalsOut{Proposals: res.JSON200.Proposals}, nil
		})
	tool(s, "me", "Who you are: your Member, Organisation, Projects, Skills and this Session.",
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

// stepsOf lists a Workflow's Steps with the outcomes out of each.
func stepsOf(wf client.Workflows) []stepOut {
	var out []stepOut
	for _, st := range wf.Steps {
		so := stepOut{ID: st.ID, ProjectID: wf.ProjectID, Name: st.Name, SkillID: st.SkillID, Outcomes: []string{}}
		for _, k := range wf.Connectors {
			if k.FromStepID == st.ID {
				so.Outcomes = append(so.Outcomes, k.Name)
			}
		}
		out = append(out, so)
	}
	return out
}
