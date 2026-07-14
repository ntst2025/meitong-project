const $ = (id) => document.getElementById(id);

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('step').files[0];
  if (!file) return;

  const params = {
    totalLoadN: Number($('totalLoadN').value),
    gravity: Number($('gravity').value),
    defaultMaterial: $('defaultMaterial').value,
    verticalAxis: $('verticalAxis').value,
    meshDivisions: Number($('meshDivisions').value),
    elementOrder: Number($('elementOrder').value),
    bonded: $('bonded').checked,
  };

  const fd = new FormData();
  fd.append('step', file);
  fd.append('params', JSON.stringify(params));

  $('run').disabled = true;
  $('statusCard').hidden = false;
  $('resultCard').hidden = true;
  setStage('上传中 uploading…', 2);

  const res = await fetch('/api/jobs', { method: 'POST', body: fd });
  const { id, error } = await res.json();
  if (error) { setStage('错误: ' + error, 0); $('run').disabled = false; return; }
  poll(id);
});

function setStage(txt, pct) {
  $('stage').textContent = txt;
  if (pct != null) $('barfill').style.width = pct + '%';
}

async function poll(id) {
  const res = await fetch('/api/jobs/' + id);
  const job = await res.json();
  setStage(`${job.stage} · ${job.status}`, job.progress);
  $('log').textContent = (job.log || []).slice(-40).map((l) => l.line).join('\n');
  $('log').scrollTop = $('log').scrollHeight;

  if (job.status === 'done') { showResult(id, job); $('run').disabled = false; return; }
  if (job.status === 'error') { setStage('❌ ' + (job.error || 'failed'), job.progress); $('run').disabled = false; return; }
  setTimeout(() => poll(id), 1500);
}

function showResult(id, job) {
  $('resultCard').hidden = false;
  $('pdf').href = `/api/jobs/${id}/report.pdf`;
  const r = job.result.results;
  const imgs = r.images || {};
  const prev = $('preview');
  prev.innerHTML = '';
  for (const [k, name] of Object.entries(imgs)) {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img src="/api/jobs/${id}/img/${name}"><figcaption>${k}</figcaption>`;
    prev.appendChild(fig);
  }
  const t = $('table');
  t.innerHTML = '<tr><th>Component</th><th>Material</th><th>Yield (MPa)</th>' +
    '<th>Max Stress (MPa)</th><th>Safety</th><th>Pass?</th></tr>' +
    r.bodies.map((b) => `<tr><td>${b.name}</td><td>${b.material}</td><td>${b.yield}</td>` +
      `<td>${b.maxStress}</td><td>${b.safetyFactor ?? '—'}</td>` +
      `<td class="${b.pass ? '' : 'fail'}">${b.pass ? 'Pass' : 'FAIL'}</td></tr>`).join('');
}
