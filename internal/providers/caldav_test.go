package providers

import (
	"context"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCalDAVDiscoveryAndExpandedAgenda(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	d := CalDAV{Now: func() time.Time { return now }, HTTP: HTTP{Client: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "user" || p != "password" {
			t.Fatal("missing credentials")
		}
		if r.Method == "PROPFIND" {
			return reply(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`), nil
		}
		body, _ := io.ReadAll(r.Body)
		if r.Method != "REPORT" || !strings.Contains(string(body), "<c:expand") || r.URL.Path != "/cal/work/" {
			t.Fatal(r.Method, r.URL, string(body))
		}
		return reply(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>meeting.ics</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:meeting
RECURRENCE-ID:20260916T160000Z
DTSTART:20260916T160000Z
DTEND:20260916T170000Z
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:meeting
RECURRENCE-ID:20260917T160000Z
DTSTART:20260917T170000Z
DTEND:20260917T180000Z
SUMMARY:Moved standup
END:VEVENT
END:VCALENDAR
]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`), nil
	})}}}
	b := Binding{Endpoint: "https://calendar.test/cal"}
	creds := Credentials{Username: "user", Token: "password"}
	containers, e := d.Containers(context.Background(), b, creds)
	if e != nil || len(containers) != 1 || containers[0].ID != "https://calendar.test/cal/work/" {
		t.Fatal(containers, e)
	}
	b.Container = containers[0].ID
	page, e := d.Pull(context.Background(), b, creds, "")
	if e != nil || len(page.Records) != 2 || page.WindowStart.IsZero() || !page.Full {
		t.Fatal(page, e)
	}
	if page.Records[0].ID == page.Records[1].ID || page.Records[1].Record.Start != "2026-09-17T17:00:00Z" || len(page.Records[1].Record.Capabilities) != 0 {
		t.Fatal(page)
	}
}
func TestCalDAVCreateRetryAndConflict(t *testing.T) {
	for _, dateOnly := range []bool{false, true} {
		t.Run(map[bool]string{true: "all day", false: "timed"}[dateOnly], func(t *testing.T) {
			var stored, path string
			puts := 0
			d := CalDAV{HTTP: HTTP{Client: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				if r.Method == "PUT" {
					puts++
					body, _ := io.ReadAll(r.Body)
					if r.Header.Get("If-None-Match") != "*" {
						t.Fatal("unconditional write")
					}
					if stored != "" {
						if path != r.URL.Path || stored != string(body) {
							t.Fatal("retry changed identity or body")
						}
						return reply(412, ""), nil
					}
					stored = string(body)
					path = r.URL.Path
					return reply(503, ""), nil
				}
				resp := reply(200, stored)
				resp.Header.Set("ETag", "v1")
				return resp, nil
			})}}}
			b := Binding{Endpoint: "https://calendar.test", Container: "https://calendar.test/cal/work/"}
			r := c.Record{ID: "canonical", Title: "Café, planning; ☕", Description: "line 1\nline 2", Location: "Room A", Start: "2026-09-16T09:00:00-07:00", End: "2026-09-16T10:00:00-07:00", CreatedAt: "2026-09-15T12:00:00Z"}
			if dateOnly {
				r.Start = "2026-09-16"
				r.End = "2026-09-17"
			}
			in := Intent{Record: r, Operation: c.Operation{Type: "event.create"}}
			_, e := d.Apply(context.Background(), b, Credentials{}, "job", in, nil)
			if State(e) != "delivery_unknown" {
				t.Fatal(e)
			}
			result, e := d.Apply(context.Background(), b, Credentials{}, "job", in, nil)
			if e != nil || result.State != "applied" || result.Remote.Record.Title != r.Title || puts != 2 {
				t.Fatal(result, e)
			}
			if dateOnly && result.Remote.Record.Start != r.Start {
				t.Fatal(result.Remote.Record)
			}
			// An external edit after an uncertain PUT is not overwritten or acknowledged.
			original := stored
			stored = strings.ReplaceAll(stored, "Room A", "Room B")
			d.Client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
				if req.Method == "PUT" {
					body, _ := io.ReadAll(req.Body)
					if string(body) != original {
						t.Fatal("changed retry")
					}
					return reply(412, ""), nil
				}
				return reply(200, stored), nil
			})
			result, e = d.Apply(context.Background(), b, Credentials{}, "job", in, nil)
			if e != nil || result.State != "conflict" {
				t.Fatal(result, e)
			}
		})
	}
}
func TestCalDAVRejectsUnsafeAndIncompleteData(t *testing.T) {
	for _, ref := range []string{"https://evil.test/cal/", "//evil.test/cal/", "http://calendar.test/cal/", "https://user:pass@calendar.test/cal/"} {
		if _, e := calURL("https://calendar.test/cal/", ref); e == nil {
			t.Fatal(ref)
		}
	}
	d := CalDAV{}
	for _, extra := range []string{"RRULE:FREQ=DAILY\n", "RDATE:20260917T120000Z\n"} {
		_, e := d.decode([]byte("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a\nDTSTART:20260916T120000Z\nDTEND:20260916T130000Z\n"+extra+"END:VEVENT\nEND:VCALENDAR\n"), "href", "container", "v1")
		if e == nil {
			t.Fatal("unexpanded recurrence accepted")
		}
	}
	_, e := d.decode([]byte("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a\nDTSTART:20260916T120000\nEND:VEVENT\nEND:VCALENDAR\n"), "href", "container", "v1")
	if e == nil {
		t.Fatal("floating time accepted")
	}
}
