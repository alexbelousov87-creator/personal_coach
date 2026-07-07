param(
  [string]$ConfigPath = "conf.json"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFullPath = [System.IO.Path]::GetFullPath((Join-Path $Root $ConfigPath))

if (Test-Path $ConfigFullPath) {
  $Config = Get-Content -Encoding UTF8 $ConfigFullPath | ConvertFrom-Json
}
else {
  $Config = [pscustomobject]@{}
}

function Get-ConfigValue($Path, $Fallback) {
  $current = $script:Config
  foreach ($part in $Path.Split(".")) {
    if ($null -eq $current -or -not $current.PSObject.Properties[$part]) {
      return $Fallback
    }
    $current = $current.$part
  }

  if ($null -eq $current -or $current -eq "") {
    return $Fallback
  }
  return $current
}

$HostName = [string](Get-ConfigValue "server.host" "127.0.0.1")
$Port = [int](Get-ConfigValue "server.port" 8765)
$LlmProvider = [string](Get-ConfigValue "llm.provider" "openrouter")
$LlmUrl = [string](Get-ConfigValue "llm.chatCompletionsUrl" "https://openrouter.ai/api/v1/chat/completions")
$LlmModel = [string](Get-ConfigValue "llm.model" "openai/gpt-oss-120b:free")
$LlmFallbackModels = @()
if ($Config.llm -and $Config.llm.PSObject.Properties["fallbackModels"] -and $Config.llm.fallbackModels) {
  $LlmFallbackModels = @($Config.llm.fallbackModels)
}
$LlmTimeoutSeconds = [int](Get-ConfigValue "llm.timeoutSeconds" 60)
$LlmTemperature = [double](Get-ConfigValue "llm.temperature" 0.2)
$LlmMaxTokens = [int](Get-ConfigValue "llm.maxTokens" 2500)
$LlmJsonMode = [bool](Get-ConfigValue "llm.jsonMode" $true)
$LlmSiteUrl = [string](Get-ConfigValue "llm.siteUrl" "http://127.0.0.1:8765")
$LlmAppName = [string](Get-ConfigValue "llm.appName" "Training Coach")

$PlanSchema = @{
  type = "object"
  additionalProperties = $false
  required = @("summary", "days")
  properties = @{
    summary = @{
      type = "string"
      description = "Короткое объяснение логики плана и главного ограничения."
    }
    days = @{
      type = "array"
      minItems = 5
      maxItems = 5
      items = @{
        type = "object"
        additionalProperties = $false
        required = @("date", "dateLabel", "focus", "title", "details", "load")
        properties = @{
          date = @{ type = "string" }
          dateLabel = @{ type = "string" }
          focus = @{ type = "string" }
          title = @{ type = "string" }
          details = @{ type = "string" }
          load = @{ type = "string" }
        }
      }
    }
  }
}

function Get-ApiKey {
  $configuredKey = [string](Get-ConfigValue "llm.apiKey" "")
  if ($configuredKey) {
    return $configuredKey.Trim()
  }

  $envName = [string](Get-ConfigValue "llm.apiKeyEnv" "")
  if ($envName) {
    return [string]([Environment]::GetEnvironmentVariable($envName)).Trim()
  }
  return ""
}

function Get-StatusText($StatusCode) {
  switch ($StatusCode) {
    200 { return "OK" }
    204 { return "No Content" }
    400 { return "Bad Request" }
    403 { return "Forbidden" }
    404 { return "Not Found" }
    500 { return "Internal Server Error" }
    502 { return "Bad Gateway" }
    default { return "OK" }
  }
}

function Write-RawResponse($Client, $StatusCode, $ContentType, [byte[]]$Bytes) {
  $stream = $Client.GetStream()
  $statusText = Get-StatusText $StatusCode
  $headers = @(
    "HTTP/1.1 $StatusCode $statusText"
    "Access-Control-Allow-Origin: *"
    "Access-Control-Allow-Headers: Content-Type"
    "Access-Control-Allow-Methods: GET, POST, OPTIONS"
    "Content-Type: $ContentType"
    "Content-Length: $($Bytes.Length)"
    "Connection: close"
    ""
    ""
  ) -join "`r`n"

  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Bytes.Length -gt 0) {
    $stream.Write($Bytes, 0, $Bytes.Length)
  }
}

function Write-Json($Client, $StatusCode, $Payload) {
  $json = $Payload | ConvertTo-Json -Depth 40 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Write-RawResponse $Client $StatusCode "application/json; charset=utf-8" $bytes
}

