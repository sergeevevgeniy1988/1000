# 1000 LAN relay: in-memory rooms, tokens, lobby, opaque JSON views and action queue.
# Dot-sourced by serve.ps1. This file never writes tokens or player names to disk
# or to the console.

$script:RelaySeats = @('human', 'alice', 'boris')
$script:RelayCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$script:RelayMaxLogEntries = 500
$script:RelayConnectedWindowSeconds = 15
$script:RelayTombstoneSeconds = 600

function Initialize-Relay {
  param(
    [int]$TtlSeconds = 120,
    [int]$MaxRooms = 8,
    [int]$MaxQueuedActions = 100,
    [int]$MaxPlayerMessages = 50
  )

  $script:RelayState = @{
    Rooms = @{}
    Tombs = @{}
    TtlSeconds = $TtlSeconds
    MaxRooms = $MaxRooms
    MaxQueuedActions = $MaxQueuedActions
    MaxPlayerMessages = $MaxPlayerMessages
    LastCleanup = [DateTime]::UtcNow.AddSeconds(-1)
  }
}

function New-RelayError {
  param(
    [int]$Status,
    [string]$Code,
    [string]$ErrorMessage
  )

  return @{
    Ok = $false
    Status = $Status
    Code = $Code
    Message = $ErrorMessage
  }
}

function New-RelayRandomBytes {
  param([int]$Count)

  $bytes = New-Object byte[] $Count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }

  return ,$bytes
}

function New-RelayToken {
  $bytes = New-RelayRandomBytes -Count 32
  return (([System.BitConverter]::ToString($bytes)) -replace '-', '').ToLowerInvariant()
}

function New-RelayRoomCode {
  $bytes = New-RelayRandomBytes -Count 6
  $builder = New-Object System.Text.StringBuilder

  for ($i = 0; $i -lt 6; $i++) {
    $index = [int]$bytes[$i] % $script:RelayCodeAlphabet.Length
    [void]$builder.Append($script:RelayCodeAlphabet[$index])
  }

  return $builder.ToString()
}

function Test-RelayName {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $false
  }

  if ($Name.Length -gt 24) {
    return $false
  }

  foreach ($character in $Name.ToCharArray()) {
    if ([char]::IsControl($character)) {
      return $false
    }
  }

  return $true
}

function Test-RelayShortText {
  param(
    [string]$Value,
    [int]$MaxLength
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }

  if ($Value.Length -gt $MaxLength) {
    return $false
  }

  foreach ($character in $Value.ToCharArray()) {
    if ([char]::IsControl($character)) {
      return $false
    }
  }

  return $true
}

