# ===============================
# Online Dev Tools Site Audit Script
# ===============================

$domain = "https://onlinedevtools.app"
$adsClient = "ca-pub-7167291111213614"

$urls = @(
  "$domain/",
  "$domain/ads.txt",
  "$domain/robots.txt",
  "$domain/sitemap.xml"
)

function Fetch($url) {
  try {
    return Invoke-WebRequest -Uri $url -Method GET -MaximumRedirection 10 -UseBasicParsing -ErrorAction Stop -Headers @{
      "User-Agent" = "Mozilla/5.0"
    }
  } catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    return $null
  }
}

function Fetch-Follow308($url, $maxHops = 10) {
  $current = $url
  for ($i = 0; $i -lt $maxHops; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $current -Method GET -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop -Headers @{
        "User-Agent" = "Mozilla/5.0"
      }
      return $r
    } catch {
      $resp = $_.Exception.Response
      if (-not $resp) {
        Write-Host "ERROR: $($_.Exception.Message)"
        return $null
      }

      $status = [int]$resp.StatusCode
      if ($status -ne 301 -and $status -ne 302 -and $status -ne 303 -and $status -ne 307 -and $status -ne 308) {
        Write-Host "ERROR: HTTP $status"
        return $null
      }

      $loc = $resp.Headers["Location"]
      if (-not $loc) {
        Write-Host "ERROR: Redirect ($status) without Location header"
        return $null
      }

      # Resolve relative Location -> absolute
      if ($loc -match '^\s*/') {
        $u = [Uri]$current
        $current = "$($u.Scheme)://$($u.Host)$loc"
      } elseif ($loc -notmatch '^https?://') {
        $u = [Uri]$current
        $current = (New-Object Uri($u, $loc)).AbsoluteUri
      } else {
        $current = $loc
      }
    }
  }

  Write-Host "ERROR: Too many redirects for $url"
  return $null
}

Write-Host "`n========== BASIC SITE CHECK =========="

foreach ($url in $urls) {
  Write-Host "`n===== $url ====="

  $r = Fetch $url
  if (-not $r) { continue }

  Write-Host "Status: $($r.StatusCode)"
  Write-Host "Content-Type: $($r.Headers.'Content-Type')"
  Write-Host "Server: $($r.Headers.Server)"
  Write-Host "Cache-Control: $($r.Headers.'Cache-Control')"
  Write-Host "X-Robots-Tag: $($r.Headers.'X-Robots-Tag')"
  Write-Host "CSP: $($r.Headers.'Content-Security-Policy')"
  Write-Host "X-Frame-Options: $($r.Headers.'X-Frame-Options')"
  Write-Host "Referrer-Policy: $($r.Headers.'Referrer-Policy')"
  Write-Host "Permissions-Policy: $($r.Headers.'Permissions-Policy')"
  Write-Host "Strict-Transport-Security: $($r.Headers.'Strict-Transport-Security')"

  Write-Host "`n---- First 60 lines of body ----"
  ($r.Content -split "`n" | Select-Object -First 60) -join "`n"
}

# ===============================
# AdSense Detection
# ===============================

Write-Host "`n========== ADSENSE CHECK =========="

$homeResp = Fetch "$domain/"
if (-not $homeResp) {
  Write-Host "Homepage fetch failed."
} else {
  $hasLoader = ($homeResp.Content -match "pagead2\.googlesyndication\.com/pagead/js/adsbygoogle\.js")
  $hasClient = ($homeResp.Content -match [regex]::Escape($adsClient))

  if ($hasLoader -or $hasClient) {
    Write-Host "AdSense script detected on homepage."
  } else {
    Write-Host "AdSense script NOT detected on homepage."
  }
}

$adsResp = Fetch "$domain/ads.txt"
if ($adsResp) {
  $pubId = $adsClient -replace "^ca-",""   # ca-pub-... -> pub-...
  if ($adsResp.Content -match [regex]::Escape($pubId)) {
    Write-Host "Publisher ID found in ads.txt."
  } else {
    Write-Host "Publisher ID NOT found in ads.txt."
  }
}

Write-Host "`n========== HOMEPAGE LINKS =========="

try {
  if ($homeResp -and $homeResp.Content) {
    $hrefs = [regex]::Matches($homeResp.Content, 'href\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase') |
      ForEach-Object { $_.Groups[1].Value } |
      Sort-Object -Unique

    if ($hrefs.Count -gt 0) {
      $hrefs | ForEach-Object { Write-Host $_ }
    } else {
      Write-Host "No href links found in HTML."
    }
  } else {
    Write-Host "Homepage not available."
  }
} catch {
  Write-Host "Could not extract links."
}

Write-Host "`n========== PARTIAL LINKS (header/footer) =========="

$headerResp = Fetch "$domain/partials/header"
$footerResp = Fetch "$domain/partials/footer"

function Print-Hrefs($label, $html) {
  Write-Host "`n--- $label ---"

  if ($null -eq $html) { Write-Host "Missing (null)"; return }

  $len = $html.Length
  Write-Host "Body length: $len"

  if ($len -eq 0) { Write-Host "Empty body (not missing)"; return }

  $hrefs = [regex]::Matches($html, 'href\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

  if ($hrefs.Count -eq 0) { Write-Host "No href links"; return }
  $hrefs | ForEach-Object { Write-Host $_ }
}

Print-Hrefs "header.html" ($headerResp.Content)
Print-Hrefs "footer.html" ($footerResp.Content)

# ===============================
# Save Local Snapshots
# ===============================

Write-Host "`n========== SAVING SNAPSHOTS =========="

try {
  $backupPath = Join-Path $PSScriptRoot "backups"

if (!(Test-Path $backupPath)) {
    New-Item -ItemType Directory -Path $backupPath | Out-Null
}

if ($homeResp) {
    $homeResp.Content | Out-File -Encoding utf8 (Join-Path $backupPath "audit_home.html")
}

Invoke-WebRequest "$domain/robots.txt"  -UseBasicParsing -OutFile (Join-Path $backupPath "audit_robots.txt")
Invoke-WebRequest "$domain/sitemap.xml" -UseBasicParsing -OutFile (Join-Path $backupPath "audit_sitemap.xml")
Invoke-WebRequest "$domain/ads.txt"     -UseBasicParsing -OutFile (Join-Path $backupPath "audit_ads.txt")


  Write-Host "Saved:"
  Write-Host " - audit_home.html"
  Write-Host " - audit_robots.txt"
  Write-Host " - audit_sitemap.xml"
  Write-Host " - audit_ads.txt"
} catch {
  Write-Host "Snapshot save failed."
}

Write-Host "`n========== DONE =========="
