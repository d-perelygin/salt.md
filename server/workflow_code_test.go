package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func testSchema() []PropSchema {
	return []PropSchema{
		{ID: "st", Name: "Статус", Type: "select", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "s1", Name: "Новое"}, {ID: "s2", Name: "В работе"}, {ID: "s3", Name: "Готово"}, {ID: "s4", Name: "На проверку"}}},
		{ID: "pr", Name: "Проект", Type: "select", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "p1", Name: "Академ"}, {ID: "p2", Name: "XXБ"}}},
		{ID: "tags", Name: "Теги", Type: "multiselect", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "t1", Name: "Срочно"}, {ID: "t2", Name: "Рилс"}}},
		{ID: "own", Name: "Ответственный", Type: "person"},
		{ID: "dd", Name: "Дедлайн", Type: "date"},
		{ID: "n", Name: "Оценка", Type: "number"},
		{ID: "txt", Name: "Заметка", Type: "text"},
		{ID: "sd", Name: "Дата старта", Type: "date"},
		{ID: "chk", Name: "Готовность", Type: "checklist"},
		{ID: "flag", Name: "Флаг", Type: "checkbox"},
	}
}

func testMembers() []codeMember {
	return []codeMember{{ID: "u1", Name: "Данил"}, {ID: "u2", Name: "Катя"}}
}

func mustResolve(t *testing.T, src string) []workflowRule {
	t.Helper()
	f, diags := parseWorkflowCode(src)
	if len(diags) > 0 {
		t.Fatalf("parse errors: %v", diags)
	}
	status := PropSchema{}
	for _, p := range testSchema() {
		if p.Name == "Статус" {
			status = p
		}
	}
	got, rdiags := resolveWorkflowCode("b1", f, testSchema(), status, testMembers())
	if len(rdiags) > 0 {
		t.Fatalf("resolve errors: %v", rdiags)
	}
	return got
}

func TestCodeBasicRule(t *testing.T) {
	got := mustResolve(t, `
rule "На проверку":
  when "Новое" becomes "В работе"
  do:
    assign me to "Ответственный"
`)
	if len(got) != 1 {
		t.Fatalf("want 1 rule, got %d", len(got))
	}
	r := got[0]
	if r.ID != "code:b1:0" {
		t.Errorf("id = %q", r.ID)
	}
	if r.When.Type != "status_to" || r.When.To != "s2" {
		t.Errorf("when = %+v", r.When)
	}
	if len(r.AllowFrom) != 1 || r.AllowFrom[0] != "s1" {
		t.Errorf("allowFrom = %v", r.AllowFrom)
	}
	if len(r.Do) != 1 || r.Do[0].Type != "assign_me" || r.Do[0].Prop != "own" {
		t.Errorf("do = %+v", r.Do)
	}
}

func TestCodeCreatedAndGuard(t *testing.T) {
	got := mustResolve(t, `
rule "Старт":
  when created

rule "Только свои":
  when any becomes "Готово"
  only from "Новое", "В работе"
  needs checklist "Готовность"
  needs filled "Дедлайн"
  if "Проект" is "Академ"
  if "Оценка" is not 5
  do:
    ask "Дедлайн" if empty
`)
	if len(got) != 2 {
		t.Fatalf("want 2 rules, got %d", len(got))
	}
	if got[0].When.Type != "created" {
		t.Errorf("r0.when = %+v", got[0].When)
	}
	r := got[1]
	if len(r.AllowFrom) != 2 {
		t.Errorf("allowFrom = %v", r.AllowFrom)
	}
	if r.Precondition == nil || r.Precondition.ChecklistProp != "chk" || r.Precondition.RequiredProp != "dd" {
		t.Errorf("precondition = %+v", r.Precondition)
	}
	if len(r.WhenProps) != 2 {
		t.Fatalf("whenProps = %+v", r.WhenProps)
	}
}

