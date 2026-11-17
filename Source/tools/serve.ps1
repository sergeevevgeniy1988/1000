param(
  [switch]$Lan,
  [string]$BindAddress = '',
  [int]$Port = 0,
  [switch]$NoBrowser,
  [int]$RoomTtlSeconds = 120
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

. (Join-Path $PSScriptRoot 'relay.ps1')

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

$script:MaxHeaderBytes = 32768
$script:MaxBodyBytes = 524288
$script:ReadTimeoutMs = 5000

function Get-HttpReason {
  param([int]$StatusCode)

  switch ($StatusCode) {
    200 { return 'OK' }
    400 { return 'Bad Request' }
    401 { return 'Unauthorized' }
    403 { return 'Forbidden' }
    404 { return 'Not Found' }
    405 { return 'Method Not Allowed' }
    408 { return 'Request Timeout' }
    409 { return 'Conflict' }
    410 { return 'Gone' }
    413 { return 'Payload Too Large' }
    429 { return 'Too Many Requests' }
    500 { return 'Internal Server Error' }
    default { return 'Error' }
  }
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

function Send-TextError {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$Message,
    [bool]$HeadOnly = $false
  )

  $body = [System.Text.Encoding]::UTF8.GetBytes($Message)
  Send-Response -Stream $Stream `
    -StatusCode $StatusCode `
    -Reason (Get-HttpReason -StatusCode $StatusCode) `
    -ContentType 'text/plain; charset=utf-8' `
    -Body $body `
    -HeadOnly $HeadOnly
}

function Send-JsonResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    $Value,
    [bool]$HeadOnly = $false,
    [string[]]$ExtraHeaders = @()
  )

  $json = ConvertTo-Json -InputObject $Value -Depth 64 -Compress

  if ([string]::IsNullOrEmpty($json)) {
    $json = 'null'
  }

  $body = [System.Text.Encoding]::UTF8.GetBytes($json)
  Send-Response -Stream $Stream `
    -StatusCode $StatusCode `
    -Reason (Get-HttpReason -StatusCode $StatusCode) `
    -ContentType 'application/json; charset=utf-8' `
    -Body $body `
    -HeadOnly $HeadOnly `
    -ExtraHeaders $ExtraHeaders
}

function Send-ApiError {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$Code,
    [string]$Message,
    [bool]$HeadOnly = $false,
    [string[]]$ExtraHeaders = @()
  )

  $value = @{
    error = $Code
    message = $Message
    status = $StatusCode
  }

  Send-JsonResponse -Stream $Stream `
    -StatusCode $StatusCode `
    -Value $value `
    -HeadOnly $HeadOnly `
    -ExtraHeaders $ExtraHeaders
}

function Send-MethodNotAllowed {
  param(
    [System.IO.Stream]$Stream,
    [string]$Allow,
    [bool]$HeadOnly = $false
  )

  Send-ApiError -Stream $Stream `
    -StatusCode 405 `
    -Code 'method_not_allowed' `
    -Message 'Method not allowed.' `
    -HeadOnly $HeadOnly `
    -ExtraHeaders @("Allow: $Allow")
}

function Find-ByteSequence {
  param(
    [byte[]]$Haystack,
    [byte[]]$Needle,
    [int]$Start
  )

  $limit = $Haystack.Length - $Needle.Length

  for ($i = $Start; $i -le $limit; $i++) {
    $matched = $true

    for ($j = 0; $j -lt $Needle.Length; $j++) {
      if ($Haystack[$i + $j] -ne $Needle[$j]) {
        $matched = $false
        break
      }
    }

    if ($matched) {
      return $i
    }
  }

  return -1
}

function Read-HttpRequest {
  param(
    [System.IO.Stream]$Stream
  )

  $buffer = New-Object byte[] 8192
  $headerStream = New-Object System.IO.MemoryStream
  $terminator = [byte[]](13, 10, 13, 10)
  $headerEnd = -1
  $searchFrom = 0

  try {
    while ($headerEnd -lt 0) {
      $read = 0

      try {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
      } catch {
        return @{ Ok = $false; Status = 408; Message = 'Timed out while reading the request.' }
      }

      if ($read -le 0) {
        return @{ Ok = $false; Status = 400; Message = 'Incomplete request.' }
      }

      $headerStream.Write($buffer, 0, $read)

      if ($headerStream.Length -gt $script:MaxHeaderBytes) {
        return @{ Ok = $false; Status = 400; Message = 'Request headers are too large.' }
      }

      $headerBytes = $headerStream.ToArray()
      $headerEnd = Find-ByteSequence -Haystack $headerBytes -Needle $terminator -Start $searchFrom

      if ($headerEnd -lt 0) {
        $searchFrom = [Math]::Max(0, $headerBytes.Length - 3)
      }
    }

    $headerBytes = $headerStream.ToArray()
  } finally {
    $headerStream.Dispose()
  }

  $headerText = [System.Text.Encoding]::GetEncoding(28591).GetString($headerBytes, 0, $headerEnd)
  $headerLines = $headerText -split "`r`n"

  if ($headerLines.Count -lt 1 -or [string]::IsNullOrWhiteSpace($headerLines[0])) {
    return @{ Ok = $false; Status = 400; Message = 'Bad request line.' }
  }

  $requestParts = $headerLines[0] -split '\s+'

  if ($requestParts.Count -lt 3) {
    return @{ Ok = $false; Status = 400; Message = 'Bad request line.' }
  }

  $method = $requestParts[0].ToUpperInvariant()
  $target = $requestParts[1]
  $protocol = $requestParts[2]

  if ($method -notmatch '^[A-Z]+$' -or $target.Length -eq 0 -or $protocol -notmatch '^HTTP/1\.[01]$') {
    return @{ Ok = $false; Status = 400; Message = 'Bad request line.' }
  }

  $headers = @{}

  for ($i = 1; $i -lt $headerLines.Count; $i++) {
    $line = $headerLines[$i]

    if ($line -eq '') {
      continue
    }

    $colonIndex = $line.IndexOf(':')

    if ($colonIndex -le 0) {
      return @{ Ok = $false; Status = 400; Message = 'Bad request header.' }
    }

    $headerName = $line.Substring(0, $colonIndex).Trim().ToLowerInvariant()
    $headerValue = $line.Substring($colonIndex + 1).Trim()

    if ($headerName -notmatch '^[a-z0-9-]+$') {
      return @{ Ok = $false; Status = 400; Message = 'Bad request header.' }
    }

    if ($headers.ContainsKey($headerName)) {
      if ($headerName -eq 'host' -or $headerName -eq 'content-length' -or $headerName -eq 'transfer-encoding') {
        return @{ Ok = $false; Status = 400; Message = 'Duplicate request header.' }
      }

      $headers[$headerName] = $headers[$headerName] + ', ' + $headerValue
    } else {
      $headers[$headerName] = $headerValue
    }
  }

  if ($headers.ContainsKey('transfer-encoding') -and -not [string]::IsNullOrEmpty($headers['transfer-encoding'])) {
    return @{ Ok = $false; Status = 400; Message = 'Chunked requests are not supported.' }
  }

  $contentLength = 0

  if ($headers.ContainsKey('content-length')) {
    [long]$contentLengthLong = 0

    if (-not [long]::TryParse($headers['content-length'], [ref]$contentLengthLong) -or $contentLengthLong -lt 0) {
      return @{ Ok = $false; Status = 400; Message = 'Bad Content-Length header.' }
    }

    if ($contentLengthLong -gt $script:MaxBodyBytes) {
      return @{ Ok = $false; Status = 413; Message = 'Request body is too large (limit 512 KiB).' }
    }

    $contentLength = [int]$contentLengthLong
  }

  if ($headers.ContainsKey('expect') -and $headers['expect'] -match '(?i)100-continue') {
    $continueText = "HTTP/1.1 100 Continue`r`n`r`n"
    $continueBytes = [System.Text.Encoding]::ASCII.GetBytes($continueText)
    $Stream.Write($continueBytes, 0, $continueBytes.Length)
    $Stream.Flush()
  }

  $bodyStream = New-Object System.IO.MemoryStream

  try {
    $prefixOffset = $headerEnd + 4
    $prefixLength = $headerBytes.Length - $prefixOffset

    if ($prefixLength -gt 0 -and $contentLength -gt 0) {
      $prefixTake = [Math]::Min($prefixLength, $contentLength)
      $bodyStream.Write($headerBytes, $prefixOffset, $prefixTake)
    }

    while ($bodyStream.Length -lt $contentLength) {
      $remaining = $contentLength - [int]$bodyStream.Length
      $read = 0

      try {
        $read = $Stream.Read($buffer, 0, [Math]::Min($buffer.Length, $remaining))
      } catch {
        return @{ Ok = $false; Status = 408; Message = 'Timed out while reading the request body.' }
      }

      if ($read -le 0) {
        return @{ Ok = $false; Status = 400; Message = 'Incomplete request body.' }
      }

      $bodyStream.Write($buffer, 0, $read)
    }

    $bodyBytes = $bodyStream.ToArray()
  } finally {
    $bodyStream.Dispose()
  }

  $bodyText = ''

  if ($bodyBytes.Length -gt 0) {
    $bodyText = [System.Text.Encoding]::UTF8.GetString($bodyBytes)
  }

  return @{
    Ok = $true
    Method = $method
    Target = $target
    Protocol = $protocol
    Headers = $headers
    Body = $bodyText
  }
}

function ConvertFrom-JsonBody {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }

  try {
    return (ConvertFrom-Json -InputObject $Text)
  } catch {
    return $null
  }
}

