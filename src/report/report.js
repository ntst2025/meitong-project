'use strict';
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const RED = '#c00000';

// Cross-platform CJK font resolution. Each candidate is [path, familyForCollection?].
// .ttc collections require the family name as pdfkit's 3rd registerFont arg.
const CJK_CANDIDATES = [
  ['C:/Windows/Fonts/Deng.ttf'],
  ['C:/Windows/Fonts/msyh.ttc', 'Microsoft YaHei'],
  ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 'WenQuanYi Zen Hei'],
  ['/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', 'WenQuanYi Micro Hei'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'Noto Sans CJK SC'],
  ['/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', 'Noto Serif CJK SC'],
];
const CJK_BOLD = [
  ['C:/Windows/Fonts/simhei.ttf'],
  ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 'WenQuanYi Zen Hei'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'Noto Sans CJK SC'],
];

function firstFont(list) {
  for (const c of list) if (fs.existsSync(c[0])) return c;
  return null;
}

// Reproduces the layout of 剪臂输出结果.pdf from real solver results.
function buildReport({ results, imagesDir, params, outPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 56, right: 56 } });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    const regFont = firstFont(CJK_CANDIDATES);
    const boldFont = firstFont(CJK_BOLD) || regFont;
    if (regFont) doc.registerFont('reg', ...regFont);
    if (boldFont) doc.registerFont('bold', ...boldFont);
    const REG = regFont ? 'reg' : 'Helvetica';
    const BOLD = boldFont ? 'bold' : 'Helvetica-Bold';
    const ML = doc.page.margins.left;
    const MR = doc.page.width - doc.page.margins.right;
    const cw = MR - ML;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const imgPath = (n) => (n && fs.existsSync(path.join(imagesDir, n)) ? path.join(imagesDir, n) : null);

    function ensure(space) { if (doc.y + space > bottom()) doc.addPage(); }
    function heading(txt) {
      ensure(40);
      doc.moveDown(0.5);
      doc.font(BOLD).fontSize(13).fillColor(RED).text(txt, ML);
      doc.fillColor('black').moveDown(0.35);
    }
    // Place an image in a full-width box of height h, centered, advancing the cursor.
    function figure(name, h, caption) {
      const p = imgPath(name);
      ensure(h + (caption ? 16 : 6));
      const y = doc.y;
      if (p) {
        doc.image(p, ML, y, { fit: [cw, h], align: 'center', valign: 'center' });
      } else {
        doc.font(REG).fontSize(9).fillColor('#999').text(`[image ${name} unavailable]`, ML, y + h / 2);
        doc.fillColor('black');
      }
      doc.y = y + h;
      if (caption) {
        doc.font(REG).fontSize(8).fillColor('#444').text(caption, ML, doc.y + 2, { width: cw, align: 'center' });
        doc.fillColor('black');
      }
      doc.y += caption ? 14 : 6;
    }

    // ---- Title ----
    doc.font(REG).fontSize(12).fillColor('black').text('针对第三章节，剪臂部分的内容', ML);

    // ---- 1. Mesh ----
    heading('1. 首先有一个网格划分的示意图');
    figure(results.images.mesh, 250, `Mesh · ${results.meta.nBodies} bodies / ${results.meta.nNodes} nodes (${results.meta.element})`);

    // ---- 2. Loads / constraints ----
    heading('2. 添加约束/负载');
    const L = results.meta.loads || {};
    doc.font(BOLD).fontSize(9).text('B: 静态结构', ML);
    doc.font(REG).fontSize(9).fillColor('black')
      .text('静态结构    时间: 1. s', ML)
      .text(`A / B   力 (总载荷): ${L.totalLoadN} N   (施加于顶部平台节点)`, ML)
      .text('C   固定支撑: 底部节点', ML)
      .text('D   位移约束', ML)
      .text(`E   标准地球重力: ${L.gravity} mm/s²`, ML);
    doc.moveDown(0.3);
    figure(results.images.overall, 250, '约束与载荷施加于装配体 (底部固定，顶部加载，整体重力)');

    // ---- 3. Stress contours ----
    heading('3. 整体应力云图，以及每层部件的应力云图');
    figure(results.images.overall, 260, 'Von Mises Stress — Overall');

    // top-N most-stressed bodies, 2-column grid
    const topN = (params && params.maxBodyImages) || 12;
    const bodies = [...(results.bodies || [])].sort((a, b) => b.maxStress - a.maxStress).slice(0, topN);
    const colW = (cw - 18) / 2;
    const cellH = 150;
    for (let i = 0; i < bodies.length; i += 2) {
      ensure(cellH + 18);
      const rowY = doc.y;
      for (let c = 0; c < 2 && i + c < bodies.length; c++) {
        const b = bodies[i + c];
        const x = ML + c * (colW + 18);
        const p = imgPath(b.image);
        if (p) doc.image(p, x, rowY, { fit: [colW, cellH], align: 'center', valign: 'center' });
        doc.font(REG).fontSize(8).fillColor('#333')
          .text(`${b.name} · ${b.material} · max ${b.maxStress} MPa`, x, rowY + cellH + 2, { width: colW, align: 'center' });
        doc.fillColor('black');
      }
      doc.y = rowY + cellH + 16;
    }

    // ---- 4. Safety factor table ----
    doc.addPage();
    heading('4. 最终将结果与材料的强度进行对比');
    doc.font(BOLD).fontSize(11).fillColor('black').text('3.3 Calculation of Safety Factor', ML);
    doc.moveDown(0.3);
    doc.font(REG).fontSize(9).fillColor('black').text(
      'From the stress contours above, the maximum stress of each component (ignoring stress ' +
      'concentration points) is compared with the material yield strength. According to ' +
      `${results.meta.standard}, the safety factor is shown below (Table 3-A):`,
      ML, doc.y, { width: cw, align: 'justify' });
    doc.moveDown(0.6);

    drawTable(doc, REG, BOLD, ML, cw, bottom, results.bodies || []);

    doc.moveDown(1);
    ensure(60);
    doc.font(REG).fontSize(7.5).fillColor('#666').text(
      `Generated by scissor-fea-app · Solver ${results.meta.solver} · Mesh ${results.meta.mesh} ` +
      `(${results.meta.element}, linear tetrahedra) · ${results.meta.nBodies} bodies / ${results.meta.nNodes} nodes. ` +
      `Bonded-interface simplification; linear elements underestimate peak stress at concentrations. ` +
      `These are automated FEA estimates and are NOT a substitute for a signed CAE certification.`,
      ML, doc.y, { width: cw });

    doc.end();
  });
}

