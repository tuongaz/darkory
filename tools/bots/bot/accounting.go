package bot

import (
	"fmt"

	"github.com/tuongaz/darkory/client"
)

// The accounting preset's Skills.
const (
	SkillClientComms   = "client-comms"
	SkillBookkeeping   = "bookkeeping"
	SkillPartnerReview = "partner-review"
)

// The accounting preset's Project, Steps and people.
const (
	ProjectTax         = "TAX"
	StepGather         = "Gather"
	StepPrepare        = "Prepare"
	StepPartnerReview  = "Partner review"
	OutcomeLodged      = "lodged"
	PersonaLan         = "Lan Pham"
	PersonaMai         = "Mai Tran"
	PersonaKai         = "Kai Nguyen"
	accountingAnswerer = PersonaKai
)

// AccountingWorkflow is the accounting Project's Workflow, Work: work filed ahead waits in Backlog, a
// hold, until the partner moves it on; then the client's documents are gathered, the return is
// prepared, and the partner reviews it, lodging it (into Done) or sending it back to Prepare.
var AccountingWorkflow = WorkflowSpec{
	Name:  "Work",
	Steps: []StepSpec{{StepBacklog, ""}, {StepGather, SkillClientComms}, {StepPrepare, SkillBookkeeping}, {StepPartnerReview, SkillPartnerReview}},
	Connectors: []ConnectorSpec{
		{StepGather, StepPrepare, "gathered"},
		{StepPrepare, StepPartnerReview, "prepared"},
		{StepPartnerReview, "", OutcomeLodged}, {StepPartnerReview, StepPrepare, "needs changes"},
	},
}

// Accounting is a small accounting practice whose work is done by people alone: one Project, TAX,
// with no agents and no Workspace. Lan Pham gathers what clients send, Mai Tran prepares the
// returns, and Kai Nguyen, the partner, owns the work, answers the questions about clients,
// moves work out of Backlog and reviews and lodges every return. No one judges their own work:
// each Step is a different person's Skill.
var Accounting = Preset{
	Name:     "accounting",
	Projects: []ProjectSpec{{Key: ProjectTax, Name: "Tax"}},
	Skills: []client.CreateSkillBody{
		{Name: SkillClientComms, Kind: client.Generic, Body: "Get from the client what the period needs. " +
			"Request the documents, chase what is missing, and write in the period's workpaper what arrived and when. " +
			"Anything only the client can answer goes to the partner as a question."},
		{Name: SkillBookkeeping, Kind: client.Generic, Body: "Prepare the return from what was gathered. " +
			"Code every transaction to the right account and GST code, write the figures in the period's workpaper, and attach it."},
		{Name: SkillPartnerReview, Kind: client.Generic, Body: "Review a prepared return before it goes to the tax office. " +
			"Check that the figures tie to the documents and that nothing is claimed without one; lodge it when it is right, " +
			"or send it back to Prepare with one sentence saying what to fix."},
	},
	Workflows: []WorkflowSpec{AccountingWorkflow},
	Humans: []Persona{
		{Name: PersonaLan, Works: []string{SkillClientComms}, Skills: []string{SkillClientComms}, Projects: []string{ProjectTax}},
		{Name: PersonaMai, Works: []string{SkillBookkeeping}, Skills: []string{SkillBookkeeping}, Projects: []string{ProjectTax}},
		{Name: PersonaKai, Owns: true, Answers: true, Works: []string{SkillPartnerReview}, Skills: []string{SkillPartnerReview},
			Projects: []string{ProjectTax}},
	},
	Manager: PersonaKai,
	Ask:     accountingAnswerer,
	Answer:  "I spoke to the client; go ahead as you suggest.",
	Tasks:   accountingTasks(),
	Plan:    accountingPlan,
	Evidence: func(d *client.TaskDetail, _ string) (string, string) {
		return "workpaper.txt", fmt.Sprintf("%s\n\nWorked as the Task describes; nothing is left open.\n", d.Task.Title)
	},
}

