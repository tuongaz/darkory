package cli

import (
	"fmt"
	"io"
	"net/http"
	"os"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/tuongaz/darkory/client"
)

var adminCommands = []command{
	{path: "health", short: "check that the Install is up, and its version (needs no token)", run: cmdHealth},
	{path: "me", short: "show who you are: your Member, Projects, Skills and Session", run: cmdMe},
	{path: "member create", args: "<name> --kind human|agent [--email e] [--admin]", short: "create a Member (admin)", run: cmdMemberCreate},
	{path: "member list", args: "[--project p] [--kind k]", short: "list Members", run: cmdMemberList},
	{path: "member show", args: "<member>", short: "show a Member with their Projects, Skills and reports", run: cmdMemberShow},
	{path: "member update", args: "<member> [--name n] [--email e] [--admin=true|false] [--avatar file-id | --no-avatar]", short: "change a Member (admin), or your own avatar", run: cmdMemberUpdate},
	{path: "member deactivate", args: "<member>", short: "revoke a Member's tokens, close their Sessions, end their Claims, refuse them from now on (admin)", run: cmdMemberDeactivate},
	{path: "member reactivate", args: "<member>", short: "let a deactivated Member sign in and be issued tokens again (admin)", run: cmdMemberReactivate},
	{path: "skill create", args: "<name> --kind generic|own [--base skill] [--project p] (--file path|- | --body text)", short: "create a Skill, publishing version 1 (admin)", run: cmdSkillCreate},
	{path: "skill set", args: `<skill> --project p|""`, short: "set the Project an own Skill belongs to; \"\" makes it the Organisation's (admin)", run: cmdSkillSet},
	{path: "skill list", args: "[--kind k]", short: "list Skills", run: cmdSkillList},
	{path: "skill show", args: "<skill>", short: "show a Skill and its current version's text", run: cmdSkillShow},
	{path: "skill versions", args: "<skill>", short: "list a Skill's published versions", run: cmdSkillVersions},
	{path: "grant", args: "<member> <skill>", short: "grant a Skill to a Member (admin)", run: cmdGrant},
	{path: "ungrant", args: "<member> <skill>", short: "take a Skill away from a Member (admin)", run: cmdUngrant},
	{path: "report-to", args: "<member> <manager> | <member> --none", short: "set or clear a Member's Reporting line (admin)", run: cmdReportTo},
	{path: "token issue", args: "<member> --name n [--timeout d]", short: "issue a token; its secret is shown once (admin)", run: cmdTokenIssue},
	{path: "token list", args: "[member]", short: "list a Member's tokens (default yours)", run: cmdTokenList},
	{path: "token revoke", args: "<token id>", short: "revoke a token, ending its Sessions' Claims", run: cmdTokenRevoke},
	{path: "login", args: "<member> | --email address", short: "issue a one-time login link for a Member (admin), or ask for one by email", run: cmdLogin},
	{path: "logout", short: "close this Session, ending the Claims bound to it", run: cmdLogout},
	{path: "session close", args: "[session id] [--member m]", short: "close a Session (default this one), ending its Claims", run: cmdSessionClose},
	{path: "session list", args: "[member] [--limit n]", short: "list a Member's open Sessions (default yours; another's needs admin)", run: cmdSessionList},
}

func cmdMe(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetMeWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		me := res.JSON200
		fmt.Fprintf(w, "%s (%s%s) in %s\n", me.Member.Name, me.Member.Kind, map[bool]string{true: ", admin"}[me.Member.Admin], me.Organisation.Name)
		fmt.Fprintf(w, "  Projects %s\n", names(me.Projects, func(p client.Project) string { return p.Key }))
		fmt.Fprintf(w, "  Skills   %s\n", names(me.Skills, func(s client.Skill) string { return s.Name }))
		session := me.Session.ID
		if conn.Settings.OneOff {
			session += " (made up for this command; DARKORY_SESSION is not set)"
		}
		fmt.Fprintf(w, "  Session  %s\n", session)
	})
}

func email(s string) *openapi_types.Email {
	if s == "" {
		return nil
	}
	return ptr(openapi_types.Email(s))
}

