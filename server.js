'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');

const cfg = require('./src/config');
const { runJob } = require('./src/pipeline/runFea');

fs.mkdirSync(cfg.JOBS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(cfg.PUBLIC_DIR));

// In-memory job registry (persisted per-job on disk under jobs/<id>/job.json).
const jobs = new Map();

function loadJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  const p = path.join(cfg.JOBS_DIR, id, 'job.json');
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    jobs.set(id, j);
    return j;
  }
  return null;
}

function saveJob(job) {
  jobs.set(job.id, job);
  fs.writeFileSync(
    path.join(cfg.JOBS_DIR, job.id, 'job.json'),
    JSON.stringify(job, null, 2)
  );
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const id = req.jobId || (req.jobId = nanoid());
      const dir = path.join(cfg.JOBS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, 'input.step');
    },
  }),
  limits: { fileSize: cfg.MAX_UPLOAD_BYTES },
});

// Create a job: upload STEP + JSON params.
app.post('/api/jobs', upload.single('step'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No STEP file uploaded (field "step").' });
  const id = req.jobId;
  let params = {};
  try {
    params = req.body.params ? JSON.parse(req.body.params) : {};
  } catch (e) {
    return res.status(400).json({ error: 'params must be valid JSON.' });
  }

  const job = {
    id,
    createdAt: new Date().toISOString(),
    status: 'queued',
    stage: 'queued',
    progress: 0,
    log: [],
    params,
    error: null,
    result: null,
  };
  saveJob(job);

  // Fire the pipeline asynchronously.
  runJob(job, {
    dir: path.join(cfg.JOBS_DIR, id),
    stepPath: req.file.path,
    onUpdate(patch) {
      Object.assign(job, patch);
      saveJob(job);
    },
  }).catch((err) => {
    job.status = 'error';
    job.error = String(err && err.stack ? err.stack : err);
    saveJob(job);
  });

  res.json({ id, status: job.status });
});

// Poll job status.
app.get('/api/jobs/:id', (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// Fetch a generated image (mesh / loads / contour) for preview.
app.get('/api/jobs/:id/img/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const p = path.join(cfg.JOBS_DIR, req.params.id, 'images', name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// Download the final PDF report.
app.get('/api/jobs/:id/report.pdf', (req, res) => {
  const p = path.join(cfg.JOBS_DIR, req.params.id, 'report.pdf');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'report not ready' });
  res.download(p, '剪臂输出结果.pdf');
});

app.listen(cfg.PORT, () => {
  console.log(`scissor-fea-app listening on http://localhost:${cfg.PORT}`);
  console.log(`  PYTHON = ${cfg.PYTHON}`);
  console.log(`  CCX    = ${cfg.CCX}`);
});
