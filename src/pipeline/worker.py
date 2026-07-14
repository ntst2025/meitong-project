#!/usr/bin/env python3
"""
FEA worker for scissor-fea-app.

Pipeline:
  1. Load STEP with gmsh (OCC); each solid = one body.
  2. Boolean-fragment + removeAllDuplicates so shared interfaces become single
     conformal surfaces => bonded assembly (simplification of the reference's contacts).
  3. Mesh 2D globally (conformal shared faces), then 3D per-volume with MeshOnlyVisible
     so one bad body is skipped instead of failing the whole assembly. setOrder(2) => C3D10.
  4. gmsh writes the Abaqus/CalculiX mesh (.inp) with correct node ordering + per-body ELSETs.
  5. Append materials, solid sections, fixed support, load, gravity => full deck; solve with ccx.
  6. Parse .frd nodal Von-Mises; reduce to max per body.
  7. Render mesh + overall + per-body contours (matplotlib Agg; headless-safe).
  8. Write results.json (per-body max stress, material, safety factor, images).

Progress lines on stdout:  PROGRESS <stage> <percent>
"""
import argparse, json, os, re, subprocess, sys, math

def log(*a): print(*a, flush=True)
def progress(stage, pct): print(f"PROGRESS {stage} {int(pct)}", flush=True)

# Consistent unit system: N, mm, MPa, tonne, s
DEFAULT_MATERIALS = {
    "Q235": {"E": 210000.0, "nu": 0.30, "rho": 7.85e-9, "yield": 235.0},
    "Q345": {"E": 210000.0, "nu": 0.30, "rho": 7.85e-9, "yield": 345.0},
    "UHMW": {"E": 800.0,    "nu": 0.42, "rho": 0.95e-9, "yield": 24.3},
}

def load_params(path):
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