function Test-RelayNameTaken {
  param(
    $Room,
    [string]$Name
  )

  foreach ($seat in $script:RelaySeats) {
    $player = $Room.Players[$seat]

    if ($null -ne $player -and [string]::Equals($player.Name, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }

  return $false
}

function Invoke-RelayCleanup {
  $state = $script:RelayState

  if ($null -eq $state) {
    return
  }

  $now = [DateTime]::UtcNow

  if (($now - $state.LastCleanup).TotalMilliseconds -lt 500) {
    return
  }

  $state.LastCleanup = $now
  $expiredCodes = @()

  foreach ($code in @($state.Rooms.Keys)) {
    $room = $state.Rooms[$code]

    if (($now - $room.HostLastSeen).TotalSeconds -gt $state.TtlSeconds) {
      $expiredCodes += $code
    }
  }

  foreach ($code in $expiredCodes) {
    [void]$state.Rooms.Remove($code)
    $state.Tombs[$code] = @{
      reason = 'expired'
      at = $now
    }
  }

  $staleTombstones = @()

  foreach ($code in @($state.Tombs.Keys)) {
    if (($now - $state.Tombs[$code].at).TotalSeconds -gt $script:RelayTombstoneSeconds) {
      $staleTombstones += $code
    }
  }

  foreach ($code in $staleTombstones) {
    [void]$state.Tombs.Remove($code)
  }
}

function Get-RelayRoomStatus {
  param([string]$Code)

  Invoke-RelayCleanup

  if ($script:RelayState.Rooms.ContainsKey($Code)) {
    return @{
      Status = 'ok'
      Room = $script:RelayState.Rooms[$Code]
    }
  }

  if ($script:RelayState.Tombs.ContainsKey($Code)) {
    return @{
      Status = 'gone'
      Reason = $script:RelayState.Tombs[$Code].reason
    }
  }

  return @{ Status = 'missing' }
}

function Get-RelayLobby {
  param($Room)

  $seats = @()

  foreach ($seat in $script:RelaySeats) {
    $player = $Room.Players[$seat]
    $occupied = $null -ne $player
    $connected = $false
    $name = $null
    $lastSeen = $null

    if ($occupied) {
      $name = $player.Name
      $lastSeen = $player.LastSeen.ToString('o')
      $connected = (([DateTime]::UtcNow) - $player.LastSeen).TotalSeconds -le $script:RelayConnectedWindowSeconds
    }

    $seats += @{
      playerId = $seat
      name = $name
      occupied = $occupied
      isHost = ($seat -eq 'human')
      isAI = (-not $occupied)
      connected = $connected
      lastSeen = $lastSeen
    }
  }

  return @{
    code = $Room.Code
    version = $Room.LobbyVersion
    started = $Room.Started
    maxPlayers = 3
    seats = $seats
  }
}

function New-RelayRoom {
  param([string]$Name)

  Invoke-RelayCleanup

  if ($script:RelayState.Rooms.Count -ge $script:RelayState.MaxRooms) {
    return New-RelayError -Status 429 -Code 'too_many_rooms' -ErrorMessage 'Too many rooms are open. Try again later.'
  }

  $trimmedName = ''
  if ($null -ne $Name) {
    $trimmedName = $Name.Trim()
  }

  if (-not (Test-RelayName -Name $trimmedName)) {
    return New-RelayError -Status 400 -Code 'bad_name' -ErrorMessage 'Name must be 1-24 characters without control characters.'
  }

  $code = $null

  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    $candidate = New-RelayRoomCode

    if (-not $script:RelayState.Rooms.ContainsKey($candidate) -and -not $script:RelayState.Tombs.ContainsKey($candidate)) {
      $code = $candidate
      break
    }
  }

  if ($null -eq $code) {
    return New-RelayError -Status 500 -Code 'room_code_exhausted' -ErrorMessage 'Could not allocate a room code.'
  }

  $token = New-RelayToken
  $now = [DateTime]::UtcNow

  $room = @{
    Code = $code
    CreatedAt = $now
    HostLastSeen = $now
    Started = $false
    LobbyVersion = 1
    Players = @{}
    Views = @{}
    ViewVersion = 0
    PublishVersion = 0
    Log = (New-Object System.Collections.ArrayList)
    LogEpoch = 0
    LogSeq = 0
    Actions = (New-Object System.Collections.ArrayList)
    ActionSeq = 0
    Messages = @{}
    MessageSeq = @{}
  }

  foreach ($seat in $script:RelaySeats) {
    $room.Messages[$seat] = New-Object System.Collections.ArrayList
    $room.MessageSeq[$seat] = 0
  }

  $player = @{
    Id = 'human'
    Name = $trimmedName
    Token = $token
    IsHost = $true
    JoinedAt = $now
    LastSeen = $now
  }

  $room.Players['human'] = $player
  $script:RelayState.Rooms[$code] = $room

  return @{
    Ok = $true
    Room = $room
    Player = $player
    Token = $token
  }
}

function Join-RelayRoom {
  param(
    $Room,
    [string]$Name
  )

  if ($Room.Started) {
    return New-RelayError -Status 409 -Code 'game_started' -ErrorMessage 'The game has already started.'
  }

  $trimmedName = ''
  if ($null -ne $Name) {
    $trimmedName = $Name.Trim()
  }

  if (-not (Test-RelayName -Name $trimmedName)) {
    return New-RelayError -Status 400 -Code 'bad_name' -ErrorMessage 'Name must be 1-24 characters without control characters.'
  }

  if (Test-RelayNameTaken -Room $Room -Name $trimmedName) {
    return New-RelayError -Status 409 -Code 'name_taken' -ErrorMessage 'That name is already used in this room.'
  }

  $seat = $null

  foreach ($candidate in @('alice', 'boris')) {
    if ($null -eq $Room.Players[$candidate]) {
      $seat = $candidate
      break
    }
  }

  if ($null -eq $seat) {
    return New-RelayError -Status 409 -Code 'room_full' -ErrorMessage 'The room is full.'
  }

  $now = [DateTime]::UtcNow
  $token = New-RelayToken

  $player = @{
    Id = $seat
    Name = $trimmedName
    Token = $token
    IsHost = $false
    JoinedAt = $now
    LastSeen = $now
  }

  $Room.Players[$seat] = $player
  $Room.LobbyVersion += 1

  return @{
    Ok = $true
    Room = $Room
    Player = $player
    Token = $token
  }
}

function Get-RelayPlayerByToken {
  param(
    $Room,
    [string]$Token
  )

  if ([string]::IsNullOrEmpty($Token)) {
    return $null
  }

  foreach ($seat in $script:RelaySeats) {
    $player = $Room.Players[$seat]

    if ($null -ne $player -and [string]::Equals($player.Token, $Token, [System.StringComparison]::Ordinal)) {
      return $player
    }
  }

  return $null
}

function Update-RelayHostSeen {
  param($Room)

  $now = [DateTime]::UtcNow
  $Room.HostLastSeen = $now
  $hostPlayer = $Room.Players['human']

  if ($null -ne $hostPlayer) {
    $hostPlayer.LastSeen = $now
  }
}

function Remove-RelayGuest {
  param(
    $Room,
    [string]$PlayerId
  )

  if ($PlayerId -eq 'human') {
    return New-RelayError -Status 403 -Code 'cannot_remove_host' -ErrorMessage 'The host cannot be removed.'
  }

  if ($PlayerId -ne 'alice' -and $PlayerId -ne 'boris') {
    return New-RelayError -Status 400 -Code 'bad_player' -ErrorMessage 'Unknown player seat.'
  }

  if (-not $Room.Players.ContainsKey($PlayerId)) {
    return New-RelayError -Status 400 -Code 'seat_empty' -ErrorMessage 'That seat is already empty.'
  }

  if ($Room.Started) {
    return New-RelayError -Status 409 -Code 'game_started' -ErrorMessage 'The game has already started.'
  }

  [void]$Room.Players.Remove($PlayerId)
  $Room.LobbyVersion += 1

  for ($i = $Room.Actions.Count - 1; $i -ge 0; $i--) {
    if ($Room.Actions[$i].playerId -eq $PlayerId) {
      $Room.Actions.RemoveAt($i)
    }
  }

  return @{ Ok = $true }
}

function Close-RelayRoom {
  param(
    $Room,
    [string]$Reason = 'closed'
  )

  $code = $Room.Code

  if ($script:RelayState.Rooms.ContainsKey($code)) {
    [void]$script:RelayState.Rooms.Remove($code)
  }

  $script:RelayState.Tombs[$code] = @{
    reason = $Reason
    at = [DateTime]::UtcNow
  }
}

function Add-RelayAction {
  param(
    $Room,
    $Player,
    [string]$ActionId,
    [string]$Type,
    $Payload
  )

  foreach ($action in $Room.Actions) {
    if ($action.playerId -eq $Player.Id -and $action.actionId -eq $ActionId) {
      return @{
        Ok = $true
        Seq = $action.seq
        Duplicate = $true
      }
    }
  }

  if ($Room.Actions.Count -ge $script:RelayState.MaxQueuedActions) {
    return New-RelayError -Status 429 -Code 'action_queue_full' -ErrorMessage 'The action queue is full.'
  }

  $Room.ActionSeq += 1

  $entry = @{
    seq = $Room.ActionSeq
    playerId = $Player.Id
    actionId = $ActionId
    type = $Type
    payload = $Payload
    at = ([DateTime]::UtcNow).ToString('o')
  }

  [void]$Room.Actions.Add($entry)
  $Player.LastSeen = [DateTime]::UtcNow

  return @{
    Ok = $true
    Seq = $Room.ActionSeq
    Duplicate = $false
  }
}

function Publish-RelayState {
  param(
    $Room,
    $Body
  )

  $versionProperty = $Body.PSObject.Properties['version']

  if ($null -eq $versionProperty -or $null -eq $versionProperty.Value) {
    return New-RelayError -Status 400 -Code 'bad_version' -ErrorMessage 'A numeric version is required.'
  }

  [int]$version = 0
  if (-not [int]::TryParse([string]$versionProperty.Value, [ref]$version) -or $version -lt 1) {
    return New-RelayError -Status 400 -Code 'bad_version' -ErrorMessage 'A numeric version is required.'
  }

  if ($version -lt $Room.PublishVersion) {
    return New-RelayError -Status 409 -Code 'stale_version' -ErrorMessage 'A newer version has already been published.'
  }

  if ($version -eq $Room.PublishVersion) {
    return @{
      Ok = $true
      Duplicate = $true
      Version = $Room.PublishVersion
      Started = $Room.Started
      GameReset = $false
      Views = $Room.Views
      Log = @()
      Messages = @{
        human = @()
        alice = @()
        boris = @()
      }
      Cursor = $Room.ActionSeq
      LobbyVersion = $Room.LobbyVersion
    }
  }

  $gameReset = $false
  $gameResetProperty = $Body.PSObject.Properties['gameReset']

  if ($null -ne $gameResetProperty -and $null -ne $gameResetProperty.Value) {
    if ($gameResetProperty.Value -isnot [bool]) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'gameReset must be a boolean.'
    }

    $gameReset = [bool]$gameResetProperty.Value
  }

  $requestedEpoch = $null
  $epochProvided = $false
  $epochProperty = $Body.PSObject.Properties['logEpoch']

  if ($null -ne $epochProperty -and $null -ne $epochProperty.Value) {
    [int]$parsedEpoch = 0

    if (-not [int]::TryParse([string]$epochProperty.Value, [ref]$parsedEpoch) -or $parsedEpoch -lt 0) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'logEpoch must be a non-negative integer.'
    }

    $requestedEpoch = $parsedEpoch
    $epochProvided = $true
  }

  $viewsValue = $null
  $viewsProvided = $false
  $viewsProperty = $Body.PSObject.Properties['views']

  if ($null -ne $viewsProperty -and $null -ne $viewsProperty.Value) {
    $viewsValue = $viewsProperty.Value

    if ($viewsValue -is [System.Array] -or $viewsValue -is [System.Collections.IList]) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'views must be an object.'
    }

    if (-not ($viewsValue -is [System.Collections.IDictionary]) -and
        -not ($viewsValue -is [System.Management.Automation.PSCustomObject])) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'views must be an object.'
    }

    $viewsProvided = $true
  }

  $newStarted = $null
  $startedProperty = $Body.PSObject.Properties['started']

  if ($null -ne $startedProperty -and $null -ne $startedProperty.Value) {
    if ($startedProperty.Value -isnot [bool]) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'started must be a boolean.'
    }

    $newStarted = [bool]$startedProperty.Value
  }

  $logItems = $null
  $logProperty = $Body.PSObject.Properties['log']

  if ($null -ne $logProperty -and $null -ne $logProperty.Value) {
    if ($logProperty.Value -isnot [System.Array]) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'log must be an array.'
    }

    $logItems = $logProperty.Value
  }

  $messageItems = @{}
  $messagesProperty = $Body.PSObject.Properties['messages']

  if ($null -ne $messagesProperty -and $null -ne $messagesProperty.Value) {
    $messagesValue = $messagesProperty.Value

    if ($messagesValue -is [System.Array] -or $messagesValue -is [System.Collections.IList]) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'messages must be an object.'
    }

    if (-not ($messagesValue -is [System.Collections.IDictionary]) -and
        -not ($messagesValue -is [System.Management.Automation.PSCustomObject])) {
      return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'messages must be an object.'
    }

    foreach ($seat in $script:RelaySeats) {
      $seatMessages = $null

      if ($messagesValue -is [System.Collections.IDictionary]) {
        if ($messagesValue.Contains($seat)) {
          $seatMessages = $messagesValue[$seat]
        }
      } else {
        $seatProperty = $messagesValue.PSObject.Properties[$seat]

        if ($null -ne $seatProperty) {
          $seatMessages = $seatProperty.Value
        }
      }

      if ($null -eq $seatMessages) {
        continue
      }

      if ($seatMessages -isnot [System.Array]) {
        return New-RelayError -Status 400 -Code 'bad_publish' -ErrorMessage 'Each messages value must be an array.'
      }

      $messageItems[$seat] = $seatMessages
    }
  }

  if ($gameReset) {
    $Room.LogEpoch += 1
    $Room.Log.Clear()
    $Room.LogSeq = 0
  } elseif ($epochProvided -and $requestedEpoch -ne $Room.LogEpoch) {
    $Room.LogEpoch = $requestedEpoch
    $Room.Log.Clear()
    $Room.LogSeq = 0
  }

  if ($viewsProvided) {
    if ($viewsValue -is [System.Collections.IDictionary]) {
      foreach ($seat in $script:RelaySeats) {
        if ($viewsValue.Contains($seat)) {
          $Room.Views[$seat] = $viewsValue[$seat]
        }
      }
    } else {
      foreach ($seat in $script:RelaySeats) {
        $seatProperty = $viewsValue.PSObject.Properties[$seat]

        if ($null -ne $seatProperty) {
          $Room.Views[$seat] = $seatProperty.Value
        }
      }
    }
  }

  if ($null -ne $newStarted -and $newStarted -ne $Room.Started) {
    $Room.Started = $newStarted
    $Room.LobbyVersion += 1
  }

  $appendedLog = @()

  if ($null -ne $logItems) {
    foreach ($entry in $logItems) {
      $Room.LogSeq += 1
      $wrapped = @{
        seq = $Room.LogSeq
        entry = $entry
      }
      [void]$Room.Log.Add($wrapped)
      $appendedLog += $wrapped
    }

    $trimmed = $false

    while ($Room.Log.Count -gt $script:RelayMaxLogEntries) {
      $Room.Log.RemoveAt(0)
      $trimmed = $true
    }

    if ($trimmed) {
      $Room.LogEpoch += 1
    }
  }

  $appendedMessages = @{}

  foreach ($seat in $script:RelaySeats) {
    $appendedMessages[$seat] = @()
  }

  foreach ($seat in $script:RelaySeats) {
    if (-not $messageItems.ContainsKey($seat)) {
      continue
    }

    $queue = $Room.Messages[$seat]

    foreach ($message in $messageItems[$seat]) {
      $Room.MessageSeq[$seat] += 1
      $wrappedMessage = @{
        seq = $Room.MessageSeq[$seat]
        payload = $message
      }
      [void]$queue.Add($wrappedMessage)
      $appendedMessages[$seat] += $wrappedMessage
    }

    while ($queue.Count -gt $script:RelayState.MaxPlayerMessages) {
      $queue.RemoveAt(0)
    }
  }

  $Room.PublishVersion = $version
  $Room.ViewVersion = $version
  Update-RelayHostSeen -Room $Room

  return @{
    Ok = $true
    Duplicate = $false
    Version = $Room.PublishVersion
    Started = $Room.Started
    GameReset = $gameReset
    Views = $Room.Views
    Log = $appendedLog
    Messages = $appendedMessages
    Cursor = $Room.ActionSeq
    LobbyVersion = $Room.LobbyVersion
  }
}

