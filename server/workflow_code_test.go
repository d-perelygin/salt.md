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
		{"require_prop", "dd", "", "if_empty", ""},
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
	if len(got[1].Do) != 1 || got[1].Do[0].Type != "require_comment" || got[1].Do[0].Mode != "if_empty" {
		t.Errorf("r1.do = %+v", got[1].Do)
	}
}

// Code blocks save through the collection PUT: the server compiles the
// source into stored rules, refuses bad sources, and the live check
// endpoint reports every problem without saving.
func TestRewriteCodeNames(t *testing.T) {
	oldSchema := []PropSchema{
		{ID: "st", Name: "Статус", Type: "select", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "s1", Name: "Новое"}, {ID: "s2", Name: "В работе"}}},
		{ID: "pr", Name: "Проект", Type: "select", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "p1", Name: "Академ"}}},
		{ID: "own", Name: "Ответственный", Type: "person"},
	}
	newSchema := []PropSchema{
		{ID: "st", Name: "Статус", Type: "select", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "s1", Name: "Новое"}, {ID: "s2", Name: "Делается"}}},
		{ID: "pr", Name: "Шоу", Type: "select", Options: []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{{ID: "p1", Name: "Академ"}}},
		{ID: "own", Name: "Ответственный", Type: "person"},
	}
	members := []codeMember{{ID: "u1", Name: "Данил"}}
	ren := diffSchemaNames(oldSchema, newSchema)
	if len(ren) != 2 {
		t.Fatalf("renames = %+v", ren)
	}
	src := "rule \"X\":\n" +
		"  when \"Новое\" becomes \"В работе\"\n" +
		"  if \"Проект\" is \"Академ\"\n" +
		"  do:\n" +
		"    set \"Проект\" = \"Академ\"\n" +
		"    set \"Ответственный\" = \"Данил\"\n"
	cfg := &workflowConfig{StatusPropID: "st", Code: []workflowCodeBlock{{ID: "b1", Name: "M", Source: src}}}
	refs, blocks := rewriteCodeWorkflow(cfg, oldSchema, members, ren)
	if refs != 3 || blocks != 1 {
		t.Fatalf("refs=%d blocks=%d, source:\n%s", refs, blocks, cfg.Code[0].Source)
	}
	got := cfg.Code[0].Source
	for _, want := range []string{`"Делается"`, `"Шоу"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "В работе") || strings.Contains(got, "\"Проект\"") {
		t.Errorf("stale names remain:\n%s", got)
	}
	// A member rename rewrites person values but leaves option text alone.
	mren := []codeRename{{kind: "member", id: "u1", from: "Данил", to: "Даня"}}
	oldMembers := []codeMember{{ID: "u1", Name: "Данил"}}
	cfg2 := &workflowConfig{StatusPropID: "st", Code: []workflowCodeBlock{{ID: "b1", Name: "M", Source: src}}}
	if refs, _ := rewriteCodeWorkflow(cfg2, oldSchema, oldMembers, mren); refs != 1 {
		t.Fatalf("member refs=%d, source:\n%s", refs, cfg2.Code[0].Source)
	}
	if !strings.Contains(cfg2.Code[0].Source, `"Даня"`) {
		t.Errorf("member not rewritten:\n%s", cfg2.Code[0].Source)
	}
	// A constant holding the old option name is rewritten at its definition.
	constSrc := "tag = \"Академ\"\nrule \"X\":\n  when \"Новое\" becomes \"В работе\"\n  do:\n    set \"Проект\" = tag\n"
	cfg3 := &workflowConfig{StatusPropID: "st", Code: []workflowCodeBlock{{ID: "b1", Name: "M", Source: constSrc}}}
	renOpt := []codeRename{{kind: "option", id: "p1", propID: "pr", from: "Академ", to: "Академ Шоу"}}
	if refs, _ := rewriteCodeWorkflow(cfg3, oldSchema, members, renOpt); refs != 1 {
		t.Fatalf("const refs=%d, source:\n%s", refs, cfg3.Code[0].Source)
	}
	if !strings.Contains(cfg3.Code[0].Source, `tag = "Академ Шоу"`) {
		t.Errorf("const not rewritten:\n%s", cfg3.Code[0].Source)
	}
}

// A rename riding the schema save rewrites code sources at exact token
// positions and announces it; a schema-only save rewrites stored code.
func TestCodePutRenamesProp(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "coderename@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	schemaOf := func(status, owner string) string {
		return `[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"` + status + `"}]},{"id":"own","name":"` + owner + `","type":"person"}]`
	}
	col := s.makeCollection(t, ws, uid, "Flow", schemaOf("Done", "Owner"))
	src := "rule \"Ship\":\n  when \"New\" becomes \"Done\"\n  do:\n    ask \"Owner\" if empty\n"
	put := func(schema, src string) (int, map[string]any) {
		wf := map[string]any{"statusPropId": "st", "rules": []any{}}
		body := map[string]any{"schema": json.RawMessage(schema)}
		if src != "" {
			wf["code"] = []any{map[string]any{"id": "b1", "name": "Main", "source": src, "rules": []any{}}}
			body["workflow"] = wf
		}
		b, _ := json.Marshal(body)
		rec := requestAs(t, s, cookie, "PUT", "/api/collections/"+col, string(b))
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	if code, _ := put(schemaOf("Done", "Owner"), src); code != 200 {
		t.Fatalf("seed: %d", code)
	}
	code, out := put(schemaOf("Shipped", "Curator"), src)
	if code != 200 {
		t.Fatalf("rename: %d %v", code, out)
	}
	ren, _ := out["codeRenames"].(map[string]any)
	if ren == nil || ren["refs"] != 2.0 || ren["blocks"] != 1.0 {
		t.Errorf("codeRenames = %v", out["codeRenames"])
	}
	var stored string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	if !strings.Contains(stored, "Shipped") || !strings.Contains(stored, "Curator") {
		t.Errorf("stored code not rewritten: %s", stored)
	}
	// Schema-only save rewrites the stored code too.
	code2, _ := put(schemaOf("Released", "Curator"), "")
	if code2 != 200 {
		t.Fatalf("schema-only: %d", code2)
	}
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	if !strings.Contains(stored, "Released") {
		t.Errorf("stored code not rewritten on schema-only save: %s", stored)
	}
}

// A member rename rewrites person names in every stored process code.
func TestRewriteMemberInCode(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "memberrename@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow", `[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	src := "rule \"Ship\":\n  when \"New\" becomes \"Done\"\n  do:\n    set \"Owner\" = \"Test\"\n"
	wf := map[string]any{"statusPropId": "st", "rules": []any{}, "code": []any{map[string]any{"id": "b1", "name": "M", "source": src, "rules": []any{}}}}
	wfb, _ := json.Marshal(map[string]any{
		"schema":   json.RawMessage(`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`),
		"workflow": wf,
	})
	rec := requestAs(t, s, cookie, "PUT", "/api/collections/"+col, string(wfb))
	if rec.Code != 200 {
		t.Fatalf("seed: %d %s", rec.Code, rec.Body.String())
	}
	s.rewriteMemberInCode(uid, "Test", "Tester", "", "Test")
	var stored string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	var cfg workflowConfig
	if err := json.Unmarshal([]byte(stored), &cfg); err != nil {
		t.Fatalf("stored workflow: %v", err)
	}
	rewritten := ""
	if len(cfg.Code) > 0 {
		rewritten = cfg.Code[0].Source
	}
	if !strings.Contains(rewritten, `"Tester"`) || strings.Contains(rewritten, `"Test"`) {
		t.Errorf("member not rewritten: %q", rewritten)
	}
	// The rename is a real change to this database's process: it is filed
	// under the person who renamed the account, not left to appear later as a
	// change nobody made.
	var author string
	var changes string
	s.db.QueryRow(`SELECT author_name, changes FROM collection_revisions WHERE page_id = ?
		ORDER BY seq DESC LIMIT 1`, col).Scan(&author, &changes)
	if author != "Test" {
		t.Errorf("the rewrite is filed under %q", author)
	}
	if !strings.Contains(changes, "workflow_code_changed") {
		t.Errorf("the rewrite is not described: %s", changes)
	}
}

