'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const cfg = require('../config');
const { buildReport } = require('../report/report');

// Orchestrates a single FEA job:
//   1. spawn worker.py  (gmsh -> ccx -> frd parse -> pyvista render -> results.json)
//   2. build the PDF report from results.json + images
function runJob(job, ctx) {
  const { dir, stepPath, onUpdate } = ctx;
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const paramsPath = path.join(dir, 'params.json');
  fs.writeFileSync(paramsPath, JSON.stringify(job.params || {}, null, 2));

  return new Promise((resolve, reject) => {
    onUpdate({ status: 'running', stage: 'meshing', progress: 5 });

    const args = [
      cfg.WORKER,
      '--step', stepPath,
      '--params', paramsPath,
      '--out', dir,
      '--images', imagesDir,
    ];
    const env = Object.assign({}, process.env, { CCX: cfg.CCX });
    const child = spawn(cfg.PYTHON, args, { cwd: dir, env });

    const appendLog = (line) => {
      const entry = { t: Date.now(), line: line.trimEnd() };
      job.log.push(entry);
      // Worker emits "PROGRESS <stage> <pct>" lines to drive the UI.
      const m = /^PROGRESS\s+(\S+)\s+(\d+)/.exec(line);
      if (m) onUpdate({ stage: m[1], progress: Number(m[2]) });
      else onUpdate({});
    };

    let stdoutBuf = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        appendLog(stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (d) => appendLog('[stderr] ' + d.toString()));

    child.on('error', reject);
    child.on('close', async (code) => {
      if (code !== 0) {
        onUpdate({ status: 'error', error: `worker exited with code ${code}` });
        return reject(new Error(`worker exited with code ${code}`));
      }
      try {
        onUpdate({ stage: 'report', progress: 90 });
        const resultsPath = path.join(dir, 'results.json');
        const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        const pdfPath = path.join(dir, 'report.pdf');
        await buildReport({ results, imagesDir, params: job.params, outPath: pdfPath });
        onUpdate({
          status: 'done',
          stage: 'done',
          progress: 100,
          result: { pdf: 'report.pdf', results },
        });
        resolve();
      } catch (err) {
        onUpdate({ status: 'error', error: String(err.stack || err) });
        reject(err);
      }
    });
  });
}

module.exports = { runJob };
