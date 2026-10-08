package core

import (
	"context"
	"strings"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// The learning loop (ADR 0010): Observations recorded while working feed the Retrospective of
// their Task's Parent, which may propose a new version of a company Skill; a Member with
// skill-review, other than the author, publishes it by advancing the Retrospective from the Step
// carrying skill-review into Done while its base is still current.

// ProposeSkillVersion writes a proposed new version of a company Skill on a Retrospective the
// caller holds (ADR 0010), against basedOn, which must be the Skill's current version; refused
// no_step unless a Connector leads from the Retrospective's Step to a Step carrying skill-review,
// along which the caller then advances it. A Task carries one pending proposal per Skill: a new
// one for the same Skill supersedes it.
func (s *Service) ProposeSkillVersion(ctx context.Context, c *auth.Caller, taskRef, skillRef string, basedOn int64, body string, idem Idem) (SkillProposal, error) {
	if strings.TrimSpace(body) == "" {
		return SkillProposal{}, refuse(CodeInvalid, "a proposal has a body: the Skill's new text")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		taskID, err := resolveTask(ctx, t, c.OrgID, taskRef)
		if err != nil {
			return nil, err
		}
		task, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		if err := holds(c, task); err != nil {
			return nil, err
		}
		if task.Kind != "retrospective" {
			return nil, refuse(CodeForbidden, "only a Retrospective proposes a Skill version, and %s is a %s Task", task.Key, task.Kind)
		}
		var reviewed int
		if task.StepID != nil {
			if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM connectors k JOIN steps st ON st.id = k.to_step_id JOIN skills sk ON sk.id = st.skill_id
WHERE k.org_id = $1 AND k.from_step_id = $2 AND sk.builtin = TRUE AND sk.name = $3`, c.OrgID, *task.StepID, SkillSkillReview).Scan(&reviewed); err != nil {
				return nil, err
			}
		}
		if reviewed == 0 {
			return nil, refuse(CodeNoStep, "no Connector leads from %s's Step to a Step carrying skill-review, where a proposal is reviewed", task.Key)
		}
		skillID, err := resolveSkill(ctx, t, c.OrgID, skillRef)
		if err != nil {
			return nil, err
		}
		sk, err := getSkill(ctx, t, c.OrgID, skillID)
		if err != nil {
			return nil, err
		}
		if sk.Kind != "company" {
			return nil, refuse(CodeInvalid, "only a company Skill takes proposals, and %s is generic", sk.Name)
		}
		if basedOn != sk.CurrentVersion {
			return nil, refuse(CodeProposalStale, "%s is at version %d; write the proposal against it, not version %d", sk.Name, sk.CurrentVersion, basedOn)
		}
		if _, err := t.Exec(ctx, `UPDATE skill_proposals SET state = 'superseded', decided_at = $1
WHERE org_id = $2 AND task_id = $3 AND skill_id = $4 AND state = 'pending'`, ms(t.now), c.OrgID, taskID, skillID); err != nil {
			return nil, err
		}
		id := newID()
		if _, err := t.Exec(ctx, `INSERT INTO skill_proposals (id, org_id, skill_id, task_id, based_on_version, body, author_id, state, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`, id, c.OrgID, skillID, taskID, basedOn, body, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.skill_proposed", taskID, map[string]any{"proposal_id": id, "skill_id": skillID, "based_on_version": basedOn}); err != nil {
			return nil, err
		}
		return getProposal(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return SkillProposal{}, err
	}
	return res.(SkillProposal), nil
}

// GetSkillProposal returns a proposed Skill version.
func (s *Service) GetSkillProposal(ctx context.Context, c *auth.Caller, id string) (SkillProposal, error) {
	return getProposal(ctx, s.store, c.OrgID, id)
}

// pendingReview returns the proposals completing pre would publish: pre is at a Step carrying
// skill-review, and they are the pending proposals it carries, one per Skill, oldest first. It
// refuses, before anything is written, a caller who wrote one of them, and proposal_stale when
// the base of any is no longer its Skill's current version, naming those in Details.
func (s *Service) pendingReview(ctx context.Context, c *auth.Caller, pre Task) ([]SkillProposal, error) {
	if pre.SkillID == nil {
		return nil, nil
	}
	review, err := skillByName(ctx, s.store, c.OrgID, SkillSkillReview)
	if err != nil {
		return nil, err
	}
	if *pre.SkillID != review {
		return nil, nil
	}
	ps, err := collect(ctx, s.store, scanProposal, `SELECT `+proposalCols+` FROM skill_proposals p
WHERE p.org_id = $1 AND p.task_id = $2 AND p.state = 'pending' ORDER BY p.created_at, p.id`, c.OrgID, pre.ID)
	if err != nil {
		return nil, err
	}
	var stale []string
	var why []string
	for _, p := range ps {
		err := s.whyNotPublished(ctx, c, p)
		if codeOf(err) == CodeProposalStale {
			stale, why = append(stale, p.ID), append(why, err.(*Error).Message)
			continue
		}
		if err != nil {
			return nil, err
		}
	}
	if len(stale) > 0 {
		return nil, refuse(CodeProposalStale, "%s; the Retrospective rewrites them against the current versions, and nothing is published until every proposal on it is current",
			strings.Join(why, "; ")).with("proposals", stale)
	}
	return ps, nil
}

// whyNotPublished says why the caller cannot publish p now: they wrote it (no one judges their
// own work), or the version it was written against is no longer current (decisions.md).
func (s *Service) whyNotPublished(ctx context.Context, c *auth.Caller, p SkillProposal) error {
	now, err := getProposal(ctx, s.store, c.OrgID, p.ID)
	if err != nil {
		return err
	}
	if now.State != "pending" {
		return refuse(CodeConflict, "the proposal is %s; read the Task again", now.State)
	}
	if now.AuthorID == c.MemberID {
		return refuse(CodeForbidden, "you wrote this proposal; another Member with skill-review publishes it")
	}
	sk, err := getSkill(ctx, s.store, c.OrgID, now.SkillID)
	if err != nil {
		return err
	}
	if sk.CurrentVersion != now.BasedOnVersion {
		return refuse(CodeProposalStale, "the proposal for %s was written against version %d, and %s is now at version %d",
			sk.Name, now.BasedOnVersion, sk.Name, sk.CurrentVersion)
	}
	return nil
}

// supersedeSQL ends a pending proposal that will not be published, in a batch.
const supersedeSQL = `UPDATE skill_proposals SET state = 'superseded', decided_at = @now`

// publishStmts publish p as the next version of its Skill inside a completing batch. The guard
// holds while p is still pending, its author is not the caller, and the version it was written
// against is still current, so two proposals on one base never both publish.
func publishStmts(p SkillProposal, args map[string]any) []store.Stmt {
	a := with(args, map[string]any{"proposal": p.ID, "skill": p.SkillID, "based": p.BasedOnVersion, "version": p.BasedOnVersion + 1})
	return []store.Stmt{
		withGuard(store.S(`SELECT 1 / COUNT(*) FROM skill_proposals p JOIN skills sk ON sk.id = p.skill_id
WHERE p.org_id = @org AND p.id = @proposal AND p.task_id = @task AND p.state = 'pending' AND p.author_id <> @member
AND sk.org_id = @org AND sk.current_version = @based`, a)),
		store.S(`UPDATE skills SET current_version = @version WHERE org_id = @org AND id = @skill`, a),
		store.S(`INSERT INTO skill_versions (org_id, skill_id, version, body, proposal_id, published_by, published_at)
SELECT @org, p.skill_id, CAST(@version AS BIGINT), p.body, p.id, CAST(@member AS TEXT), CAST(@now AS BIGINT)
FROM skill_proposals p WHERE p.org_id = @org AND p.id = @proposal`, a),
		store.S(`UPDATE skill_proposals SET state = 'published', published_version = @version, decided_at = @now
WHERE org_id = @org AND id = @proposal`, a),
	}
}

// ListParentObservations lists the Observations recorded on a Parent's Subtasks, oldest first:
// only those no Retrospective has reviewed yet, unless all asks for every one.
func (s *Service) ListParentObservations(ctx context.Context, c *auth.Caller, ref string, all bool) ([]Observation, error) {
	id, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return nil, err
	}
	q := `SELECT ` + observationCols + ` FROM observations o WHERE o.org_id = $1
AND o.task_id IN (SELECT ot.id FROM tasks ot WHERE ot.org_id = $1 AND (ot.parent_id = $2 OR ot.id = $2))`
	if !all {
		q += ` AND o.reviewed_by_task_id IS NULL`
	}
	return collect(ctx, s.store, scanObservation, q+` ORDER BY o.created_at, o.id`, c.OrgID, id)
}