// The compile endpoint turns one rule snippet into the JSON the visual
// editor stores, or reports problems, or flags code-only features.
func TestCompileTextEndpoint(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "compile@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow", `[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	compile := func(src string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"source": src, "statusPropId": "st"})
		rec := requestAs(t, s, cookie, "POST", "/api/collections/"+col+"/workflow/compile-text", string(b))
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	rulesOf := func(out map[string]any) []any {
		r, _ := out["rules"].([]any)
		return r
	}
	// Two plain rules compile to rule JSON each.
	code, out := compile("rule \"A\":\n  when created\n\nrule \"B\":\n  when \"New\" becomes \"Done\"\n  do:\n    ask comment always\n")
	if code != 200 {
		t.Fatalf("compile: %d %v", code, out)
	}
	rules := rulesOf(out)
	if len(rules) != 2 {
		t.Fatalf("rules = %v", out)
	}
	if rules[0].(map[string]any)["header"] != "A" || rules[1].(map[string]any)["header"] != "B" {
		t.Errorf("headers = %v", rules)
	}
	r1 := rules[1].(map[string]any)["rule"].(map[string]any)
	if when, _ := r1["when"].(map[string]any); when["to"] != "s2" {
		t.Errorf("when = %v", when)
	}
	for _, r := range rules {
		rm := r.(map[string]any)
		if len(rm["errors"].([]any)) != 0 || rm["codeOnly"] != false {
			t.Errorf("plain rule flagged: %v", rm)
		}
	}
	// An OR list is valid but List cannot show it.
	code, out = compile("rule \"F\":\n  when any becomes \"Done\"\n  if \"Status\" is \"New\", \"Done\"\n")
	rules = rulesOf(out)
	if code != 200 || len(rules) != 1 || rules[0].(map[string]any)["codeOnly"] != true || rules[0].(map[string]any)["reason"] != "or" {
		t.Errorf("or: %d %v", code, out)
	}
	// A named constant is valid but List cannot show it.
	code, out = compile("hook = \"https://h.example/x\"\nrule \"W\":\n  when any becomes \"Done\"\n  do:\n    webhook hook\n")
	rules = rulesOf(out)
	if code != 200 || len(rules) != 1 || rules[0].(map[string]any)["codeOnly"] != true || rules[0].(map[string]any)["reason"] != "constants" {
		t.Errorf("constants: %d %v", code, out)
	}
	// Error lists are always arrays, never null: the Code tab spreads them.
	if out["errors"] == nil {
		t.Errorf("errors must be [], not null: %v", out)
	}
	// Broken text reports line errors on its rule, and the good rule still
	// compiles beside it.
	code, out = compile("rule \"Good\":\n  when created\nrule \"Bad\":\n  when someday\n")
	rules = rulesOf(out)
	if code != 200 || len(rules) != 2 {
		t.Fatalf("mixed: %d %v", code, out)
	}
	if len(rules[0].(map[string]any)["errors"].([]any)) != 0 {
		t.Errorf("good rule flagged: %v", rules[0])
	}
	if len(rules[1].(map[string]any)["errors"].([]any)) == 0 {
		t.Errorf("bad rule not flagged: %v", rules[1])
	}
	// Lists are always arrays, never null: the List tab reads .length on
	// all of them without guards.
	good := rules[0].(map[string]any)["rule"].(map[string]any)
	for _, k := range []string{"do", "allowFrom", "whenProps"} {
		if good[k] == nil {
			t.Errorf("rule[%s] is null, want []: %v", k, good)
		}
	}
	// Text outside any rule is a global error.
	code, out = compile("frob\nrule \"A\":\n  when created\n")
	if code != 200 || len(out["errors"].([]any)) == 0 {
		t.Errorf("global: %d %v", code, out)
	}
}

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

// set_workflow_code replaces the whole process with one code document; the
// proposal path validates without saving and hands the text to the browser.
func TestSetWorkflowCodeTool(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "setcode@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow", `[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	// A process has to exist before code can replace it.
	if _, err := callTool(t, s, u, "add_workflow_rule", `{"page_id":"`+col+`","status_property":"st","when":{"type":"created"},"actions":[]}`); err != nil {
		t.Fatalf("seed process: %v", err)
	}
	src := "rule \"Ship\":\n  when any becomes \"Done\"\n  if \"Status\" is \"New\", \"Done\"\n  do:\n    ask comment always\n"
	out, err := callTool(t, s, u, "set_workflow_code", `{"page_id":"`+col+`","source":`+`"`+escapeJSON(t, src)+`"`+`}`)
	if err != nil {
		t.Fatalf("set_workflow_code: %v", err)
	}
	if !strings.Contains(out, "1 rule") {
		t.Errorf("answer = %q", out)
	}
	var stored string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	var cfg workflowConfig
	if err := json.Unmarshal([]byte(stored), &cfg); err != nil {
		t.Fatal(err)
	}
	// The visual rules are gone: the document is the process now.
	if len(cfg.Rules) != 0 {
		t.Errorf("visual rules survived: %+v", cfg.Rules)
	}
	if len(cfg.Code) != 1 || len(cfg.Code[0].Rules) != 1 {
		t.Fatalf("code = %+v", cfg.Code)
	}
	if cfg.Code[0].Rules[0].When.To != "s2" {
		t.Errorf("compiled rule = %+v", cfg.Code[0].Rules[0])
	}
	// Broken code is refused with the line, and nothing is stored.
	if _, err := callTool(t, s, u, "set_workflow_code", `{"page_id":"`+col+`","source":"rule \"X\":\n  when someday\n"}`); err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Errorf("broken code: %v", err)
	}
	// A proposal validates but does not save; the browser may fetch it, and
	// dismissing drops it.
	prop := "rule \"Ship\":\n  when any becomes \"Done\"\n  do:\n    ask comment always\n\nrule \"Second\":\n  when created\n  do:\n    ask \"Owner\" if empty\n"
	if _, err := s.aiProposeWorkflowCode(u, col, prop, "two rules"); err != nil {
		t.Fatalf("propose: %v", err)
	}
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	if err := json.Unmarshal([]byte(stored), &cfg); err != nil || len(cfg.Code[0].Rules) != 1 {
		t.Errorf("a proposal changed the process: %s", stored)
	}
	rec := requestAs(t, s, cookie, "GET", "/api/collections/"+col+"/workflow/proposal", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "two rules") {
		t.Fatalf("proposal fetch: %d %s", rec.Code, rec.Body.String())
	}
	if code := requestAs(t, s, cookie, "DELETE", "/api/collections/"+col+"/workflow/proposal", "").Code; code != 200 {
		t.Errorf("dismiss: %d", code)
	}
	if rec := requestAs(t, s, cookie, "GET", "/api/collections/"+col+"/workflow/proposal", ""); strings.Contains(rec.Body.String(), "source") {
		t.Errorf("proposal survived a dismiss: %s", rec.Body.String())
	}
}

func escapeJSON(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b[1 : len(b)-1])
}
