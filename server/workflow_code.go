package server

// Human-readable workflow rules ("process code").
//
// A code block is a small Python-flavored program that reads as plain rules:
//
//	rule "На проверку":
//	  when "В работе" becomes "На проверку"
//	  only from "Запланировано", "В работе"
//	  if "Тип" is "Рилс", "Клип"
//	  do:
//	    assign me to "Ответственный"
//	    ask "Дедлайн" if empty
//
// Colons open blocks with a body (rule, do) and nothing else: guard lines
// (when, only from, needs checklist, needs filled, if) never take one.
// Multi-word keywords use spaces, values stay in quotes, and a bare name
// refers to a top-level constant. Names (properties, options, people) are
// written as the user sees them, in quotes; the resolver maps them to
// stored ids. Anything the visual editor can express the DSL can express,
// and back: visual blocks are shown in code view via a generated rendering
// of the same grammar, so a round trip never loses meaning. Code blocks are
// validated on save exactly like visual rules (see validateWorkflowCode)
// and the resolved rules run through the same matcher — there is no second
// engine to drift.

import (
	"fmt"
	"strconv"
	"strings"
)

// A problem found in one code block. Line is 1-based within that block's
// source; the UI jumps the caret to it.
type codeDiag struct {
	Block string
	Line  int
	Msg   string
}

func (d codeDiag) Error() string {
	return fmt.Sprintf("%s, line %d: %s", d.Block, d.Line, d.Msg)
}

type codeMember struct {
	ID   string
	Name string
}

// ---- lexer ----

type codeTokKind int

const (
	tokWord codeTokKind = iota
	tokString
	tokNum
	tokBool
	tokOp
)

type codeTok struct {
	kind codeTokKind
	text string
	pos  int // byte offset of the token in the trimmed line
	end  int // byte offset just past the token
	q    byte // the quote for strings, 0 otherwise
}