func TestCodeFullRule(t *testing.T) {
	got := mustResolve(t, `
# комментарий
rule "На проверку":
  when "В работе" becomes "На проверку"
  only from "Новое", "В работе"
  needs checklist "Готовность"
  needs filled "Дедлайн"
  if "Проект" is "Академ"
  if "Оценка" is not 5
  do:
    set "Заметка" = "готово"
    set "Оценка" = 5
    set "Флаг" = true
    set "Дедлайн" = "2026-11-21"
    set "Проект" = "XXБ"
    set "Теги" = ["Срочно", "Рилс"]
    set "Ответственный" = "Данил"
    assign me to "Ответственный"
    ask "Дедлайн" if empty
    ask comment always
    set "Дедлайн" = today
    webhook https://hooks.example/x
`)
	if len(got) != 1 {
		t.Fatalf("want 1 rule, got %d", len(got))
	}
	r := got[0]
	if r.When.To != "s4" {
		t.Errorf("to = %q", r.When.To)
	}
	if len(r.AllowFrom) != 2 || r.AllowFrom[0] != "s1" || r.AllowFrom[1] != "s2" {
		t.Errorf("allowFrom = %v", r.AllowFrom)
	}
	if r.Precondition == nil || r.Precondition.ChecklistProp != "chk" || r.Precondition.RequiredProp != "dd" {
		t.Errorf("precondition = %+v", r.Precondition)
	}
	if len(r.WhenProps) != 2 {
		t.Fatalf("whenProps = %+v", r.WhenProps)
	}
	if r.WhenProps[0].Prop != "pr" || r.WhenProps[0].Op != "is" || r.WhenProps[0].Value != "p1" {
		t.Errorf("cond0 = %+v", r.WhenProps[0])
	}
	if r.WhenProps[1].Prop != "n" || r.WhenProps[1].Op != "is_not" || r.WhenProps[1].Value != "5" {
		t.Errorf("cond1 = %+v", r.WhenProps[1])
	}
	want := []struct {
		typ, prop, val, mode, url string
	}{
		{"set_prop", "txt", `"готово"`, "", ""},
		{"set_prop", "n", "5", "", ""},
		{"set_prop", "flag", "true", "", ""},
		{"set_prop", "dd", `"2026-11-21"`, "", ""},
		{"set_prop", "pr", `"p2"`, "", ""},
		{"set_prop", "tags", `["t1","t2"]`, "", ""},
		{"set_prop", "own", `["u1"]`, "", ""},
		{"assign_me", "own", "", "", ""},
		{"require_prop", "dd", "", "if empty", ""},
		{"require_comment", "", "", "always", ""},
		{"set_today", "dd", "", "", ""},
		{"webhook", "", "", "", "https://hooks.example/x"},
	}
	if len(r.Do) != len(want) {
		t.Fatalf("actions = %+v", r.Do)
	}
	for i, w := range want {
		a := r.Do[i]
		if a.Type != w.typ || a.Prop != w.prop || string(a.Value) != w.val || a.Mode != w.mode || a.URL != w.url {
			t.Errorf("action %d = %+v, want %+v", i, a, w)
		}
	}
}

func TestCodeConstants(t *testing.T) {
	got := mustResolve(t, `
hook = "https://hooks.example.com/kbrd"
reviewers = ["Данил", "Катя"]

rule "На проверку":
  when "В работе" becomes "На проверку"
  do:
    webhook hook
    set "Ответственный" = reviewers
`)
	if len(got) != 1 {
		t.Fatalf("want 1 rule, got %d", len(got))
	}
	r := got[0]
	if len(r.Do) != 2 {
		t.Fatalf("do = %+v", r.Do)
	}
	if r.Do[0].Type != "webhook" || r.Do[0].URL != "https://hooks.example.com/kbrd" {
		t.Errorf("webhook = %+v", r.Do[0])
	}
	if r.Do[1].Type != "set_prop" || r.Do[1].Prop != "own" {
		t.Errorf("set = %+v", r.Do[1])
	}
}

func TestCodeOrList(t *testing.T) {
	got := mustResolve(t, `
rule "Фильтр":
  when any becomes "Готово"
  if "Проект" is "Академ", "XXБ"
  do:
    ask comment always
`)
	if len(got) != 1 {
		t.Fatalf("want 1 rule, got %d", len(got))
	}
	c := got[0].WhenProps[0]
	if c.Op != "is" || c.Value != "p1" || len(c.Values) != 2 || c.Values[0] != "p1" || c.Values[1] != "p2" {
		t.Errorf("or cond = %+v", c)
	}
}

func TestCodeMaximal(t *testing.T) {
	got := mustResolve(t, `
# Процесс: выпуск КБРД
hook = "https://hooks.example.com/kbrd"
reviewers = ["Данил", "Катя"]
urgent_tags = ["Срочно", "Рилс"]

rule "Создание":
  when created
  do:
    set "Ответственный" = reviewers
    set "Дата старта" = today
    ask "Дедлайн" if empty
`)
	_ = got
	if len(got) != 1 {
		t.Fatalf("want 1 rule, got %d", len(got))
	}
}

