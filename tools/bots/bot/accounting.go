package bot

import (
	"fmt"

	"github.com/tuongaz/darkory/client"
)

// The accounting preset's Skills, besides the built-ins and review.
const (
	SkillBookkeeping    = "bookkeeping"
	SkillReconciliation = "reconciliation" // a company Skill on bookkeeping, which a Retrospective improves
	SkillTaxReview      = "tax-review"
	SkillLodgement      = "lodgement"
	SkillClientComms    = "client-comms"
)

// The accounting preset's Statuses, Workspace and people.
const (
	StatusAwaitingClient = "Awaiting client"
	StatusLodged         = "Lodged"
	WorkspaceClients     = "clients"
	PersonaMai           = "Mai Tran"
	PersonaKai           = "Kai Nguyen"
)

// Accounting is an accounting firm: Teams BOOK and TAX, a Workspace of client folders, a planner,
// a drafter who collects, reconciles and drafts, a tax reviewer and a retro; Mai Tran, the client
// manager, who answers the questions about clients and lodges, and Kai Nguyen, the partner, who
// owns the work. A Task waiting for a client's documents sits in Awaiting client, where next
// does not offer it.
var Accounting = Preset{
	Name: "accounting",
	Teams: []TeamSpec{
		{Key: "BOOK", Name: "Bookkeeping", DefaultWorkspace: WorkspaceClients, ShipWhenDone: true},
		{Key: "TAX", Name: "Tax", DefaultWorkspace: WorkspaceClients},
	},
	Skills: []client.CreateSkillBody{
		{Name: SkillBookkeeping, Kind: client.Generic, Body: "Keep the client's books. Code every transaction to the right account and GST code, " +
			"write what you did in the period's workpaper in the client's folder, and attach the workpaper to the Task. " +
			"When a document is missing or something is unclear, ask the client manager rather than guess."},
		{Name: SkillReconciliation, Kind: client.Company, BaseSkill: ptr(SkillBookkeeping), Body: "Reconcile the way this firm does: " +
			"match every bank line for the period to the ledger, list any line that does not match with its date and amount, " +
			"and stop only at zero unreconciled items or a question for the client manager. " +
			"Write the closing statement and ledger balances in the reconciliation workpaper and attach it."},
		{Name: SkillTaxReview, Kind: client.Generic, Body: "Review a draft before it goes to the tax office. " +
			"Check that the figures tie to the reconciliation and the ledger, that the GST codes are right, and that nothing is claimed without a document. " +
			"Complete the Task when it is right; when it is not, hand it back to the preparer with one sentence saying what to fix."},
		{Name: SkillLodgement, Kind: client.Generic, Body: "Lodge a reviewed return or BAS through the tax agent portal. " +
			"Lodge only what review has passed, write the receipt number in the period's lodgement workpaper, and attach it."},
		{Name: SkillClientComms, Kind: client.Generic, Body: "Get from the client what the period needs. " +
			"Request the documents, chase what is missing, and write in the folder's document register what arrived and when. " +
			"Anything only the client can answer goes to the client manager as a question."},
		{Name: SkillReview, Kind: client.Generic, Body: "Check a correction or a small piece of bookkeeping. " +
			"Read the workpaper entry and the Evidence; complete the Task when it is right, or hand it back with one sentence saying what to fix."},
	},
	Statuses: []client.StatusInput{
		{Name: StatusAwaitingClient, Kind: client.StatusKindBacklog},
		{Name: "Todo", Kind: client.StatusKindTodo},
		{Name: "In progress", Kind: client.StatusKindInProgress},
		{Name: "In review", Kind: client.StatusKindInProgress},
		{Name: StatusLodged, Kind: client.StatusKindDone},
		{Name: "Dropped", Kind: client.StatusKindDropped},
	},
	Workspaces: []WorkspaceSpec{{Name: WorkspaceClients, Files: map[string]string{
		"README.md": "# Client folders\n\nOne folder per client and one per period inside it. The workpapers are plain text; " +
			"whoever works a Task adds a dated line to the workpaper it names and attaches the file to the Task.\n",
		"northwind-traders/2026-q1/documents.txt":           "Northwind Traders, January to March 2026: document register\n",
		"northwind-traders/2026-q1/bank-reconciliation.txt": "Northwind Traders, January to March 2026: bank reconciliation\n",
		"northwind-traders/2026-q1/bas-worksheet.txt":       "Northwind Traders, January to March 2026: BAS worksheet\n",
		"northwind-traders/2026-q1/gst-corrections.txt":     "Northwind Traders, January to March 2026: GST corrections\n",
		"northwind-traders/2026-q1/lodgement.txt":           "Northwind Traders, January to March 2026: lodgements\n",
		"fabrikam-cafe/2026-q1/documents.txt":               "Fabrikam Cafe, January to March 2026: document register\n",
		"fabrikam-cafe/2026-q1/bank-reconciliation.txt":     "Fabrikam Cafe, January to March 2026: bank reconciliation\n",
		"fabrikam-cafe/2026-q1/bas-worksheet.txt":           "Fabrikam Cafe, January to March 2026: BAS worksheet\n",
		"fabrikam-cafe/2026-q1/lodgement.txt":               "Fabrikam Cafe, January to March 2026: lodgements\n",
		"contoso/fy26/documents.txt":                        "Contoso Pty Ltd, year to 30 June 2026: document register\n",
		"contoso/fy26/bank-reconciliation.txt":              "Contoso Pty Ltd, year to 30 June 2026: bank reconciliation\n",
		"contoso/fy26/payroll.txt":                          "Contoso Pty Ltd, year to 30 June 2026: payroll and super\n",
		"contoso/fy26/fixed-assets.txt":                     "Contoso Pty Ltd, year to 30 June 2026: fixed asset register\n",
		"contoso/fy26/financial-statements.txt":             "Contoso Pty Ltd, year to 30 June 2026: financial statements\n",
		"contoso/fy26/tax-return.txt":                       "Contoso Pty Ltd, year to 30 June 2026: company tax return\n",
		"contoso/fy26/lodgement.txt":                        "Contoso Pty Ltd, year to 30 June 2026: lodgements\n",
	}}},
	Agents: []Spec{
		{Name: "planner", Role: RolePlanner, Teams: []string{"BOOK", "TAX"}, Skills: []string{SkillBreakdown}, Model: "claude-opus-5-5"},
		{Name: "drafter", Role: RoleBuilder, Teams: []string{"BOOK", "TAX"}, Skills: []string{SkillBookkeeping, SkillReconciliation, SkillClientComms},
			Model: "claude-sonnet-5-5"},
		{Name: "reviewer-tax", Role: RoleReviewer, Teams: []string{"BOOK", "TAX"}, Skills: []string{SkillTaxReview, SkillReview, SkillSkillReview},
			Model: "claude-opus-5-5"},
		{Name: "retro", Role: RoleRetro, Teams: []string{"BOOK", "TAX"}, Skills: []string{SkillRetro}, Model: "claude-sonnet-5-5"},
	},
	Humans: []Persona{
		{Name: PersonaMai, Answers: true, Works: []string{SkillLodgement}, Skills: []string{SkillClientComms, SkillLodgement}, Teams: []string{"BOOK", "TAX"}},
		{Name: PersonaKai, Owns: true, Teams: []string{"BOOK", "TAX"}},
	},
	Manager:  PersonaKai,
	Ask:      PersonaMai,
	Answer:   "I spoke to the client; go ahead as you suggest.",
	Features: accountingFeatures(),
	Plan:     accountingPlan,
	Evidence: func(d *client.TaskDetail, _ string) (string, string) {
		return "workpaper.txt", fmt.Sprintf("%s\n\nWorked as the Task describes; nothing is left open.\n", d.Task.Title)
	},
}

