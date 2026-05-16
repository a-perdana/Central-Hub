import { useState, useEffect, useMemo } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
// Replace with your deployed Apps Script Web App URL
const SHEETS_API_URL = "https://script.google.com/macros/s/AKfycbz8Wiv4ndiecRZSYmbLsOe9DVc8A7BiV0TMHVV_8x9Tz08goc8WVhPQGtMW3umkTyO5/exec";

// Fallback demo data (replaces API when URL not configured)
const DEMO_EVENTS = [
  // July 2025
  { id: 1, date_start: "2025-07-04", date_end: "2025-07-05", title: "New Teacher & Staff Induction / Inset", department: "Admin/Operations", category: "Professional Development" },
  { id: 2, date_start: "2025-07-07", date_end: "2025-07-09", title: "Professional Development (1)", department: "Academic", category: "Professional Development" },
  { id: 3, date_start: "2025-07-10", date_end: "2025-07-12", title: "Guidance Orientation Program (1)", department: "Academic", category: "Student Event" },
  { id: 4, date_start: "2025-07-14", date_end: "2025-07-15", title: "Teacher & Staff Inset", department: "Admin/Operations", category: "Professional Development" },
  { id: 5, date_start: "2025-07-16", date_end: "2025-07-18", title: "New Student Induction", department: "Academic", category: "Student Event" },
  { id: 6, date_start: "2025-07-19", date_end: "2025-07-19", title: "New Parent Induction (1)", department: "Admin/Operations", category: "Parent Event" },
  { id: 7, date_start: "2025-07-21", date_end: "2025-07-21", title: "Start of Semester 1", department: "Academic", category: "Academic" },
  { id: 8, date_start: "2025-07-26", date_end: "2025-07-26", title: "New Parent Induction (2)", department: "Admin/Operations", category: "Parent Event" },
  // August 2025
  { id: 9, date_start: "2025-08-11", date_end: "2025-08-15", title: "Civic Education (PPKn) Week", department: "Academic", category: "Academic Week" },
  { id: 10, date_start: "2025-08-17", date_end: "2025-08-18", title: "Hari Kemerdekaan RI", department: "Admin/Operations", category: "Public Holiday" },
  { id: 11, date_start: "2025-08-21", date_end: "2025-08-22", title: "School Appraisal Visit Cahaya Rancamaya (1)", department: "Academic", category: "Appraisal Visit" },
  { id: 12, date_start: "2025-08-23", date_end: "2025-08-23", title: "National Subject Dept Meeting (1)", department: "Academic", category: "Meeting" },
  { id: 13, date_start: "2025-08-30", date_end: "2025-08-30", title: "Staff Motivation Day (1)", department: "Admin/Operations", category: "Staff Event" },
  // September 2025
  { id: 14, date_start: "2025-09-05", date_end: "2025-09-06", title: "Maulid Nabi Muhammad SAW", department: "Admin/Operations", category: "Public Holiday" },
  { id: 15, date_start: "2025-09-10", date_end: "2025-09-13", title: "C.E. School Visits (KB Jogja)", department: "College Counseling", category: "School Visit" },
  { id: 16, date_start: "2025-09-20", date_end: "2025-09-20", title: "National Subject Dept Meeting (2)", department: "Academic", category: "Meeting" },
  { id: 17, date_start: "2025-09-27", date_end: "2025-09-27", title: "Staff Motivation Day (2)", department: "Admin/Operations", category: "Staff Event" },
  { id: 18, date_start: "2025-09-29", date_end: "2025-10-03", title: "Secondary EASE 1", department: "Academic", category: "Assessment" },
  // October 2025
  { id: 19, date_start: "2025-10-09", date_end: "2025-10-10", title: "School Appraisal Visit Kesatuan Bangsa", department: "Academic", category: "Appraisal Visit" },
  { id: 20, date_start: "2025-10-18", date_end: "2025-10-18", title: "Midterm Semester 1 Report Distribution", department: "Academic", category: "Reporting" },
  { id: 21, date_start: "2025-10-20", date_end: "2025-10-24", title: "Bahasa Indonesia Week", department: "Academic", category: "Academic Week" },
  { id: 22, date_start: "2025-10-21", date_end: "2025-10-22", title: "School Appraisal Visit Mega Islamic Boarding School", department: "Academic", category: "Appraisal Visit" },
  { id: 23, date_start: "2025-10-22", date_end: "2025-10-24", title: "C.E. School Visits Cahaya Rancamaya", department: "College Counseling", category: "School Visit" },
  { id: 24, date_start: "2025-10-25", date_end: "2025-10-25", title: "Staff Motivation Day (3)", department: "Admin/Operations", category: "Staff Event" },
  { id: 25, date_start: "2025-10-28", date_end: "2025-10-28", title: "Sumpah Pemuda Day", department: "Admin/Operations", category: "Public Holiday" },
  // November 2025
  { id: 26, date_start: "2025-11-10", date_end: "2025-11-14", title: "Mathematics Week", department: "Academic", category: "Academic Week" },
  { id: 27, date_start: "2025-11-12", date_end: "2025-11-12", title: "School Appraisal Visit Pakar Belia (1)", department: "Academic", category: "Appraisal Visit" },
  { id: 28, date_start: "2025-11-13", date_end: "2025-11-14", title: "School Appraisal Visit Pribadi Bandung (1)", department: "Academic", category: "Appraisal Visit" },
  { id: 29, date_start: "2025-11-18", date_end: "2025-11-19", title: "C.E. School Visits Prestige", department: "College Counseling", category: "School Visit" },
  { id: 30, date_start: "2025-11-22", date_end: "2025-11-22", title: "National Subject Dept Meeting (4)", department: "Academic", category: "Meeting" },
  { id: 31, date_start: "2025-11-25", date_end: "2025-11-25", title: "National Teacher's Day", department: "Admin/Operations", category: "Public Holiday" },
  { id: 32, date_start: "2025-11-29", date_end: "2025-11-29", title: "Staff Motivation Day (4)", department: "Admin/Operations", category: "Staff Event" },
  // December 2025
  { id: 33, date_start: "2025-12-06", date_end: "2025-12-06", title: "AEASE 1", department: "Academic", category: "Assessment" },
  { id: 34, date_start: "2025-12-08", date_end: "2025-12-12", title: "Secondary EASE 2 & Primary EASE 1", department: "Academic", category: "Assessment" },
  { id: 35, date_start: "2025-12-15", date_end: "2025-12-17", title: "Leadership Camp (1)", department: "Academic", category: "Student Event" },
  { id: 36, date_start: "2025-12-20", date_end: "2025-12-20", title: "Finalterm Semester 1 Report Distribution", department: "Academic", category: "Reporting" },
  { id: 37, date_start: "2025-12-22", date_end: "2025-12-22", title: "Start of Semester 1 Holiday", department: "Academic", category: "Academic" },
  { id: 38, date_start: "2025-12-25", date_end: "2025-12-26", title: "Hari Raya Natal", department: "Admin/Operations", category: "Public Holiday" },
  // January 2026
  { id: 39, date_start: "2026-01-01", date_end: "2026-01-01", title: "Tahun Baru 2026 Masehi", department: "Admin/Operations", category: "Public Holiday" },
  { id: 40, date_start: "2026-01-05", date_end: "2026-01-05", title: "Start of Semester 2", department: "Academic", category: "Academic" },
  { id: 41, date_start: "2026-01-21", date_end: "2026-01-24", title: "C.E. School Visits Kharisma Bangsa", department: "College Counseling", category: "School Visit" },
  { id: 42, date_start: "2026-01-29", date_end: "2026-01-30", title: "School Appraisal Visit Kharisma Bangsa (1)", department: "Academic", category: "Appraisal Visit" },
  { id: 43, date_start: "2026-01-31", date_end: "2026-01-31", title: "Staff Motivation Day (5)", department: "Admin/Operations", category: "Staff Event" },
  // February 2026
  { id: 44, date_start: "2026-02-03", date_end: "2026-02-07", title: "C.E. School Visits Pribadi Depok & Pribadi Premiere", department: "College Counseling", category: "School Visit" },
  { id: 45, date_start: "2026-02-05", date_end: "2026-02-06", title: "School Appraisal Visit SD-SMP-SMA Semesta", department: "Academic", category: "Appraisal Visit" },
  { id: 46, date_start: "2026-02-09", date_end: "2026-02-13", title: "Science Week", department: "Academic", category: "Academic Week" },
  { id: 47, date_start: "2026-02-17", date_end: "2026-02-17", title: "Tahun Baru Imlek 2577", department: "Admin/Operations", category: "Public Holiday" },
  { id: 48, date_start: "2026-02-28", date_end: "2026-02-28", title: "National Subject Dept Meeting (5)", department: "Academic", category: "Meeting" },
  // March 2026
  { id: 49, date_start: "2026-03-07", date_end: "2026-03-07", title: "Staff Motivation Day (6)", department: "Admin/Operations", category: "Staff Event" },
  { id: 50, date_start: "2026-03-09", date_end: "2026-03-13", title: "Secondary EASE 3", department: "Academic", category: "Assessment" },
  { id: 51, date_start: "2026-03-16", date_end: "2026-03-16", title: "Start of Ramadhan Holiday", department: "Academic", category: "Academic" },
  { id: 52, date_start: "2026-03-20", date_end: "2026-03-21", title: "Hari Raya Idul Fitri 1447 H", department: "Admin/Operations", category: "Public Holiday" },
  // April 2026
  { id: 53, date_start: "2026-04-11", date_end: "2026-04-11", title: "Midterm Semester 2 Report Distribution", department: "Academic", category: "Reporting" },
  { id: 54, date_start: "2026-04-18", date_end: "2026-04-18", title: "National Subject Dept Meeting (6)", department: "Academic", category: "Meeting" },
  { id: 55, date_start: "2026-04-20", date_end: "2026-04-24", title: "English Week", department: "Academic", category: "Academic Week" },
  { id: 56, date_start: "2026-04-25", date_end: "2026-04-25", title: "Staff Motivation Day (7)", department: "Admin/Operations", category: "Staff Event" },
  // May 2026
  { id: 57, date_start: "2026-05-09", date_end: "2026-05-09", title: "AEASE 2", department: "Academic", category: "Assessment" },
  { id: 58, date_start: "2026-05-16", date_end: "2026-05-16", title: "Staff Motivation Day (8)", department: "Admin/Operations", category: "Staff Event" },
  { id: 59, date_start: "2026-05-18", date_end: "2026-05-22", title: "Secondary EASE 4 & Primary EASE 2", department: "Academic", category: "Assessment" },
  { id: 60, date_start: "2026-05-23", date_end: "2026-05-25", title: "Leadership Camp (2)", department: "Academic", category: "Student Event" },
  { id: 61, date_start: "2026-05-30", date_end: "2026-05-30", title: "Finalterm Semester 2 Report Distribution", department: "Academic", category: "Reporting" },
];

