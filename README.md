# scissor-fea-app

Web app that turns a **STEP assembly** into a structural **FEA report PDF** modelled on
`剪臂输出结果.pdf` (mesh → loads/constraints → Von-Mises stress contours → EN280 safety-factor table).

The report is produced from a **real finite-element solve** — nothing is fabricated.

## Pipeline

```
Browser (upload STEP + params)
   └─ Express server.js
        └─ src/pipeline/worker.py   (Python)
             1. gmsh  : import STEP, fragment+dedup (bonded), mesh
             2. build CalculiX deck (materials, fixed base, top load, gravity)
             3. ccx   : static solve  ->  .frd
             4. parse Von-Mises per node, reduce to max per body
             5. matplotlib: mesh / overall / per-body stress images
        └─ src/report/report.js     (pdfkit)  -> report.pdf  (CJK layout)
```

## Toolchain (portable, under `..\tools`)

| Tool | Version | Path |
|------|---------|------|
| Node.js | 24.18.0 | `..\tools\node-v24.18.0-win-x64` |
| Python  | 3.12.7  | `..\tools\python\python.exe` (gmsh, numpy, matplotlib) |
| CalculiX (ccx) | 2.15 MT | `..\tools\calculix\ccx.exe` |

## Run

```powershell
.\start.ps1
# open http://localhost:3000
```

## API

- `POST /api/jobs`  — multipart: `step` (file), `params` (JSON). Returns `{id}`.
- `GET  /api/jobs/:id` — job status/progress/log.
- `GET  /api/jobs/:id/img/:name` — a generated PNG.
- `GET  /api/jobs/:id/report.pdf` — the report.

### Parameters (all optional)

| key | default | meaning |
|-----|---------|---------|
| `totalLoadN` | 12125 | total downward load on top nodes (N) |
| `gravity` | 9806.6 | gravity (mm/s²) |
| `defaultMaterial` | Q345 | material for bodies (Q235 / Q345 / UHMW) |
| `materialMap` | {} | `{ "<bodyId>": "Q235" }` per-body override |
| `verticalAxis` | z | axis used to pick fixed (bottom) / loaded (top) nodes |
| `meshDivisions` | 50 | bbox-diagonal / this = element size |
| `elementOrder` | 1 | 1 = C3D4 linear tets (v1) |
| `bonded` | true | fragment interfaces so touching bodies bond |

## Known limitations (honest scope)

- **Bonded interfaces** replace the reference's frictional/joint contacts — a simplification.
- **Linear tetrahedra (C3D4)** underestimate peak stress at concentrations; a C3D10 upgrade
  is the main accuracy improvement to make next.
- Load/constraint faces are picked by a **bounding-box heuristic** (fix bottom, load top),
  not by user face-selection. Fine for upright scissor lifts; verify for other geometry.
- Small fasteners below the mesh size are skipped; the main structural bodies dominate results.
- Output is an **automated engineering estimate — not a substitute for a signed CAE certification.**

## Next steps

1. C3D10 quadratic elements (verify gmsh→ccx node ordering) for accurate peak stress.
2. Interactive face-picking for loads/BCs (three.js viewer of the STEP).
3. Auto-name bodies from STEP product names (JCC-100W…) instead of Body1..N.
4. Per-body material auto-assignment (steel vs UHMW sliding blocks) from part metadata.
5. Upgrade multer 1.x → 2.x.
