# The e2e job's machine (.github/workflows/ci.yml "e2e"), for local runs: CI's Playwright container
# image (browsers, fonts, Node 24, root with HOME=/root), the .NET SDK that setup-dotnet installs
# (10.0.x) and `pnpm install`. No source: web/e2e/run-linux.mjs streams the working tree in at run time
# (entrypoint.sh). Built by that script; see it for usage.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
FROM ${PLAYWRIGHT_IMAGE}

ENV HOME=/root \
    CI=true \
    DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:$PATH \
    DOTNET_NOLOGO=true \
    DOTNET_CLI_TELEMETRY_OPTOUT=true \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel 10.0 --install-dir /usr/share/dotnet \
 && rm /tmp/dotnet-install.sh \
 && dotnet --version

WORKDIR /repo/web
# pnpm through corepack, at web/package.json's packageManager version.
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/.pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile

COPY deploy/e2e-linux/entrypoint.sh /usr/local/bin/hb-e2e-linux
RUN chmod +x /usr/local/bin/hb-e2e-linux
WORKDIR /repo
ENTRYPOINT ["hb-e2e-linux"]