// Tokenize one comment-stripped line. Strings accept \" and \\ escapes;
// single quotes allow no escapes at all — pick the other quote instead.
func tokenizeCodeLine(s string) ([]codeTok, *codeDiag) {
	var out []codeTok
	i := 0
	for i < len(s) {
		c := s[i]
		if c == ' ' {
			i++
			continue
		}
		switch {
		case c == '"' || c == '\'':
			var b strings.Builder
			q := c
			start := i
			i++
			closed := false
			for i < len(s) {
				if s[i] == '\\' && q == '"' && i+1 < len(s) && (s[i+1] == '"' || s[i+1] == '\\') {
					b.WriteByte(s[i+1])
					i += 2
					continue
				}
				if s[i] == q {
					closed = true
					i++
					break
				}
				b.WriteByte(s[i])
				i++
			}
			if !closed {
				return nil, &codeDiag{Msg: "unterminated string"}
			}
			out = append(out, codeTok{kind: tokString, text: b.String(), pos: start, end: i, q: q})
		case c >= '0' && c <= '9' || (c == '-' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9'):
			j := i
			if s[j] == '-' {
				j++
			}
			for j < len(s) && ((s[j] >= '0' && s[j] <= '9') || s[j] == '.') {
				j++
			}
			text := s[i:j]
			if _, err := strconv.ParseFloat(text, 64); err != nil {
				return nil, &codeDiag{Msg: fmt.Sprintf("bad number %q", text)}
			}
			out = append(out, codeTok{kind: tokNum, text: text, pos: i, end: j})
			i = j
		case c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			j := i
			for j < len(s) {
				d := s[j]
				isWord := d == '_' || (d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9')
				isDash := d == '-' && !(j+1 < len(s) && s[j+1] == '>')
				if !isWord && !isDash {
					break
				}
				j++
			}
			w := s[i:j]
			pos := i
			if w == "true" || w == "false" {
				out = append(out, codeTok{kind: tokBool, text: w, pos: pos, end: j})
			} else {
				out = append(out, codeTok{kind: tokWord, text: w, pos: pos, end: j})
			}
			i = j
		case c == '-' && strings.HasPrefix(s[i:], "->"):
			out = append(out, codeTok{kind: tokOp, text: "->", pos: i, end: i + 2})
			i += 2
		case c == '=' || c == ',' || c == ':' || c == '*' || c == '[' || c == ']':
			out = append(out, codeTok{kind: tokOp, text: string(c), pos: i, end: i + 1})
			i++
		default:
			return nil, &codeDiag{Msg: fmt.Sprintf("unexpected character %q — names go in quotes", string(c))}
		}
	}
	return out, nil
}

// Strip a trailing # comment, ignoring # inside quotes.
func stripCodeComment(s string) string {
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == '\\' && q == '"' {
				i++
				continue
			}
			if c == q {
				q = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			q = c
			continue
		}
		if c == '#' {
			return s[:i]
		}
	}
	return s
}

// ---- raw (unresolved) model ----

type codeNameRef struct {
	text  string
	line  int
	start int  // token offsets in the trimmed source line
	end   int
	quote byte // the quote for quoted names, 0 for constant references
	dline int  // definition line for constant references, 0 for inline names
}

type codeValue struct {
	kind  string // "str" | "num" | "bool" | "list" | "today"
	text  string // unquoted content, or the number/bool literal
	items []codeValue
	line  int
	start int  // token offsets in the trimmed source line
	end   int
	quote byte // the quote for strings, 0 otherwise
	dline int  // definition line for constant values, 0 for inline ones
}

// A top-level constant: name = value, defined before its first use.
// Referenced by its bare name wherever a value is expected.
type codeConst struct {
	name string
	val  codeValue
	line int
}

type codeCond struct {
	prop codeNameRef
	not  bool
	vals []codeValue // one or more; several mean OR ("is A, B")
	line int
}

type codeAction struct {
	kind string // set|assign|ask|askcomment|today|webhook
	prop codeNameRef
	val  codeValue
	mode string // ask only: "always" | "if_empty" ("if empty" in text)
	url  string // webhook only
	// dline marks a webhook URL taken from a constant (its definition line).
	dline int
	line  int
}

type codeRule struct {
	name      string
	nameLine  int
	headLine  int
	created   bool
	from      *codeNameRef // explicit `A ->` source; nil means any status
	to        codeNameRef  // empty when created
	allowFrom []codeNameRef
	checklist *codeNameRef
	required  *codeNameRef
	conds     []codeCond
	actions   []codeAction
	hasWhen   bool
	hasDo     bool
}

type codeFile struct {
	rules  []codeRule
	consts map[string]codeConst // insertion order irrelevant; use-before-define is an error
}

// ---- structural parser ----

type codeFrameKind int

const (
	frameRoot codeFrameKind = iota
	frameRule
	frameDo
)

type codeFrame struct {
	indent int
	kind   codeFrameKind
	rule   int // rule index for rule/do frames, -1 for root
}

type codeParser struct {
	rules   []codeRule
	consts  map[string]codeConst
	diags   []codeDiag
	stack   []codeFrame
	opener  string // block kind opened by the previous line: "", "rule", "do"
	ruleIdx int    // rule index the pending opener belongs to
}

func (p *codeParser) top() codeFrame {
	return p.stack[len(p.stack)-1]
}

func (p *codeParser) fail(no int, format string, args ...any) {
	p.diags = append(p.diags, codeDiag{Line: no, Msg: fmt.Sprintf(format, args...)})
}

// Parse one code block's source into unresolved rules. Names stay as written;
// resolveWorkflowCode maps them to stored ids against schema and members.
func parseWorkflowCode(source string) (*codeFile, []codeDiag) {
	p := &codeParser{stack: []codeFrame{{indent: -1, kind: frameRoot, rule: -1}}, ruleIdx: -1, consts: map[string]codeConst{}}
	rawLines := strings.Split(source, "\n")
	for ln, raw := range rawLines {
		no := ln + 1
		stripped := stripCodeComment(raw)
		if strings.TrimSpace(stripped) == "" {
			continue
		}
		// Tabs are not indentation: mixing them with spaces makes nesting
		// ambiguous, and an invisible mistake deserves a loud error.
		indent := 0
		for indent < len(stripped) && stripped[indent] == ' ' {
			indent++
		}
		if indent < len(stripped) && stripped[indent] == '\t' {
			p.fail(no, "use spaces for indentation, not tabs")
			continue
		}
		text := strings.TrimSpace(stripped)
		// Webhook URLs do not survive tokenizing (slashes, dots), so
		// tokenize leniently: one word token is enough, parseAction
		// re-slices the raw line for the URL or constant name.
		lower := strings.ToLower(text)
		if lower == "webhook" || strings.HasPrefix(lower, "webhook ") || strings.HasPrefix(lower, "webhook\t") {
			toks := []codeTok{{kind: tokWord, text: "webhook"}}
			top := p.top()
			for len(p.stack) > 1 && p.top().indent > indent {
				p.stack = p.stack[:len(p.stack)-1]
			}
			top = p.top()
			if top.kind == frameRoot {
				p.fail(no, "webhook lives inside a do block")
				continue
			}
			if indent == top.indent && top.kind == frameDo {
				p.opener = ""
				p.parseAction(no, text, toks, top.rule)
				continue
			}
			if p.opener == "do" {
				p.stack = append(p.stack, codeFrame{indent: indent, kind: frameDo, rule: p.ruleIdx})
				p.opener = ""
				top = p.top()
				p.parseAction(no, text, toks, top.rule)
				continue
			}
			p.fail(no, "webhook lives inside a do block")
			continue
		}
		toks, derr := tokenizeCodeLine(text)
		if derr != nil {
			derr.Line = no
			p.diags = append(p.diags, *derr)
			continue
		}
		if len(toks) == 0 {
			continue
		}
		top := p.top()
		// Pop frames deeper than this line; the root frame never pops.
		for len(p.stack) > 1 && p.top().indent > indent {
			p.stack = p.stack[:len(p.stack)-1]
		}
		top = p.top()
		if top.kind == frameRoot {
			// Only rule blocks and top-level constants live at column 0.
			// A deeper line here is the first body line, valid only right
			// after a rule header opened it.
			if indent == 0 {
				p.opener = ""
				if len(toks) > 0 && toks[0].kind == tokWord && toks[0].text == "rule" {
					p.parseRuleHeader(no, toks)
					continue
				}
				p.parseConst(no, toks)
				continue
			}
			if p.opener != "rule" {
				p.fail(no, "unexpected indent — top-level blocks start at column 0")
				continue
			}
			p.stack = append(p.stack, codeFrame{indent: indent, kind: frameRule, rule: p.ruleIdx})
			p.opener = ""
			top = p.top()
			p.parseRuleLine(no, toks, top.rule)
			continue
		}
		if indent == top.indent {
			// A sibling never opens a block; a dangling opener dies here.
			p.opener = ""
			switch top.kind {
			case frameRule:
				p.parseRuleLine(no, toks, top.rule)
			case frameDo:
				p.parseAction(no, text, toks, top.rule)
			}
			continue
		}
		// Deeper than the current block: the previous line must have opened
		// one, and this line is its first child.
		if p.opener == "" {
			p.fail(no, `unexpected indent — an indented block follows only rule "...": or do:`)
			continue
		}
		kind := frameRule
		if p.opener == "do" {
			kind = frameDo
		}
		p.stack = append(p.stack, codeFrame{indent: indent, kind: kind, rule: p.ruleIdx})
		p.opener = ""
		top = p.top()
		switch top.kind {
		case frameRule:
			p.parseRuleLine(no, toks, top.rule)
		case frameDo:
			p.parseAction(no, text, toks, top.rule)
		}
	}
	// A rule left without a when line never fires; flag it where it starts
	// rather than letting a silent rule through.
	for _, r := range p.rules {
		if !r.hasWhen {
			p.fail(r.headLine, "rule %q has no when line", r.name)
		}
	}
	return &codeFile{rules: p.rules, consts: p.consts}, p.diags
}

// parseRuleHeader consumes `rule "Name":` at the top level.
func (p *codeParser) parseRuleHeader(no int, toks []codeTok) {
	if len(toks) == 0 || toks[0].kind != tokWord || toks[0].text != "rule" {
		p.fail(no, `expected a rule block starting with: rule "Name":`)
		return
	}
	rest := toks[1:]
	if len(rest) != 2 || rest[0].kind != tokString || rest[1].kind != tokOp || rest[1].text != ":" {
		p.fail(no, `a rule starts with: rule "Name":`)
		return
	}
	if strings.TrimSpace(rest[0].text) == "" {
		p.fail(no, "rule name must not be empty")
		return
	}
	p.rules = append(p.rules, codeRule{name: rest[0].text, nameLine: no, headLine: no})
	p.ruleIdx = len(p.rules) - 1
	p.opener = "rule"
	p.opener = "rule"
}

// parseConst consumes `name = value` at the top level. Values are
// strings, numbers, true/false or ["quoted", "lists"]; a bare name
// elsewhere refers back to exactly these.
func (p *codeParser) parseConst(no int, toks []codeTok) {
	if len(toks) < 3 || toks[0].kind != tokWord || toks[0].text == "rule" {
		p.fail(no, `expected a rule block starting with: rule "Name":`)
		return
	}
	name := toks[0].text
	if name == "today" || name == "me" {
		p.fail(no, "%q is reserved — pick another constant name", name)
		return
	}
	if _, dup := p.consts[name]; dup {
		p.fail(no, "%q is already defined", name)
		return
	}
	c := &codeCursor{toks: toks[1:], no: no, p: p, ok: true}
	if !c.expectOp("=") {
		p.fail(no, `a constant looks like: name = "value"`)
		return
	}
	val := c.expectValue()
	if val == nil || !c.expectEnd() {
		return
	}
	if val.kind == "today" {
		p.fail(no, "today is not a constant — use it where a date goes")
		return
	}
	p.consts[name] = codeConst{name: name, val: *val, line: no}
}

// parseRuleLine handles one body line of a rule.
func (p *codeParser) parseRuleLine(no int, toks []codeTok, ri int) {
	if len(toks) == 0 || toks[0].kind != tokWord {
		p.fail(no, "expected one of: when, only from, needs checklist, needs filled, if, do")
		return
	}
	r := &p.rules[ri]
	// Two-word keywords read as verbs; the old dashed forms still parse.
	rest := toks[1:]
	kw := toks[0].text
	if kw == "only" && len(toks) > 1 && toks[1].kind == tokWord && toks[1].text == "from" {
		kw = "only from"
		rest = toks[2:]
	}
	if kw == "needs" && len(toks) > 1 && toks[1].kind == tokWord && (toks[1].text == "checklist" || toks[1].text == "filled") {
		kw = "needs " + toks[1].text
		rest = toks[2:]
	}
	switch kw {
	case "when":
		if r.hasWhen {
			p.fail(no, "this rule already has a when line")
			return
		}
		r.hasWhen = true
		p.parseWhen(no, rest, r)
	case "only-from", "only from":
		r.allowFrom = p.parseNameList(no, rest, "only from")
	case "needs-checklist", "needs checklist":
		if r.checklist != nil {
			p.fail(no, "needs checklist is already set for this rule")
			return
		}
		if n := p.parseSingleName(no, rest, "needs checklist"); n != nil {
			r.checklist = n
		}
	case "needs-filled", "needs filled":
		if r.required != nil {
			p.fail(no, "needs filled is already set for this rule")
			return
		}
		if n := p.parseSingleName(no, rest, "needs filled"); n != nil {
			r.required = n
		}
	case "if":
		p.parseIf(no, rest, r)
	case "do":
		if r.hasDo {
			p.fail(no, "this rule already has a do block")
			return
		}
		if len(rest) != 1 || rest[0].kind != tokOp || rest[0].text != ":" {
			p.fail(no, "a do block is just: do:")
			return
		}
		r.hasDo = true
		p.opener = "do"
	default:
		p.fail(no, "unknown rule line %q — expected one of: when, only from, needs checklist, needs filled, if, do", toks[0].text)
	}
}

func (p *codeParser) parseSingleName(no int, toks []codeTok, what string) *codeNameRef {
	c := &codeCursor{toks: toks, no: no, p: p, ok: true}
	// A bare name refers to a string constant defined above.
	if t := c.peek(); t != nil && t.kind == tokWord {
		if cc, ok := p.consts[t.text]; ok {
			if cc.val.kind != "str" {
				p.fail(no, "%q is a list — %s needs one name", t.text, what)
				return nil
			}
			c.next()
			if !c.expectEnd() {
				return nil
			}
			dline := cc.val.dline
			if dline == 0 {
				dline = cc.line
			}
			return &codeNameRef{text: cc.val.text, line: no, start: cc.val.start, end: cc.val.end, quote: cc.val.quote, dline: dline}
		}
	}
	nm := c.expectName("a name in quotes")
	if nm == nil || !c.expectEnd() {
		return nil
	}
	_ = what
	return nm
}

func (p *codeParser) parseNameList(no int, toks []codeTok, what string) []codeNameRef {
	var out []codeNameRef
	c := &codeCursor{toks: toks, no: no, p: p, ok: true}
	// No colon: `only from "A", "B"`. A leading colon from the old
	// `only-from:` form is swallowed for backward compatibility.
	if c.atOp(":") {
		c.next()
	}
	for {
		t := c.peek()
		if t == nil {
			c.errf("expected at least one name")
			return nil
		}
		if t.kind == tokWord {
			cc, ok := p.consts[t.text]
			if !ok {
				c.errf("unknown %q — define it above or put the name in quotes", t.text)
				return nil
			}
			c.next()
			if cc.val.kind == "str" {
				dline := cc.val.dline
				if dline == 0 {
					dline = cc.line
				}
				out = append(out, codeNameRef{text: cc.val.text, line: no, start: cc.val.start, end: cc.val.end, quote: cc.val.quote, dline: dline})
			} else if cc.val.kind == "list" {
				for _, it := range cc.val.items {
					dline := it.dline
					if dline == 0 {
						dline = cc.line
					}
					out = append(out, codeNameRef{text: it.text, line: no, start: it.start, end: it.end, quote: it.quote, dline: dline})
				}
			} else {
				c.errf("%q is not a name", t.text)
				return nil
			}
		} else {
			nm := c.expectName("a quoted name")
			if nm == nil {
				return nil
			}
			out = append(out, *nm)
		}
		if c.atOp(",") {
			c.next()
			continue
		}
		break
	}
	if !c.expectEnd() {
		return nil
	}
	if len(out) == 0 {
		p.fail(no, "%s needs at least one name", what)
		return nil
	}
	return out
}

// when created | when any becomes "B" | when "A" becomes "B"
// Old forms (`when:`, `*`, `->`, `moved`) still parse; new code
// omits the colon and says `becomes`.
func (p *codeParser) parseWhen(no int, toks []codeTok, r *codeRule) {
	c := &codeCursor{toks: toks, no: no, p: p, ok: true}
	if c.atOp(":") {
		c.next()
	}
	if c.peek() == nil {
		p.fail(no, `expected created or a transition like "A" becomes "B"`)
		return
	}
	if c.atWord("created") {
		c.next()
		r.created = true
		c.expectEnd()
		return
	}
	if c.atOp("*") {
		c.next()
	} else if c.atWord("any") {
		c.next()
	} else if nm := c.expectName(`a status like "B"`); nm != nil {
		r.from = nm
	} else {
		return
	}
	// The verb: becomes (new), moved or -> (old). `moved` may add `to`.
	if c.atOp("->") {
		c.next()
	} else if c.atWord("becomes") || c.atWord("moved") {
		moved := c.atWord("moved")
		c.next()
		if moved && c.atWord("to") {
			c.next()
		}
	} else {
		c.errf(`expected "becomes", like "A" becomes "B"`)
		return
	}
	if nm := c.expectName(`a status like "B"`); nm != nil {
		r.to = *nm
	} else {
		return
	}
	c.expectEnd()
}

// if "Prop" is Value [, Value...] — no colon; several values mean OR.
func (p *codeParser) parseIf(no int, toks []codeTok, r *codeRule) {
	c := &codeCursor{toks: toks, no: no, p: p, ok: true}
	if c.atOp(":") {
		c.next()
	}
	prop := c.expectName("a property name")
	if prop == nil {
		return
	}
	if !c.expectWord("is") {
		return
	}
	not := false
	if c.atWord("not") {
		c.next()
		not = true
	}
	var vals []codeValue
	for {
		v := c.expectValue()
		if v == nil {
			return
		}
		if v.kind == "list" {
			vals = append(vals, v.items...)
		} else {
			vals = append(vals, *v)
		}
		if c.atOp(",") {
			c.next()
			continue
		}
		break
	}
	if len(vals) == 0 || !c.expectEnd() {
		return
	}
	r.conds = append(r.conds, codeCond{prop: *prop, not: not, vals: vals, line: no})
}

// do-block actions.
func (p *codeParser) parseAction(no int, raw string, toks []codeTok, ri int) {
	r := &p.rules[ri]
	c := &codeCursor{toks: toks, no: no, p: p, ok: true}
	if len(toks) == 0 || toks[0].kind != tokWord {
		p.fail(no, "expected one of: set, assign, ask, today, webhook")
		return
	}
	switch toks[0].text {
	case "set":
		c.next()
		prop := c.expectName("a property name")
		if prop == nil {
			return
		}
		if !c.expectOp("=") {
			return
		}
		val := c.expectValue()
		if val == nil || !c.expectEnd() {
			return
		}
		r.actions = append(r.actions, codeAction{kind: "set", prop: *prop, val: *val, line: no})
	case "assign":
		c.next()
		if !c.expectWord("me") {
			return
		}
		// New: `assign me to "Prop"`; the old `->` still parses.
		if c.atWord("to") {
			c.next()
		} else if !c.expectOp("->") {
			return
		}
		prop := p.parseSingleName(no, c.toks[c.pos:], "assign me to")
		if prop == nil {
			return
		}
		c.pos = len(c.toks)
		r.actions = append(r.actions, codeAction{kind: "assign", prop: *prop, line: no})
	case "ask":
		c.next()
		var prop codeNameRef
		isComment := false
		if c.atWord("comment") {
			c.next()
			isComment = true
		} else {
			pr := c.expectName("a property name")
			if pr == nil {
				return
			}
			prop = *pr
		}
		var mode string
		if c.atWord("always") {
			c.next()
			mode = "always"
		} else if c.atWord("if") {
			c.next()
			if !c.expectWord("empty") {
				return
			}
			mode = "if_empty"
		} else {
			p.fail(no, `say when to ask: "always" or "if empty"`)
			return
		}
		if !c.expectEnd() {
			return
		}
		if isComment {
			r.actions = append(r.actions, codeAction{kind: "askcomment", mode: mode, line: no})
		} else {
			r.actions = append(r.actions, codeAction{kind: "ask", prop: prop, mode: mode, line: no})
		}
	case "today":
		c.next()
		if !c.expectOp("->") {
			return
		}
		prop := c.expectName("a date property")
		if prop == nil || !c.expectEnd() {
			return
		}
		r.actions = append(r.actions, codeAction{kind: "today", prop: *prop, line: no})
	case "webhook":
		c.next()
		// URLs do not survive tokenizing (slashes, dots), so take the raw
		// remainder of the line instead. A bare name refers to a string
		// constant holding the URL.
		rest := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "webhook"))
		if rest == "" {
			p.fail(no, "webhook needs a URL")
			return
		}
		if strings.Contains(rest, " ") || strings.Contains(rest, "\t") {
			p.fail(no, "webhook URL must not contain spaces")
			return
		}
		url := rest
		udline := 0
		if cc, ok := p.consts[rest]; ok {
			if cc.val.kind != "str" {
				p.fail(no, "%q is a list — webhook needs one URL", rest)
				return
			}
			url = cc.val.text
			udline = cc.line
		} else if strings.HasPrefix(rest, `"`) || strings.HasPrefix(rest, `'`) {
			p.fail(no, "webhook takes a bare URL or a constant name, without quotes")
			return
		} else if _, ok := p.consts[rest]; !ok && !strings.Contains(rest, "://") && !strings.HasPrefix(rest, "http") {
			// A bare word that is neither a constant nor a URL: point at
			// the constant table instead of a cryptic scheme error.
			if len(rest) < 64 && !strings.ContainsAny(rest, "/.:") {
				p.fail(no, "unknown %q — define it above as a constant or write the full URL", rest)
				return
			}
		}
		r.actions = append(r.actions, codeAction{kind: "webhook", url: url, dline: udline, line: no})
	default:
		p.fail(no, "unknown action %q — expected one of: set, assign, ask, today, webhook", toks[0].text)
	}
}