function Get-RelayHostState {
  param(
    $Room,
    [int]$ActionSince
  )

  $actions = @()

  foreach ($action in $Room.Actions) {
    if ($action.seq -gt $ActionSince) {
      $actions += $action
    }
  }

  Update-RelayHostSeen -Room $Room

  return @{
    actions = $actions
    lobby = (Get-RelayLobby -Room $Room)
    cursor = $Room.ActionSeq
    lobbyVersion = $Room.LobbyVersion
  }
}

function Get-RelayPlayerState {
  param(
    $Room,
    $Player,
    [int]$ViewSince,
    [int]$LogSince,
    [int]$LogEpoch,
    [int]$MessageSince
  )

  $result = @{
    lobby = (Get-RelayLobby -Room $Room)
    viewVersion = $Room.ViewVersion
    logEpoch = $Room.LogEpoch
    logTotal = $Room.LogSeq
    messageTotal = $Room.MessageSeq[$Player.Id]
    started = $Room.Started
  }

  if ($ViewSince -lt $Room.ViewVersion -and $Room.Views.ContainsKey($Player.Id)) {
    $result.view = $Room.Views[$Player.Id]
  }

  $logEntries = @()

  foreach ($entry in $Room.Log) {
    if ($LogEpoch -ne $Room.LogEpoch -or $entry.seq -gt $LogSince) {
      $logEntries += $entry
    }
  }

  $result.log = $logEntries

  $messages = @()
  $queue = $Room.Messages[$Player.Id]

  foreach ($message in $queue) {
    if ($message.seq -gt $MessageSince) {
      $messages += $message
    }
  }

  $result.messages = $messages
  $Player.LastSeen = [DateTime]::UtcNow

  return $result
}