function Read-JsonBody($Body) {
  $body = [string]$Body
  if (-not $body) {
    throw "empty request body"
  }
  return $body | ConvertFrom-Json
}

function Get-ResponseText($LlmResponse) {
  if ($LlmResponse.choices -and $LlmResponse.choices[0].message.content) {
    return [string]$LlmResponse.choices[0].message.content
  }

  if ($LlmResponse.output_text) {
    return [string]$LlmResponse.output_text
  }

  foreach ($item in $LlmResponse.output) {
    foreach ($content in $item.content) {
      if ($content.text) {
        return [string]$content.text
      }
    }
  }

  throw "OpenRouter API не вернул текст плана"
}

function New-UserPrompt($Payload) {
  $context = $Payload.context | ConvertTo-Json -Depth 40
  $localPlan = $Payload.localPlan | ConvertTo-Json -Depth 40

  return @"
Сформируй персональный план на 5 дней на основе фактического тренировочного состояния. Не делай план слишком легким по умолчанию: если данные показывают нормальное восстановление и стабильную нагрузку, включи 1 развивающую тренировку (темпо, интервалы, прогрессия или длинная аэробная работа) и объясни выбор. Если данные показывают перегруз или резкий рост нагрузки, снизь интенсивность и явно объясни причину.

Контекст спортсмена и тренировок:
$context

Локальный черновик:
$localPlan

Локальный черновик не является обязательным: используй его только как baseline и корректируй по данным. Целевая дистанция из profile.targetDistance и trainingState.targetDistance должна определять акценты плана: 5 км - скорость, VO2max, экономичность и короткие интервалы; 10 км - порог, темповая устойчивость и умеренный объем; 21 км - длительная аэробная работа, темпо и устойчивость к утомлению; 42 км - аэробная база, длинные тренировки, марафонское усилие, питание и восстановление. Опирайся на load7Days, load28Days, previous7DaysLoad, acuteChronicRatio, rampRate, hoursSinceLast, частоту тренировок и последние тренировки. Для каждого дня укажи конкретную длительность, интенсивность, зоны/RPE при необходимости и смысл тренировки. Темп используй только если в recentWorkouts есть paceSource='imported' и paceMinPerKm/pace; paceMinPerKm означает минуты на километр, а не километры в час. Не вычисляй и не восстанавливай темп из durationMin и distanceKm; если импортированного темпа нет, задавай интенсивность через RPE/пульс/разговорный темп. План должен быть реалистичным, но развивающим, если состояние это позволяет. Не назначай только легкие тренировки, если нет признаков перегруза. Пиши по-русски, кратко и практически.
Верни только валидный JSON без Markdown и пояснений: {"summary":"...","stateAssessment":"...","days":[{"date":"...","dateLabel":"...","focus":"...","title":"...","details":"...","load":"...","rationale":"..."}]}
"@
}

function New-AiPlan($Payload) {
  $apiKey = Get-ApiKey
  if (-not $apiKey) {
    throw "API key не найден. Укажите llm.apiKey или llm.apiKeyEnv в conf.json."
  }

  $headers = @{
    Authorization = "Bearer $apiKey"
    "Content-Type" = "application/json"
  }
  if ($LlmSiteUrl) {
    $headers["HTTP-Referer"] = $LlmSiteUrl
  }
  if ($LlmAppName) {
    $headers["X-Title"] = $LlmAppName
  }

  $models = @($LlmModel) + $LlmFallbackModels | Where-Object { $_ } | Select-Object -Unique
  $rateLimitErrors = @()
  foreach ($model in $models) {
    $body = @{
      model = $model
      messages = @(
        @{
          role = "system"
          content = [string]$Payload.system
        },
        @{
          role = "user"
          content = New-UserPrompt $Payload
        }
      )
      temperature = $LlmTemperature
      max_tokens = $LlmMaxTokens
    }
    if ($LlmJsonMode) {
      $body.response_format = @{
        type = "json_object"
      }
    }
    $body = $body | ConvertTo-Json -Depth 50

    try {
      $response = Invoke-RestMethod -Method Post -Uri $LlmUrl -Headers $headers -Body $body -TimeoutSec $LlmTimeoutSeconds
    }
    catch {
      $status = $null
      if ($_.Exception.Response) {
        $status = [int]$_.Exception.Response.StatusCode
      }
      if ($status -eq 429) {
        $rateLimitErrors += "$model`: $($_.Exception.Message)"
        continue
      }
      throw
    }

    $text = Get-ResponseText $response
    $text = $text.Trim()
    $start = $text.IndexOf("{")
    $end = $text.LastIndexOf("}")
    if ($start -ge 0 -and $end -gt $start) {
      $text = $text.Substring($start, $end - $start + 1)
    }
    try {
      $plan = $text | ConvertFrom-Json
      $plan | Add-Member -NotePropertyName modelUsed -NotePropertyValue $model -Force
      return $plan
    }
    catch {
      $rateLimitErrors += "$model`: невалидный JSON"
      continue
    }
  }

  throw "Не удалось получить валидный JSON от моделей: $($models -join ', '). Последняя ошибка: $($rateLimitErrors[-1])"
}