function Get-RequestHeader {
  param(
    $Headers,
    [string]$Name
  )

  $key = $Name.ToLowerInvariant()

  if ($Headers.ContainsKey($key)) {
    return $Headers[$key]
  }

  return $null
}

function Test-RequestSecurity {
  param($Request)

  $hostHeader = Get-RequestHeader -Headers $Request.Headers -Name 'Host'

  if ([string]::IsNullOrWhiteSpace($hostHeader)) {
    return New-RelayError -Status 400 -Code 'bad_host' -ErrorMessage 'Host header is required.'
  }

  if ($hostHeader -match '[\s/\\,]') {
    return New-RelayError -Status 400 -Code 'bad_host' -ErrorMessage 'Bad Host header.'
  }

  $hostName = $hostHeader
  $hostPort = 80
  $colonIndex = $hostHeader.LastIndexOf(':')

  if ($colonIndex -ge 0) {
    $hostName = $hostHeader.Substring(0, $colonIndex)
    [int]$parsedPort = 0

    if (-not [int]::TryParse($hostHeader.Substring($colonIndex + 1), [ref]$parsedPort)) {
      return New-RelayError -Status 400 -Code 'bad_host' -ErrorMessage 'Bad Host header.'
    }

    $hostPort = $parsedPort
  }

  if ([string]::IsNullOrWhiteSpace($hostName)) {
    return New-RelayError -Status 400 -Code 'bad_host' -ErrorMessage 'Bad Host header.'
  }

  if ($hostName.StartsWith('[')) {
    return New-RelayError -Status 403 -Code 'bad_host' -ErrorMessage 'Host is not allowed.'
  }

  if (-not $script:ServerAllowedHosts.Contains($hostName)) {
    return New-RelayError -Status 403 -Code 'bad_host' -ErrorMessage 'Host is not allowed.'
  }

  if ($hostPort -ne $script:ServerPort) {
    return New-RelayError -Status 403 -Code 'bad_host' -ErrorMessage 'Host is not allowed.'
  }

  if ($Request.Headers.ContainsKey('origin')) {
    $origin = $Request.Headers['origin']

    if (-not [string]::IsNullOrEmpty($origin)) {
      $originUri = $null

      if (-not [System.Uri]::TryCreate($origin, [System.UriKind]::Absolute, [ref]$originUri)) {
        return New-RelayError -Status 403 -Code 'bad_origin' -ErrorMessage 'Origin is not allowed.'
      }

      if ($originUri.Scheme -ne 'http') {
        return New-RelayError -Status 403 -Code 'bad_origin' -ErrorMessage 'Origin is not allowed.'
      }

      if (-not $script:ServerAllowedHosts.Contains($originUri.Host)) {
        return New-RelayError -Status 403 -Code 'bad_origin' -ErrorMessage 'Origin is not allowed.'
      }

      if ($originUri.Port -ne $script:ServerPort) {
        return New-RelayError -Status 403 -Code 'bad_origin' -ErrorMessage 'Origin is not allowed.'
      }

      if ($originUri.AbsolutePath -ne '/' -or -not [string]::IsNullOrEmpty($originUri.Query)) {
        return New-RelayError -Status 403 -Code 'bad_origin' -ErrorMessage 'Origin is not allowed.'
      }
    }
  }

  return @{ Ok = $true }
}

