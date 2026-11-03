param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;

public static class ThousandServerControl
{
    public static volatile bool StopRequested;

    public static void OnCancelKeyPress(object sender, ConsoleCancelEventArgs args)
    {
        args.Cancel = true;
        StopRequested = true;
    }

    public static void Install()
    {
        Console.CancelKeyPress += OnCancelKeyPress;
    }

    public static void Uninstall()
    {
        Console.CancelKeyPress -= OnCancelKeyPress;
    }
}
"@

[ThousandServerControl]::Install()

$script:mimeTypes = @{
  '.html'  = 'text/html; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.mjs'   = 'text/javascript; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.svg'   = 'image/svg+xml; charset=utf-8'
  '.png'   = 'image/png'
  '.ico'   = 'image/x-icon'
  '.woff2' = 'font/woff2'
  '.txt'   = 'text/plain; charset=utf-8'
  '.md'    = 'text/markdown; charset=utf-8'
}

function Send-Response {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$Reason,
    [string]$ContentType,
    [byte[]]$Body = @(),
    [bool]$HeadOnly = $false,
    [string[]]$ExtraHeaders = @()
  )

  $headerLines = @(
    "HTTP/1.1 $StatusCode $Reason",
    "Content-Type: $ContentType",
    "Content-Length: $($Body.Length)",
    'Cache-Control: no-store',
    'X-Content-Type-Options: nosniff',
    'Connection: close'
  )

  foreach ($extraHeader in $ExtraHeaders) {
    $headerLines += $extraHeader
  }

  $headerText = ($headerLines -join "`r`n") + "`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)

  $Stream.Write($headerBytes, 0, $headerBytes.Length)

  if (-not $HeadOnly -and $Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }

  $Stream.Flush()
}

function Send-ErrorResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$Reason,
    [string]$Message,
    [bool]$HeadOnly,
    [string[]]$ExtraHeaders = @()
  )

  $body = [System.Text.Encoding]::UTF8.GetBytes($Message)
  Send-Response -Stream $Stream `
    -StatusCode $StatusCode `
    -Reason $Reason `
    -ContentType 'text/plain; charset=utf-8' `
    -Body $body `
    -HeadOnly $HeadOnly `
    -ExtraHeaders $ExtraHeaders
}

