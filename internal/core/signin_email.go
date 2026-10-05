package core

import (
	"context"
	"fmt"

	"github.com/tuongaz/darkory/internal/auth"
)

// EmailMember is a Member found by their email address, to email a login link to.
type EmailMember struct {
	OrgID, MemberID string
	Organisation    string // its name
}

// EmailedLink is a login link issued to be emailed to its Member.
type EmailedLink struct {
	Organisation string // its name
	Member       Member
	Link         LoginLink
}

// MembersByEmail finds every Member whose email is address, compared without regard to case. It
// finds none when no Member has the address; the caller answers the same either way
// (decisions.md).
//
// It is an Install-level read: the address is how the Organisation is learned, as a credential's
// hash is.
func (s *Service) MembersByEmail(ctx context.Context, address string) ([]EmailMember, error) {
	rows, err := s.store.Query(ctx, `SELECT m.org_id, m.id, o.name FROM members m JOIN organisations o ON o.id = m.org_id
WHERE m.email IS NOT NULL AND lower(m.email) = lower($1) ORDER BY m.created_at, m.id`, address)
	if err != nil {
		return nil, fmt.Errorf("core: find Members by email: %w", err)
	}
	defer rows.Close()
	var out []EmailMember
	for rows.Next() {
		var m EmailMember
		if err := rows.Scan(&m.OrgID, &m.MemberID, &m.Organisation); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// IssueEmailLink issues a one-time login link for m, with the expiry and single use of every
// login link, to be emailed.
func (s *Service) IssueEmailLink(ctx context.Context, m EmailMember) (EmailedLink, error) {
	c := &auth.Caller{OrgID: m.OrgID, MemberID: m.MemberID}
	res, err := s.write(ctx, c, Idem{}, func(t *tx) (any, error) {
		return issueLoginLink(t, m.MemberID, nil)
	})
	if err != nil {
		return EmailedLink{}, err
	}
	member, err := getMember(ctx, s.store, m.OrgID, m.MemberID)
	if err != nil {
		return EmailedLink{}, err
	}
	return EmailedLink{Organisation: m.Organisation, Member: member, Link: res.(LoginLink)}, nil
}
