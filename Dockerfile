# syntax=docker/dockerfile:1
# Production image for the WYSIWYG fork (plan §2): Vite SPA + ASP.NET Core API in one container.
# Build from the repository root:   docker build -t homebrewery .
# Run:  docker run -p 8080:8080 -v homebrewery-keys:/var/lib/homebrewery/keys \
#         -e ConnectionStrings__Homebrewery="Host=...;Database=homebrewery;Username=...;Password=..." homebrewery
# Behind a TLS proxy also set ASPNETCORE_FORWARDEDHEADERS_ENABLED=true, so sign-in cookies are marked Secure
# (or Auth__CookieSecurePolicy=Always when the proxy cannot send X-Forwarded-Proto).
# The legacy Node app has its own Dockerfile in legacy/.

# ---- 1. web: build the SPA and the theme assets --------------------------------------------
FROM node:24 AS web
WORKDIR /repo
# pnpm through corepack, at web/package.json's packageManager version: corepack reads the
# package.json of the working directory, so pnpm runs in web/.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/.pnpmfile.cjs web/
RUN cd web && pnpm install --frozen-lockfile
COPY themes themes
# shared/ holds the committed schema manifest. The glob keeps this step working before it exists,
# and mkdir guarantees the folder that the api stage copies from (a glob that matches nothing
# creates nothing).
COPY shared* shared/
RUN mkdir -p shared
COPY web web
# Writes src/Homebrewery.Api/wwwroot (SPA + /themes/...) and shared/schema-manifest.json.
RUN cd web && pnpm run build

# ---- 2. restore: the NuGet packages of the ASP.NET Core host ---------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS restore
WORKDIR /repo
# Restore from the project files alone so the package layer stays cached until one of them changes.
COPY global.json Directory.Build.props Directory.Packages.props* NuGet.config* nuget.config* ./
COPY src/Homebrewery.Api/*.csproj src/Homebrewery.Api/
COPY src/Homebrewery.Core/*.csproj src/Homebrewery.Core/
COPY src/Homebrewery.Data/*.csproj src/Homebrewery.Data/
RUN dotnet restore src/Homebrewery.Api/Homebrewery.Api.csproj

# ---- 3. playwright: the Playwright CLI of the pinned Microsoft.Playwright package --------------
# PDF export (POST /api/export/pdf) runs headless Chromium. The browser build belongs to the package
# version, so the stages below install it with this CLI: that layer changes only with the package.
FROM restore AS playwright
RUN set -eu; \
    package="$(echo /root/.nuget/packages/microsoft.playwright/*/.playwright)"; \
    case "$(uname -m)" in \
      x86_64) node=linux-x64 ;; \
      aarch64) node=linux-arm64 ;; \
      *) echo "Playwright has no driver for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /playwright/node; \
    cp "$package/node/$node/node" /playwright/node/node; \
    cp -r "$package/package" /playwright/package

# ---- 4. api: publish the ASP.NET Core host ---------------------------------------------------
FROM restore AS api
COPY src src
COPY --from=web /repo/src/Homebrewery.Api/wwwroot src/Homebrewery.Api/wwwroot
COPY --from=web /repo/shared shared
# The Playwright driver (Node) comes out of the package executable by its owner only (root); the app runs as $APP_UID.
RUN dotnet publish src/Homebrewery.Api/Homebrewery.Api.csproj -c Release -o /out \
    && chmod 755 /out/.playwright/node/*/node

# ---- dev-api: the SDK image of `docker compose up`'s api service, with Chromium -----------------
# Not part of the production image (it is not the last stage). docker-compose.yml builds it; after a
# Microsoft.Playwright upgrade, `docker compose build api` installs the new Chromium.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dev-api
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The CLI is bind-mounted, not copied: a copied file stays in its layer even when a later step deletes it.
RUN --mount=type=bind,from=playwright,source=/playwright,target=/tmp/playwright \
    /tmp/playwright/node/node /tmp/playwright/package/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

# ---- dev-web: the image of `docker compose up`'s web service (the Vite dev server) -------------
# Not part of the production image. It holds a copy of the sources Vite reads; `docker compose watch`
# (docker-compose.yml web: develop.watch, initial_sync) brings it up to date and keeps it so.
# node_modules is a volume (the service's command installs into it).
FROM node:24 AS dev-web
COPY themes /repo/themes
COPY shared* /repo/shared/
COPY web /repo/web

# ---- 5. runtime ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
# Chromium headless shell and the system libraries and fonts it needs (as root, before USER), readable by the app user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The CLI is bind-mounted, not copied: a copied file stays in its layer even when a later step deletes it.
RUN --mount=type=bind,from=playwright,source=/playwright,target=/tmp/playwright \
    /tmp/playwright/node/node /tmp/playwright/package/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=api /out .
ENV ASPNETCORE_HTTP_PORTS=8080
# Data Protection keys (they encrypt the sign-in cookies; see src/Homebrewery.Api/Infrastructure/DataProtectionSetup.cs).
# Mount a volume here, e.g. `-v homebrewery-keys:/var/lib/homebrewery/keys`, or every new container signs everyone
# out. The directory belongs to the app user, so a new named volume starts out writable. Startup fails if it is not.
ENV DataProtection__KeysPath=/var/lib/homebrewery/keys
RUN mkdir -p /var/lib/homebrewery/keys && chown "$APP_UID" /var/lib/homebrewery/keys && chmod 700 /var/lib/homebrewery/keys
EXPOSE 8080
# Non-root user built into the .NET images.
USER $APP_UID
ENTRYPOINT ["dotnet", "Homebrewery.Api.dll"]
