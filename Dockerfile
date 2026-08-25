# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for MEK-Org/meta-coder packaging (PR-2)

# --- Stage 1: Flutter Builder ---
FROM ubuntu:22.04 AS flutter-builder

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies needed by Flutter
RUN apt-get update && apt-get install -y \
    curl \
    git \
    unzip \
    xz-utils \
    libglu1-mesa \
    && rm -rf /var/lib/apt/lists/*

# Clone Flutter SDK version 3.41.5
RUN git clone --depth 1 --branch 3.41.5 https://github.com/flutter/flutter.git /usr/local/flutter
ENV PATH="/usr/local/flutter/bin:${PATH}"

# Pre-download development binaries and disable analytics
RUN flutter config --no-analytics
RUN flutter doctor

WORKDIR /app

# Copy dashboard source and its submodule dependencies
COPY packages/rusa/flutter_dashboard ./packages/rusa/flutter_dashboard
COPY third_party/glass_goals ./third_party/glass_goals

WORKDIR /app/packages/rusa/flutter_dashboard
RUN flutter pub get
RUN flutter build web --release

# --- Stage 2: Node Runtime ---
FROM node:24-slim AS runtime

# Install system runtime dependencies:
# - git (needed by the git-bridge)
# - python3, make, g++ (needed for rebuilding better-sqlite3 native bindings)
# (Do NOT install bwrap - under this profile, the container itself is the sandbox boundary)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    make \
    g++ \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Install the workspace package manager and the provider CLIs used by both the
# setup and service containers. Keeping these in the shared runtime image makes
# the login-time and runtime CLI versions identical.
RUN npm install -g \
    pnpm@10.29.3 \
    @openai/codex@0.144.4 \
    @anthropic-ai/claude-code@2.1.210

RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- -d /usr/local/bin

# Set state directory environment variables and volumes
ENV RUSA_HOME=/home/node/.rusa
ENV NODE_ENV=production

# Create volume directory and app workspace
RUN mkdir -p /home/node/.rusa /app && chown -R node:node /home/node/.rusa /app

WORKDIR /app

# Run as non-root user
USER node

# Copy manifests to cache dependency resolution step
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/rusa/package.json ./packages/rusa/

# Install deps fresh in the image to rebuild better-sqlite3 against Node 24 ABI
RUN pnpm install --frozen-lockfile

# Copy the rest of the application source code (excluding those in .dockerignore)
COPY --chown=node:node . .

WORKDIR /app/packages/rusa

# Compile backend typescript files with RUSA_TSUP_PRESERVE_DIST=1
RUN RUSA_TSUP_PRESERVE_DIST=1 pnpm exec tsup && node scripts/copy-assets.mjs

# Copy Flutter dashboard build output from builder stage into dist/ after tsup
COPY --from=flutter-builder --chown=node:node /app/packages/rusa/flutter_dashboard/build/web ./dist/dashboard-ui-app

# Assert that dashboard UI index.html was copied and is present in image build
RUN test -f ./dist/dashboard-ui-app/index.html || (echo "ERROR: dist/dashboard-ui-app/index.html is missing in docker build" && exit 1)

# Write build sentinel file (.build-ok) for boot verification
RUN echo "docker-build" > ./dist/.build-ok

# Set up global cli access symlink
USER root
RUN chmod +x /app/packages/rusa/dist/cli.js \
    && ln -s /app/packages/rusa/dist/cli.js /usr/local/bin/rusa
USER node

WORKDIR /app
EXPOSE 8080 8085
# Provider CLIs persist interactive login state below $HOME. Quickstart shares
# this volume between its setup and app containers so those credentials land
# where the service reads them.
VOLUME /home/node

ENTRYPOINT ["rusa", "start", "--profile", "quickstart"]