function Get-QueryValue {
  param(
    [string]$Query,
    [string]$Name
  )

  if ([string]::IsNullOrEmpty($Query)) {
    return $null
  }

  foreach ($pair in $Query.Split('&')) {
    if ([string]::IsNullOrEmpty($pair)) {
      continue
    }

    $separator = $pair.IndexOf('=')

    if ($separator -lt 0) {
      $key = $pair
      $value = ''
    } else {
      $key = $pair.Substring(0, $separator)
      $value = $pair.Substring($separator + 1)
    }

    try {
      $key = [System.Uri]::UnescapeDataString($key.Replace('+', ' '))
      $value = [System.Uri]::UnescapeDataString($value.Replace('+', ' '))
    } catch {
      continue
    }

    if ([string]::Equals($key, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $value
    }
  }

  return $null
}

function Get-QueryIntResult {
  param(
    [string]$Query,
    [string]$Name,
    [int]$Default = 0
  )

  $raw = Get-QueryValue -Query $Query -Name $Name

  if ($null -eq $raw) {
    return @{ Ok = $true; Value = $Default }
  }

  if ($raw -eq '') {
    return @{ Ok = $false; Value = 0 }
  }

  [int]$parsed = 0

  if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt 0) {
    return @{ Ok = $false; Value = 0 }
  }

  return @{ Ok = $true; Value = $parsed }
}

function Resolve-RoomAuth {
  param(
    $Room,
    [string]$Token
  )

  if ([string]::IsNullOrEmpty($Token)) {
    return New-RelayError -Status 401 -Code 'missing_token' -ErrorMessage 'Room token is required.'
  }

  $player = Get-RelayPlayerByToken -Room $Room -Token $Token

  if ($null -eq $player) {
    return New-RelayError -Status 401 -Code 'invalid_token' -ErrorMessage 'Room token is invalid.'
  }

  return @{
    Ok = $true
    Player = $player
  }
}

function Resolve-HostAuth {
  param(
    $Room,
    [string]$Token
  )

  $auth = Resolve-RoomAuth -Room $Room -Token $Token

  if (-not $auth.Ok) {
    return $auth
  }

  if (-not $auth.Player.IsHost) {
    return New-RelayError -Status 403 -Code 'not_host' -ErrorMessage 'Host token is required.'
  }

  Update-RelayHostSeen -Room $Room

  return $auth
}