// ─── DEPARTMENT CONFIG ──────────────────────────────────────────────────────────
const DEPARTMENTS = {
  "Academic": {
    color: "#2563EB",
    bg: "#EFF6FF",
    border: "#BFDBFE",
    dot: "#2563EB",
    label: "Academic"
  },
  "College Counseling": {
    color: "#D97706",
    bg: "#FFFBEB",
    border: "#FDE68A",
    dot: "#D97706",
    label: "College Counseling"
  },
  "Admin/Operations": {
    color: "#059669",
    bg: "#ECFDF5",
    border: "#A7F3D0",
    dot: "#059669",
    label: "Admin / Operations"
  },
};

// Special category overrides
const CATEGORY_OVERRIDES = {
  "Public Holiday": { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA", dot: "#DC2626" },
  "Assessment": { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE", dot: "#7C3AED" },
};

function getEventStyle(event) {
  if (CATEGORY_OVERRIDES[event.category]) return CATEGORY_OVERRIDES[event.category];
  return DEPARTMENTS[event.department] || DEPARTMENTS["Academic"];
}

// ─── UTILS ─────────────────────────────────────────────────────────────────────
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function parseDate(str) {
  const [y, m, d] = String(str).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function eventSpansDay(event, dayStr) {
  const day = parseDate(dayStr);
  const start = parseDate(event.date_start);
  const end = parseDate(event.date_end);
  return day >= start && day <= end;
}

// ─── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function AcademicCalendar() {
  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [events, setEvents] = useState(DEMO_EVENTS);
  const [loading, setLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [view, setView] = useState("month"); // "month" | "list"
  const [activeFilters, setActiveFilters] = useState(new Set(["Academic", "College Counseling", "Admin/Operations"]));
  const [activeCategoryFilters, setActiveCategoryFilters] = useState(new Set(["Public Holiday", "Assessment"]));

  // Fetch from Sheets API
  useEffect(() => {
    if (SHEETS_API_URL === "YOUR_APPS_SCRIPT_WEB_APP_URL") return;
    setLoading(true);
    fetch(SHEETS_API_URL)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data) && data.length > 0) setEvents(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Navigate months
  const prevMonth = () => {
    if (currentMonth === 0) { setCurrentMonth(11); setCurrentYear(y => y - 1); }
    else setCurrentMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (currentMonth === 11) { setCurrentMonth(0); setCurrentYear(y => y + 1); }
    else setCurrentMonth(m => m + 1);
  };

  // Filter events
  const filteredEvents = useMemo(() => events.filter(e => {
    if (CATEGORY_OVERRIDES[e.category]) return activeCategoryFilters.has(e.category);
    return activeFilters.has(e.department);
  }), [events, activeFilters, activeCategoryFilters]);

  // Calendar grid
  const calendarDays = useMemo(() => {
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(d);
    return days;
  }, [currentYear, currentMonth]);

  const getEventsForDay = (day) => {
    if (!day) return [];
    const dayStr = isoDate(new Date(currentYear, currentMonth, day));
    return filteredEvents.filter(e => eventSpansDay(e, dayStr));
  };

  // Upcoming events list
  const upcomingEvents = useMemo(() => {
    const todayStr = isoDate(today);
    return filteredEvents
      .filter(e => e.date_end >= todayStr)
      .sort((a, b) => a.date_start.localeCompare(b.date_start))
      .slice(0, 30);
  }, [filteredEvents]);

  const toggleFilter = (key, setFn) => setFn(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const isToday = (day) => {
    const t = new Date();
    return day === t.getDate() && currentMonth === t.getMonth() && currentYear === t.getFullYear();
  };

  return (
    <div style={{
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      background: "#F8FAFC",
      minHeight: "100vh",
      padding: "0",
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #0F172A 0%, #1E3A5F 60%, #1D4ED8 100%)",
        padding: "28px 32px 24px",
        color: "white",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.2em", color: "#93C5FD", textTransform: "uppercase", marginBottom: 4 }}>
              Eduversal Indonesia
            </div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.5px" }}>
              Academic Calendar 2025–2026
            </h1>
          </div>
          {/* View Toggle */}
          <div style={{ display: "flex", gap: 6, background: "rgba(255,255,255,0.1)", borderRadius: 10, padding: 4 }}>
            {[["month", "📅 Month"], ["list", "📋 List"]].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: "7px 16px", borderRadius: 7, border: "none", cursor: "pointer",
                background: view === v ? "white" : "transparent",
                color: view === v ? "#1E3A5F" : "rgba(255,255,255,0.7)",
                fontWeight: 700, fontSize: 13, transition: "all 0.15s",
              }}>{label}</button>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#CBD5E1", fontWeight: 600, marginRight: 4 }}>Filter:</span>
          {Object.entries(DEPARTMENTS).map(([key, cfg]) => (
            <FilterChip
              key={key}
              label={cfg.label}
              color={cfg.color}
              active={activeFilters.has(key)}
              onClick={() => toggleFilter(key, setActiveFilters)}
            />
          ))}
          {Object.entries(CATEGORY_OVERRIDES).map(([key, cfg]) => (
            <FilterChip
              key={key}
              label={key}
              color={cfg.color}
              active={activeCategoryFilters.has(key)}
              onClick={() => toggleFilter(key, setActiveCategoryFilters)}
            />
          ))}
        </div>
      </div>

      {/* Month Navigator */}
      {view === "month" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 32px 12px" }}>
          <button onClick={prevMonth} style={navBtnStyle}>← Prev</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#0F172A" }}>
              {MONTHS[currentMonth]} {currentYear}
            </div>
          </div>
          <button onClick={nextMonth} style={navBtnStyle}>Next →</button>
        </div>
      )}

      {/* Calendar Grid */}
      {view === "month" && (
        <div style={{ padding: "0 24px 32px" }}>
          {/* Day headers */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
            {DAYS.map(d => (
              <div key={d} style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "#64748B", padding: "6px 0", letterSpacing: "0.05em" }}>
                {d}
              </div>
            ))}
          </div>
          {/* Day cells */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
            {calendarDays.map((day, idx) => {
              const dayEvents = getEventsForDay(day);
              const today_ = isToday(day);
              return (
                <div key={idx} style={{
                  minHeight: 90,
                  background: day ? (today_ ? "#EFF6FF" : "white") : "transparent",
                  borderRadius: 10,
                  border: day ? (today_ ? "2px solid #2563EB" : "1px solid #E2E8F0") : "none",
                  padding: day ? "8px 6px 6px" : 0,
                  position: "relative",
                  transition: "box-shadow 0.15s",
                  cursor: dayEvents.length > 0 ? "pointer" : "default",
                }}>
                  {day && (
                    <>
                      <div style={{
                        fontSize: 13,
                        fontWeight: today_ ? 800 : 500,
                        color: today_ ? "#2563EB" : "#374151",
                        marginBottom: 4,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: today_ ? 24 : "auto",
                        height: today_ ? 24 : "auto",
                        background: today_ ? "#2563EB" : "transparent",
                        color: today_ ? "white" : "#374151",
                        borderRadius: today_ ? "50%" : 0,
                      }}>{day}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {dayEvents.slice(0, 2).map(e => {
                          const style = getEventStyle(e);
                          return (
                            <div
                              key={e.id}
                              onClick={() => setSelectedEvent(e)}
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: style.color,
                                background: style.bg,
                                border: `1px solid ${style.border}`,
                                borderLeft: `3px solid ${style.dot}`,
                                borderRadius: 4,
                                padding: "2px 4px",
                                lineHeight: 1.3,
                                cursor: "pointer",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={e.title}
                            >
                              {e.title}
                            </div>
                          );
                        })}
                        {dayEvents.length > 2 && (
                          <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600, paddingLeft: 2 }}>
                            +{dayEvents.length - 2} more
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* List View */}
      {view === "list" && (
        <div style={{ padding: "24px 32px", maxWidth: 780 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: "#0F172A", marginBottom: 20 }}>
            Upcoming Events
          </h2>
          {upcomingEvents.length === 0 && (
            <div style={{ color: "#94A3B8", textAlign: "center", padding: 40 }}>No events found for selected filters.</div>
          )}
          {upcomingEvents.map((e, i) => {
            const style = getEventStyle(e);
            const sameAsLast = i > 0 && upcomingEvents[i-1].date_start.slice(0,7) === e.date_start.slice(0,7);
            const monthLabel = !sameAsLast ? (
              <div style={{ fontSize: 12, fontWeight: 800, color: "#64748B", letterSpacing: "0.12em", textTransform: "uppercase", marginTop: i > 0 ? 24 : 0, marginBottom: 8 }}>
                {MONTHS[parseInt(e.date_start.split("-")[1])-1]} {e.date_start.split("-")[0]}
              </div>
            ) : null;
            return (
              <div key={e.id}>
                {monthLabel}
                <div onClick={() => setSelectedEvent(e)} style={{
                  display: "flex",
                  gap: 16,
                  alignItems: "flex-start",
                  padding: "12px 16px",
                  background: "white",
                  border: `1px solid #E2E8F0`,
                  borderLeft: `4px solid ${style.dot}`,
                  borderRadius: 10,
                  marginBottom: 6,
                  cursor: "pointer",
                  transition: "box-shadow 0.15s",
                }}>
                  <div style={{ minWidth: 70, textAlign: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase" }}>
                      {MONTHS[parseInt(e.date_start.split("-")[1])-1].slice(0,3)}
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: "#0F172A", lineHeight: 1 }}>
                      {e.date_start.split("-")[2]}
                    </div>
                    {e.date_start !== e.date_end && (
                      <div style={{ fontSize: 10, color: "#94A3B8" }}>– {e.date_end.split("-")[2]}</div>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: "#0F172A", fontSize: 14, marginBottom: 4 }}>{e.title}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Tag color={style.color} bg={style.bg}>{e.department}</Tag>
                      <Tag color="#64748B" bg="#F1F5F9">{e.category}</Tag>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div style={{ padding: "0 32px 32px", display: "flex", gap: 20, flexWrap: "wrap" }}>
        {Object.entries(DEPARTMENTS).map(([key, cfg]) => (
          <LegendItem key={key} color={cfg.color} label={cfg.label} />
        ))}
        {Object.entries(CATEGORY_OVERRIDES).map(([key, cfg]) => (
          <LegendItem key={key} color={cfg.color} label={key} />
        ))}
      </div>

      {/* Event Modal */}
      {selectedEvent && (
        <div onClick={() => setSelectedEvent(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 100, backdropFilter: "blur(4px)",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "white", borderRadius: 16, padding: 28,
            maxWidth: 420, width: "90%", boxShadow: "0 25px 60px rgba(0,0,0,0.2)",
          }}>
            {(() => {
              const style = getEventStyle(selectedEvent);
              return (
                <>
                  <div style={{
                    height: 6, background: style.color,
                    borderRadius: 3, marginBottom: 20, marginTop: -4,
                    marginLeft: -4, marginRight: -4, borderTopLeftRadius: 12, borderTopRightRadius: 12
                  }} />
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 16 }}>
                    <div style={{
                      background: style.bg, border: `1px solid ${style.border}`,
                      borderRadius: 10, padding: "10px 14px", textAlign: "center", minWidth: 60
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: style.color, textTransform: "uppercase" }}>
                        {MONTHS[parseInt(selectedEvent.date_start.split("-")[1])-1].slice(0,3)}
                      </div>
                      <div style={{ fontSize: 24, fontWeight: 900, color: "#0F172A" }}>
                        {selectedEvent.date_start.split("-")[2]}
                      </div>
                    </div>
                    <div>
                      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#0F172A", lineHeight: 1.3 }}>
                        {selectedEvent.title}
                      </h3>
                      {selectedEvent.date_start !== selectedEvent.date_end && (
                        <div style={{ fontSize: 13, color: "#64748B", marginTop: 4 }}>
                          {selectedEvent.date_start} → {selectedEvent.date_end}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                    <Tag color={style.color} bg={style.bg}>{selectedEvent.department}</Tag>
                    <Tag color="#64748B" bg="#F1F5F9">{selectedEvent.category}</Tag>
                  </div>
                  <button onClick={() => setSelectedEvent(null)} style={{
                    width: "100%", padding: "10px", background: "#F1F5F9",
                    border: "none", borderRadius: 8, cursor: "pointer",
                    fontWeight: 700, color: "#64748B", fontSize: 14,
                  }}>Close</button>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SUB-COMPONENTS ─────────────────────────────────────────────────────────────
function FilterChip({ label, color, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px",
      borderRadius: 20,
      border: `2px solid ${active ? color : "rgba(255,255,255,0.25)"}`,
      background: active ? color : "rgba(255,255,255,0.08)",
      color: active ? "white" : "rgba(255,255,255,0.6)",
      fontSize: 12,
      fontWeight: 700,
      cursor: "pointer",
      transition: "all 0.15s",
    }}>
      {label}
    </button>
  );
}

function Tag({ color, bg, children }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700,
      color, background: bg,
      padding: "3px 8px", borderRadius: 5,
    }}>{children}</span>
  );
}

function LegendItem({ color, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 12, height: 12, borderRadius: 3, background: color }} />
      <span style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>{label}</span>
    </div>
  );
}

const navBtnStyle = {
  padding: "8px 16px",
  background: "white",
  border: "1px solid #E2E8F0",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 700,
  color: "#374151",
  fontSize: 13,
};
