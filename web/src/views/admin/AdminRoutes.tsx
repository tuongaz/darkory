import { NavLink, Navigate, Route, Routes } from "react-router";
import { useCurrentMe } from "../../me";
import { NotFound } from "../NotFound";
import { MemberAdmin, MembersAdmin } from "./Members";
import { SkillAdmin, SkillsAdmin } from "./Skills";
import { TeamAdmin, TeamsAdmin } from "./Teams";

/** Organisation admin: Members, Teams, Skills, Reporting lines, tokens and login links. */
export function AdminRoutes() {
  const me = useCurrentMe();
  if (!me.member.admin) {
    return (
      <>
        <h1>Admin</h1>
        <p>Only admins create Members, Teams and Skills, set Reporting lines, and issue tokens and login links.</p>
      </>
    );
  }
  return (
    <>
      <h1>Admin</h1>
      <nav aria-label="Admin" className="tabs">
        <NavLink to="/admin/members">Members</NavLink>
        <NavLink to="/admin/teams">Teams</NavLink>
        <NavLink to="/admin/skills">Skills</NavLink>
      </nav>
      <Routes>
        <Route index element={<Navigate to="members" replace />} />
        <Route path="members" element={<MembersAdmin />} />
        <Route path="members/:member" element={<MemberAdmin />} />
        <Route path="teams" element={<TeamsAdmin />} />
        <Route path="teams/:team" element={<TeamAdmin />} />
        <Route path="skills" element={<SkillsAdmin />} />
        <Route path="skills/:skill" element={<SkillAdmin />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