function Serve-StaticFile {
  param(
    [System.IO.Stream]$Stream,
    [string]$RequestPath,
    [bool]$HeadOnly
  )

  $relative = $RequestPath.TrimStart('/')

  if ([string]::IsNullOrWhiteSpace($relative)) {
    $relative = 'index.html'
  }

  $relative = $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)

  if ($relative.Contains(':') -or $relative.Contains([char]0)) {
    Send-TextError -Stream $Stream -StatusCode 400 -Message 'Bad request.' -HeadOnly $HeadOnly
    return
  }

  try {
    $candidate = [System.IO.Path]::GetFullPath(
      $script:ServerRoot + [System.IO.Path]::DirectorySeparatorChar + $relative
    )
  } catch {
    Send-TextError -Stream $Stream -StatusCode 400 -Message 'Bad request.' -HeadOnly $HeadOnly
    return
  }

  if (-not $candidate.StartsWith($script:ServerRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Send-TextError -Stream $Stream -StatusCode 403 -Message 'Forbidden.' -HeadOnly $HeadOnly
    return
  }

  if (-not [System.IO.File]::Exists($candidate)) {
    Send-TextError -Stream $Stream -StatusCode 404 -Message 'Not found.' -HeadOnly $HeadOnly
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
    Send-TextError -Stream $Stream -StatusCode 500 -Message 'Could not read the requested file.' -HeadOnly $HeadOnly
    return
  }

  Send-Response -Stream $Stream -StatusCode 200 -Reason 'OK' `
    -ContentType $contentType -Body $body -HeadOnly $HeadOnly
}

function Handle-Request {
  param(
    [System.IO.Stream]$Stream,
    $Request
  )

  $method = $Request.Method
  $headOnly = ($method -eq 'HEAD')
  $target = $Request.Target
  $path = $target
  $query = ''

  $queryIndex = $path.IndexOf('?')

  if ($queryIndex -ge 0) {
    $path = $path.Substring(0, $queryIndex)
    $query = $target.Substring($queryIndex + 1)
  }

  $fragmentIndex = $path.IndexOf('#')

  if ($fragmentIndex -ge 0) {
    $path = $path.Substring(0, $fragmentIndex)
  }

  if (-not $path.StartsWith('/')) {
    Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_request' -Message 'Bad request.' -HeadOnly $headOnly
    return
  }

  try {
    $path = [System.Uri]::UnescapeDataString($path)
  } catch {
    Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_request' -Message 'Bad request.' -HeadOnly $headOnly
    return
  }

  $security = Test-RequestSecurity -Request $Request

  if (-not $security.Ok) {
    Send-ApiError -Stream $Stream -StatusCode $security.Status -Code $security.Code -Message $security.Message -HeadOnly $headOnly
    return
  }

  if ($path -eq '/api/health') {
    if ($method -ne 'GET' -and $method -ne 'HEAD') {
      Send-MethodNotAllowed -Stream $Stream -Allow 'GET, HEAD' -HeadOnly $headOnly
      return
    }

    $health = @{
      ok = $true
      version = $script:ServerVersion
      lan = $script:ServerLan
      bindAddress = $script:ServerBindAddress
      port = $script:ServerPort
      lanUrl = $script:ServerUrl
      roomTtlSeconds = $script:RelayState.TtlSeconds
    }

    Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $health -HeadOnly $headOnly
    return
  }

  if (-not $script:ServerLan) {
    if ($path -eq '/api' -or $path.StartsWith('/api/')) {
      Send-ApiError -Stream $Stream -StatusCode 404 -Code 'not_found' -Message 'Not found.' -HeadOnly $headOnly
      return
    }

    if ($method -ne 'GET' -and $method -ne 'HEAD') {
      Send-MethodNotAllowed -Stream $Stream -Allow 'GET, HEAD' -HeadOnly $headOnly
      return
    }

    Serve-StaticFile -Stream $Stream -RequestPath $path -HeadOnly $headOnly
    return
  }

  if ($path -eq '/api/rooms') {
    if ($method -ne 'POST') {
      Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
      return
    }

    $body = ConvertFrom-JsonBody -Text $Request.Body

    if ($null -eq $body) {
      Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_json' -Message 'Request body must be valid JSON.' -HeadOnly $headOnly
      return
    }

    $nameProperty = $body.PSObject.Properties['name']

    if ($null -eq $nameProperty -or $nameProperty.Value -isnot [string]) {
      Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_name' -Message 'Name must be 1-24 characters without control characters.' -HeadOnly $headOnly
      return
    }

    $created = New-RelayRoom -Name $nameProperty.Value

    if (-not $created.Ok) {
      Send-ApiError -Stream $Stream -StatusCode $created.Status -Code $created.Code -Message $created.Message -HeadOnly $headOnly
      return
    }

    $response = @{
      roomCode = $created.Room.Code
      playerId = 'human'
      token = $created.Token
      lobby = (Get-RelayLobby -Room $created.Room)
    }

    Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $response -HeadOnly $headOnly
    return
  }

  if ($path -match '^/api/rooms/([A-Za-z0-9]{1,16})/([a-z]+)$') {
    $roomCode = $Matches[1].ToUpperInvariant()
    $roomAction = $Matches[2]
    $lookup = Get-RelayRoomStatus -Code $roomCode

    if ($lookup.Status -eq 'missing') {
      Send-ApiError -Stream $Stream -StatusCode 404 -Code 'room_not_found' -Message 'Room not found.' -HeadOnly $headOnly
      return
    }

    if ($lookup.Status -eq 'gone') {
      Send-ApiError -Stream $Stream -StatusCode 410 -Code 'room_closed' -Message 'Room is closed or expired.' -HeadOnly $headOnly
      return
    }

    $room = $lookup.Room

    switch ($roomAction) {
      'join' {
        if ($method -ne 'POST') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
          return
        }

        $body = ConvertFrom-JsonBody -Text $Request.Body

        if ($null -eq $body) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_json' -Message 'Request body must be valid JSON.' -HeadOnly $headOnly
          return
        }

        $nameProperty = $body.PSObject.Properties['name']

        if ($null -eq $nameProperty -or $nameProperty.Value -isnot [string]) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_name' -Message 'Name must be 1-24 characters without control characters.' -HeadOnly $headOnly
          return
        }

        $joined = Join-RelayRoom -Room $room -Name $nameProperty.Value

        if (-not $joined.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $joined.Status -Code $joined.Code -Message $joined.Message -HeadOnly $headOnly
          return
        }

        $response = @{
          roomCode = $room.Code
          playerId = $joined.Player.Id
          token = $joined.Token
          lobby = (Get-RelayLobby -Room $room)
        }

        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $response -HeadOnly $headOnly
        return
      }

      'host' {
        if ($method -ne 'GET' -and $method -ne 'HEAD') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'GET, HEAD' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-HostAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        $actionSinceResult = Get-QueryIntResult -Query $query -Name 'actionSince' -Default 0
        $lobbySinceResult = Get-QueryIntResult -Query $query -Name 'lobbySince' -Default 0

        if (-not $actionSinceResult.Ok -or -not $lobbySinceResult.Ok) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_query' -Message 'Query parameters must be non-negative integers.' -HeadOnly $headOnly
          return
        }

        $hostState = Get-RelayHostState -Room $room -ActionSince $actionSinceResult.Value
        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $hostState -HeadOnly $headOnly
        return
      }

      'publish' {
        if ($method -ne 'POST') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-HostAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        $body = ConvertFrom-JsonBody -Text $Request.Body

        if ($null -eq $body) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_json' -Message 'Request body must be valid JSON.' -HeadOnly $headOnly
          return
        }

        $published = Publish-RelayState -Room $room -Body $body

        if (-not $published.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $published.Status -Code $published.Code -Message $published.Message -HeadOnly $headOnly
          return
        }

        $response = @{
          version = $published.Version
          started = $published.Started
          gameReset = $published.GameReset
          views = $published.Views
          log = $published.Log
          messages = $published.Messages
          cursor = $published.Cursor
          lobbyVersion = $published.LobbyVersion
          duplicate = $published.Duplicate
        }

        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $response -HeadOnly $headOnly
        return
      }

      'kick' {
        if ($method -ne 'POST') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-HostAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        $body = ConvertFrom-JsonBody -Text $Request.Body

        if ($null -eq $body) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_json' -Message 'Request body must be valid JSON.' -HeadOnly $headOnly
          return
        }

        $playerProperty = $body.PSObject.Properties['playerId']

        if ($null -eq $playerProperty -or $playerProperty.Value -isnot [string]) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_player' -Message 'playerId is required.' -HeadOnly $headOnly
          return
        }

        $removed = Remove-RelayGuest -Room $room -PlayerId $playerProperty.Value

        if (-not $removed.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $removed.Status -Code $removed.Code -Message $removed.Message -HeadOnly $headOnly
          return
        }

        $response = @{
          ok = $true
          lobby = (Get-RelayLobby -Room $room)
        }

        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $response -HeadOnly $headOnly
        return
      }

      'close' {
        if ($method -ne 'POST') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-HostAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        Close-RelayRoom -Room $room -Reason 'closed'
        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value @{ ok = $true } -HeadOnly $headOnly
        return
      }

      'player' {
        if ($method -ne 'GET' -and $method -ne 'HEAD') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'GET, HEAD' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-RoomAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        $viewSinceResult = Get-QueryIntResult -Query $query -Name 'viewSince' -Default 0
        $logSinceResult = Get-QueryIntResult -Query $query -Name 'logSince' -Default 0
        $logEpochResult = Get-QueryIntResult -Query $query -Name 'logEpoch' -Default 0
        $messageSinceResult = Get-QueryIntResult -Query $query -Name 'messageSince' -Default 0

        if (-not $viewSinceResult.Ok -or -not $logSinceResult.Ok -or -not $logEpochResult.Ok -or -not $messageSinceResult.Ok) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_query' -Message 'Query parameters must be non-negative integers.' -HeadOnly $headOnly
          return
        }

        $state = Get-RelayPlayerState -Room $room -Player $auth.Player `
          -ViewSince $viewSinceResult.Value `
          -LogSince $logSinceResult.Value `
          -LogEpoch $logEpochResult.Value `
          -MessageSince $messageSinceResult.Value

        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $state -HeadOnly $headOnly
        return
      }

      'action' {
        if ($method -ne 'POST') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-RoomAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        $body = ConvertFrom-JsonBody -Text $Request.Body

        if ($null -eq $body) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_json' -Message 'Request body must be valid JSON.' -HeadOnly $headOnly
          return
        }

        $actionIdProperty = $body.PSObject.Properties['actionId']
        $typeProperty = $body.PSObject.Properties['type']

        if ($null -eq $actionIdProperty -or $actionIdProperty.Value -isnot [string] -or -not (Test-RelayShortText -Value $actionIdProperty.Value -MaxLength 64)) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_action' -Message 'actionId must be 1-64 characters.' -HeadOnly $headOnly
          return
        }

        if ($null -eq $typeProperty -or $typeProperty.Value -isnot [string] -or -not (Test-RelayShortText -Value $typeProperty.Value -MaxLength 64)) {
          Send-ApiError -Stream $Stream -StatusCode 400 -Code 'bad_action' -Message 'type must be 1-64 characters.' -HeadOnly $headOnly
          return
        }

        $payload = $null
        $payloadProperty = $body.PSObject.Properties['payload']

        if ($null -ne $payloadProperty) {
          $payload = $payloadProperty.Value
        }

        $queued = Add-RelayAction -Room $room -Player $auth.Player `
          -ActionId $actionIdProperty.Value `
          -Type $typeProperty.Value `
          -Payload $payload

        if (-not $queued.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $queued.Status -Code $queued.Code -Message $queued.Message -HeadOnly $headOnly
          return
        }

        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value @{ ok = $true; seq = $queued.Seq } -HeadOnly $headOnly
        return
      }

      'leave' {
        if ($method -ne 'POST') {
          Send-MethodNotAllowed -Stream $Stream -Allow 'POST' -HeadOnly $headOnly
          return
        }

        $auth = Resolve-RoomAuth -Room $room -Token (Get-RequestHeader -Headers $Request.Headers -Name 'X-Room-Token')

        if (-not $auth.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $auth.Status -Code $auth.Code -Message $auth.Message -HeadOnly $headOnly
          return
        }

        if ($auth.Player.IsHost) {
          Close-RelayRoom -Room $room -Reason 'closed'
          Send-JsonResponse -Stream $Stream -StatusCode 200 -Value @{ ok = $true; closed = $true } -HeadOnly $headOnly
          return
        }

        $removed = Remove-RelayGuest -Room $room -PlayerId $auth.Player.Id

        if (-not $removed.Ok) {
          Send-ApiError -Stream $Stream -StatusCode $removed.Status -Code $removed.Code -Message $removed.Message -HeadOnly $headOnly
          return
        }

        $response = @{
          ok = $true
          lobby = (Get-RelayLobby -Room $room)
        }

        Send-JsonResponse -Stream $Stream -StatusCode 200 -Value $response -HeadOnly $headOnly
        return
      }

      default {
        Send-ApiError -Stream $Stream -StatusCode 404 -Code 'not_found' -Message 'Not found.' -HeadOnly $headOnly
        return
      }
    }
  }

  if ($path -eq '/api' -or $path.StartsWith('/api/')) {
    Send-ApiError -Stream $Stream -StatusCode 404 -Code 'not_found' -Message 'Not found.' -HeadOnly $headOnly
    return
  }

  if ($method -ne 'GET' -and $method -ne 'HEAD') {
    Send-MethodNotAllowed -Stream $Stream -Allow 'GET, HEAD' -HeadOnly $headOnly
    return
  }

  Serve-StaticFile -Stream $Stream -RequestPath $path -HeadOnly $headOnly
}