function drawTable(doc, REG, BOLD, ML, cw, bottom, bodies) {
  const cols = [
    { t: 'Component', w: 0.24, k: 'name' },
    { t: 'Material', w: 0.14, k: 'material' },
    { t: 'Yield (MPa)', w: 0.16, k: 'yield' },
    { t: 'Max Stress (MPa)', w: 0.20, k: 'maxStress' },
    { t: 'Safety', w: 0.12, k: 'safetyFactor' },
    { t: 'Pass', w: 0.14, k: 'pass' },
  ];
  const rowH = 18;
  let y = doc.y;
  const row = (vals, opts = {}) => {
    if (y + rowH > bottom()) { doc.addPage(); y = doc.page.margins.top; }
    let x = ML;
    doc.font(opts.header ? BOLD : REG).fontSize(8.5);
    cols.forEach((c, i) => {
      const w = c.w * cw;
      doc.rect(x, y, w, rowH).strokeColor('#999').lineWidth(0.5).stroke();
      doc.fillColor(opts.fail && c.k === 'pass' ? RED : 'black')
        .text(String(vals[i]), x + 2, y + 5, { width: w - 4, align: 'center' });
      x += w;
    });
    doc.fillColor('black');
    y += rowH;
    doc.y = y;
  };
  row(cols.map((c) => c.t), { header: true });
  // include only bodies with meaningful stress, sorted desc
  const rows = [...bodies].sort((a, b) => b.maxStress - a.maxStress);
  for (const b of rows) {
    row([b.name, b.material, b.yield, b.maxStress, b.safetyFactor ?? '—', b.pass ? 'Pass' : 'FAIL'],
      { fail: !b.pass });
  }
}

module.exports = { buildReport };