# ---------------------------------------------------------------- meshing ----
def mesh_step(step_path, params):
    """Robust assembly meshing that preserves bonding:
       - fragment + removeAllDuplicates => conformal shared surfaces
       - global 2D mesh (shared faces meshed once, conformally)
       - per-volume 3D mesh, extracting tets immediately and rebuilding one
         global node table keyed by rounded coordinate (coincident shared-face
         nodes merge => bonded assembly; interior nodes stay unique).
       Returns (coords{gid:(x,y,z)}, bodies[{elset,etype,elements{eid:[nodes]}}], bbox).
    """
    import gmsh
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.model.add("assembly")
    log(f"Importing STEP: {step_path}")
    gmsh.model.occ.importShapes(step_path)
    gmsh.model.occ.synchronize()
    vols = [t for (d, t) in gmsh.model.getEntities(3)]
    log(f"Solids found: {len(vols)}")
    if not vols:
        raise RuntimeError("No solid volumes in STEP file.")

    if len(vols) > 1 and params.get("bonded", True):
        progress("meshing", 12)
        log("Fragment + removeAllDuplicates (conformal bonded interfaces)...")
        try:
            gmsh.model.occ.fragment([(3, vols[0])], [(3, t) for t in vols[1:]])
            gmsh.model.occ.removeAllDuplicates()
            gmsh.model.occ.synchronize()
            vols = [t for (d, t) in gmsh.model.getEntities(3)]
            log(f"Solids after fragment: {len(vols)}")
        except Exception as e:
            log(f"[warn] fragment failed, meshing as-is: {e}")

    bbox = gmsh.model.getBoundingBox(-1, -1)
    diag = math.dist(bbox[:3], bbox[3:])
    size = float(params.get("meshSize", diag / float(params.get("meshDivisions", 50))))
    gmsh.option.setNumber("Mesh.MeshSizeMin", size * 0.5)
    gmsh.option.setNumber("Mesh.MeshSizeMax", size)
    gmsh.option.setNumber("Mesh.Optimize", 1)
    log(f"Mesh size ~{size:.1f} mm (bbox diag {diag:.0f} mm), linear C3D4")

    progress("meshing", 20)
    gmsh.model.mesh.generate(2)

    # coordinate quantization for merge (bond) — fine relative to model size
    q = 1e-4 * diag
    kmap, coords = {}, {}       # coord-key -> gid ; gid -> xyz

    def gid_of(xyz):
        k = (round(xyz[0] / q), round(xyz[1] / q), round(xyz[2] / q))
        g = kmap.get(k)
        if g is None:
            g = len(kmap) + 1
            kmap[k] = g
            coords[g] = (xyz[0], xyz[1], xyz[2])
        return g

    vtol = (0.02 * size) ** 3       # drop tets thinner than this (sliver/degenerate)

    def clean_tet(g):
        """Return a CalculiX-valid tet (positive jacobian) or None if degenerate."""
        if len(set(g)) != 4:
            return None
        a, b, c, d = (coords[i] for i in g)
        ab = (b[0]-a[0], b[1]-a[1], b[2]-a[2])
        ac = (c[0]-a[0], c[1]-a[1], c[2]-a[2])
        ad = (d[0]-a[0], d[1]-a[1], d[2]-a[2])
        cx = ac[1]*ad[2]-ac[2]*ad[1]
        cy = ac[2]*ad[0]-ac[0]*ad[2]
        cz = ac[0]*ad[1]-ac[1]*ad[0]
        vol = (ab[0]*cx + ab[1]*cy + ab[2]*cz) / 6.0
        if abs(vol) < vtol:
            return None
        return [g[0], g[1], g[3], g[2]] if vol < 0 else g   # swap to make positive

    progress("meshing", 30)
    gmsh.option.setNumber("Mesh.MeshOnlyVisible", 1)
    all_ents = gmsh.model.getEntities()
    bodies, eid_seq, ok, fail = [], 0, 0, 0
    for tg in vols:
        for e in all_ents:
            gmsh.model.setVisibility([e], 0)
        gmsh.model.setVisibility([(3, tg)], 1, recursive=True)
        try:
            gmsh.model.mesh.generate(3)
        except Exception:
            fail += 1
            continue
        et, eta, ena = gmsh.model.mesh.getElements(3, tg)
        if not eta or sum(len(x) for x in eta) == 0:
            continue
        nt, nc, _ = gmsh.model.mesh.getNodes(3, tg, includeBoundary=True)
        loc = {int(nt[i]): (nc[3*i], nc[3*i+1], nc[3*i+2]) for i in range(len(nt))}
        elems = {}
        for j, typ in enumerate(et):
            if typ != 4:            # 4 = 4-node linear tetra
                continue
            conn, tags = ena[j], eta[j]
            for k in range(len(tags)):
                ln = [int(x) for x in conn[k*4:(k+1)*4]]
                g = clean_tet([gid_of(loc[n]) for n in ln])
                if g is None:
                    continue
                eid_seq += 1
                elems[eid_seq] = g
        if elems:
            bodies.append({"elset": f"Volume{tg}", "etype": "C3D4", "elements": elems})
            ok += 1
    gmsh.finalize()
    log(f"3D meshing: {ok} bodies meshed, {fail} skipped; "
        f"{len(coords)} nodes, {eid_seq} tets")
    if not bodies:
        raise RuntimeError("No 3D elements produced (mesh too coarse or geometry invalid).")
    return coords, bodies, bbox

