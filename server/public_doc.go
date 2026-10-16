package server

import (
	"html"
	"net/http"
	"regexp"
	"strings"
	"unicode"
)

// The public document view: what an anonymous reader gets at /public/{token}.
//
// It used to be the print layout only — A4 sheets on a grey desk. Readers
// asked for the Google Docs shape instead: a continuous borderless page with
// a collapsible outline on the side. So the public page now has two modes:
//
//	?view=continuous  (the default) — one flowing white column, no sheets
//	?view=paged       — the A4 sheets, for checking page breaks and printing
//
// The mode travels in the link like the other print options, and the Print
// button always goes through the paged version (page numbers and the A4
// grid only exist there). The authenticated export/print path is untouched —
// pub == nil renders byte-for-byte what pageHTML always rendered.

// pubView carries public-share rendering: signed file URLs, the view mode,
// and whether the page should offer the print dialog on its own.
type pubView struct {
	Token string // share token, for signed file URLs
	View  string // "continuous" or "paged"
	// AutoPrint opens the print dialog once the paged version is ready.
	// Set from ?print=1, which the dock's printer points at from the
	// continuous view — one click prints instead of two.
	AutoPrint bool
}

// publicDocView reads the public view mode off the link. Anything but an
// explicit paged is the continuous page, so old links keep opening.
func publicDocView(r *http.Request) string {
	if r.URL.Query().Get("view") == "paged" {
		return "paged"
	}
	return "continuous"
}

// tocEntry is one outline row: the heading level, its anchor and its text.
type tocEntry struct {
	Level int
	ID    string
	Text  string
}

// headingRef matches the generated markup's headings, which never carry
// attributes — so a plain pattern is exact, not optimistic. RE2 has no
// backreferences, hence the closing [1-6] instead of \1; the generator always
// opens and closes the same level.
var headingRef = regexp.MustCompile(`<h([1-6])>(.*?)</h[1-6]>`)

// tagRef strips inline markup down to the heading's readable text.
var tagRef = regexp.MustCompile(`<[^>]+>`)

// slugHeading turns heading text into an anchor slug. Unicode-aware on
// purpose: a Russian document must get readable anchors, not "section-7".
func slugHeading(s string) string {
	var sb strings.Builder
	dash := true // collapse runs and trim the edges
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			sb.WriteRune(r)
			dash = false
		case !dash:
			sb.WriteRune('-')
			dash = true
		}
	}
	out := strings.Trim(sb.String(), "-")
	if r := []rune(out); len(r) > 60 {
		out = strings.Trim(string(r[:60]), "-")
	}
	if out == "" {
		out = "section"
	}
	return out
}

