# Laporan Implementasi — Improve UI Hermes Web UI (Fase 1 + Fase 2)

- Tanggal: 2026-10-23 · Eksekusi atas perintah user ("gunakan mode mendalam, agen khusus, skill, repo terinstall")
- Repo: `~/workspace/rea-work/hermes-webui/repo` · Branch lokal: `improve/bot-rail-triage` (dari `543252f`) · **Tidak di-push**
- Spec: `UI_IMPROVEMENT_SPEC.md` · Pagar: `DEFICIENCIES.md` · Metode visual: `implementation/README.md`

## Commit (5)

| Hash | Isi |
|---|---|
| `5d9304f3` | Fase 2 — `api/bot_status.py` + `GET /api/bots/status` + `tests/test_bot_status.py` (14 test) |
| `1096ed70` | Fase 1 — modul aditif `static/botrail.js` (rail dua zona, triase, framing, tab Activity) + i18n + CSS |
| `01f9cf74` | fix(review) F1 — kunci `bot_*` untuk locale zh & cs |
| `045695a3` | fix(review) F2/F3/F5/F7 — memoization render, tutup Activity saat tab programatik, refresh badge pasca-switch, tooltip pin |
| `128a73e2` | fix(review) F6 — fallback mtime `bot_status` mengecualikan sidecar underscore |

Diff builder murni aditif +1030/−0 (7 file) — terverifikasi reviewer terhadap baseline.

## Verdict

- **Terverifikasi teknis: YA (bersyarat, syarat terpenuhi).** Reviewer independen menjalankan ulang: gabungan final 10 file test → **89 passed, 1 skipped** (skip sama dengan sebelum fix); ruff `routes.py` 15 vs 15 baseline (pre-existing); `node --check` OK; nol innerHTML/EventSource baru; Fase 2 terbukti read-only di belakang auth global.
- **Diterima visual oleh pengguna: MENUNGGU** — screenshot di `implementation/` (real desktop, mocked multibot, activity panel, narrow, mobile).

## Temuan review (ringkas)

- **F1 HIGH (diperbaiki):** regresi i18n — 17 kunci `bot_*` hanya di `en`; test cakupan zh/cs merah di HEAD, hijau di baseline. Klaim builder "parity 119 lulus" memakai subset yang tidak mencakup dua test ini.
- **F2 MEDIUM (diperbaiki):** DOM rail/attention/breadcrumb dibangun ulang tiap 1 detik (fokus keyboard jatuh, churn). Fix: signature-based render.
- **F3 MEDIUM (diperbaiki):** panel Activity tidak tertutup saat tab Files dibuka programatik (`openArtifactPath`). Fix: wrap `switchWorkspacePanelTab`.
- **F4 MEDIUM (TERBUKA — keputusan user):** pengelompokan "departemen" hanya punya sisi render; `LS_GROUPS` tidak pernah ditulis UI mana pun, dan jalur awalan nama `dept:` tidak viable (nama profil Hermes melarang `:`). Perlu keputusan UX penetapan grup (usulan: menu klik-kanan pada entri bot).
- **F5/F6/F7 LOW (diperbaiki).** **F8 LOW (observasi):** heuristik unread Fase 2 praktis selalu jendela 7 hari karena marker `bot_last_seen.json` tak berpenulis — jujur & terdokumentasi; memperbaikinya butuh endpoint tulis (melanggar read-only).

## Putusan atas 7 gap builder

(a) Latensi attention: **sah** — jalur SSE `sessions_changed` yang sama dengan indikator bawaan (attention_pending/resolved dipublikasikan server; klien coalesce 300ms); tak ada SSE terpisah yang terlewat. (b) Rail mobile absen: **sah** (`.rail` bawaan pun hilang <641px; nav mobile tak disentuh) — bot-switcher mobile = keputusan user. (c) Tab Sessions→chat+filter: **penafsiran sah**. (d) Activity tak mirror PTY mandiri: **sah sebagian** (kartu tool terminal dari transkrip tertangkap; PTY mandiri butuh plumbing baru). (e) Heuristik unread: **jujur/cukup** (lihat F8). (f) Tick 1 dtk: cacatnya rebuild DOM → **diperbaiki via F2**. (g) Nol test JS `botrail.js`: **pola repo** (penjaga lint lulus).

## NOT RUN (batas lingkungan, jujur)

Klik-switch antarprofil end-to-end, event approval sungguhan, indikator Working live, isi feed Activity dari tool run sungguhan — semuanya butuh checkout hermes-agent + model yang tidak ada di VM ini. Full suite 1.776 file tidak dijalankan (RAM ±8GB); cakupan teruji: 288 eksekusi (builder) + run independen reviewer.

## Keputusan menunggu user

1. Penerimaan visual screenshot.
2. F4: UX penetapan grup departemen.
3. Bot-switcher di mobile — diinginkan atau tidak.
4. Terjemahan zh/cs oleh reviewer — cek penutur asli bila nuansa dipedulikan.