# --------------------------------------------------------------- inp parse ---
def parse_inp(path):
    """Parse a gmsh-written .inp -> (coords, bodies, etype).
       bodies: list of {elset, elements:{eid:[nodes]}}"""
    coords, bodies = {}, []
    mode, cur, etype = None, None, None
    with open(path, "r", errors="ignore") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            if line.startswith("*"):
                u = line.upper()
                if u.startswith("*NODE"):
                    mode = "node"
                elif u.startswith("*ELEMENT"):
                    m = re.search(r"TYPE\s*=\s*(\w+)", u)
                    et = m.group(1) if m else "C3D4"
                    # keep only 3D solid tets/hexes; skip surface/line elements
                    if et.upper().startswith("C3D"):
                        mode = "elem"
                        etype = etype or et
                        ms = re.search(r"ELSET\s*=\s*(\S+)", line)
                        name = ms.group(1) if ms else f"E{len(bodies)+1}"
                        cur = {"elset": name, "elements": {}, "etype": et}
                        bodies.append(cur)
                    else:
                        mode = None
                else:
                    mode = None
                continue
            parts = [p for p in line.replace(",", " ").split() if p]
            if mode == "node":
                nid = int(parts[0]); coords[nid] = tuple(float(x) for x in parts[1:4])
            elif mode == "elem" and cur is not None:
                eid = int(parts[0]); conn = [int(x) for x in parts[1:]]
                cur["elements"][eid] = conn
    # drop empty
    bodies = [b for b in bodies if b["elements"]]
    return coords, bodies, (etype or "C3D4")

# ----------------------------------------------------------- materials/BC ----
def assign_materials(bodies, params):
    mats = dict(DEFAULT_MATERIALS)
    for name, props in (params.get("materials") or {}).items():
        mats.setdefault(name, {}).update(props)
    mmap = params.get("materialMap") or {}
    default_mat = params.get("defaultMaterial", "Q345")
    for i, b in enumerate(bodies, 1):
        b["id"] = i
        b["material"] = mmap.get(str(i), default_mat)
        b["name"] = (params.get("bodyNames") or {}).get(str(i), f"Body{i}")
    return mats

