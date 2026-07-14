'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.resolve(ROOT, '..', 'tools');

// Resolve an external tool. Priority:
//   1. explicit env var (a path OR a bare command like "python3"/"ccx") — trusted as-is
//   2. a portable copy bundled under ../tools
//   3. fall back to a bare command resolved from PATH at spawn time
function tool(envVal, candidates, fallbackOnPath) {
  if (envVal) return envVal;
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return fallbackOnPath;
}

module.exports = {
  ROOT,
  TOOLS,
  PORT: process.env.PORT || 3000,
  JOBS_DIR: path.join(ROOT, 'jobs'),
  PUBLIC_DIR: path.join(ROOT, 'public'),

  // Python interpreter that has: gmsh, numpy, matplotlib (used by worker.py)
  PYTHON: tool(
    process.env.PYTHON,
    [path.join(TOOLS, 'python', 'python.exe')],
    process.platform === 'win32' ? 'python' : 'python3'
  ),

  // CalculiX solver executable (ccx). Passed to worker.py via env.
  CCX: tool(
    process.env.CCX,
    [
      path.join(TOOLS, 'calculix', 'ccx.exe'),
      path.join(TOOLS, 'calculix', 'ccx_static.exe'),
    ],
    'ccx'
  ),

  WORKER: path.join(ROOT, 'src', 'pipeline', 'worker.py'),

  // Max upload size for STEP files
  MAX_UPLOAD_BYTES: 200 * 1024 * 1024,
};