func TestCodeParseErrors(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string // substring of the first diagnostic
	}{
		{"no rule", "when created\n", "rule"},
		{"empty name", "rule \"\":\n  when created\n", "must not be empty"},
		{"no when", "rule \"X\":\n  do:\n    ask comment always\n", "when"},
		{"bad indent", "rule \"X\":\n  when created\n  do:\n      ask comment always\n   ask comment always\n", "indent"},
		{"tab", "rule \"X\":\n\twhen created\n", "tab"},
		{"unknown toplevel", "rule \"X\":\n  when created\nfrob\n", "rule"},
		{"bad when", "rule \"X\":\n  when someday\n", "status"},
		{"missing becomes target", "rule \"X\":\n  when \"A\"\n", "becomes"},
		{"unknown section", "rule \"X\":\n  when created\n  frob\n", "unknown rule line"},
		{"double when", "rule \"X\":\n  when created\n  when created\n", "already has a when"},
		{"double do", "rule \"X\":\n  when created\n  do:\n    ask comment always\n  do:\n    ask comment always\n", "already has a do"},
		{"do needs colon", "rule \"X\":\n  when created\n  do\n    ask comment always\n", "do:"},
		{"when no trailing colon", "rule \"X\":\n  when created:\n", "colon"},
		{"ask needs mode", "rule \"X\":\n  when created\n  do:\n    ask \"Дедлайн\"\n", "always"},
		{"bad webhook", "rule \"X\":\n  when created\n  do:\n    webhook\n", "URL"},
		{"webhook unknown const", "rule \"X\":\n  when created\n  do:\n    webhook missing_hook\n", "unknown"},
		{"unterminated", "rule \"X:\n  when created\n", "unterminated"},
		{"const redefined", "a = \"x\"\na = \"y\"\nrule \"X\":\n  when created\n", "already defined"},
		{"const reserved", "today = \"x\"\nrule \"X\":\n  when created\n", "reserved"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, diags := parseWorkflowCode(c.src)
			if len(diags) == 0 {
				t.Fatalf("expected error containing %q, got none", c.want)
			}
			if !strings.Contains(diags[0].Msg, c.want) {
				t.Fatalf("error %q does not contain %q", diags[0].Msg, c.want)
			}
		})
	}
}

func TestCodeResolveErrors(t *testing.T) {
	status := PropSchema{}
	for _, p := range testSchema() {
		if p.Name == "Статус" {
			status = p
		}
	}
	resolve := func(src string) []codeDiag {
		f, pdiags := parseWorkflowCode(src)
		if len(pdiags) != 0 {
			t.Fatalf("unexpected parse errors: %v", pdiags)
		}
		_, rdiags := resolveWorkflowCode("b1", f, testSchema(), status, testMembers())
		return rdiags
	}
	cases := []struct {
		name string
		src  string
		want string
	}{
		{"unknown status", "rule \"X\":\n  when \"Нет\" becomes \"В работе\"\n", "unknown status"},
		{"unknown from", "rule \"X\":\n  when \"Нет\" becomes \"В работе\"\n", "unknown status"},
		{"unknown prop", "rule \"X\":\n  when created\n  if \"Нет\" is \"x\"\n", "unknown property"},
		{"bad cond type", "rule \"X\":\n  when created\n  if \"Дедлайн\" is \"x\"\n", "conditions support"},
		{"unknown option", "rule \"X\":\n  when created\n  if \"Проект\" is \"Нет\"\n", "unknown option"},
		{"unknown member", "rule \"X\":\n  when created\n  do:\n    set \"Ответственный\" = \"Никто\"\n", "unknown member"},
		{"number not quoted-able", "rule \"X\":\n  when created\n  do:\n    set \"Заметка\" = 5\n", "in quotes"},
		{"text not bare", "rule \"X\":\n  when created\n  do:\n    set \"Оценка\" = \"5\"\n", "without quotes"},
		{"bad date", "rule \"X\":\n  when created\n  do:\n    set \"Дедлайн\" = \"завтра\"\n", "not a date"},
		{"relative date ok", "rule \"X\":\n  when created\n  do:\n    set \"Дедлайн\" = \"today+7d\"\n", ""},
		{"checklist type", "rule \"X\":\n  when created\n  needs checklist \"Заметка\"\n", "not a checklist"},
		{"webhook scheme", "rule \"X\":\n  when created\n  do:\n    webhook ftp://x\n", "http"},
		{"empty if value", "rule \"X\":\n  when created\n  if \"Заметка\" is \"\"\n", "empty"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			diags := resolve(c.src)
			if c.want == "" {
				if len(diags) != 0 {
					t.Fatalf("expected no errors, got %v", diags)
				}
				return
			}
			if len(diags) == 0 {
				t.Fatalf("expected error containing %q, got none", c.want)
			}
			if !strings.Contains(diags[0].Msg, c.want) {
				t.Fatalf("error %q does not contain %q", diags[0].Msg, c.want)
			}
		})
	}
}

