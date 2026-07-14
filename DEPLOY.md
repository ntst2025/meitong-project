# Deploying scissor-fea-app to Render (free tier)

The repo is already committed and Docker/Render-ready (`Dockerfile`, `render.yaml`).
Two steps remain, and **both need your accounts** — they can't be automated from this machine:

## Step 1 — put the repo on GitHub

```bash
# from scissor-fea-app/
git remote add origin https://github.com/<you>/scissor-fea-app.git
git branch -M main
git push -u origin main
```

(Create the empty repo first at https://github.com/new. A **public** repo is simplest for
Render's free tier — no OAuth connection needed.)

## Step 2 — deploy on Render

1. Sign in at https://render.com (free).
2. **New +  →  Blueprint**  →  select your `scissor-fea-app` repo.
3. Render reads `render.yaml`, builds the `Dockerfile`, and starts the service on the free plan.
4. First build takes ~5–10 min (installs CalculiX + gmsh + fonts). The URL appears when live.

That's it — no other configuration. `render.yaml` sets the plan to `free` and Render provides `PORT`.

## Automate it for me

If you drop either of these into the chat, I can finish without you touching a terminal:

- a **GitHub push URL with a token** — `https://<token>@github.com/<you>/scissor-fea-app.git`
  (a fine-grained PAT with `contents:write` on one empty repo), **or**
- a **Render API key** + the repo URL — I'll create the service via the Render API.

## ⚠️ Free-tier reality (important)

Render Free = **512 MB RAM, 0.1 shared CPU, sleeps after 15 min idle**.

- Meshing + CalculiX solving the **full** `80.STEP` (~27k nodes) can **exceed 512 MB and OOM**,
  or run very slowly on 0.1 CPU.
- For the free tier, use a **coarse mesh** — set *Mesh divisions* to **≤ 30** in the form.
  That keeps a job within memory and finishes in a couple of minutes.
- For full-resolution runs, use Render's **Starter** plan (512 MB→2 GB, 1 CPU) or another host.
  The app code is unchanged either way; it's purely a resource ceiling.

The first request after idle wakes the service (~30 s cold start) — normal for free tier.
