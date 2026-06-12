# nextclaw memory Postgres image: pgvector + pgvectorscale (DiskANN).
#
# Why: pgvector's HNSW index is capped at 2000 dimensions (8 KB index-tuple
# page limit); the deployment's embedder (Qwen3-Embedding-8B) is 4096-d.
# pgvectorscale's StreamingDiskANN (SBQ-compressed layout) indexes high-dim
# vectors, so semantic recall stays index-accelerated without truncating the
# embedding. src/storage/migrate.ts builds a `diskann` index when the
# `vectorscale` extension is present, falling back to `hnsw` otherwise.
#
# The package is the official, PostgreSQL-licensed release from
# timescale/pgvectorscale. Pin both version and arch.
#
# Build (this host is arm64; pass --build-arg VS_ARCH=amd64 on x86):
#   docker build -f dev/vectorscale.Dockerfile -t nextclaw-pg:pg16-vectorscale dev
FROM pgvector/pgvector:pg16

ARG VS_VERSION=0.9.0
ARG VS_ARCH=arm64

ADD https://github.com/timescale/pgvectorscale/releases/download/${VS_VERSION}/pgvectorscale-${VS_VERSION}-pg16-${VS_ARCH}.zip /tmp/vs.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && unzip /tmp/vs.zip -d /tmp/vs \
 && apt-get install -y --no-install-recommends "/tmp/vs/pgvectorscale-postgresql-16_${VS_VERSION}-Linux_${VS_ARCH}.deb" \
 && rm -rf /tmp/vs /tmp/vs.zip \
 && apt-get purge -y unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