function Handle-Client {
  param([System.Net.Sockets.TcpClient]$Client)

  $stream = $Client.GetStream()
  $stream.ReadTimeout = $script:ReadTimeoutMs
  $stream.WriteTimeout = $script:ReadTimeoutMs

  try {
    $request = Read-HttpRequest -Stream $stream

    if (-not $request.Ok) {
      Send-ApiError -Stream $stream -StatusCode $request.Status -Code 'bad_request' -Message $request.Message
      return
    }

    Handle-Request -Stream $stream -Request $request
  } catch {
    Write-Host ("Request error: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow
  } finally {
    try {
      $stream.Dispose()
    } catch {
      # The client can disappear at any time.
    }
  }
}

function Test-PrivateIPv4Address {
  param([System.Net.IPAddress]$Address)

  if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }

  $bytes = $Address.GetAddressBytes()

  if ($bytes[0] -eq 10) {
    return $true
  }

  if ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) {
    return $true
  }

  if ($bytes[0] -eq 192 -and $bytes[1] -eq 168) {
    return $true
  }

  return $false
}

function Test-LoopbackIPv4Address {
  param([System.Net.IPAddress]$Address)

  if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }

  return ($Address.GetAddressBytes()[0] -eq 127)
}

function Test-ApipaIPv4Address {
  param([System.Net.IPAddress]$Address)

  if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }

  $bytes = $Address.GetAddressBytes()
  return ($bytes[0] -eq 169 -and $bytes[1] -eq 254)
}