func accountingTasks() []TaskTemplate {
	return []TaskTemplate{
		{Project: ProjectTax, Title: "Q1 BAS — Northwind Traders", Alone: true,
			Description: "Prepare and lodge Northwind Traders' business activity statement for January to March 2026.",
			Items: []Item{{Title: "Q1 BAS — Northwind Traders", Step: StepGather, Backlog: true, Workpaper: "northwind-traders/2026-q1/bas.txt",
				Question: &Question{Step: StepGather, Title: "Statements for March are missing — ask Northwind?",
					Answer: "Northwind sent the March statements this morning; they are in the folder now."},
				Entries: map[string]string{
					StepGather:        "Received the January to March statements for the cheque and card accounts.",
					StepPrepare:       "G1 total sales $182,400, 1A GST on sales $16,581, 1B GST on purchases $9,214: net GST payable $7,367.",
					StepPartnerReview: "Lodged the Q1 BAS with receipt 4410 7731 2026; $7,367 is payable by 28 April.",
				}}}},
		{Project: ProjectTax, Title: "FY26 accounts — Contoso Pty Ltd",
			Description: "Prepare Contoso Pty Ltd's financial statements and company tax return for the year to 30 June 2026.",
			Items: []Item{
				{Ref: "statements", Title: "Financial statements", Step: StepGather, Backlog: true, Workpaper: "contoso/fy26/financial-statements.txt",
					Description: "The balance sheet and profit and loss for the year to 30 June 2026.",
					Entries: map[string]string{
						StepGather:        "Received twelve months of bank statements, the sales and purchase ledgers and the asset invoices.",
						StepPrepare:       "The draft profit and loss shows revenue of $1,284,000, expenses of $1,042,000 and a net profit of $242,000.",
						StepPartnerReview: "Signed off the financial statements with a net profit of $214,660.",
					},
					HandBack: "Depreciation on the van is missing from the profit and loss; add it and send it back.",
					Fix:      "Added $27,340 of depreciation to the profit and loss, which brings the net profit to $214,660."},
				{Ref: "return", Title: "Company tax return", Step: StepGather, BlockedBy: []string{"statements"}, Workpaper: "contoso/fy26/tax-return.txt",
					Description: "The company tax return from the reviewed financial statements.",
					Entries: map[string]string{
						StepGather:        "The reviewed statements and last year's return are in the folder.",
						StepPrepare:       "Taxable income of $214,660 gives tax of $53,665 at 25%; after $48,000 of PAYG instalments, $5,665 is payable.",
						StepPartnerReview: "Lodged the FY26 company tax return with receipt 5521 0094 2026.",
					}},
			}},
		{Project: ProjectTax, Title: "Fix the GST code on invoice 1042", Alone: true,
			Description: "Invoice 1042 from Harbour Freight is coded GST-free but carries GST; recode it and adjust the Q1 BAS worksheet.",
			Items: []Item{{Title: "Fix the GST code on invoice 1042", Step: StepPrepare, Workpaper: "northwind-traders/2026-q1/gst-corrections.txt",
				Entries: map[string]string{
					StepPrepare:       "Recoded invoice 1042 from Harbour Freight ($1,320 with $120 GST) from GST-free to GST on purchases.",
					StepPartnerReview: "Checked the recoding of invoice 1042 and lodged the corrected worksheet.",
				}}}},
	}
}

// accountingPlan is the Subtasks of a Parent filed by hand, with no template: gather what the
// client has, then prepare the return.
func accountingPlan(parent, _ string) []Item {
	return []Item{
		{Ref: "gather", Title: "Gather the documents for " + parent, Step: StepGather,
			Description: "Request what the client has for this piece of work and file it in their folder."},
		{Ref: "prepare", Title: "Prepare " + parent, Step: StepPrepare, BlockedBy: []string{"gather"},
			Description: "Code the transactions and write the workpaper, for the partner's review."},
	}
}