def pick_bc_nodes(coords, bbox, params):
    axis = {"x": 0, "y": 1, "z": 2}[params.get("verticalAxis", "z").lower()]
    lo, hi = bbox[axis], bbox[axis + 3]
    span = (hi - lo) or 1.0
    tol = float(params.get("bcTolerance", 0.03)) * span
    fixed = [n for n, c in coords.items() if c[axis] <= lo + tol]
    top = [n for n, c in coords.items() if c[axis] >= hi - tol]
    if not fixed:
        fixed = sorted(coords, key=lambda n: coords[n][axis])[:max(3, len(coords)//200)]
    if not top:
        top = sorted(coords, key=lambda n: -coords[n][axis])[:max(3, len(coords)//200)]
    return fixed, top, axis

# ------------------------------------------------------------- write deck ----
def write_deck(deck_path, bodies, mats, coords, fixed, top, axis, params):
    total_load = float(params.get("totalLoadN", 8838.0 + 3287.0))
    gval = float(params.get("gravity", 9806.6))
    per_node = total_load / max(1, len(top))
    grav_dir = [0.0, 0.0, 0.0]; grav_dir[axis] = -1.0
    comp = axis + 1

    used = {}
    for b in bodies:
        used[b["material"]] = mats.get(b["material"], DEFAULT_MATERIALS["Q345"])

    with open(deck_path, "w") as f:
        # nodes (all)
        f.write("*NODE, NSET=NALL\n")
        for n in sorted(coords):
            x, y, z = coords[n]
            f.write(f"{n}, {x:.6f}, {y:.6f}, {z:.6f}\n")
        # 3D solid elements, one ELSET per body
        for b in bodies:
            f.write(f"*ELEMENT, TYPE={b['etype']}, ELSET={b['elset']}\n")
            for eid, conn in b["elements"].items():
                f.write(f"{eid}, " + ", ".join(str(x) for x in conn) + "\n")
        # all-elements set (union of per-body elsets)
        f.write("*ELSET, ELSET=EALL\n")
        f.write(",\n".join(b["elset"] for b in bodies) + "\n")
        # materials + sections
        for name, mp in used.items():
            f.write(f"*MATERIAL, NAME={name}\n*ELASTIC\n{mp['E']}, {mp['nu']}\n*DENSITY\n{mp['rho']}\n")
        for b in bodies:
            f.write(f"*SOLID SECTION, ELSET={b['elset']}, MATERIAL={b['material']}\n")
        # BC node sets
        f.write("*NSET, NSET=FIXED\n" + ids_block(fixed))
        f.write("*NSET, NSET=LOADED\n" + ids_block(top))
        # step
        f.write("*STEP\n*STATIC\n")
        f.write("*BOUNDARY\nFIXED, 1, 3, 0.0\n")
        f.write("*CLOAD\n")
        for n in top:
            f.write(f"{n}, {comp}, {-per_node:.5f}\n")
        f.write("*DLOAD\n")
        f.write(f"EALL, GRAV, {gval}, {grav_dir[0]}, {grav_dir[1]}, {grav_dir[2]}\n")
        f.write("*EL FILE\nS\n*NODE FILE\nU\n*END STEP\n")

def ids_block(ids, per_line=8):
    out = []
    for i in range(0, len(ids), per_line):
        out.append(", ".join(str(x) for x in ids[i:i + per_line]))
    return "\n".join(out) + "\n"

# --------------------------------------------------------------- solve -------
def run_ccx(deck_path, out_dir):
    ccx = os.environ.get("CCX", "ccx")
    job = os.path.splitext(os.path.basename(deck_path))[0]
    log(f"Running CalculiX: {ccx} {job}")
    env = dict(os.environ); env.setdefault("OMP_NUM_THREADS", "2")
    p = subprocess.run([ccx, job], cwd=out_dir, capture_output=True, text=True, env=env)
    if p.stdout: log(p.stdout[-1500:])
    frd = os.path.join(out_dir, job + ".frd")
    if p.returncode != 0 or not os.path.exists(frd):
        if p.stderr: log(p.stderr[-1500:])
        raise RuntimeError(f"ccx failed (code {p.returncode})")
    return frd

def parse_frd_vonmises(frd_path):
    vm = {}
    with open(frd_path, "r", errors="ignore") as f:
        lines = f.readlines()
    in_stress = False
    for ln in lines:
        if (" STRESS" in ln) and ("-4" in ln):
            in_stress = True; continue
        if in_stress and ln.startswith(" -3"):
            in_stress = False; continue
        if in_stress and ln.startswith(" -1"):
            try:
                node = int(ln[3:13])
                vals = [float(ln[13 + i*12: 25 + i*12]) for i in range(6)]
            except Exception:
                continue
            sxx, syy, szz, sxy, syz, szx = vals
            vm[node] = math.sqrt(0.5*((sxx-syy)**2+(syy-szz)**2+(szz-sxx)**2)
                                 + 3*(sxy*sxy+syz*syz+szx*szx))
    return vm

# ------------------------------------------------------------- rendering -----
def render_images(coords, bodies, vm, images_dir, params, axis):
    import numpy as np, matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    view = params.get("view", (22, -60))
    vmax_global = max(vm.values()) if vm else 1.0

    def draw(elements, fname, title, colorby=True, vmax=None):
        faces, vals = [], []
        for conn in elements.values():
            c = conn[:4]
            if not all(n in coords for n in c):
                continue
            pts = [coords[n] for n in c]
            for tr in ((0,1,2),(0,1,3),(0,2,3),(1,2,3)):
                faces.append([pts[i] for i in tr])
                if colorby:
                    vals.append(np.mean([vm.get(c[i], 0.0) for i in tr]))
        if not faces:
            return False
        fig = plt.figure(figsize=(10, 6.2))
        ax = fig.add_subplot(111, projection="3d")
        pc = Poly3DCollection(faces, linewidths=0.05, edgecolors=(0,0,0,0.12))
        if colorby and vals:
            arr = np.array(vals)
            pc.set_array(arr); pc.set_cmap("jet")
            pc.set_clim(0, vmax or arr.max() or 1.0)
            cb = fig.colorbar(pc, ax=ax, shrink=0.6, pad=0.02)
            cb.set_label("Von Mises (MPa)")
        else:
            pc.set_facecolor((0.80,0.82,0.88,1.0)); pc.set_edgecolor((0,0,0,0.25))
        ax.add_collection3d(pc)
        allpts = np.array([coords[n] for e in elements.values() for n in e[:4] if n in coords])
        for setlim, i in ((ax.set_xlim,0),(ax.set_ylim,1),(ax.set_zlim,2)):
            setlim(allpts[:,i].min(), allpts[:,i].max())
        try: ax.set_box_aspect((np.ptp(allpts[:,0]), np.ptp(allpts[:,1]), np.ptp(allpts[:,2])))
        except Exception: pass
        ax.view_init(elev=view[0], azim=view[1])
        ax.set_title(title, fontsize=11); ax.set_axis_off()
        fig.savefig(os.path.join(images_dir, fname), dpi=115, bbox_inches="tight")
        plt.close(fig)
        return True

    made = {}
    all_elems = {}
    for b in bodies: all_elems.update(b["elements"])
    if draw(all_elems, "mesh.png", "Mesh", colorby=False): made["mesh"] = "mesh.png"
    if draw(all_elems, "overall.png", "Von Mises Stress - Overall (MPa)", vmax=vmax_global):
        made["overall"] = "overall.png"
    for b in bodies:
        nm = f"body{b['id']}.png"
        if draw(b["elements"], nm, f"{b['name']}  (max {b.get('maxStress',0)} MPa)"):
            made[f"body{b['id']}"] = nm
    return made

# ---------------------------------------------------------------- main -------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", required=True)
    ap.add_argument("--params", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--images", required=True)
    args = ap.parse_args()

    params = load_params(args.params)
    os.makedirs(args.out, exist_ok=True); os.makedirs(args.images, exist_ok=True)

    progress("meshing", 6)
    coords, bodies, bbox = mesh_step(args.step, params)
    etype = bodies[0]["etype"] if bodies else "C3D4"
    mats = assign_materials(bodies, params)
    fixed, top, axis = pick_bc_nodes(coords, bbox, params)
    log(f"BC: {len(fixed)} fixed nodes, {len(top)} loaded nodes, vertical axis idx {axis}")

    progress("solving", 55)
    deck = os.path.join(args.out, "model.inp")
    write_deck(deck, bodies, mats, coords, fixed, top, axis, params)
    frd = run_ccx(deck, args.out)

    progress("post", 72)
    vm = parse_frd_vonmises(frd)
    log(f"Von-Mises nodes parsed: {len(vm)}")

    results_bodies = []
    for b in bodies:
        bn = set()
        for conn in b["elements"].values():
            bn.update(conn)
        vals = [vm[n] for n in bn if n in vm]
        maxs = max(vals) if vals else 0.0
        mat = mats.get(b["material"], DEFAULT_MATERIALS["Q345"])
        y = mat["yield"]
        fos = (y / maxs) if maxs > 0 else None
        b["maxStress"] = round(maxs, 2)
        results_bodies.append({
            "id": b["id"], "name": b["name"], "material": b["material"],
            "yield": y, "maxStress": round(maxs, 2),
            "safetyFactor": round(fos, 2) if fos else None,
            "pass": (maxs < y) if maxs > 0 else True,
            "image": f"body{b['id']}.png",
        })

    progress("render", 82)
    made = render_images(coords, bodies, vm, args.images, params, axis)

    results = {
        "meta": {
            "solver": "CalculiX 2.15 (ccx)", "mesh": "gmsh tetra",
            "element": etype, "nBodies": len(bodies), "nNodes": len(coords),
            "standard": params.get("standard", "EN280 5.2.5.3.1"),
            "loads": {"totalLoadN": float(params.get("totalLoadN", 8838.0 + 3287.0)),
                      "gravity": float(params.get("gravity", 9806.6))},
        },
        "images": made,
        "bodies": results_bodies,
    }
    with open(os.path.join(args.out, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    progress("post", 88)
    log("Worker done.")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback; traceback.print_exc(); sys.exit(1)
