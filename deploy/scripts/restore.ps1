<#
.SYNOPSIS
Replace the database with a pg_dump backup (docs/operations.md "Backups and restore"). Same behaviour as restore.sh.

.DESCRIPTION
Steps: take a safety dump of the current database (<prefix>-<time>-pre-restore.dump), stop the app, restore (default:
drop and re-create the database; -Clean: restore over the existing objects, for managed servers where the database
cannot be dropped), start the app again and wait until it is healthy. When the restore fails the app stays stopped.
Compose files: COMPOSE_FILE / COMPOSE_PROJECT_NAME when set, otherwise docker-compose.yml + compose.prod.yml.
HB_APP_SERVICE names the app's compose service (default: app).

.PARAMETER Dump
A file name in the backups volume, 'latest', or a .dump file on this machine (copied into the backups volume first).

.EXAMPLE
deploy/scripts/restore.ps1 latest
deploy/scripts/restore.ps1 homebrewery-20260926T010203Z.dump -Yes
deploy/scripts/restore.ps1 C:\backups\homebrewery-20260926T010203Z.dump -Clean -NoOwner
#>
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Dump,
    [switch]$Yes,
    [switch]$Clean,
    [switch]$NoOwner,
    [switch]$NoSafetyBackup
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

function Invoke-Compose {
    if ($env:COMPOSE_FILE) { & docker compose @args }
    else { & docker compose -f docker-compose.yml -f compose.prod.yml @args }
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') failed with exit code $LASTEXITCODE" }
}

$app = if ($env:HB_APP_SERVICE) { $env:HB_APP_SERVICE } else { 'app' }
$script = '/opt/hb-backup/hb-backup.sh'
$options = @()
if ($Clean) { $options += '--clean' }
if ($NoOwner) { $options += '--no-owner' }

# The backup service runs the restore (it has the database settings and the volume).
Invoke-Compose up -d backup | Out-Null

$target = $Dump
if (Test-Path -LiteralPath $Dump -PathType Leaf) {
    $target = Split-Path -Leaf $Dump
    Write-Host "Copying $Dump into the backups volume as $target"
    Invoke-Compose cp (Resolve-Path -LiteralPath $Dump).Path "backup:/backups/$target"
}
$verified = Invoke-Compose exec -T backup bash $script verify $target
$name = Split-Path -Leaf (@($verified)[-1].Trim())

if (-not $Yes) {
    $answer = Read-Host "Replace the database with $name? Everything written since that dump is lost. Type 'yes'"
    if ($answer -ne 'yes') { Write-Host 'Cancelled.'; exit 1 }
}

if (-not $NoSafetyBackup) {
    Write-Host 'Taking a safety dump of the current database'
    Invoke-Compose exec -T backup bash $script now pre-restore | Out-Null
}

Write-Host "Stopping $app"
Invoke-Compose stop $app

Write-Host "Restoring $name"
try {
    Invoke-Compose exec -T backup bash $script restore $name @options
}
catch {
    Write-Error "The restore failed; $app stays stopped. Restore the pre-restore dump or fix the problem, then run 'docker compose ... start $app'. $_"
    exit 1
}

Write-Host "Starting $app"
Invoke-Compose up -d --no-deps --wait $app
Write-Host "Restored $name; $app is healthy."