// ---- per-line cursor ----

type codeCursor struct {
	toks []codeTok
	pos  int
	no   int
	p    *codeParser
	ok   bool
}

func (c *codeCursor) failed() bool {
	return !c.ok
}

func (c *codeCursor) errf(format string, args ...any) {
	if c.ok {
		c.ok = false
		c.p.fail(c.no, format, args...)
	}
}

func (c *codeCursor) peek() *codeTok {
	if c.pos < len(c.toks) {
		return &c.toks[c.pos]
	}
	return nil
}

func (c *codeCursor) next() {
	if c.pos < len(c.toks) {
		c.pos++
	}
}

func (c *codeCursor) atWord(w string) bool {
	t := c.peek()
	return t != nil && t.kind == tokWord && t.text == w
}

func (c *codeCursor) atOp(o string) bool {
	t := c.peek()
	return t != nil && t.kind == tokOp && t.text == o
}

func (c *codeCursor) expectWord(w string) bool {
	if !c.atWord(w) {
		c.errf("expected %q here", w)
		return false
	}
	c.next()
	return true
}

func (c *codeCursor) expectOp(o string) bool {
	if !c.atOp(o) {
		c.errf("expected %q here", o)
		return false
	}
	c.next()
	return true
}

func (c *codeCursor) expectName(what string) *codeNameRef {
	t := c.peek()
	if t == nil || t.kind != tokString {
		c.errf("expected %s, like \"Name\"", what)
		return nil
	}
	c.next()
	return &codeNameRef{text: t.text, line: c.no, start: t.pos, end: t.end, quote: t.q}
}

