package core

import (
	"context"
	"fmt"

	"github.com/tuongaz/darkory/internal/auth"
)

// EmailedLink is a login link issued to be emailed to its Member.
type EmailedLink struct {
	Organisation string // its name
	Member       Member
	Link         LoginLink
}

// EmailLoginLinks issues a one-time login link, with the expiry and single use of every login
// link, for each Member whose email is address, compared without regard to case. It returns none
// when no Member has the address; the caller answers the same either way (decisions.md).
//
// Finding the Members is an Install-level read: the address is how the Organisation is learned,
// as a credential's hash is.
func (s *Service) EmailLoginLinks(ctx context.Context, address string) ([]EmailedLink, error) {
	rows, err := s.store.Query(ctx, `SELECT m.org_id, m.id, o.name FROM members m JOIN organisations o ON o.id = m.org_id
WHERE m.email IS NOT NULL AND lower(m.email) = lower($1) ORDER BY m.created_at, m.id`, address)
	if err != nil {
		return nil, fmt.Errorf("core: find Members by email: %w", err)
	}
	type found struct{ org, member, orgName string }
	var members []found
	for rows.Next() {
		var f found
		if err := rows.Scan(&f.org, &f.member, &f.orgName); err != nil {
			rows.Close()
			return nil, err
		}
		members = append(members, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []EmailedLink
	for _, f := range members {
		c := &auth.Caller{OrgID: f.org, MemberID: f.member}
		res, err := s.write(ctx, c, Idem{}, func(t *tx) (any, error) {
			return issueLoginLink(t, f.member, nil)
		})
		if err != nil {
			return out, err
		}
		m, err := getMember(ctx, s.store, f.org, f.member)
		if err != nil {
			return out, err
		}
		out = append(out, EmailedLink{Organisation: f.orgName, Member: m, Link: res.(LoginLink)})
	}
	return out, nil
}
