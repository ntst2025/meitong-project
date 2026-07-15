# scissor-fea-app — Node web server + Python FEA worker (gmsh + CalculiX) on Linux.
FROM node:20-bookworm-slim

# System deps: Python + numpy/matplotlib (apt = fast, no heavy pip build),
# CalculiX solver, gmsh runtime libs, and a CJK font for the PDF report.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-numpy python3-matplotlib \
      calculix-ccx \
      libgl1 libglu1-mesa libgomp1 libx11-6 libxext6 libxft2 libxrender1 \
      libxcursor1 libxinerama1 libfontconfig1 \
      fonts-wqy-zenhei fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# gmsh Python API (not packaged for apt) — wheel bundles its own libs.
RUN pip3 install --no-cache-dir --break-system-packages gmsh

# Symlink whatever versioned ccx the package installed to a stable name.
RUN set -eux; ccx="$(ls /usr/bin/ccx* 2>/dev/null | head -n1)"; \
    test -n "$ccx"; ln -sf "$ccx" /usr/local/bin/ccx; /usr/local/bin/ccx -v || true

ENV PYTHON=python3 \
    CCX=/usr/local/bin/ccx \
    OMP_NUM_THREADS=2 \
    PORT=10000 \
    NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
