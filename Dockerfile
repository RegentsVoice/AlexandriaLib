FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    python3-dev \
    build-essential \
    libsndfile1 \
    libgomp1 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY python/requirements.txt python/hf_compat.py python/tts_server.py ./python/
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY auth.js db.js server.js ./

RUN python3 -m venv /app/python/.venv \
    && /app/python/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/python/.venv/bin/pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r /app/python/requirements.txt

ENV NODE_ENV=production
ENV PORT=8766
ENV HOST=0.0.0.0
ENV TORCH_HOME=/app/python/.torch
ENV HF_HOME=/app/python/.hf
ENV NODE_OPTIONS=--no-warnings

RUN mkdir -p /app/books /app/data /app/python/.torch /app/python/.hf

EXPOSE 8766

VOLUME ["/app/books", "/app/data", "/app/python/.torch", "/app/python/.hf"]

CMD ["node", "server.js"]