func cmdMemberCreate(c *call) error {
	kind := c.fs.String("kind", "", "human or agent")
	mail := c.fs.String("email", "", "the Member's email address")
	admin := c.fs.Bool("admin", false, "give the Member the admin mark")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *kind == "" {
		return usagef("needs --kind human or --kind agent")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	body := client.CreateMemberBody{Name: args[0], Kind: client.MemberKind(*kind), Email: email(*mail)}
	if *admin {
		body.Admin = admin
	}
	res, err := conn.CreateMemberWithResponse(c.ctx, &client.CreateMemberParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printMemberLine(w, *res.JSON201) })
}

func cmdMemberList(c *call) error {
	project := c.fs.String("project", "", "only Members of this Project")
	kind := c.fs.String("kind", "", "only human or agent Members")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	params := &client.ListMembersParams{Project: opt(*project)}
	if *kind != "" {
		params.Kind = ptr(client.MemberKind(*kind))
	}
	res, err := conn.ListMembersWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		for _, m := range res.JSON200.Items {
			c.printMemberLine(w, m)
		}
	})
}

func cmdMemberShow(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetMemberWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		d := res.JSON200
		c.printMemberLine(w, d.Member)
		fmt.Fprintf(w, "  Projects %s\n", names(d.Projects, func(p client.Project) string { return p.Key }))
		fmt.Fprintf(w, "  Skills   %s\n", names(d.Skills, func(s client.Skill) string {
			if s.ProjectID != nil {
				return s.Name + " (" + c.project(*s.ProjectID) + ")"
			}
			return s.Name
		}))
		fmt.Fprintf(w, "  Reports  %s\n", names(d.Reports, func(m client.Member) string { return m.Name }))
	})
}

func cmdMemberUpdate(c *call) error {
	name := c.fs.String("name", "", "the Member's new name")
	mail := c.fs.String("email", "", "the Member's new email address")
	var admin optBool
	c.fs.Var(&admin, "admin", "set (--admin or --admin=true) or clear (--admin=false) the admin mark")
	avatar := c.fs.String("avatar", "", "show this file, uploaded with files upload --avatar, as the Member's avatar")
	noAvatar := c.fs.Bool("no-avatar", false, "remove the Member's avatar")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	body := client.UpdateMemberBody{Name: opt(*name), Email: email(*mail), Admin: admin.v, AvatarFileID: opt(*avatar)}
	if *noAvatar {
		if body.AvatarFileID != nil {
			return usagef("give --avatar or --no-avatar, not both")
		}
		none := ""
		body.AvatarFileID = &none
	}
	if body.Name == nil && body.Email == nil && body.Admin == nil && body.AvatarFileID == nil {
		return usagef("nothing to change: give --name, --email, --admin, --avatar or --no-avatar")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.UpdateMemberWithResponse(c.ctx, args[0], &client.UpdateMemberParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printMemberLine(w, *res.JSON200) })
}

func cmdMemberDeactivate(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.DeactivateMemberWithResponse(c.ctx, args[0], &client.DeactivateMemberParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printMemberLine(w, *res.JSON200) })
}

func cmdMemberReactivate(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ReactivateMemberWithResponse(c.ctx, args[0], &client.ReactivateMemberParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printMemberLine(w, *res.JSON200) })
}

func cmdSkillCreate(c *call) error {
	kind := c.fs.String("kind", "", "generic or own")
	base := c.fs.String("base", "", "the generic Skill an own Skill builds on")
	project := c.fs.String("project", "", "the Project an own Skill belongs to (default: the whole Organisation)")
	file := c.fs.String("file", "", "the Skill's text; - reads standard input")
	text := c.fs.String("body", "", "the Skill's text")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *kind == "" {
		return usagef("needs --kind generic or --kind own")
	}
	if (*file == "") == (*text == "") {
		return usagef("give the Skill's text with --file or --body")
	}
	body := *text
	if *file == "-" {
		body, err = c.text("-")
	} else if *file != "" {
		var b []byte
		b, err = os.ReadFile(*file)
		body = string(b)
	}
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.CreateSkillWithResponse(c.ctx, &client.CreateSkillParams{}, client.CreateSkillBody{
		Name: args[0], Kind: client.SkillKind(*kind), BaseSkill: opt(*base), Project: opt(*project), Body: body})
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printSkillLine(w, res.JSON201.Skill) })
}