function Handle-Client {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [string]$Root,
    [string]$RootPrefix
  )

  $stream = $Client.GetStream()
  $stream.ReadTimeout = 5000
  $stream.WriteTimeout = 5000

  $reader = New-Object System.IO.StreamReader(
    $stream,
    [System.Text.Encoding]::ASCII,
    $false,
    1024,
    $true
  )

  try {
    $requestLine = $reader.ReadLine()

    if ([string]::IsNullOrWhiteSpace($requestLine)) {
      return
    }

    while ($true) {
      $headerLine = $reader.ReadLine()

      if ($null -eq $headerLine -or $headerLine -eq '') {
        break
      }
    }

    $parts = $requestLine -split '\s+'

    if ($parts.Count -lt 2) {
      Send-ErrorResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' `
        -Message 'Bad request.' -HeadOnly $false
      return
    }

    $method = $parts[0].ToUpperInvariant()
    $target = $parts[1]
    $headOnly = $method -eq 'HEAD'

    if ($method -ne 'GET' -and $method -ne 'HEAD') {
      Send-ErrorResponse -Stream $stream -StatusCode 405 -Reason 'Method Not Allowed' `
        -Message 'Method not allowed.' -HeadOnly $false `
        -ExtraHeaders @('Allow: GET, HEAD')
      return
    }

    $path = $target
    $queryIndex = $path.IndexOf('?')

    if ($queryIndex -ge 0) {
      $path = $path.Substring(0, $queryIndex)
    }

    $fragmentIndex = $path.IndexOf('#')

    if ($fragmentIndex -ge 0) {
      $path = $path.Substring(0, $fragmentIndex)
    }

    if (-not $path.StartsWith('/')) {
      Send-ErrorResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' `
        -Message 'Bad request.' -HeadOnly $headOnly
      return
    }

    try {
      $path = [System.Uri]::UnescapeDataString($path)
    } catch {
      Send-ErrorResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' `
        -Message 'Bad request.' -HeadOnly $headOnly
      return
    }

    $relative = $path.TrimStart('/')

    if ([string]::IsNullOrWhiteSpace($relative)) {
      $relative = 'index.html'
    }

    $relative = $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)

    if ($relative.Contains(':') -or $relative.Contains([char]0)) {
      Send-ErrorResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' `
        -Message 'Bad request.' -HeadOnly $headOnly
      return
    }

    try {
      $candidate = [System.IO.Path]::GetFullPath(
        $Root + [System.IO.Path]::DirectorySeparatorChar + $relative
      )
    } catch {
      Send-ErrorResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' `
        -Message 'Bad request.' -HeadOnly $headOnly
      return
    }

    if (-not $candidate.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-ErrorResponse -Stream $stream -StatusCode 403 -Reason 'Forbidden' `
        -Message 'Forbidden.' -HeadOnly $headOnly
      return
    }

    if (-not [System.IO.File]::Exists($candidate)) {
      Send-ErrorResponse -Stream $stream -StatusCode 404 -Reason 'Not Found' `
        -Message 'Not found.' -HeadOnly $headOnly
      return
    }

    $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
    $contentType = $script:mimeTypes[$extension]

    if (-not $contentType) {
      $contentType = 'application/octet-stream'
    }

    try {
      $body = [System.IO.File]::ReadAllBytes($candidate)
    } catch {
      Send-ErrorResponse -Stream $stream -StatusCode 500 -Reason 'Internal Server Error' `
        -Message 'Could not read the requested file.' -HeadOnly $headOnly
      return
    }

    Send-Response -Stream $stream -StatusCode 200 -Reason 'OK' `
      -ContentType $contentType -Body $body -HeadOnly $headOnly
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPrefix = $root.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar

$listener = $null
$port = $null

foreach ($candidatePort in 8765..8785) {
  $candidateListener = New-Object -TypeName System.Net.Sockets.TcpListener `
    -ArgumentList @([System.Net.IPAddress]::Loopback, $candidatePort)

  try {
    $candidateListener.Start()
    $listener = $candidateListener
    $port = $candidatePort
    break
  } catch [System.Net.Sockets.SocketException] {
    $candidateListener.Stop()

    if ($candidatePort -lt 8785) {
      Write-Host ("Port {0} is busy, trying {1}..." -f $candidatePort, ($candidatePort + 1)) `
        -ForegroundColor DarkGray
    }
  }
}

if (-not $listener) {
  Write-Host ''
  Write-Host 'ERROR: ports 8765-8785 are all busy.' -ForegroundColor Red
  Write-Host 'Close the application that uses these ports and run start.cmd again.' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

$url = "http://127.0.0.1:$port/"

Write-Host ''
Write-Host '  ============================================' -ForegroundColor DarkYellow
Write-Host '    1000 - Thousand card game' -ForegroundColor Yellow
Write-Host ("    {0}" -f $url) -ForegroundColor Green
Write-Host '    Press Ctrl+C to stop the server.' -ForegroundColor DarkGray
Write-Host '  ============================================' -ForegroundColor DarkYellow
Write-Host ''

if (-not $NoBrowser) {
  try {
    Start-Process -FilePath $url
  } catch {
    Write-Host 'Could not open the browser automatically.' -ForegroundColor Yellow
    Write-Host ("Open this address manually: {0}" -f $url) -ForegroundColor Green
    Write-Host ''
  }
}

try {
  while (-not [ThousandServerControl]::StopRequested) {
    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 50
      continue
    }

    $client = $listener.AcceptTcpClient()

    try {
      $client.NoDelay = $true
      Handle-Client -Client $client -Root $root -RootPrefix $rootPrefix
    } catch {
      Write-Host ("Request error: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow
    } finally {
      $client.Dispose()
    }
  }
} finally {
  try {
    [ThousandServerControl]::Uninstall()
  } catch {
    # The handler can already be detached when the console is closing.
  }

  if ($listener) {
    $listener.Stop()
  }

  Write-Host ''
  Write-Host 'Server stopped.' -ForegroundColor DarkGray
}
