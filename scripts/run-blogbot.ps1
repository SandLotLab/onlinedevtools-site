<#
.SYNOPSIS
  Manually trigger the BlogBot Worker.

.EXAMPLE
  # Dry-run (no GitHub commit)
  .\scripts\run-blogbot.ps1 -WorkerUrl https://onlinedevtools-blogbot.<your-subdomain>.workers.dev -AdminToken <token> -DryRun

  # Live run for a specific topic ID (e.g. "jwt-decoder")
  .\scripts\run-blogbot.ps1 -WorkerUrl https://... -AdminToken <token> -Topic jwt-decoder

  # Fully automated live run (picks next topic in rotation)
  .\scripts\run-blogbot.ps1 -WorkerUrl https://... -AdminToken <token>
#>

param(
  [Parameter(Mandatory = $true)]
  [string] $WorkerUrl,

  [Parameter(Mandatory = $true)]
  [string] $AdminToken,

  [string] $Topic  = "",
  [switch] $DryRun
)

$body = @{ dryRun = [bool]$DryRun }
if ($Topic -ne "") { $body.topic = $Topic }

try {
  $result = Invoke-RestMethod `
    -Method      Post `
    -Uri         "$WorkerUrl/api/blogbot/run" `
    -Headers     @{ Authorization = "Bearer $AdminToken" } `
    -ContentType "application/json" `
    -Body        ($body | ConvertTo-Json)

  Write-Host "Status : $($result.result.status)"
  if ($result.result.slug)   { Write-Host "Slug   : $($result.result.slug)" }
  if ($result.result.pr.url) { Write-Host "PR URL : $($result.result.pr.url)" }
  $result | ConvertTo-Json -Depth 6
} catch {
  Write-Error "BlogBot call failed: $_"
  exit 1
}