func cmdSkillSet(c *call) error {
	var project optString
	c.fs.Var(&project, "project", `the Project the own Skill belongs to; "" makes it the whole Organisation's`)
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if project.v == nil {
		return usagef(`nothing to change: give --project, or --project "" for the whole Organisation`)
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.UpdateSkillWithResponse(c.ctx, args[0], &client.UpdateSkillParams{}, client.UpdateSkillBody{Project: *project.v})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printSkillLine(w, res.JSON200.Skill) })
}

func cmdSkillList(c *call) error {
	kind := c.fs.String("kind", "", "only generic or own Skills")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	params := &client.ListSkillsParams{}
	if *kind != "" {
		params.Kind = ptr(client.SkillKind(*kind))
	}
	res, err := conn.ListSkillsWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		for _, s := range res.JSON200.Items {
			c.printSkillLine(w, s)
		}
	})
}

func cmdSkillShow(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetSkillWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		c.printSkillLine(w, res.JSON200.Skill)
		fmt.Fprintf(w, "\n%s\n", res.JSON200.Current.Body)
	})
}

func cmdSkillVersions(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListSkillVersionsWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		for _, v := range res.JSON200.Items {
			by := ""
			if v.PublishedBy != nil {
				by = " by " + c.member(*v.PublishedBy)
			}
			fmt.Fprintf(w, "v%-4d published %s%s\n", v.Version, stamp(v.PublishedAt), by)
		}
	})
}

func cmdGrant(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GrantSkillWithResponse(c.ctx, args[0], args[1], &client.GrantSkillParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s has the Skill %s.\n", args[0], args[1]) })
}

func cmdUngrant(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RevokeSkillWithResponse(c.ctx, args[0], args[1], &client.RevokeSkillParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s no longer has the Skill %s.\n", args[0], args[1]) })
}

func cmdReportTo(c *call) error {
	none := c.fs.Bool("none", false, "remove the Member's Reporting line")
	args, err := c.args(1, 2)
	if err != nil {
		return err
	}
	if *none == (len(args) == 2) {
		return usagef("give a manager or --none")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	if *none {
		res, err := conn.ClearManagerWithResponse(c.ctx, args[0], &client.ClearManagerParams{})
		if err := check(res, err, http.StatusNoContent); err != nil {
			return err
		}
		return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s reports to no one.\n", args[0]) })
	}
	res, err := conn.SetManagerWithResponse(c.ctx, args[0], &client.SetManagerParams{}, client.SetManagerBody{Manager: args[1]})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s reports to %s.\n", args[0], args[1]) })
}

func cmdTokenIssue(c *call) error {
	name := c.fs.String("name", "", "the token's name, unique among the Member's live tokens")
	timeout := c.fs.String("timeout", "", "the default heartbeat timeout of Claims made with it, such as 5m (default: none)")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *name == "" {
		return usagef("needs --name")
	}
	body := client.IssueTokenBody{Name: *name}
	if *timeout != "" {
		n, err := seconds(*timeout)
		if err != nil || n < 1 {
			return usagef("--timeout is a duration of at least 1s")
		}
		body.DefaultHeartbeatTimeoutSeconds = &n
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.IssueTokenWithResponse(c.ctx, args[0], &client.IssueTokenParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		c.printToken(w, res.JSON201.Token)
		fmt.Fprintf(w, "\nSecret, shown once; keep it safe:\n  %s\n", res.JSON201.Secret)
	})
}

func cmdTokenList(c *call) error {
	args, err := c.args(0, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	member := ""
	if len(args) == 1 {
		member = args[0]
	} else if member, err = c.me(); err != nil {
		return err
	}
	res, err := conn.ListTokensWithResponse(c.ctx, member)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		for _, t := range res.JSON200.Items {
			c.printToken(w, t)
		}
	})
}

func cmdTokenRevoke(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RevokeTokenWithResponse(c.ctx, args[0], &client.RevokeTokenParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printToken(w, *res.JSON200) })
}

func cmdHealth(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dialPublic()
	if err != nil {
		return err
	}
	res, err := conn.GetHealthWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		h := res.JSON200
		fmt.Fprintf(w, "%s is up: darkory %s\n", conn.Settings.URL, one(h.Version))
		fmt.Fprintf(w, "  Sign-in  %s\n", names(h.SignInModes, func(m client.SignInMode) string { return string(m) }))
		if deref(h.UpdateAvailable) {
			fmt.Fprintf(w, "  Update   darkory %s is available\n", one(deref(h.LatestVersion)))
		}
	})
}