function Get-ContentType($Path) {
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".js" { return "application/javascript; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".svg" { return "image/svg+xml" }
    default { return "application/octet-stream" }
  }
}

function Write-StaticFile($Client, $Path) {
  $requestPath = $Path.TrimStart("/")
  if (-not $requestPath) {
    $requestPath = "index.html"
  }
  $requestPath = [System.Uri]::UnescapeDataString($requestPath)

  $target = [System.IO.Path]::GetFullPath((Join-Path $Root $requestPath))
  $rootFull = [System.IO.Path]::GetFullPath($Root)
  if (-not $target.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Json $Client 403 @{ error = "forbidden" }
    return
  }
  if (-not (Test-Path $target -PathType Leaf)) {
    Write-Json $Client 404 @{ error = "not found" }
    return
  }

  $bytes = [System.IO.File]::ReadAllBytes($target)
  Write-RawResponse $Client 200 (Get-ContentType $target) $bytes
}

function Read-HttpRequest($Client) {
  $stream = $Client.GetStream()
  $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)
  $requestLine = $reader.ReadLine()
  if (-not $requestLine) {
    throw "empty request"
  }

  $parts = $requestLine.Split(" ")
  $headers = @{}
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line -or $line -eq "") {
      break
    }
    $index = $line.IndexOf(":")
    if ($index -gt 0) {
      $name = $line.Substring(0, $index).Trim().ToLowerInvariant()
      $value = $line.Substring($index + 1).Trim()
      $headers[$name] = $value
    }
  }

  $contentLength = 0
  if ($headers.ContainsKey("content-length")) {
    [int]::TryParse($headers["content-length"], [ref]$contentLength) | Out-Null
  }

  $body = ""
  if ($contentLength -gt 0) {
    $buffer = New-Object char[] $contentLength
    $read = $reader.ReadBlock($buffer, 0, $contentLength)
    if ($read -gt 0) {
      $body = -join $buffer[0..($read - 1)]
    }
  }

  return @{
    method = $parts[0]
    target = $parts[1]
    body = $body
  }
}

function Handle-Client($Client) {
  try {
    $request = Read-HttpRequest $Client
    $path = ($request.target -split "\?", 2)[0]

    if ($request.method -eq "OPTIONS") {
      Write-RawResponse $Client 204 "text/plain; charset=utf-8" ([byte[]]::new(0))
    }
    elseif ($request.method -eq "GET" -and $path -eq "/api/health") {
      Write-Json $Client 200 @{ ok = $true; provider = $LlmProvider; model = $LlmModel; fallbackModels = $LlmFallbackModels; config = [System.IO.Path]::GetFileName($ConfigFullPath); hasApiKey = [bool](Get-ApiKey) }
    }
    elseif ($request.method -eq "POST" -and $path -eq "/api/plan") {
      $payload = Read-JsonBody $request.body
      $plan = New-AiPlan $payload
      Write-Json $Client 200 @{ plan = $plan }
    }
    elseif ($request.method -eq "GET") {
      Write-StaticFile $Client $path
    }
    else {
      Write-Json $Client 404 @{ error = "unknown endpoint" }
    }
  }
  catch {
    Write-Json $Client 500 @{ error = $_.Exception.Message }
  }
  finally {
    $Client.Close()
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($HostName), $Port)
$listener.Start()
$prefix = "http://$HostName`:$Port/"

Write-Host "Training Coach: $prefix"
Write-Host "Config: $ConfigFullPath"
Write-Host "Остановить сервер: Ctrl+C"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    Handle-Client $client
  }
}
finally {
  $listener.Stop()
}