// A value: "quoted", number, true/false, today, ["a", "b"] lists of
// quoted names, or a bare constant name defined above.
func (c *codeCursor) expectValue() *codeValue {
	t := c.peek()
	if t == nil {
		c.errf("expected a value")
		return nil
	}
	switch t.kind {
	case tokString:
		c.next()
		return &codeValue{kind: "str", text: t.text, line: c.no, start: t.pos, end: t.end, quote: t.q}
	case tokNum:
		c.next()
		return &codeValue{kind: "num", text: t.text, line: c.no, start: t.pos, end: t.end}
	case tokBool:
		c.next()
		return &codeValue{kind: "bool", text: t.text, line: c.no, start: t.pos, end: t.end}
	case tokWord:
		if t.text == "today" {
			c.next()
			return &codeValue{kind: "today", text: "today", line: c.no, start: t.pos, end: t.end}
		}
		if c.p != nil {
			if cc, ok := c.p.consts[t.text]; ok {
				c.next()
				out := cc.val
				out.line = c.no
				if out.dline == 0 {
					out.dline = cc.line
				}
				if out.kind == "list" {
					items := make([]codeValue, len(out.items))
					for i, it := range out.items {
						items[i] = it
						if items[i].dline == 0 {
							items[i].dline = cc.line
						}
					}
					out.items = items
				}
				return &out
			}
		}
		c.errf("unknown %q — define it above as a constant or put the value in quotes", t.text)
		return nil
	case tokOp:
		if t.text == "[" {
			return c.expectList()
		}
	}
	c.errf("expected a value: \"text\", 123, true/false, today, or [\"a\", \"b\"]")
	return nil
}