func cmdLogin(c *call) error {
	byEmail := c.fs.String("email", "", "ask for a login link to be emailed to this address, when the Install sends email (needs no token)")
	args, err := c.args(0, 1)
	if err != nil {
		return err
	}
	if (*byEmail == "") != (len(args) == 1) {
		return usagef("give a Member, or --email")
	}
	if *byEmail != "" {
		conn, err := c.dialPublic()
		if err != nil {
			return err
		}
		res, err := conn.RequestEmailSignInWithResponse(c.ctx, &client.RequestEmailSignInParams{},
			client.EmailSignInBody{Email: openapi_types.Email(*byEmail)})
		if err := check(res, err, http.StatusAccepted); err != nil {
			return err
		}
		return c.show(nil, func(w io.Writer) {
			fmt.Fprintf(w, "If %s belongs to a Member and this Install sends email, a login link is on its way.\n", *byEmail)
		})
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.IssueLoginLinkWithResponse(c.ctx, args[0], &client.IssueLoginLinkParams{})
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		fmt.Fprintf(w, "Open this link once in a browser to sign in as %s, before %s:\n  %s\n", args[0], stamp(res.JSON201.ExpiresAt), res.JSON201.URL)
	})
}

func cmdLogout(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(lasting)
	if err != nil {
		return err
	}
	res, err := conn.LogoutWithResponse(c.ctx, &client.LogoutParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	stopped, _ := stopBackground(conn.Settings)
	return c.show(nil, func(w io.Writer) {
		fmt.Fprintf(w, "Closed Session %s.\n", conn.Settings.Session)
		if stopped != 0 {
			fmt.Fprintf(w, "Stopped its background heartbeat (pid %d).\n", stopped)
		}
	})
}

func cmdSessionList(c *call) error {
	limit := c.fs.Int("limit", 0, "at most this many Sessions (default 100)")
	args, err := c.args(0, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	member := ""
	if len(args) == 1 {
		member = args[0]
	} else if member, err = c.me(); err != nil {
		return err
	}
	params := &client.ListSessionsParams{}
	if *limit > 0 {
		params.Limit = limit
	}
	res, err := conn.ListSessionsWithResponse(c.ctx, member, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		for _, s := range res.JSON200.Items {
			c.printSession(w, s)
		}
		if res.JSON200.NextCursor != nil {
			fmt.Fprintln(w, "… more; raise --limit to see them")
		}
	})
}

func cmdSessionClose(c *call) error {
	member := c.fs.String("member", "", "the Member whose Session to close (admin; default you)")
	args, err := c.args(0, 1)
	if err != nil {
		return err
	}
	need := lasting
	if len(args) == 1 {
		need = oneOff
	}
	conn, err := c.dial(need)
	if err != nil {
		return err
	}
	id := conn.Settings.Session
	if len(args) == 1 {
		id = args[0]
	}
	res, err := conn.CloseSessionWithResponse(c.ctx, id, &client.CloseSessionParams{Member: opt(*member)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	stopped := 0
	if id == conn.Settings.Session && *member == "" {
		stopped, _ = stopBackground(conn.Settings)
	}
	return c.show(res.Body, func(w io.Writer) {
		fmt.Fprintf(w, "Closed Session %s. Claims bound to it that ended: %d.\n", id, res.JSON200.ClaimsEnded)
		if stopped != 0 {
			fmt.Fprintf(w, "Stopped its background heartbeat (pid %d).\n", stopped)
		}
	})
}
