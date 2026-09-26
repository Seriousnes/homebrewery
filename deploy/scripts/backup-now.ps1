<#
.SYNOPSIS
One pg_dump backup right away, through the compose `backup` service (docs/operations.md "Backups and restore").

.DESCRIPTION
Prints the new dump's file name (in the backups volume), e.g. homebrewery-20260926T010203Z-manual.dump.
Compose files: COMPOSE_FILE / COMPOSE_PROJECT_NAME when set (e.g. $env:COMPOSE_FILE = 'deploy/compose.external-db.yml'),
otherwise docker-compose.yml + compose.prod.yml. Same behaviour as backup-now.sh.

.PARAMETER Label
Letters, digits, '.', '_' or '-' (default: manual). Labelled dumps don't postpone the scheduled ones, but they count
towards BACKUP_KEEP.

.EXAMPLE
deploy/scripts/backup-now.ps1
deploy/scripts/backup-now.ps1 before-upgrade
#>
param([string]$Label = 'manual')

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

function Invoke-Compose {
    if ($env:COMPOSE_FILE) { & docker compose @args }
    else { & docker compose -f docker-compose.yml -f compose.prod.yml @args }
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') failed with exit code $LASTEXITCODE" }
}

$script = '/opt/hb-backup/hb-backup.sh'
$running = Invoke-Compose ps --status running --quiet backup
if ($running) {
    $output = Invoke-Compose exec -T backup bash $script now $Label
}
else {
    Write-Warning 'The backup service is not running; using a one-off container.'
    $output = Invoke-Compose run --rm --no-deps -T backup bash $script now $Label
}
$file = @($output)[-1].Trim()
Split-Path -Leaf $file
