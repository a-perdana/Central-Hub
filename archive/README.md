# Central Hub — archived pages

Retired pages, kept for reference. **Nothing in this folder is built or
deployed**: `build.js` lists its HTML files explicitly and none of these are
on that list, and Vercel serves only `dist/`.

| File | What it was | Retired |
|---|---|---|
| `kpi/read-me-kpi.html`, `kpi/school-kpi-admin.html`, `kpi/teacher-kpi-admin.html` | The KPI Management set: a Read Me, the per-school KPI configuration (`teacher_kpi_config`) and the teacher KPI admin view (`teacher_kpi_submissions`). | 2026-10-02, alongside the Academic Hub KPI pages (AH `archive/kpi/`, 2026-10-01). The live pack has no standalone KPI system: "Quantitative operational indicators are embedded within the Appraisal Suite rather than operated as a separate standalone KPI system" (Academic Services: Start Here); legacy KPI trackers "should not be used as a second scoring system" (Appraisal Suite: Quality Assurance & Performance Architecture 26-27). Removed from `build.js`, the navbar (desktop + mobile + `groupKeys`) and the read-me footers. `kpi/dist/` holds the last built copies that were served. The Firestore data (`teacher_kpi_*`) and the `page_access_config` rows are untouched. |
