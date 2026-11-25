package server

// Process-code proposals from the in-app agent.
//
// A person editing the Process → Code tab holds an unsaved draft. If the
// agent wrote straight to the database, that write would either be
// overwritten by Save or silently change the process behind the person's
// back. So the in-app agent proposes instead: the text is validated, kept
// here for a few minutes, and the Code tab offers one click to apply it —
// the same path a typed edit takes.
//
// The SSE event carries only the page id. The text itself is fetched through
// a route that checks read access, because a workspace-wide event reaches
// members who may not be allowed to read a private page.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

type workflowProposal struct {
	Source  string
	Summary string
	At      time.Time
	Owner   string
}

// proposalTTL keeps a proposal from surprising somebody hours later.
const proposalTTL = 30 * time.Minute

var workflowProposals = struct {
	sync.Mutex
	m map[string]workflowProposal
}{m: map[string]workflowProposal{}}

func putWorkflowProposal(pageID string, p workflowProposal) {
	workflowProposals.Lock()
	defer workflowProposals.Unlock()
	// Sweep on write: the map only ever holds what people are looking at.
	for id, old := range workflowProposals.m {
		if time.Since(old.At) > proposalTTL {
			delete(workflowProposals.m, id)
		}
	}
	workflowProposals.m[pageID] = p
}

func takeWorkflowProposal(pageID string) (workflowProposal, bool) {
	workflowProposals.Lock()
	defer workflowProposals.Unlock()
	p, ok := workflowProposals.m[pageID]
	if !ok || time.Since(p.At) > proposalTTL {
		return workflowProposal{}, false
	}
	return p, true
}

func dropWorkflowProposal(pageID string) {
	workflowProposals.Lock()
	defer workflowProposals.Unlock()
	delete(workflowProposals.m, pageID)
}

// workflowProposed tells the workspace that a proposal is waiting. Content-free,
// addressed at the workspace: the text is fetched by whoever may read it.
func (s *Server) workflowProposed(pageID string) {
	ws := s.pageWorkspace(pageID)
	if ws == "" {
		return
	}
	b, err := json.Marshal(map[string]string{"type": "workflow-code", "page": pageID})
	if err != nil {
		return
	}
	s.events.broadcastTo(string(b), s.inWorkspace(ws))
}

// aiProposeWorkflowCode validates a document and leaves it for the person in
// the browser. It never writes the process: applying stays a human click.
func (s *Server) aiProposeWorkflowCode(u *user, pageID, source, summary string) (string, error) {
	if pageID == "" {
		return "", fmt.Errorf("page_id is required: the database whose process this is")
	}
	if !s.canWrite(u.ID, pageID) {
		return "", fmt.Errorf("page %q not found", pageID)
	}
	cfg, err := s.compileWorkflowDocument(pageID, "", source)
	if err != nil {
		return "", err
	}
	n := len(cfg.Code[0].Rules)
	putWorkflowProposal(pageID, workflowProposal{
		Source:  source,
		Summary: strings.TrimSpace(summary),
		At:      time.Now(),
		Owner:   u.ID,
	})
	s.workflowProposed(pageID)
	word := "rules"
	if n == 1 {
		word = "rule"
	}
	return fmt.Sprintf("Proposal left for the person: %d %s, nothing saved yet. They see it in Process → Code and apply it with one click. Do not also call set_workflow_code — one path or the other.", n, word), nil
}

// handleWorkflowProposal serves the waiting proposal to a browser that may
// read the page. Always 200: an empty answer is an ordinary state.
func (s *Server) handleWorkflowProposal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canReadReq(r, id) {
		httpError(w, 404, "page not found")
		return
	}
	p, ok := takeWorkflowProposal(id)
	if !ok {
		writeJSON(w, map[string]any{})
		return
	}
	writeJSON(w, map[string]any{
		"source":  p.Source,
		"summary": p.Summary,
		"at":      p.At.UTC().Format(time.RFC3339),
	})
}

// handleDismissWorkflowProposal drops it: the person said no.
func (s *Server) handleDismissWorkflowProposal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canWriteReq(r, id) {
		httpError(w, 404, "page not found")
		return
	}
	dropWorkflowProposal(id)
	writeJSON(w, map[string]any{"ok": true})
}