func TestCodeMultilineAndComments(t *testing.T) {
	got := mustResolve(t, `
# шапка
rule "A":  # комментарий
  when created  # тоже

rule "B":
  when any becomes "В работе" # переход
  do:
    ask comment if empty
`)
	if len(got) != 2 {
		t.Fatalf("want 2 rules, got %d", len(got))
	}
	if got[0].When.Type != "created" {
		t.Errorf("r0 = %+v", got[0].When)
	}
	if got[1].When.Type != "status_to" || got[1].When.To != "s2" || len(got[1].AllowFrom) != 0 {
		t.Errorf("r1 = %+v", got[1].When)
	}
	if len(got[1].Do) != 1 || got[1].Do[0].Type != "require_comment" || got[1].Do[0].Mode != "if empty" {
		t.Errorf("r1.do = %+v", got[1].Do)
	}
}

// Code blocks save through the collection PUT: the server compiles the
// source into stored rules, refuses bad sources, and the live check
// endpoint reports every problem without saving.
func TestCodePutAndValidateEndpoint(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "codeput@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow", `[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	putWorkflow := func(src string) (int, string) {
		wf := map[string]any{"statusPropId": "st", "rules": []any{}, "code": []any{map[string]any{"id": "b1", "name": "Main", "source": src, "rules": []any{}}}}
		wfb, _ := json.Marshal(wf)
		schema := `[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`
		rec := requestAs(t, s, cookie, "PUT", "/api/collections/"+col, `{"schema":`+schema+`,"workflow":`+string(wfb)+`}`)
		return rec.Code, rec.Body.String()
	}
	good := "rule \"Ship\":\n  when \"New\" becomes \"Done\"\n  do:\n    set \"Status\" = \"Done\"\n"
	if code, body := putWorkflow(good); code != 200 {
		t.Fatalf("good code: %d %s", code, body)
	}
	var stored string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	if !strings.Contains(stored, "code:b1:0") {
		t.Errorf("compiled rule missing: %s", stored)
	}
	bad := "rule \"Ship\":\n  when \"Nope\" becomes \"Done\"\n"
	if code, body := putWorkflow(bad); code != 400 {
		t.Errorf("bad code: %d, want 400 (%s)", code, body)
	}
	// The refused save kept the good source.
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	if !strings.Contains(stored, "code:b1:0") {
		t.Errorf("refused save overwrote the good code: %s", stored)
	}
	// Live check: bad source reports block and line, good source is clean.
	check := func(src string) map[string]any {
		wf := map[string]any{"statusPropId": "st", "rules": []any{}, "code": []any{map[string]any{"id": "b1", "name": "Main", "source": src}}}
		wfb, _ := json.Marshal(map[string]any{"workflow": wf})
		rec := requestAs(t, s, cookie, "POST", "/api/collections/"+col+"/workflow/validate", string(wfb))
		if rec.Code != 200 {
			t.Fatalf("validate: %d %s", rec.Code, rec.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("validate answer: %v", err)
		}
		return out
	}
	errs := check(bad)["errors"].([]any)
	if len(errs) == 0 {
		t.Fatalf("validate found nothing in bad code")
	}
	first, _ := errs[0].(map[string]any)
	if first["block"] != "Main" {
		t.Errorf("validate block = %v, want Main", first["block"])
	}
	if errs := check(good)["errors"].([]any); len(errs) != 0 {
		t.Errorf("validate flagged good code: %v", errs)
	}
	// MCP sees code as read-only and cannot remove compiled rules.
	out, err := callTool(t, s, &user{ID: uid}, "get_workflow", `{"page_id":"`+col+`"}`)
	if err != nil {
		t.Fatalf("get_workflow: %v", err)
	}
	if !strings.Contains(out, "code_blocks") || !strings.Contains(out, "Main") || !strings.Contains(out, "becomes") {
		t.Errorf("get_workflow hides code blocks: %s", out)
	}
	if _, err := callTool(t, s, &user{ID: uid}, "remove_workflow_rule", `{"page_id":"`+col+`","rule_id":"code:b1:0"}`); err == nil {
		t.Errorf("remove_workflow_rule on a code rule should be refused")
	}
}
