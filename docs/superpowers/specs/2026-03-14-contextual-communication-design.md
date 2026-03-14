# Contextual Communication — Design Spec

**Date:** 2026-03-14
**Platform:** Central Hub (CentralHub)
**Status:** Approved for implementation

---

## Problem

Announcements, documents, and messageboard topics exist on separate pages with no connection to each other. When a topic like "Cambridge Accreditation 2025" is active, the related announcement, supporting documents, and discussion thread are in three different places. There is no shared context tying them together.

---

## Goal

Transform messageboard topics into lightweight contextual workspaces. Each topic can hold a status, deadline, category, attached documents, and a linked announcement — so everything related to one subject lives in one place.

---

## Scope

Four pages are affected:

- `messageboard.html` — topic creation form + topic list view
- `index.html` — Active Boards dashboard widget
- `documents.html` — document upload form
- `announcements.html` — announcement creation form

No new pages are added. No new Firestore collections are created. All changes are additive and backward-compatible.

---

## Data Model

New fields added to `topics/{topicId}` in Firestore:

| Field | Type | Default | Notes |
|---|---|---|---|
| `status` | `'open' \| 'in_progress' \| 'closed'` | `'open'` | Required on creation |
| `deadline` | `timestamp \| null` | `null` | Optional |
| `category` | `string \| null` | `null` | Free text, e.g. "Akreditasyon", "Müfredat" |
| `attachments` | `Array<{name, url, uploadedAt, uploadedBy}>` | `[]` | Files attached directly to the topic |
| `linkedAnnouncementId` | `string \| null` | `null` | Reference to `announcements/{id}` |

Existing topics without these fields remain valid. All new fields are treated as nullable. Firestore rules do not change — topic writes are already restricted to `central_admin`.

---

## UI Changes

### 1. `messageboard.html` — Topic Creation / Edit Form

Add below the existing message body field (separated by a dashed divider):

- **Kategori** — free-text input (or predefined dropdown: Akreditasyon, Müfredat, Genel, Personel)
- **Deadline** — date picker, optional
- **İlişkili Duyuru** — dropdown populated from `announcements` collection, optional (Phase 3)
- **Ekler** — drag-and-drop file upload area, optional (Phase 2)

### 2. `messageboard.html` — Topic List View

Each topic card in the list shows:

- Status badge: `OPEN` (green) / `IN PROGRESS` (amber) / `CLOSED` (grey)
- Category badge: teal pill (if set)
- Deadline badge: red pill with ⏰ icon (if set and upcoming)
- Attachment count: `📎 N` suffix on the meta line (if > 0)

Closed topics render with muted background (`#f9fafb`) and muted text color.

### 3. `index.html` — Active Boards Widget

The existing "Active Boards" panel on the dashboard currently shows topic title + reply count. Updated to also show:

- Status badge (small, 9px)
- Category badge (small, if set)
- Deadline badge (red, if set)
- Attachment count suffix (`📎 N`)

Only `open` and `in_progress` topics appear in the dashboard widget. Closed topics are excluded.

### 4. `documents.html` — Upload Form

Add one new optional field after the existing category dropdown:

- **Topic'e Ekle** — dropdown populated from open/in-progress topics. Selecting a topic appends the document to that topic's `attachments[]` array in addition to saving it to `central_documents`.

### 5. `announcements.html` — Creation Form

Add one new optional field at the bottom of the form:

- **İlişkili Konu** — dropdown populated from open/in-progress topics. Selecting a topic sets `linkedAnnouncementId` on the topic document.

A preview note below the field reads: *"Bu duyuru seçilen topic sayfasında İlişkili Duyuru olarak görünecek."*

---

## Implementation Phases

### Phase 1 — Status, Deadline, Category (no file uploads, no announcement linking)

Files changed: `messageboard.html`, `index.html`

- Add `status` dropdown (required, default `'open'`) to topic creation form
- Add `deadline` date picker (optional) to topic creation form
- Add `category` text/dropdown (optional) to topic creation form
- Render status + deadline + category badges in topic list
- Update `index.html` Active Boards widget to show badges; filter out closed topics

**Deliverable:** Topics have structure and urgency at a glance, on both the messageboard and the dashboard.

### Phase 2 — File Attachments

Files changed: `messageboard.html`, `documents.html`

- Add drag-and-drop file area to topic creation and edit form
- Upload files to Firebase Storage at `topics/{topicId}/attachments/{filename}`
- Write `attachments[]` array to the topic document on save
- Render attachment chips in topic list view
- Add "Topic'e Ekle" dropdown to `documents.html` upload form; when selected, append to topic's `attachments[]`

### Phase 3 — Announcement Linking

Files changed: `messageboard.html`, `announcements.html`

- Add "İlişkili Duyuru" dropdown to topic creation form; write `linkedAnnouncementId` to topic
- Add "İlişkili Konu" dropdown to announcement creation form; write `linkedAnnouncementId` to topic
- In `messageboard.html` topic detail view, fetch and display the linked announcement as a highlighted card

---

## Out of Scope

- No changes to Firestore rules
- No new collections
- No read-receipt or notification system (separate feature area)
- No school-level scoping (topics remain platform-wide)
- No mobile-specific layout changes

---

## Success Criteria

- A `central_admin` can create a topic with status, deadline, and category in one form submission
- The dashboard Active Boards widget shows status and deadline without navigating away
- A document uploaded via `documents.html` can be attached to a topic in the same upload flow
- An announcement can be linked to a topic so both sides reference each other