function Test-UnspecifiedIPv4Address {
  param([System.Net.IPAddress]$Address)

  if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    return $false
  }

  $bytes = $Address.GetAddressBytes()
  return ($bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 0 -and $bytes[3] -eq 0)
}

function Get-PrivateIPv4Candidates {
  $ranked = @()
  $interfaceIndex = 0

  foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    $interfaceIndex += 1

    if ($networkInterface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) {
      continue
    }

    $interfaceType = $networkInterface.NetworkInterfaceType

    if ($interfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) {
      continue
    }

    if ($interfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Tunnel) {
      continue
    }

    $hasGateway = $false

    foreach ($gateway in $networkInterface.GetIPProperties().GatewayAddresses) {
      if ($null -eq $gateway.Address) {
        continue
      }

      if ($gateway.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
          -not (Test-UnspecifiedIPv4Address -Address $gateway.Address)) {
        $hasGateway = $true
        break
      }
    }

    $isCommonLanType = (
      $interfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Ethernet -or
      $interfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::GigabitEthernet -or
      $interfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::FastEthernet -or
      $interfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211
    )

    if ($hasGateway -and $isCommonLanType) {
      $rank = 0
    } elseif ($hasGateway) {
      $rank = 1
    } elseif ($isCommonLanType) {
      $rank = 2
    } else {
      $rank = 3
    }

    foreach ($unicast in $networkInterface.GetIPProperties().UnicastAddresses) {
      $address = $unicast.Address

      if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        continue
      }

      if (-not (Test-PrivateIPv4Address -Address $address)) {
        continue
      }

      $ranked += [pscustomobject]@{
        Rank = $rank
        Index = $interfaceIndex
        Address = $address
      }
    }
  }

  $ordered = $ranked | Sort-Object -Property Rank, Index
  $result = @()

  foreach ($item in $ordered) {
    $result += $item.Address
  }

  return $result
}

