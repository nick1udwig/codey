package providers

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	ical "github.com/emersion/go-ical"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
)

// CalDAV imports a rolling agenda. Recurrences are expanded by the calendar
// server, which owns its timezone definitions and recurrence exceptions.
type CalDAV struct {
	HTTP
	Now func() time.Time
}

func (d CalDAV) Describe() Descriptor {
	return Descriptor{ID: "caldav", Name: "CalDAV Calendar", Kind: "event", Auth: []string{"app_password"}, Fields: []Field{{"endpoint", "HTTPS calendar or calendar-home URL", "url"}, {"username", "Username", "text"}, {"token", "App password", "secret"}}, Available: true, IdempotentWrites: true, AbsenceDeletion: true, Capabilities: []string{"event.create"}, Limitations: "Upcoming 90 days, including expanded recurring events. Create events here; edit, delete, invite attendees, and manage recurrence in your calendar app. Requires CalDAV calendar-query with expansion."}
}
func (d CalDAV) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}
func calURL(base, ref string) (string, error) {
	b, e := url.Parse(base)
	if e != nil {
		return "", e
	}
	u, e := url.Parse(ref)
	if e != nil {
		return "", e
	}
	u = b.ResolveReference(u)
	if u.Scheme != "https" || !strings.EqualFold(u.Host, b.Host) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("CalDAV returned an invalid or cross-origin resource")
	}
	return u.String(), nil
}
func (d CalDAV) dav(ctx context.Context, method, endpoint string, creds Credentials, body string, headers map[string]string) ([]byte, http.Header, error) {
	if e := Endpoint(endpoint); e != nil {
		return nil, nil, e
	}
	req, e := http.NewRequestWithContext(ctx, method, endpoint, strings.NewReader(body))
	if e != nil {
		return nil, nil, e
	}
	req.SetBasicAuth(creds.Username, creds.Token)
	req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := d.Client
	if client == nil {
		client = SafeClient(nil)
	}
	resp, e := client.Do(req)
	write := method == "PUT"
	if e != nil {
		return nil, nil, &Failure{State: map[bool]string{true: "delivery_unknown", false: "retryable"}[write]}
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if e != nil || len(raw) > 8<<20 {
		return nil, nil, &Failure{State: map[bool]string{true: "delivery_unknown", false: "retryable"}[write]}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.Header, classify(resp.StatusCode, write)
	}
	return raw, resp.Header, nil
}

type davProp struct {
	Name  string `xml:"DAV: displayname"`
	Types struct {
		Calendar *struct{} `xml:"urn:ietf:params:xml:ns:caldav calendar"`
	} `xml:"DAV: resourcetype"`
	Components struct {
		Values []struct {
			Name string `xml:"name,attr"`
		} `xml:"urn:ietf:params:xml:ns:caldav comp"`
	} `xml:"urn:ietf:params:xml:ns:caldav supported-calendar-component-set"`
	ETag string `xml:"DAV: getetag"`
	Data string `xml:"urn:ietf:params:xml:ns:caldav calendar-data"`
}
type davResponse struct {
	Href   string `xml:"DAV: href"`
	Status string `xml:"DAV: status"`
	Props  []struct {
		Status string  `xml:"DAV: status"`
		Prop   davProp `xml:"DAV: prop"`
	} `xml:"DAV: propstat"`
}

func davResponses(raw []byte) ([]davResponse, error) {
	var v struct {
		XMLName   xml.Name      `xml:"DAV: multistatus"`
		Responses []davResponse `xml:"DAV: response"`
	}
	e := xml.Unmarshal(raw, &v)
	return v.Responses, e
}
func (d CalDAV) Containers(ctx context.Context, b Binding, creds Credentials) ([]Container, error) {
	if creds.Username == "" || creds.Token == "" {
		return nil, fmt.Errorf("CalDAV username and app password are required")
	}
	endpoint := strings.TrimRight(b.Endpoint, "/") + "/"
	raw, _, e := d.dav(ctx, "PROPFIND", endpoint, creds, `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>`, map[string]string{"Depth": "1"})
	if e != nil {
		return nil, e
	}
	values, e := davResponses(raw)
	if e != nil {
		return nil, e
	}
	out := []Container{}
	seen := map[string]bool{}
	for _, r := range values {
		for _, ps := range r.Props {
			if !strings.Contains(ps.Status, " 200 ") || ps.Prop.Types.Calendar == nil {
				continue
			}
			events := len(ps.Prop.Components.Values) == 0
			for _, comp := range ps.Prop.Components.Values {
				if comp.Name == "VEVENT" {
					events = true
				}
			}
			if !events {
				continue
			}
			u, e := calURL(endpoint, r.Href)
			if e != nil {
				return nil, e
			}
			if seen[u] {
				continue
			}
			seen[u] = true
			name := ps.Prop.Name
			if name == "" {
				name = u
			}
			out = append(out, Container{u, name})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("No event calendars found. Enter a calendar URL or calendar-home URL from your calendar app")
	}
	return out, nil
}
func (d CalDAV) decode(raw []byte, href, container, etag string) ([]Remote, error) {
	cal, e := ical.NewDecoder(bytes.NewReader(raw)).Decode()
	if e != nil {
		return nil, e
	}
	out := []Remote{}
	for _, ev := range cal.Events() {
		if ev.Props.Get(ical.PropRecurrenceRule) != nil || ev.Props.Get(ical.PropRecurrenceDates) != nil {
			return nil, fmt.Errorf("Calendar server did not expand recurring events")
		}
		start, e := ev.DateTimeStart(nil)
		if e != nil {
			return nil, e
		}
		end, e := ev.DateTimeEnd(nil)
		if e != nil {
			return nil, e
		}
		prop := ev.Props.Get(ical.PropDateTimeStart)
		if prop == nil {
			return nil, fmt.Errorf("Event has no start")
		}
		allDay := len(prop.Value) == 8
		if !allDay && !strings.HasSuffix(prop.Value, "Z") && prop.Params.Get(ical.PropTimezoneID) == "" {
			return nil, fmt.Errorf("Calendar server returned floating event time; configure a timezone in the calendar")
		}
		layout := time.RFC3339
		if allDay {
			layout = "2006-01-02"
		}
		title, e := ev.Props.Text(ical.PropSummary)
		if e != nil {
			return nil, e
		}
		if title == "" {
			title = "Untitled event"
		}
		description, _ := ev.Props.Text(ical.PropDescription)
		location, _ := ev.Props.Text(ical.PropLocation)
		status, _ := ev.Props.Text(ical.PropStatus)
		uid, _ := ev.Props.Text(ical.PropUID)
		id := href
		if rid := ev.Props.Get(ical.PropRecurrenceID); rid != nil {
			t, e := rid.DateTime(nil)
			if e != nil {
				return nil, e
			}
			id += "#" + url.QueryEscape(t.UTC().Format(time.RFC3339))
		}
		if len(title) > 4096 || len(description) > c.MaxBodyBytes || len(location) > 4096 {
			return nil, fmt.Errorf("Calendar event exceeds collection limits")
		}
		r := c.Record{Kind: "event", Title: title, Start: start.Format(layout), End: end.Format(layout), Location: location, Body: description, BodyComplete: true, Format: "plain", Deleted: status == "CANCELLED", Capabilities: []string{}, Extensions: Raw(map[string]string{"uid": uid})}
		out = append(out, Remote{ID: id, Container: container, Version: etag, Record: r, Raw: Raw(map[string]string{"uid": uid})})
	}
	return out, nil
}
func (d CalDAV) Pull(ctx context.Context, b Binding, creds Credentials, page string) (Page, error) {
	endpoint, e := calURL(strings.TrimRight(b.Endpoint, "/")+"/", b.Container)
	if e != nil {
		return Page{}, e
	}
	today := d.now().UTC().Truncate(24 * time.Hour)
	start := today.AddDate(0, 0, -1) // include ongoing all-day events west of UTC
	end := today.AddDate(0, 0, 90)
	body := fmt.Sprintf(`<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="%s" end="%s"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="%s" end="%s"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`, start.Format("20060102T150405Z"), end.Format("20060102T150405Z"), start.Format("20060102T150405Z"), end.Format("20060102T150405Z"))
	raw, _, e := d.dav(ctx, "REPORT", endpoint, creds, body, map[string]string{"Depth": "1"})
	if e != nil {
		return Page{}, e
	}
	responses, e := davResponses(raw)
	if e != nil {
		return Page{}, e
	}
	out := Page{Records: []Remote{}, Full: true, WindowStart: start, WindowEnd: end}
	for _, v := range responses {
		href, e := calURL(endpoint, v.Href)
		if e != nil {
			return Page{}, e
		}
		var data, etag string
		for _, ps := range v.Props {
			if !strings.Contains(ps.Status, " 200 ") {
				return Page{}, fmt.Errorf("Incomplete CalDAV response")
			}
			if ps.Prop.Data != "" {
				data = ps.Prop.Data
			}
			if ps.Prop.ETag != "" {
				etag = ps.Prop.ETag
			}
		}
		if data == "" {
			return Page{}, fmt.Errorf("Calendar response missing event data")
		}
		records, e := d.decode([]byte(data), href, b.Container, etag)
		if e != nil {
			return Page{}, e
		}
		out.Records = append(out.Records, records...)
	}
	return out, nil
}
func (d CalDAV) Fetch(ctx context.Context, b Binding, creds Credentials, id string) (Remote, error) {
	if strings.Contains(id, "#") {
		return Remote{}, fmt.Errorf("Recurring occurrences are read-only")
	}
	endpoint, e := calURL(b.Endpoint, id)
	if e != nil {
		return Remote{}, e
	}
	raw, h, e := d.dav(ctx, "GET", endpoint, creds, "", nil)
	if e != nil {
		return Remote{}, e
	}
	records, e := d.decode(raw, endpoint, b.Container, h.Get("ETag"))
	if e != nil {
		return Remote{}, e
	}
	if len(records) != 1 {
		return Remote{}, fmt.Errorf("Expected one calendar event")
	}
	return records[0], nil
}

// CreateID lets the sync engine defer importing an uncertain local create until
// its conditional retry has acknowledged the same canonical record.
func (d CalDAV) CreateID(b Binding, record c.Record) (string, error) {
	return calURL(b.Endpoint, strings.TrimRight(b.Container, "/")+"/"+UUID(record.ID)+".ics")
}
func (d CalDAV) Apply(ctx context.Context, b Binding, creds Credentials, id string, in Intent, base *Remote) (ApplyResult, error) {
	if in.Operation.Type != "event.create" || base != nil {
		return ApplyResult{State: "permanent_error"}, nil
	}
	cal := ical.NewCalendar()
	cal.Props.SetText(ical.PropVersion, "2.0")
	cal.Props.SetText(ical.PropProductID, "-//codey//Calendar//EN")
	ev := ical.NewEvent()
	uid := UUID(in.Record.ID) + "@codey"
	ev.Props.SetText(ical.PropUID, uid)
	ev.Props.SetText(ical.PropSummary, in.Record.Title)
	description := in.Record.Description
	if description == "" {
		description = in.Record.Body
	}
	ev.Props.SetText(ical.PropDescription, description)
	ev.Props.SetText(ical.PropLocation, in.Record.Location)
	start, e := c.EventTime(in.Record.Start)
	if e != nil {
		return ApplyResult{}, e
	}
	end, e := c.EventTime(in.Record.End)
	if e != nil {
		return ApplyResult{}, e
	}
	if len(in.Record.Start) == 10 {
		ev.Props.SetDate(ical.PropDateTimeStart, start)
		ev.Props.SetDate(ical.PropDateTimeEnd, end)
	} else {
		ev.Props.SetDateTime(ical.PropDateTimeStart, start.UTC())
		ev.Props.SetDateTime(ical.PropDateTimeEnd, end.UTC())
	}
	stamp, _ := time.Parse(time.RFC3339Nano, in.Record.CreatedAt)
	ev.Props.SetDateTime(ical.PropDateTimeStamp, stamp.UTC())
	cal.Children = append(cal.Children, ev.Component)
	var buf bytes.Buffer
	if e := ical.NewEncoder(&buf).Encode(cal); e != nil {
		return ApplyResult{}, e
	}
	endpoint, e := d.CreateID(b, in.Record)
	if e != nil {
		return ApplyResult{}, e
	}
	_, _, e = d.dav(ctx, "PUT", endpoint, creds, buf.String(), map[string]string{"Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*"})
	if e != nil {
		if f, ok := e.(*Failure); !ok || f.Status != 412 {
			return ApplyResult{}, e
		}
	}
	remote, fetchErr := d.Fetch(ctx, b, creds, endpoint)
	if fetchErr != nil {
		return ApplyResult{}, &Failure{State: "delivery_unknown"}
	}
	// Deterministic resource + UID makes a lost PUT response safe to retry. A
	// collision or external edit must never be overwritten or acknowledged.
	expected := c.Record{Title: in.Record.Title, Start: start.UTC().Format(time.RFC3339), End: end.UTC().Format(time.RFC3339), Location: in.Record.Location, Body: description}
	if len(in.Record.Start) == 10 {
		expected.Start = in.Record.Start
		expected.End = in.Record.End
	}
	gotStart, _ := c.EventTime(remote.Record.Start)
	gotEnd, _ := c.EventTime(remote.Record.End)
	if remote.Record.Title != expected.Title || !gotStart.Equal(start) || !gotEnd.Equal(end) || remote.Record.Location != expected.Location || remote.Record.Body != expected.Body || string(remote.Raw) != string(Raw(map[string]string{"uid": uid})) {
		return ApplyResult{State: "conflict"}, nil
	}
	return ApplyResult{State: "applied", Remote: &remote}, nil
}
