package server

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Relative days in collection filters.
//
// A date filter value may be a calendar day ("2026-10-09") or a word naming a
// day relative to the day the query runs on: "today", "yesterday",
// "tomorrow", or "today" with an offset such as "today-1M" (a month ago) or
// "today+7d" (a week from now). The stored value keeps the word, so a saved
// view reading "after today-1M" stays live — tomorrow it still means a month
// back from tomorrow, where a baked-in date would already lie.
//
// Grammar, case-insensitive, spaces ignored:
//
//	today | yesterday | tomorrow, each with an optional [+-]N[unit] offset
//	unit: d (days, the default when omitted), w (weeks), m (months), y (years)
//
// Months and years shift on the calendar, not by a fixed day count: 2026-03-31
// minus one month is 2026-02-28, clamped to the shorter month's last day.
// Offsets beyond 9999 units are rejected rather than overflowed.
//
// The day resolved is the server's calendar day. The browser preview resolves
// with the viewer's own day (see web/src/smartdate.ts), so around midnight the
// two can disagree across timezones — accepted, the alternative is asking the
// server for the viewer's zone on every row query.
var smartDateRe = regexp.MustCompile(`^(today|yesterday|tomorrow)([+-]\d+)([dwmy])?$`)

// resolveSmartDate names the calendar day a filter value means, in YYYY-MM-DD
// form. ok is false for plain dates ("2026-10-09") and for anything that is
// neither a date nor a recognised word — both pass through untouched.
func resolveSmartDate(s string, now time.Time) (day string, ok bool) {
	norm := strings.ToLower(strings.ReplaceAll(s, " ", ""))
	base := ""
	off := 0
	unit := byte('d')
	switch {
	case norm == "today" || norm == "yesterday" || norm == "tomorrow":
		base = norm
	default:
		m := smartDateRe.FindStringSubmatch(norm)
		if m == nil {
			return "", false
		}
		base = m[1]
		n, err := strconv.Atoi(m[2])
		if err != nil || n > 9999 || n < -9999 {
			return "", false
		}
		off = n
		if m[3] != "" {
			unit = m[3][0]
		}
	}
	y, mth, d := now.Date()
	switch base {
	case "yesterday":
		d--
	case "tomorrow":
		d++
	}
	anchor := time.Date(y, mth, d, 12, 0, 0, 0, now.Location())
	switch unit {
	case 'w':
		anchor = anchor.AddDate(0, 0, off*7)
	case 'm':
		anchor = shiftMonths(anchor, off)
	case 'y':
		anchor = shiftMonths(anchor, off*12)
	default:
		anchor = anchor.AddDate(0, 0, off)
	}
	return anchor.Format("2006-01-02"), true
}

// shiftMonths moves a day by whole calendar months, clamping to the target
// month's last day when the day does not exist there (March 31 minus one
// month is February 28, not March 3, which is what a naive AddDate yields).
func shiftMonths(t time.Time, delta int) time.Time {
	y, m, d := t.Date()
	total := int(m-1) + delta
	ny := y + floorDiv(total, 12)
	nm := time.Month(floorMod(total, 12) + 1)
	last := time.Date(ny, nm+1, 0, 12, 0, 0, 0, t.Location()).Day()
	if d > last {
		d = last
	}
	return time.Date(ny, nm, d, 12, 0, 0, 0, t.Location())
}

func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func floorMod(a, b int) int {
	r := a % b
	if r != 0 && ((r < 0) != (b < 0)) {
		r += b
	}
	return r
}

// resolveDates returns a copy of the condition with every relative day
// replaced by the calendar day it names today, so the SQL below always
// compares static values. Anything that is not a relative day keeps its
// value — the resolver only ever rewrites what it recognises.
func (f rowFilter) resolveDates(now time.Time) rowFilter {
	if v, ok := resolveSmartDate(f.Value, now); ok {
		f.Value = v
	}
	if v, ok := resolveSmartDate(f.Value2, now); ok {
		f.Value2 = v
	}
	if len(f.Values) > 0 {
		vs := make([]string, len(f.Values))
		copy(vs, f.Values)
		for i, v := range vs {
			if r, ok := resolveSmartDate(v, now); ok {
				vs[i] = r
			}
		}
		f.Values = vs
	}
	return f
}