$script:ServerVersion = '1.2.0'
$packagePath = Join-Path $PSScriptRoot '..\package.json'

try {
  if ([System.IO.File]::Exists($packagePath)) {
    $package = [System.IO.File]::ReadAllText($packagePath) | ConvertFrom-Json

    if ($null -ne $package.version -and -not [string]::IsNullOrWhiteSpace([string]$package.version)) {
      $script:ServerVersion = [string]$package.version
    }
  }
} catch {
  # Keep the built-in version if package.json cannot be read.
}

if ($RoomTtlSeconds -lt 1 -or $RoomTtlSeconds -gt 86400) {
  Write-Host ''
  Write-Host 'ERROR: -RoomTtlSeconds must be between 1 and 86400.' -ForegroundColor Red
  Write-Host ''
  exit 1
}

Initialize-Relay -TtlSeconds $RoomTtlSeconds

$lanMode = [bool]$Lan
$portSpecified = $PSBoundParameters.ContainsKey('Port')

if ($portSpecified -and ($Port -lt 1 -or $Port -gt 65535)) {
  Write-Host ''
  Write-Host 'ERROR: -Port must be between 1 and 65535.' -ForegroundColor Red
  Write-Host ''
  exit 1
}

if ($lanMode) {
  $bindCandidates = @()

  if (-not [string]::IsNullOrWhiteSpace($BindAddress)) {
    $parsedAddress = $null

    if (-not [System.Net.IPAddress]::TryParse($BindAddress.Trim(), [ref]$parsedAddress)) {
      Write-Host ''
      Write-Host ("ERROR: -BindAddress '{0}' is not a valid IPv4 address." -f $BindAddress) -ForegroundColor Red
      Write-Host ''
      exit 1
    }

    if ($parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
      Write-Host ''
      Write-Host 'ERROR: -BindAddress must be an IPv4 address.' -ForegroundColor Red
      Write-Host ''
      exit 1
    }

    if (-not (Test-PrivateIPv4Address -Address $parsedAddress) -and -not (Test-LoopbackIPv4Address -Address $parsedAddress)) {
      $reason = 'not a private IPv4 address'

      if (Test-ApipaIPv4Address -Address $parsedAddress) {
        $reason = 'an APIPA (169.254.0.0/16) address'
      } elseif (Test-UnspecifiedIPv4Address -Address $parsedAddress) {
        $reason = 'an unspecified address'
      }

      Write-Host ''
      Write-Host ("ERROR: -BindAddress {0} is {1}." -f $parsedAddress, $reason) -ForegroundColor Red
      Write-Host 'LAN mode allows only 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or an explicit 127.0.0.1 test bind.' -ForegroundColor Yellow
      Write-Host 'Public bind addresses are refused on purpose.' -ForegroundColor Yellow
      Write-Host ''
      exit 1
    }

    $bindCandidates = @($parsedAddress)
  } else {
    $foundCandidates = Get-PrivateIPv4Candidates

    if ($foundCandidates.Count -eq 0) {
      Write-Host ''
      Write-Host 'ERROR: no private IPv4 address was found on this computer.' -ForegroundColor Red
      Write-Host 'Connect to the office LAN (Wi-Fi or Ethernet) and run start-lan.cmd again.' -ForegroundColor Yellow
      Write-Host ''
      exit 1
    }

    $bindCandidates = $foundCandidates
  }
} else {
  if (-not [string]::IsNullOrWhiteSpace($BindAddress)) {
    Write-Host ''
    Write-Host 'ERROR: -BindAddress can only be used together with -Lan.' -ForegroundColor Red
    Write-Host ''
    exit 1
  }

  $bindCandidates = @([System.Net.IPAddress]::Loopback)
}

