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
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci
COPY themes themes
# shared/ holds the committed schema manifest. The glob keeps this step working before it exists,
# and mkdir guarantees the folder that the api stage copies from (a glob that matches nothing
# creates nothing).
COPY shared* shared/
RUN mkdir -p shared
COPY web web
# Writes src/Homebrewery.Api/wwwroot (SPA + /themes/...) and shared/schema-manifest.json.
RUN npm --prefix web run build

# ---- 2. api: restore and publish the ASP.NET Core host ---------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /repo
# Restore from the project files alone so the package layer stays cached until one of them changes.
COPY global.json Directory.Build.props Directory.Packages.props* NuGet.config* nuget.config* ./
COPY src/Homebrewery.Api/*.csproj src/Homebrewery.Api/
COPY src/Homebrewery.Core/*.csproj src/Homebrewery.Core/
COPY src/Homebrewery.Data/*.csproj src/Homebrewery.Data/
RUN dotnet restore src/Homebrewery.Api/Homebrewery.Api.csproj
COPY src src
COPY --from=web /repo/src/Homebrewery.Api/wwwroot src/Homebrewery.Api/wwwroot
COPY --from=web /repo/shared shared
RUN dotnet publish src/Homebrewery.Api/Homebrewery.Api.csproj -c Release -o /out

# ---- 3. runtime ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
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