// addHeadingIDs gives every heading a stable anchor and collects the outline.
// The document's own title (the first h1) gets an id but no outline row —
// the toolbar already names the document, and Google Docs does the same.
func addHeadingIDs(docHTML string) (string, []tocEntry) {
	seen := map[string]int{}
	var toc []tocEntry
	firstH1 := false
	out := headingRef.ReplaceAllStringFunc(docHTML, func(m string) string {
		sub := headingRef.FindStringSubmatch(m)
		level := int(sub[1][0] - '0')
		inner := sub[2]
		text := strings.TrimSpace(html.UnescapeString(tagRef.ReplaceAllString(inner, "")))
		if len([]rune(text)) > 120 {
			text = string([]rune(text)[:120])
		}
		slug := slugHeading(text)
		seen[slug]++
		id := slug
		if seen[slug] > 1 {
			id = slug + "-" + itoa(seen[slug])
		}
		if level == 1 && !firstH1 {
			firstH1 = true
		} else if text != "" {
			toc = append(toc, tocEntry{Level: level, ID: id, Text: text})
		}
		return `<h` + sub[1] + ` id="` + html.EscapeString(id) + `">` + inner + `</h` + sub[1] + `>`
	})
	return out, toc
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// pubChrome is the whole public-page furniture, and it is all icons: a
// floating outline button at the top left (with a collapse control living on
// the outline itself once it is open) and a bottom-center island with the
// view switch and printing. No top bar — nothing may compete with the text.
func pubChrome(view string, hasTOC bool) string {
	var b strings.Builder
	if hasTOC {
		b.WriteString(`<button class="pub-fab" id="pubtocfab" type="button" title="Contents" aria-label="Contents">` + iconOutline() + `</button>`)
	}
	b.WriteString(`<div class="pub-dock">`)
	// A two-icon switch in its own rounded group: both views stay visible,
	// the active one is filled.
	b.WriteString(`<span class="pub-toggle">`)
	if view == "paged" {
		b.WriteString(`<a class="pub-ibtn" href="?view=continuous" title="Continuous view">` + iconContinuous() + `</a>`)
		b.WriteString(`<span class="pub-ibtn on" title="Paged view" aria-current="true">` + iconPaged() + `</span>`)
	} else {
		b.WriteString(`<span class="pub-ibtn on" title="Continuous view" aria-current="true">` + iconContinuous() + `</span>`)
		b.WriteString(`<a class="pub-ibtn" href="?view=paged" title="Paged view">` + iconPaged() + `</a>`)
	}
	b.WriteString(`</span>`)
	b.WriteString(`<span class="pub-sep"></span>`)
	// Printing goes through the paged version: page numbers and the A4 grid
	// only exist there. From the continuous view the printer goes straight
	// to a paged copy that opens the dialog on its own (?print=1) and comes
	// back afterwards (from=) — one click, not two.
	if view == "paged" {
		b.WriteString(`<button class="pub-ibtn" type="button" title="Print / Save as PDF" onclick="window.print()">` + iconPrint() + `</button>`)
	} else {
		b.WriteString(`<a class="pub-ibtn" href="?view=paged&amp;print=1&amp;from=continuous" title="Print / Save as PDF">` + iconPrint() + `</a>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// Stroke icons, inline so the public page stays one self-contained file.
// Lucide-shaped, drawn by hand: three lines for the outline, two pages for
// the paged view, justified lines for the flow, a printer for printing,
// a chevron for collapsing the outline.
func pubIcon(paths string) string {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` + paths + `</svg>`
}

func iconOutline() string {
	return pubIcon(`<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>`)
}

func iconPaged() string {
	return pubIcon(`<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`)
}

func iconContinuous() string {
	return pubIcon(`<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>`)
}

func iconPrint() string {
	return pubIcon(`<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>`)
}

func iconCollapse() string {
	return pubIcon(`<path d="m15 18-6-6 6-6"/>`)
}

// pubTOC renders the outline sidebar from the collected headings. Static
// HTML on purpose: it is there before any script runs, and the script only
// highlights the row in view. The collapse control lives on the outline
// itself; the floating button outside only reopens it.
func pubTOC(toc []tocEntry) string {
	var b strings.Builder
	b.WriteString(`<aside class="pub-toc" id="pubtoc"><div class="pub-toc-head"><h3>Contents</h3>` +
		`<button class="pub-ibtn small" id="pubtocclose" type="button" title="Hide contents">` + iconCollapse() + `</button></div><nav>`)
	for _, e := range toc {
		b.WriteString(`<a class="toc-l` + string(rune('0'+e.Level)) + `" href="#` + html.EscapeString(e.ID) + `">` +
			html.EscapeString(e.Text) + `</a>`)
	}
	b.WriteString(`</nav></aside>`)
	return b.String()
}

// pubDocStyle dresses the public page around the shared document typography:
// a floating outline button, the bottom island and the outline sidebar. The
// continuous mode is deliberately plain — text on white, like the editor —
// while the paged mode reuses the sheets untouched.
const pubDocStyle = `
.pub-fab{position:fixed;top:16px;left:16px;z-index:50;width:40px;height:40px;display:none;align-items:center;justify-content:center;background:#fff;border:1px solid #e3e2df;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.1);cursor:pointer;color:#1f1f1d}
.pub-fab:hover{background:#f5f5f4}
.pub-fab svg{width:20px;height:20px}
body.toc-hidden .pub-fab{display:flex}
.pub-dock{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:4px;background:#fff;border:1px solid #e3e2df;border-radius:999px;padding:6px;box-shadow:0 4px 20px rgba(0,0,0,.12)}
.pub-ibtn{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:none;border-radius:50%;background:transparent;color:#1f1f1d;cursor:pointer;text-decoration:none}
.pub-ibtn:hover{background:#efeeea}
.pub-ibtn.on{background:#1f1f1d;color:#fff;cursor:default}
.pub-ibtn.on:hover{background:#1f1f1d}
.pub-toggle{display:flex;align-items:center;gap:2px;background:#f5f5f4;border:1px solid #e3e2df;border-radius:999px;padding:3px}
.pub-ibtn svg{width:19px;height:19px}
.pub-ibtn.small{width:40px;height:40px;color:#8a8a85}
.pub-ibtn.small svg{width:20px;height:20px}
.pub-sep{width:1px;height:22px;background:#e3e2df;margin:0 3px}
.pub-wrap{display:flex;align-items:stretch;min-height:100vh}
.pub-toc{flex:none;width:272px;border-right:1px solid #e3e2df;background:#faf9f7;padding:28px 16px 40px;position:sticky;top:0;max-height:100vh;overflow:auto}
.pub-toc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.pub-toc h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#8a8a85;font-weight:600}
.pub-toc nav a{display:block;padding:4px 8px;border-radius:6px;color:#5b5b57;text-decoration:none;font-size:13.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pub-toc nav a:hover{background:#efeeea;color:#1f1f1d}
.pub-toc nav a.on{background:rgba(47,125,79,.13);color:#1f1f1d;font-weight:600}
.toc-l1{padding-left:8px}.toc-l2{padding-left:20px}.toc-l3{padding-left:32px}.toc-l4{padding-left:44px}.toc-l5{padding-left:56px}.toc-l6{padding-left:68px}
body.toc-hidden .pub-toc{display:none}
.pub-main{flex:1;min-width:0}
body.pub-paged .pub-flow{display:none}
body.pub-continuous{background:#fff}
body.pub-continuous .sheets{display:none}
.pub-flow{max-width:750px;margin:0 auto;padding:76px 24px 120px;overflow-wrap:break-word}
.pub-flow .flow-meta{display:none;color:#8a8a85;font-size:.92em;margin:0 0 1.6em}
body.pub-paged .flow-meta{display:none}
body.pub-continuous.opt-cover .pub-flow .flow-meta{display:block}
#pubflow h[id],#sheets h[id]{scroll-margin-top:16px}
@media (max-width:1000px){
.pub-toc{position:fixed;left:0;top:0;bottom:0;z-index:40;width:min(300px,84vw);box-shadow:0 12px 40px rgba(0,0,0,.18);display:none;background:#faf9f7}
/* On narrow screens the floating button is the only way in, so it shows by
   default and hides only behind the open drawer. Without this, a sidebar
   left open on desktop left mobile with neither the outline nor its button. */
.pub-fab{display:flex;top:56px}
body.toc-open .pub-toc{display:block}
body.toc-open .pub-fab{display:none}
.pub-flow{padding:110px 20px 120px}
}
@media print{
.pub-fab,.pub-dock,.pub-toc{display:none!important}
.pub-wrap{display:block;min-height:0}
}`

// pubDocJS starts the public page. Paged mode is the familiar sheet cutter;
// continuous mode pours the same template into one flowing column (width-only
// fitting for wide tables — heights simply grow, nothing is paginated).
// Outline links scroll via script to the VISIBLE copy: the template's own
// copies are inert, so a plain fragment jump would land nowhere.
const pubDocJS = `
function pubStart(view){
  if(view==='paged'){saltStart();pubAutoPrint();}
  else{
    var src=document.getElementById('doc-src'),flow=document.getElementById('pubflow');
    if(src&&flow){flow.appendChild(src.content.cloneNode(true));try{saltFitWide(flow);}catch(e){}}
  }
  try{
    var d=saltDay(SALT_DAY);
    document.querySelectorAll('.flow-day').forEach(function(el){el.textContent=d;});
  }catch(e){}
  pubTOCInit(view);
}
function pubHost(view){
  return view==='paged'?document.getElementById('sheets'):document.getElementById('pubflow');
}
// After an automatic print dialog closes (printed or cancelled), go back to
// the view the reader came from. Only ?print=1 pages do this — a paged view
// opened on purpose stays where it is.
window.addEventListener('afterprint',function(){
  try{
    var q=new URLSearchParams(location.search);
    if(q.get('print')!=='1')return;
    var from=q.get('from');
    if(from!=='continuous'&&from!=='paged')return;
    var u=new URL(location.href);
    u.searchParams.set('view',from);
    u.searchParams.delete('print');
    u.searchParams.delete('from');
    location.replace(u.toString());
  }catch(e){}
});
// A ?print=1 page offers the dialog on its own once the sheets are cut —
// with pictures measured, so nothing spills off the paper. That is the one
// click the dock's printer promises from the continuous view.
function pubAutoPrint(){
  if(!window.SALT_AUTOPRINT)return;
  var go=function(){setTimeout(function(){window.print();},350);};
  try{saltAfterImages(go);}catch(e){setTimeout(function(){window.print();},800);}
}
function pubSetToc(open){
  // One switch for every outline control: the floating button opens, the
  // control on the outline closes. Narrow screens use the drawer class,
  // wide ones hide the sidebar in place.
  var b=document.body;
  try{
    if(window.matchMedia&&matchMedia('(max-width: 1000px)').matches){b.classList.toggle('toc-open',!!open);}
    else{b.classList.toggle('toc-hidden',!open);}
  }catch(e){b.classList.toggle('toc-hidden',!open);}
}
var pubObs=null;
function pubObserve(view){
  try{
    if(pubObs)pubObs.disconnect();
    var links=[].slice.call(document.querySelectorAll('#pubtoc a'));
    if(!links.length||!('IntersectionObserver' in window))return;
    var map={};links.forEach(function(a){map[decodeURIComponent(a.getAttribute('href').slice(1))]=a;});
    var host=pubHost(view);if(!host)return;
    pubObs=new IntersectionObserver(function(es){
      es.forEach(function(e){
        var a=map[e.target.id];if(!a)return;
        if(e.isIntersecting){links.forEach(function(x){x.classList.remove('on');});a.classList.add('on');}
      });
    },{rootMargin:'-15% 0px -75% 0px'});
    host.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').forEach(function(h){pubObs.observe(h);});
  }catch(e){}
}
function pubTOCInit(view){
  var toc=document.getElementById('pubtoc');
  if(toc){
    toc.addEventListener('click',function(e){
      var a=e.target.closest?e.target.closest('a'):null;
      if(!a)return;
      var id=decodeURIComponent(a.getAttribute('href').slice(1));
      var host=pubHost(view);
      var t=host?host.querySelector('[id="'+id.replace(/"/g,'')+'"]'):null;
      if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'});}
      try{
        if(window.matchMedia&&matchMedia('(max-width: 1000px)').matches){document.body.classList.remove('toc-open');}
      }catch(x){}
    });
  }
  var fab=document.getElementById('pubtocfab');
  if(fab){
    fab.addEventListener('click',function(){pubSetToc(true);});
  }
  var close=document.getElementById('pubtocclose');
  if(close){
    close.addEventListener('click',function(){pubSetToc(false);});
  }
  // Sheets are rebuilt (images arriving late re-cut the pages), so the
  // observed copies go stale: re-observe after every pagination pass.
  if(view==='paged'&&typeof saltPaginate==='function'){
    var prev=saltPaginate;
    saltPaginate=function(){prev();pubObserve(view);};
  }
  pubObserve(view);
}
`