if ($portSpecified) {
  $candidatePorts = @($Port)
} else {
  $candidatePorts = @(8765..8785)
}

$listener = $null
$boundAddress = $null
$boundPort = 0
$lastBindError = ''

foreach ($candidateAddress in $bindCandidates) {
  foreach ($candidatePort in $candidatePorts) {
    $candidateListener = $null

    try {
      $candidateListener = New-Object -TypeName System.Net.Sockets.TcpListener `
        -ArgumentList @($candidateAddress, $candidatePort)
      $candidateListener.Start()
      $listener = $candidateListener
      $boundAddress = $candidateAddress
      $boundPort = $candidatePort
      break
    } catch [System.Net.Sockets.SocketException] {
      $lastBindError = $_.Exception.Message

      if ($null -ne $candidateListener) {
        try {
          $candidateListener.Stop()
        } catch {
          # Nothing to clean up.
        }
      }

      if (-not $portSpecified -and $candidatePort -lt 8785) {
        Write-Host ("Port {0} is busy, trying {1}..." -f $candidatePort, ($candidatePort + 1)) -ForegroundColor DarkGray
      }
    }
  }

  if ($null -ne $listener) {
    break
  }
}

if ($null -eq $listener) {
  Write-Host ''

  if ($portSpecified) {
    Write-Host ("ERROR: port {0} is busy or cannot be bound." -f $Port) -ForegroundColor Red
  } else {
    Write-Host 'ERROR: ports 8765-8785 are all busy.' -ForegroundColor Red
  }

  if (-not [string]::IsNullOrWhiteSpace($lastBindError)) {
    Write-Host ("Details: {0}" -f $lastBindError) -ForegroundColor DarkGray
  }

  Write-Host 'Close the application that uses these ports and run the launcher again.' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

$script:ServerLan = $lanMode
$script:ServerBindAddress = $boundAddress.ToString()
$script:ServerPort = $boundPort
$script:ServerUrl = "http://{0}:{1}/" -f $script:ServerBindAddress, $boundPort
$script:ServerRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:ServerRootPrefix = $script:ServerRoot.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
$script:ServerAllowedHosts = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
[void]$script:ServerAllowedHosts.Add($script:ServerBindAddress)
[void]$script:ServerAllowedHosts.Add('127.0.0.1')
[void]$script:ServerAllowedHosts.Add('localhost')

try {
  [void]$script:ServerAllowedHosts.Add([System.Net.Dns]::GetHostName().ToLowerInvariant())
} catch {
  # The machine name is optional.
}

$url = $script:ServerUrl

if ($script:ServerLan) {
  Write-Host ''
  Write-Host '  ============================================================' -ForegroundColor DarkYellow
  Write-Host '    1000 - Thousand card game - LAN mode' -ForegroundColor Yellow
  Write-Host ("    {0}" -f $url) -ForegroundColor Green
  Write-Host '    Open this address on the other computers in the same LAN.' -ForegroundColor DarkGray
  Write-Host '    Windows Firewall may ask to allow PowerShell on private networks.' -ForegroundColor Yellow
  Write-Host '    Public bind addresses are refused. Do not use public networks.' -ForegroundColor DarkGray
  Write-Host '    Room codes are created in the browser and are not printed here.' -ForegroundColor DarkGray
  Write-Host '    Press Ctrl+C to stop the server.' -ForegroundColor DarkGray

  if ($script:ServerBindAddress -eq '127.0.0.1') {
    Write-Host '    NOTE: loopback test bind; other computers cannot connect.' -ForegroundColor Yellow
  }

  Write-Host '  ============================================================' -ForegroundColor DarkYellow
  Write-Host ''
} else {
  Write-Host ''
  Write-Host '  ============================================' -ForegroundColor DarkYellow
  Write-Host '    1000 - Thousand card game' -ForegroundColor Yellow
  Write-Host ("    {0}" -f $url) -ForegroundColor Green
  Write-Host '    Press Ctrl+C to stop the server.' -ForegroundColor DarkGray
  Write-Host '  ============================================' -ForegroundColor DarkYellow
  Write-Host ''
}

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
    Invoke-RelayCleanup

    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 50
      continue
    }

    $client = $listener.AcceptTcpClient()

    try {
      $client.NoDelay = $true
      Handle-Client -Client $client
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