// ws names the clients Workspace, which every accounting Task works in.
var ws = []string{WorkspaceClients}

func accountingFeatures() []FeatureTemplate {
	return []FeatureTemplate{
		{Team: "BOOK", Title: "Q1 BAS — Northwind Traders", ShipWhenDone: true,
			Description: "Prepare and lodge Northwind Traders' business activity statement for January to March 2026.",
			Tasks: []Step{
				{Ref: "collect", Title: "Collect bank statements", Skill: SkillClientComms, Workspaces: ws,
					Description: "Get Northwind's January to March statements for the cheque and card accounts into the client folder.",
					Workpaper:   "northwind-traders/2026-q1/documents.txt",
					Entry:       "Received the January and February statements for the cheque and card accounts; March is still to come.",
					Question: &Question{Title: "Statements for March are missing — ask Northwind?",
						Answer: "Northwind sent the March statements this morning; they are in the folder now."}},
				{Ref: "reconcile", Title: "Reconcile bank feed", Skill: SkillReconciliation, Workspaces: ws, Backlog: true, BlockedBy: []string{"collect"},
					Description: "Match every January to March bank line to the ledger and clear the unreconciled items.",
					Workpaper:   "northwind-traders/2026-q1/bank-reconciliation.txt",
					Entry:       "At 31 March 2026 the statement balance of $48,213.07 agrees to the ledger, with 214 lines matched and none unreconciled."},
				{Ref: "draft", Title: "Draft the BAS", Skill: SkillBookkeeping, Workspaces: ws, BlockedBy: []string{"reconcile"}, Handover: SkillTaxReview,
					Description: "Fill in the BAS worksheet from the reconciled ledger, for review.",
					Workpaper:   "northwind-traders/2026-q1/bas-worksheet.txt",
					Entry:       "G1 total sales $182,400, 1A GST on sales $16,581, 1B GST on purchases $9,214: net GST payable $7,367."},
				{Ref: "lodge", Title: "Lodge the BAS", Skill: SkillLodgement, Workspaces: ws, BlockedBy: []string{"draft"},
					Description: "Lodge the reviewed BAS through the tax agent portal and file the receipt.",
					Workpaper:   "northwind-traders/2026-q1/lodgement.txt",
					Entry:       "Lodged the Q1 BAS through the tax agent portal with receipt 4410 7731 2026; $7,367 is payable by 28 April."},
			}},
		{Team: "TAX", Title: "FY26 accounts — Contoso Pty Ltd",
			Description: "Prepare Contoso Pty Ltd's financial statements and company tax return for the year to 30 June 2026.",
			Tasks: []Step{
				{Ref: "collect", Title: "Collect the year's statements and invoices", Skill: SkillClientComms, Workspaces: ws,
					Description: "Request Contoso's FY26 bank statements, sales and purchase invoices and payroll reports.",
					Workpaper:   "contoso/fy26/documents.txt",
					Entry:       "Received twelve months of bank statements, the sales and purchase ledgers and the payroll summary."},
				{Ref: "bank", Title: "Reconcile the bank accounts", Skill: SkillReconciliation, Workspaces: ws, BlockedBy: []string{"collect"},
					Description: "Reconcile the operating and savings accounts to 30 June 2026.",
					Workpaper:   "contoso/fy26/bank-reconciliation.txt",
					Entry:       "At 30 June 2026 the operating account ($112,904.55) and the savings account ($40,000.00) agree to the ledger.",
					Question: &Question{Title: "The $4,200 transfer on 14 May has no invoice — what was it for?",
						Answer: "Contoso says it repaid a director's loan, so code it to the loan account."}},
				{Ref: "payroll", Title: "Reconcile payroll and super", Skill: SkillReconciliation, Workspaces: ws, BlockedBy: []string{"collect"},
					Description: "Agree wages, PAYG withholding and super to the payroll summary and the STP report.",
					Workpaper:   "contoso/fy26/payroll.txt",
					Entry:       "Wages of $386,200, PAYG withheld of $81,330 and super of $46,344 agree to the STP finalisation."},
				{Ref: "assets", Title: "Update the fixed asset register", Skill: SkillBookkeeping, Workspaces: ws, Backlog: true,
					Description: "Add the year's purchases and depreciation once Contoso sends the asset invoices.",
					Workpaper:   "contoso/fy26/fixed-assets.txt",
					Entry:       "Added the delivery van bought on 1 September 2025 for $48,500, with $27,340 of depreciation for the year."},
				{Ref: "statements", Title: "Draft the financial statements", Skill: SkillBookkeeping, Workspaces: ws,
					BlockedBy: []string{"bank", "payroll", "assets"}, Handover: SkillTaxReview,
					Description: "Draft the balance sheet and profit and loss from the reconciled ledger.",
					Workpaper:   "contoso/fy26/financial-statements.txt",
					Entry:       "The draft profit and loss shows revenue of $1,284,000, expenses of $1,042,000 and a net profit of $242,000.",
					HandBack:    "Depreciation on the van is missing from the profit and loss; add it and send it back.",
					Fix:         "Added $27,340 of depreciation to the profit and loss, which brings the net profit to $214,660."},
				{Ref: "return", Title: "Draft the company tax return", Skill: SkillBookkeeping, Workspaces: ws, BlockedBy: []string{"statements"},
					Handover:    SkillTaxReview,
					Description: "Prepare the company tax return from the reviewed financial statements.",
					Workpaper:   "contoso/fy26/tax-return.txt",
					Entry:       "Taxable income of $214,660 gives tax of $53,665 at 25%; after $48,000 of PAYG instalments, $5,665 is payable."},
				{Ref: "lodge", Title: "Lodge the tax return", Skill: SkillLodgement, Workspaces: ws, BlockedBy: []string{"return"},
					Description: "Lodge Contoso's reviewed company tax return and file the receipt.",
					Workpaper:   "contoso/fy26/lodgement.txt",
					Entry:       "Lodged the FY26 company tax return through the tax agent portal with receipt 5521 0094 2026."},
			}},
		{Team: "BOOK", Title: "Fix the GST code on invoice 1042", Quick: true,
			Description: "Invoice 1042 from Harbour Freight is coded GST-free but carries GST; recode it and adjust the Q1 BAS worksheet.",
			Tasks: []Step{{Title: "Fix the GST code on invoice 1042", Skill: SkillBookkeeping, Workspaces: ws, Handover: SkillReview,
				Workpaper: "northwind-traders/2026-q1/gst-corrections.txt",
				Entry:     "Recoded invoice 1042 from Harbour Freight ($1,320 with $120 GST) from GST-free to GST on purchases."}}},
		{Team: "BOOK", Title: "Q1 BAS — Fabrikam Cafe", ShipWhenDone: true,
			Description: "Prepare and lodge Fabrikam Cafe's business activity statement for January to March 2026.",
			Tasks: []Step{
				{Ref: "collect", Title: "Collect bank statements", Skill: SkillClientComms, Workspaces: ws,
					Description: "Get Fabrikam's January to March statements for the business account into the client folder.",
					Workpaper:   "fabrikam-cafe/2026-q1/documents.txt",
					Entry:       "Received the January to March statements for the business account and the card terminal reports."},
				{Ref: "reconcile", Title: "Reconcile bank feed", Skill: SkillReconciliation, Workspaces: ws, BlockedBy: []string{"collect"},
					Description: "Match every January to March bank line to the ledger and clear the unreconciled items.",
					Workpaper:   "fabrikam-cafe/2026-q1/bank-reconciliation.txt",
					Entry:       "At 31 March 2026 the statement balance of $9,870.40 agrees to the ledger, with 1,032 lines matched and none unreconciled."},
				{Ref: "draft", Title: "Draft the BAS", Skill: SkillBookkeeping, Workspaces: ws, BlockedBy: []string{"reconcile"}, Handover: SkillTaxReview,
					Description: "Fill in the BAS worksheet from the reconciled ledger, for review.",
					Workpaper:   "fabrikam-cafe/2026-q1/bas-worksheet.txt",
					Entry:       "G1 total sales $96,250, 1A GST on sales $8,750, 1B GST on purchases $4,105: net GST payable $4,645."},
				{Ref: "lodge", Title: "Lodge the BAS", Skill: SkillLodgement, Workspaces: ws, BlockedBy: []string{"draft"},
					Description: "Lodge the reviewed BAS through the tax agent portal and file the receipt.",
					Workpaper:   "fabrikam-cafe/2026-q1/lodgement.txt",
					Entry:       "Lodged the Q1 BAS through the tax agent portal with receipt 3318 2290 2026; $4,645 is payable by 28 April."},
			}},
	}
}

// accountingPlan breaks down a Feature filed by hand, with no template: collect what the client
// has, do the bookkeeping, and have it reviewed.
func accountingPlan(f client.Feature, _ string) []Step {
	return []Step{
		{Ref: "collect", Title: "Collect the documents for " + f.Title, Skill: SkillClientComms, Workspaces: ws,
			Description: "Request what the client has for this piece of work and file it in their folder."},
		{Ref: "books", Title: "Do the bookkeeping for " + f.Title, Skill: SkillBookkeeping, Workspaces: ws, BlockedBy: []string{"collect"},
			Handover: SkillTaxReview, Description: "Code the transactions and write the workpaper, for review."},
	}
}