func (c *codeCursor) expectList() *codeValue {
	start := c.no
	c.next() // [
	var items []codeValue
	for {
		t := c.peek()
		if t == nil {
			c.errf("unterminated [ list — close it with ]")
			return nil
		}
		if t.kind == tokOp && t.text == "]" {
			c.next()
			break
		}
		if t.kind != tokString {
			c.errf("lists hold quoted names, like [\"A\", \"B\"]")
			return nil
		}
		items = append(items, codeValue{kind: "str", text: t.text, line: c.no, start: t.pos, end: t.end, quote: t.q})
		c.next()
		if c.atOp(",") {
			c.next()
			continue
		}
		if c.atOp("]") {
			continue
		}
		c.errf("separate list items with commas")
		return nil
	}
	return &codeValue{kind: "list", items: items, line: start}
}

// restText returns the unparsed remainder of the line (for webhook URLs).
func (c *codeCursor) restText() string {
	// Reconstruct from tokens is lossy for URLs; the caller re-slices the
	// original line instead. This helper only reports whether anything is
	// left at all.
	var b strings.Builder
	for _, t := range c.toks[c.pos:] {
		b.WriteString(t.text)
		b.WriteString(" ")
	}
	return strings.TrimSpace(b.String())
}

func (c *codeCursor) expectEnd() bool {
	if c.peek() != nil {
		if c.peek().text == ":" {
			c.errf("remove the trailing colon — only rule and do end with a colon")
			return false
		}
		c.errf("unexpected %q here", c.peek().text)
		return false
	}
	return true
}
